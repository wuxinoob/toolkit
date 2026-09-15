# 消息传递框架统一化 — 现状分析与重构设计

> 来源项目：`D:\code\rust\eyecare\eyecare`（只读分析，未改动任何代码）
> 目标项目：本仓库 `D:\code\rust\toolkit`（当前为 Tauri+Vue 空白脚手架，git 仅 `init` 一次提交）
> 说明：`eyecare/docs/ARCHITECTURE.md` 与真实代码已有明显偏差，本文以**实际代码**为准。
> 采集时间：2026-09-14 20:00（分析过程中 `src-tauri/src/services/*` 正在被并发修改，见 §2）
>
> **状态：本设计已在 toolbox 中落地。** 应用名 **Toolbox**，identifier `com.tan18.toolbox`
> （原 `com.tan18.toolkit` 与 eyecare 冲突，已更名）。协议参考见 [`PROTOCOL.md`](./PROTOCOL.md)，
> 实现位置见 §5 的目录结构。
>
> 落地后的验证：**应用内自检 15/15 全绿**（含真实 sidecar 往返）、7 插件 / 7 视图全部 active、
> `cargo test` 39、`node --test` 39、`cargo check --all-targets` 零代码警告、`npm run build` 通过。
>
> 由测试与真实运行抓出并修复的四个缺陷：
> ① `pty-stream` 在 `await` 之后才注册回调，会丢掉进程启动时的首批输出；
> ② 在 `open` 期间就结束的流会在 hub 中残留一条永远不释放的记录；
> ③ `pty-stream` 的 exit 帧会抢在尾部输出之前到达（read 循环与 wait() 独立），把 `exit`
> 当终止的消费者会丢最后一段输出 → 退出后等数据流静默再发 exit；
> ④ 外部插件权限有 `plugin.json` 与代码内 `manifest` 两个来源，漂移后表现为莫名的
> `lacks permission` → 改为 `plugin.json` 权威并加一致性断言。

---

## 1. 现状：代码逻辑总结

### 1.1 总体形态

Tauri 2 + Vue 3 桌面工具箱。宿主（host）实现插件**发现 / 加载 / 生命周期 / 权限 / 前后端通信中介**；功能以插件形式挂载（`notepad` / `eyecare` / `procman` / `floatwin`），另有一个**非插件的核心模块**（进程管理器，实为 `procman` 插件形态）。

### 1.2 前端宿主内核（`src/host/`）

| 文件 | 职责 |
|---|---|
| `boot.js` | 启动编排：装 debug → 启内置插件 → 扫外部插件 → 注册唤出热键 → dev 下跑自检并落盘 `debug.log` |
| `registry.js` | 内置插件静态 import 表（id → module） |
| `lifecycle.js` | 状态机 `discovered→loaded→activated→deactivated`；`Disposer` 收集清理函数，停用即全量拆除；启用状态持久化于 localStorage（含 known-key 迁移） |
| `ctx.js` | 插件 SDK（`ctx`）：`storage` / `events` / `ui` / `rpc` / `proc` / `windows` / `registerView`。**唯一的权限闸口** `gatedRpc`（校验 `rpc:<service>`）+ `gatedWin`（校验 `win:manage`） |
| `bridge.js` | `rpc()` = `invoke('plugin_rpc', {...})`；`hasPermission()` |
| `events.js` | **纯 JS 的窗口内** pub/sub（`Map<event, Set<fn>>`）——没有任何 IPC |
| `external.js` | 外部插件：`plugin_scan` → `plugin_read_entry` → `Blob URL` → 动态 `import()` |
| `pluginwin-host.js` | 独立插件窗口页面（`?mode=pluginwin`）：Blob 导入插件入口并调用其 `mountWindow(bridge)` |
| `store.js` / `debug.js` | Vue 响应式单一数据源 / `window.__toolbox` 调试命名空间 |

### 1.3 Rust 侧（`src-tauri/src/`）

| 文件 | 职责 |
|---|---|
| `lib.rs` | 单一网关命令 `plugin_rpc`；3 个直连命令（`plugin_scan` / `plugin_read_entry` / `plugin_open_dir`）；`RunEvent::Exit` → `proc::kill_all()` |
| `services/storage.rs` | `storage`（per-plugin `data.json` KV）+ `host`（info / write_debug_log）；`validate_plugin_id`（防 `..` 穿越）；纯路径核心 `dispatch_at` 便于单测 |
| `services/external.rs` | 插件目录扫描 / 入口源码读取（canonicalize + 前缀校验防穿越）/ 打开目录 |
| `services/proc.rs` | sidecar 服务：`spawn / send / recv / kill / kill_all / list`；`(plugin,key)` 注册表、每插件上限 4、行读上限 1 MiB、`recv` 带超时、reader 线程 + `Condvar`、退出时精确 exit code |
| `services/frames.rs` | **新增（未跟踪）**：下行线格式契约——`StreamFrame`（`{"t":"data"\|"end"\|"error"}`）+ `raw`（1 字节 kind 前缀：`0x01 data / 0x02 end / 0x03 exit`） |
| `services/mod.rs` | **新增（已改）**：`trait Service { name(); dispatch(app, plugin_id, action, params) }` + `table()` 返回 `[StorageService, HostService, ProcService]`；并声明 `pub mod stream;` |

### 1.4 与 ARCHITECTURE.md 的偏差（以代码为准）

| 文档说法 | 实际代码 |
|---|---|
| 前端内核在 `src/core/plugins/` | 实际在 `src/host/` |
| Rust 在 `src/host/{rpc,shortcut,plugins}.rs` | 实际在 `src-tauri/src/services/`，且无 `rpc.rs` |
| 下行 `app.emit("host:<topic>")` → 总线 | **Rust 侧没有任何 `emit`**；热键在**前端**用 global-shortcut 注册；下行总线是纯 JS 的**窗口内** Map |
| 插件热键 `host:hotkey` | 未实现（仅"唤出主窗口"一个热键） |
| 网关按登记表做 Rust 侧权限校验（D4 / P4） | **未实现**；Rust 只校验 plugin id 形状 + service 白名单 |
| PTY 数据走插件 `onData`（v1） | 属实，但 PTY 完全在网关之外（`tauri-plugin-pty` 自有命令 + 回调） |
| `plugins/` 磁盘插件 | 属实 |
| 文档未提及 | `floatwin`（多窗口悬浮窗）、`pluginwin`（外部插件窗口）、`proc` sidecar 服务、`frames.rs` |

---

## 2. 现状：消息通道全清单（问题的核心）

当前项目里同时存在 **9 条消息路径、5 种载体、4 种编码、3 套权限口径、2 套 id 关联策略、2 套生命周期注册表**。

| # | 方向 | 载体 (transport) | 编码 (codec) | 调用面 | 权限校验 | id 关联 | 生命周期归属 |
|---|---|---|---|---|---|---|---|
| 1 | ↑ | `invoke('plugin_rpc')` | JSON 信封 `{pluginId,service,action,params}` | `ctx.rpc` / `storage` / `proc` | JS 侧 `gatedRpc`（`rpc:<service>`） | invoke Promise | 无状态 |
| 2 | ↑ | `invoke` 直连命令 | 位置参数 | `plugin_scan` / `read_entry` / `open_dir` | **无**（仅路径防护） | 无 | 无状态 |
| 3 | ↑↓ | `tauri-plugin-pty` 自有命令 + `onData/onExit` 回调 | **原始字节** `Uint8Array`（4KB 拉取） | `ptyClient`（procman / selftest） | **仅 Tauri ACL**（`pty:default`） | `ptyClient` sid + 回调 | `ptyClient._sessions` |
| 4 | ↑ | `@tauri-apps/api` WebviewWindow / global-shortcut | API 参数 | `ctx.windows` | JS 侧 `win:manage` + ACL | 无 | 窗口由宿主管 |
| 5 | ↓ | **无 IPC**：窗口内 JS Map | JS 对象 | `ctx.events` / `events.emit` | 无 | 无 | 无 |
| 6 | ↓ | **轮询** `plugin_rpc storage.get`（250ms） | JSON | `floatwin-widget.js` | `rpc:storage` | 无（全量覆盖） | 无 |
| 7 | ↓ | `Channel`（设计） | tagged JSON 帧 `{t:data\|end\|error}` | `plugin_stream_open` | 未实现 | 未实现 | 未实现 |
| 8 | ↓ | `Channel`（设计） | **原始帧** 1 字节 kind + payload | PTY 后端 | 未实现 | 未实现 | 未实现 |
| 9 | ↑↓ | **stdio 行** | **行 JSON**（1 行 1 文档） | `ctx.proc.spawn/send/recv` | `rpc:proc`（JS） | **插件自己**（`id` 字段） | `proc` 注册表 `(plugin,key)`，上限 4 |

> 采集时 `git status`：`M services/{mod,proc,storage}.rs`、`?? services/frames.rs`。也就是说 **`trait Service` + `table()` 已经写好，但 `lib.rs` 尚未接入**（仍在 `if service == "proc" {...} else { storage::dispatch(...) }`），且 `pub mod stream;` 指向的 `stream.rs` **还不存在**，`frames.rs` 注释里写的是 `services/streams.rs`（多一个 s）。→ **当前这份代码编译不过**，属于重构进行中的快照。

### 2.1 复杂度来源诊断（"为什么主程序越来越复杂"）

1. **载体与编码被焊死在一起**：`plugin_rpc` 既是载体又是编码；`proc` 既是服务名又隐含"行 JSON"；PTY 干脆自成一国。
2. **网关没有真正收敛**：`Service::dispatch` 签名里没有 service 名，导致 `storage`/`host` 只能共用一个 `dispatch_at` 靠 `self.name()` 兜；`proc` 又用另一套 root（`plugins_root` vs `app_data_dir`）。同一 trait 装两种语义。
3. **"单一闸口"名不副实**：Rust 侧没有登记表权限校验；路径 #2（直连命令）与 #3（PTY）**完全绕过网关**。
4. **下行有四套写法**：同窗口 Map(#5)、跨窗口轮询(#6)、Channel 帧(#7/#8)、PTY 回调(#3)。插件必须按场景记住用哪一套。
5. **生命周期注册表分裂**：`ptyClient._sessions`(#3) 与 `proc` registry(#9) 各管一半；**应用退出只 `proc::kill_all()`，PTY 子进程无人回收 → 孤儿进程**（真实缺陷）。
6. **`action_spawn` 每次都全量扫描 plugins root** 去找插件目录 → 每次 spawn 都是 O(插件数) 的 IO。
7. **单文件 ESM + Blob URL 约束** → 每个窗口是独立 JS 上下文、模块实例不共享（`calc.demo` 只能用 `calc-view` / `calc-win` 两个 proc key 规避串扰），跨窗口状态只能靠轮询。
8. **实验之间不可比**：没有统一的一致性测试，方案 A 与方案 C 无法对照评估。
9. **版本口径不一**：`Cargo.toml` 是 `tauri-plugin-pty = "0.3"`，`package.json` 是 `tauri-pty ^0.2.1`，文档描述的是 0.2.1 的 API。

---

## 3. 统一设计：消息平面（Message Plane）

核心思路：**把"载体"和"编码"拆成两个正交轴，方案 = 两者的组合，用描述符声明；宿主只认识接口，不认识具体方案。**

### 3.1 两个正交轴

```
Transport（载体）         Codec（编码）
├── invoke               ├── json-envelope    {v,kind,id,ch,svc,act,payload}
├── channel              ├── json-tagged      {"t":"data"|"end"|"error"}
├── event (emit/listen)  ├── line-json        1 行 1 JSON 文档
├── stdio (pipe)         ├── raw-binary       1 字节 kind + payload
└── pty                  └── in-process       JS 对象（零序列化）
```

### 3.2 统一信封（上行/下行同一形状）

```
Envelope {
  v:   1,
  kind: "req" | "res" | "err" | "evt" | "data" | "end" | "exit",
  id?:  u64,        // req/res 关联
  ch?:  string,     // 会话/频道 id（stream / session）
  svc?: string,     // 服务名（kind=req）
  act?: string,     // 动作
  payload: JSON | bytes,
  meta?: { seq?, ts?, bytes? }
}
```

- 上行 = `req / res / err`
- 下行 = `evt / data / end / exit`
- 两个方向共用同一信封与同一 codec 实现 → **一套编解码、一套关联逻辑**。

### 3.3 统一会话（Session）

```
Session { id, plugin, kind: "sidecar" | "pty" | "stream",
          state: "starting"|"running"|"exited"|"killed",
          pid?, openedAt, metrics: { bytesIn, bytesOut } }
```

单一 `SessionRegistry` 同时管 sidecar(#9)、PTY(#3)、未来 stream(#7/#8)。
收益：① 退出时**一次 `kill_all()` 覆盖全部**（修掉 PTY 孤儿缺陷）；② 统一的 `list/attach/detach`；③ UI 只需要一个会话列表。

### 3.4 分层架构

```
插件（功能代码）
  └─ ctx / SDK            ← 对外接口面保持不变（storage/events/proc/windows/stream）
       └─ MessageHub       ← 信封编解码 + 路由 + 权限闸口 + SessionRegistry
            └─ TransportRegistry  ← 描述符驱动的查表，无 if/else
                 ├─ rpcTransport      invoke + json-envelope      上行 req/res
                 ├─ channelJson       Channel + json-tagged       下行 push
                 ├─ channelRaw        Channel + raw-binary        下行 push（二进制）
                 ├─ eventBus          emit/listen + json          下行广播（跨窗口）
                 ├─ stdioLine         pipe + line-json            双向（sidecar 数据面）
                 ├─ ptyStream         pty + raw-binary            双向（字节流）
                 └─ inProcess         JS Map + 对象               下行（零 IPC）
```

Rust 侧镜像同一结构：

```
plugin_rpc 网关 ──► Router(table)            ← 控制面：StorageService/HostService/ProcService
plugin_stream_* ──► StreamProvider(table)    ← 数据面：携带 Channel 的独立命令族
                        └─ codec (frames.rs: json-tagged + raw-binary)
                        └─ SessionRegistry（sidecar + pty + stream 统一）
```

> 数据面必须是与 `plugin_rpc` 并列的**独立命令族**（因为要携带 IPC `Channel` 句柄，无法塞进 JSON req/resp 信封）——`services/mod.rs` 里已经写了这个判断，方向是对的。要点是：**它同样是"注册表驱动"，而不是在 `lib.rs` 里堆特判。**

### 3.5 让宿主不膨胀的四条硬规则

1. **查表，禁止特判**：`lib.rs` 里不允许出现 `if service == ...`；一律 `table().iter().find(|s| s.name() == service)`。
2. **编码是数据不是代码**：framing 由描述符里的枚举决定，不是每个功能写一遍。
3. **每个 transport 必备 mock**：沿用 `ptyClient.setBackend('mock')` 的先例，自检与单测不依赖真实进程。
4. **能力协商**：transport 声明 `capabilities { push, pull, binary, ordered, crossWindow }`；功能声明需求；不匹配在**装配期**报错，而不是运行期特判。

### 3.6 统一组织的关键：一致性测试

单一 `transport-conformance.test.mjs`，同一套断言跑遍所有方案：

```
spawn → data 到达 → 背压 → end → exit(code) 精确
错误传播（mid-stream error 帧）
取消 / 清理无泄漏（注册表归零）
权限拒绝在触达 invoke 之前
二进制安全（0x00 / 0xFF / 半个 UTF-8 字符跨 chunk）
跨窗口广播可见
```

方案 A..F 全过 = **可比较、可替换、可回归**。这正是"把不同方案统一组织在一起"的落地方式——组织手段是**测试与描述符**，不是宿主里的分支。

---

## 4. 方案实验矩阵

| 方案 | Transport | Codec | 方向 | 定位 | 现状 |
|---|---|---|---|---|---|
| **A** | `invoke` + `plugin_rpc` | JSON 信封 | ↑↓ req/resp | 控制面（storage / host / proc 控制） | 已实现，待接入 `table()` |
| **B** | stdio 行 | 行 JSON | ↑↓ | sidecar 数据面（插件自带原生后端） | 已实现（`send` + 带超时 `recv`，**pull 模式**） |
| **C** | `Channel` | tagged JSON 帧 | ↓ push | 结构化流事件（进度/日志/结果） | `frames.rs` 骨架已有，`stream.rs` 缺失 |
| **D** | `Channel` | 原始二进制帧 | ↓ push | PTY 字节流（零 JSON 解析开销） | `frames.rs` 的 `raw` 模块已有 |
| **E** | `emit` / `listen` | JSON | ↓ 广播 | **跨窗口总线**（替代 250ms 轮询） | 未实现 |
| **F** | 进程内 `Map` | JS 对象 | ↓ | 同窗口零 IPC | 已实现（`events.js`） |

**待验证的实验假设（建议按此设计对照实验）**

- B 的 pull（`recv` 轮询 + 插件侧 id 关联）vs 新增 push 变体：吞吐 / 延迟 / 代码量对比。
- C vs D：同一 PTY 流下 JSON 帧与原始帧的 CPU 与内存占用差（预期 D 显著优）。
- E vs 轮询(#6)：跨窗口状态同步的延迟与空闲开销（预期 E 在空闲时几乎为零）。
- F vs C：同窗口事件是否有必要过 IPC（预期不必）。

---

## 5. 目标目录结构（toolbox）

```
toolbox/
├── docs/MESSAGE-FRAMEWORK.md          ← 本文
├── src/
│   ├── host/                          ← 从 eyecare/src/host 迁入
│   │   ├── boot.js  lifecycle.js  ctx.js  store.js  debug.js
│   │   ├── registry.js  external.js  pluginwin-host.js
│   │   └── message/                   ← 新增：消息平面
│   │       ├── envelope.js            ← 统一信封 + kind 常量
│   │       ├── hub.js                 ← MessageHub：路由 + 权限闸 + SessionRegistry
│   │       ├── sessions.js            ← 统一会话注册表
│   │       └── transports/
│   │           ├── index.js           ← TransportRegistry（描述符查表）
│   │           ├── rpc.js             ← A
│   │           ├── channelJson.js     ← C
│   │           ├── channelRaw.js      ← D
│   │           ├── eventBus.js        ← E
│   │           ├── stdioLine.js       ← B
│   │           └── inProcess.js       ← F
│   ├── core/ptyClient.js              ← 退化为 ptyStream 的一个 transport
│   └── plugins/…
└── src-tauri/src/
    ├── lib.rs                         ← 只做注册：table() + stream 命令族
    └── services/
        ├── mod.rs                     ← Service trait + table() + StreamProvider
        ├── codec.rs                   ← 由 frames.rs 更名统一（json-tagged + raw-binary）
        ├── session.rs                 ← 统一 SessionRegistry（sidecar + pty + stream）
        ├── stream.rs                  ← 数据面命令族（plugin_stream_open/close）
        ├── storage.rs  external.rs  proc.rs
        └── pty.rs                     ← 自建 portable-pty（P5：Channel 推送 + Job Object）
```

---

## 6. 迁移路径（从 eyecare 到 toolbox，绞杀者模式）

**Phase 1 — 先让它编译并通过现有测试**
- ① `lib.rs` 接入 `table()`，删掉 `if service == "proc"` 特判；
- ② 命名统一：`frames.rs` / `pub mod stream;` / 注释里的 `services/streams.rs` 三处不一致，定为 `codec.rs` + `stream.rs`；
- ③ 补齐 `stream.rs`（或先删掉 `pub mod stream;` 让骨架可编译，再增量加回）。
- 验收：`cargo test`（现有 7 项）+ `node --test tests/`（现有 11 项）全绿。

**Phase 2 — 抽消息平面**
- 落地 `envelope.js` / `hub.js` / `transports/*`；把现有 6 条路径逐个改写为 transport（行为不变，先只换组织方式）。
- `ctx` 对外接口**保持不变** → 插件零改动。
- 验收：自检 8 项 + 新增 conformance 套件全绿。

**Phase 3 — 会话统一**
- `SessionRegistry` 同时纳管 sidecar / PTY / stream；退出时统一清理（**修掉 PTY 孤儿**）。
- 验收：退出应用后任务管理器无残留（含 PTY）。

**Phase 4 — 闸口统一**
- Rust 侧按 manifest 登记表校验 `rpc:<service>`；把直连命令(#2)与 PTY(#3)收进闸口。
- 验收：未声明权限的插件在 Rust 侧也被拒（不只 JS 侧）。

**Phase 5 — 跑实验**
- 用 conformance 套件对照 A..F，产出实验结论，再决定默认方案。

---

## 7. 风险与取舍

| 风险 | 缓解 |
|---|---|
| 抽象层本身变成新的复杂度 | 四条硬规则（§3.5）；抽象只覆盖"载体+编码"，不覆盖业务 |
| 数据面（Channel）无法走 req/resp 信封 | 明确划分为独立命令族，但**同样注册表驱动**；共享同一 codec |
| 逐条改写导致行为回归 | Phase 2 只换组织、不改行为；每步都有既有测试兜底 |
| 权限闸口收紧后误伤已装插件 | 保留"本地自装插件=信任"模型，权限为声明式，先告警后强制 |
| PTY 后端迁移（0.2.1 → 0.3 → 自建） | transport 层隔离后端差异；`ptyClient` 的 DSR 看门狗等 workaround 收敛在 `pty.rs` 内 |

---

## 8. 立即可确认的待办（建议先做这三件）

1. **修编译**：`lib.rs` 接 `table()`；`stream.rs` 缺失 / 命名三处不一致。
2. **修 PTY 孤儿**：`RunEvent::Exit` 目前只 `proc::kill_all()`，PTY 会话无人回收。
3. **统一跨窗口下行**：`floatwin-widget` 的 250ms 轮询换成方案 E，并与 `settings:changed` 事件合并成同一条总线（现在该事件只在同窗口有效，跨窗口是静默失效的）。
