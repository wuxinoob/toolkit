# 通信接口清单与统一性核查

> 本文回答四个问题：协议是否统一、新插件能否直接复用、接口清单、改进空间。
> 所有结论都从代码核对得出（含一条自动审计测试与一次真实插件实测）。

---

## 结论速览

| 问题 | 结论 |
|---|---|
| **1. 协议是否统一了？** | **插件侧完全统一**；13 个命令里只有 `plugin_rpc` 是网关，另外 4 个是**插件可调但必须裸命令**的（3 个流 + 原生对话框，各自设闸），其余 8 个是宿主自己的管理操作；窗口控制不在协议内（热键已收敛进 `hotkey` 服务）。 |
| **2. 新插件能否直接调用已有接口？** | **能，且已验证**。`examples/plugins/probe` 不 import 任何模块、不碰 Tauri API，一次调用覆盖 11 项接口全部通过。 |
| **3. 接口有哪些？** | 13 个原生命令 · 9 个服务 / 36 个动作 · 8 个方案 · 3 个流提供者。见 §1–§4。 |
| **4. 有改进空间吗？** | 有。**P1、P2 与 P0 两项均已完成**（见 §8）。剩余的是结构性例外与后续增强，不再是缺口。 |

---

## 1. 原生入口：13 个命令

| # | 命令 | 用途 | 谁调用 | 在网关内 | 闸口 |
|---|---|---|---|---|---|
| 1 | `plugin_rpc` | **唯一请求/响应网关**（信封进、信封出） | `rpc` 方案 | — 它本身就是网关 | `rpc:<svc>` |
| 2 | `plugin_stream_open` | 开一条 json-envelope 推送流 | `channel-json` 方案 | ✗ 需携带 `Channel` 句柄 | `rpc:stream` + 提供者自己的 |
| 3 | `plugin_stream_open_raw` | 开一条 raw-binary 推送流 | `channel-raw` 方案 | ✗ 同上 | 同上 |
| 4 | `plugin_stream_close` | 取消一条流 | 两个 channel 方案的 `close()` | ✗ 同上 | `rpc:stream` |
| 5 | `plugin_dialog` | 原生对话框（`ctx.files.pick/save/message`） | `ctx.js` | ✗ 不是网关动作 | `rpc:dialog`（**自设**） |
| 6 | `plugin_register` | 上报插件声明的权限 | `lifecycle.loadPlugin` | ✗ 加载期引导 | — |
| 7 | `plugin_reap_orphans` | 杀掉上一次前端上下文遗留的宿主侧会话 | `boot()` | ✗ 宿主内部操作 | 仅主窗口 |
| 8 | `plugin_scan` | 扫描磁盘插件目录（读 manifest **+ 每个入口文件**算 digest） | `host/external.js` | ✗ 同上 | — |
| 9 | `plugin_info` | 按 id 查**一个**插件的位置（只读 manifest） | `pluginwin-host.js` | ✗ 同上 | — |
| 10 | `plugin_read_entry` | 读插件入口源码 | 同上 | ✗ 同上 | — |
| 11 | `plugin_open_dir` | 打开插件目录 | `SettingsView` | ✗ 同上 | — |
| 12 | `host_autostart_get` | 读开机自启状态 | `SettingsView` | ✗ 同上 | 仅主窗口 |
| 13 | `host_autostart_set` | 设置开机自启（返回 OS 的**实际**状态，不是请求值） | `SettingsView` | ✗ 同上 | 仅主窗口 |

**1–5 是数据面**（要携带 IPC `Channel`，或必须在同步网关上做异步的事），**6–13 是宿主自身的管理操作**，不是插件能力 —— 插件也调用不到它们。

**两类用的不是同一种闸口，这是刻意的**：数据面的闸口是**权威**的（Rust `host/registry.rs`，fail-closed），因为插件能绕过 `ctx` 直接 `invoke`；管理操作只由宿主自己的代码调用，用的是 `require_main`（窗口 label 检查）—— 防的不是恶意插件，而是**第二个前端上下文**（窗口分发的规则见 `src/main.js`）。

**「仅主窗口」的 3 条**（`plugin_reap_orphans` / `host_autostart_get` / `host_autostart_set`）共用同一个 `require_main`：它们的后果都是**全局**的（杀会话、改注册表的自启项），而 `pluginwin.html` 里如果跑起了宿主就会再调一次。

> `plugin_info` 存在的唯一理由是**成本**：插件窗口以前调 `plugin_scan` 再 `.find()` 自己要的那个，
> 于是开一个窗口要读遍插件目录里**所有** manifest **和所有入口文件**（本仓库实测 ~900KB），
> 只为拿一个 `dir` + `entry_file` —— 而主窗口启动时早就知道。见 §1.2。

> `plugin_dialog` 之所以是**裸命令**而不是网关动作：`blocking_pick_file()` 需要主线程的消息循环
> 来泵消息，而同步命令就在那条线程上 —— 在那里等一个模态框会**死锁**。所以它自己用同一句
> `host::registry::is_allowed(&plugin_id, "rpc:dialog")` 设闸，和其他入口一样 fail-closed。

> 原先还有一个 `plugin_registry`，核查时发现**没有任何调用方**（Settings 页走网关的 `host/plugins`），已删除，避免留一个无人使用、无人校验的入口。

### 1.1 全部命令都是 `async fn` —— 这不是风格，是硬要求

**Tauri 把没有 `async` 关键字的命令跑在主线程上**，而主线程就是给**所有**窗口泵消息的那一条：

> "Async commands are executed on a separate async task using `async_runtime::spawn`.
> Commands without the *async* keyword are executed on the main thread unless
> defined with `#[tauri::command(async)]`." —— Tauri v2 文档

所以一个同步命令只要做了阻塞 I/O，卡住的不只是调用它的那个窗口，而是**整个应用**：
不能拖拽、不能重绘、不能处理输入。**而症状永远不是"某个命令阻塞了"，是"界面卡"** ——
和十几种别的原因长得一模一样。

**真实事故**：`plugin_rpc`（每个插件调用都过的网关）原本是普通 `fn`，而它背后的服务
做的是阻塞文件 I/O —— `storage/*` 读写整个 store、`host/write_debug_log` 每行开关一次
文件、`bus/publish` 向每个窗口投递。结果是主窗口发涩、插件窗口一起发涩，因为**是同一个
线程在做这些**。`plugin_scan` 更重：它遍历插件目录并读**每个插件的完整入口文件**
（算 digest 要字节），在启动时和**每次开插件窗口时**各跑一遍。

现在的规则是统一的，不逐条判断"这个够不够便宜"：

1. **每个 `#[tauri::command]` 都必须是 `async fn`**（或 `#[tauri::command(async)]`）。
2. **做 I/O 的命令再走一层 `spawn_blocking`** —— `async` 只是把工作挪出主线程，
   而阻塞调用会占住一个 runtime worker，worker 数量等于核数：一串 storage 调用
   就会饿死应用里其他 async 任务，那是同一个 bug 换顶帽子。阻塞池才是它该待的地方。

两条都由 `tests/main-thread.test.mjs` 机器把关（第 1 条扫全部命令，第 2 条盯
`plugin_rpc` / `plugin_scan` / `plugin_info` / `plugin_read_entry`）。
**加新命令时它会替你记住这件事。**

### 1.2 开一个插件窗口要付多少

窗口的开启成本由**三件不相干的事**决定，三边都量过（本仓库实测）。

**① 这个窗口加载多少 JS。** 入口曾把 `App.vue` **静态**导入，而静态导入是每个窗口都要
**取、解析、求值**的 —— 包括永远不挂载外壳的插件窗口。它为此付了 `App.vue` 拉进来的
整张图（外壳 + ViewHost + SettingsView + 整个 `components/ui/` + toaster + tooltip）。
改成动态导入后：

| | 之前 | 之后 |
|---|---|---|
| 插件窗口加载的 JS | **782.3 KB**（24 chunks） | **42.6 KB**（5 chunks） |
| 主窗口加载的 JS | 534.9 KB | 534.9 KB（不变） |

**② 这个窗口加载多少 CSS。** 一个页面的样式表是 `<link>`，**在任何模块运行前生效**，
所以它只能在**页面**这一层选 —— JS 里怎么分支都拦不住。于是拆成两个页面：`index.html`
（外壳）引 `app.css`，`pluginwin.html`（插件窗口）**不引任何样式表**。

| CSS 层 | 字节 | 插件窗口需要吗 |
|---|---|---|
| `utilities`（Tailwind 工具类） | 122,313 | ❌ 插件**根本用不了**（源码在项目外，Tailwind 扫不到） |
| 未分层：`vue-sonner` | 22,451 | ❌ toaster 只在外壳里 |
| `components`（64 个 `.tb-*`） | 12,160 | ❌ 见下：窗口最终一份都没要 |
| `base` + `theme` + `properties` | 9,020 | ❌ 同上 |

| | 之前 | 之后 |
|---|---|---|
| 插件窗口加载的 CSS | **166 KB** | **0 KB** |

**合计：948 KB → 42 KB。** 中间还有一步：把共享的
`src/assets/design-system.css`（令牌 + `.tb-*`）留给插件窗口，窗口降到 19 KB。
**那 19 KB 后来也删掉了**（2026-09-29）—— 它的 preflight 落在无层，反过来压过与它
同船交付的 `.tb-*`；而仓库里两个真实的插件窗口都自带 reset 与配色，没人需要它。
一个插件窗口现在是一张白纸，样式由插件自己负责。

**③ 这个窗口要读多少磁盘。** 插件窗口曾调 `plugin_scan` 再 `.find()` 自己要的那个 ——
而 `plugin_scan` 为了算 digest 会读**每个插件的完整入口文件**。本机装的 10 个插件
入口合计 **918 KB**（`moment-notes` 一个就 674 KB），全读一遍只为拿一个 `dir`。
`plugin_info` 只读 manifest（每个 ~300 字节）并在命中处停下。

**这三条都不是"优化"，是"别做无关的事"** —— 把不属于插件窗口的模块/样式/文件排除出它的路径。
**判断标准是「这个窗口真的需要它吗」**，不是「快一点」。

## 2. 网关背后的服务：9 个服务 / 36 个动作

| 服务 | 动作 | 说明 |
|---|---|---|
| `storage` | `get` `set` `remove` `keys` | 每插件独立的磁盘 JSON KV（`plugin-data/<id>/data.json`） |
| `host` | `info` **`paths`** `write_debug_log` `sessions` **`stop_session`** `plugins` `schema` `unregister` | 路径/元数据、**常用目录（软件 + 系统文件夹）**、调试落盘、**统一会话表**、**按会话停止（仅宿主）**、已授权插件、**能力协商面**、**撤销授权**（仅宿主可调） |
| `proc` | `spawn` `send` `recv` `kill` `kill_all` `list` | sidecar 行 JSON 管道（`stdio-line` 方案的底层） |
| `stream` | `close` `providers` `list` `session_open` `session_close` `open_in` `write_in` `close_in` | 推送流生命周期 + 第三方进程的会话登记 + **上行流**（插件按批把帧推给宿主侧 sink） |
| `bus` | `publish` | 跨窗口广播（宿主 `app.emit` 扇出到所有窗口） |
| `hotkey` | `register` `unregister` `unregister_all` `list` | 全局热键，**由宿主代插件注册**（`contributes.hotkeys`） |
| `notify` | `send` | **操作系统**通知（动作中心/通知中心）。与 `ctx.ui.notify` 的站内 toast 是两回事：toast 只在用户看着这个窗口时有用 |
| `clipboard` | `read` `write` | 系统剪贴板文本。**变化监听不是动作** —— 它是流（见 §3 的 `clipboard` 提供者） |
| `screen` | `monitors` `capture` | 枚举显示器 + 截屏。`capture` 返回 base64 PNG（网关最重的载荷） |

分发是**查表**的：`services::route` 按 `name()` 找 `Service` 实现，并用该服务自己声明的
`actions()` 先校验动作，`lib.rs` 里没有任何 `if service == ...`。加一个能力 = 加一个表项。

> 动作清单是**权威**的而不是文档：`host/schema` 直接由同一份 `actions()` 生成，所以
> "告诉插件存在什么"与"网关实际接受什么"不可能漂移。

### 为什么 `host/stop_session` 必须另开一个门

`stream/close` 是按**调用者的插件 id** 定位会话的（`session::stop_one(plugin, ch)`）。
对插件来说这是对的默认值 —— 一个插件不该停掉别人的活。但设置页是以 `__host__` 的身份
问的，**永远匹配不到插件的会话**，所以「停掉这一条」需要一个宿主侧的门。

`rpc:host` 是**发给插件**的，而 `host` 服务此前只有读动作（`info`/`sessions`/`plugins`/
`schema`）加一个日志写。`stop_session` 会杀掉别的插件的进程 —— 所以它和 `unregister`
一样按**宿主身份**门禁。**一个读授权悄悄变成写权力，正是权限模型腐烂的方式。**
`tests/host-kernel.test.mjs` 盯着这两个动作的门禁。

## 3. 方案表：8 个方案 + 3 个流提供者

| 方案 id | 载体 · 编码 | 方向 | 能力 |
|---|---|---|---|
| `rpc` | invoke · json-envelope | ↑ | requestResponse, ordered |
| `channel-in` | **invoke（批量）** · json-envelope | **↑** | **uplink**, ordered |
| `channel-json` | channel · json-envelope | ↓ | push, ordered, crossWindow |
| `channel-raw` | channel · raw-binary | ↓ | push, binary, ordered, crossWindow |
| `event-bus` | event · json-envelope | ↓ | push, crossWindow |
| `stdio-line` | stdio · line-json | ↕ | requestResponse, push, pull, ordered |
| `pty-stream` | pty · raw-binary | ↕ | push, binary, ordered, requestResponse |
| `in-process` | in-process · object | ↓ | push |

流提供者（`stream` 服务的数据源）：`ticker`（支持两种编码）、`blob`（仅 raw，用于演示能力协商）、
`clipboard`（json，轮询检测剪贴板变化）。

### 提供者可以要求自己的权限

`rpc:stream` 的意思是「我能开一条流」—— 对 pty、sidecar、ticker 来说这就够了。
但 `clipboard` 提供者的**数据**比这敏感得多：监听剪贴板等于读取用户复制的**一切**。
让它搭 `rpc:stream` 的便车，就是**没人改过任何权限、权限却悄悄变宽了**。

所以 `StreamProvider` 有一个 `permission()`：声明了就**额外**校验（`clipboard` → `rpc:clipboard`），
没声明（默认）表示它的数据就是 `rpc:stream` 所描述的东西。
`host/schema` 的 `providerPermissions` 公布这张表 —— 插件可以**问**，而不是靠被拒绝去发现。

> **形状规则**：拉取用 service（一次问答），推送用 stream 提供者（宿主主动告知）。
> 这就是为什么 `screen/capture` 是动作而 `clipboard` 的变化监听是流 —— 同一件事的两种方向。
上行 sink（`channel-in` 的宿主侧消费者）：`proc`（每帧写成一行 line-json 送到 sidecar 的 stdin）。

> `channel-json` 原先声明了 `backpressure`，核查发现**没有任何实现或消费方**——一个调用方无法依赖的声明比不声明更糟，已移除，并在 `registry.js` 里写明原因。

## 4. 权限：一个能力一个权限

| 能力 | 权限 |
|---|---|
| `rpc` 调用某服务 X | `rpc:X` |
| `channel-json` / `channel-raw` | `rpc:stream` |
| `pty-stream` | `rpc:stream` |
| `stdio-line` | `rpc:proc`（运行插件自带的二进制是独立且更强的能力） |
| `event-bus` **发布** | `rpc:bus` |
| `event-bus` **订阅** | —（被动监听不构成能力） |
| `in-process` | —（无 IPC） |
| 窗口控制 | `win:manage` |
| `ctx.sessions()` / `ctx.schema()` / `ctx.paths()` | `rpc:host` |
| `ctx.closeStream()` | —（关比开弱，且只能关自己开的流） |
| `contributes.hotkeys` 声明的热键 | —（清单条目本身就是声明） |

---

## 5. 功能 × 接口映射（由源码扫描生成）

| 功能 | 用到的接口 |
|---|---|
| procman（内置） | `rpc:storage` · `pty-stream` · `rpc:host`(sessions) |
| streamlab（内置） | `rpc:host` · `channel-json` · `channel-raw` · `event-bus` · `in-process` · 方案表 |
| eyecare.demo（外部） | `rpc:storage` · overlay 层 · 多窗口 · `stdio-line`(sidecar) |
| fileprobe.demo（外部） | `rpc:dialog` · `rpc:notify` · `rpc:host` |
| calc.demo（外部） | `stdio-line`(经 `ctx.sidecar`) · `rpc:host` · `win:manage` |
| probe.demo（外部） | 上述全部（除 pty / stdio） |
| 宿主内核（lifecycle/external） | `plugin_register` · `plugin_scan` · `plugin_read_entry` |
| 宿主设置页 | `plugin_open_dir` · 网关 `host/plugins` |
| 应用内自检 | `rpc:*` · `channel-json` · `channel-raw` · `event-bus` · `in-process` · `stdio-line` · `pty-stream` |

---

## 6. 统一性核查：结论与例外

**统一的部分（有测试强制）**

- **插件侧 100% 统一**：没有任何插件 `import` Tauri API、直接 `invoke()` 或自己 `new Channel()`。这条由 `tests/plugins.test.mjs` 的静态审计强制，违反即测试失败。
- **一个信封**：上行 `req → res|err`，下行 `evt` / `data|end|exit|err`，两侧共用同一套构造器与校验规则。
- **加方案不改宿主**：`transports/index.js` 启动时断言"声明的方案都有实现"；`registry.js` 是唯一把方案 id 绑到实现的地方。

**例外（都已明确边界）**

| 例外 | 为什么 | 风险 |
|---|---|---|
| 插件发现 4 命令（`plugin_scan`/`plugin_info`/`plugin_read_entry`/`plugin_open_dir`） | 宿主要在"还没有插件"时读取插件目录，无法走插件网关 | 低：仅宿主调用，含路径逃逸防护 |
| 原生对话框（`plugin_dialog`） | 模态框需要主线程泵消息，而同步命令就在那条线程上 → 走网关会**死锁** | 低：自己设 `rpc:dialog` 闸；拿到的只是用户在看得见的对话框里选中的路径 |
| 窗口控制（`ctx.windows`） | Tauri 的 `WebviewWindow` 是命令式 API，套进 req/res 信封只会更绕 | 中：有 `win:manage` 闸口 + Tauri ACL 两层，但不在信封体系内，无法被统一日志/测试覆盖。**另有一处已知缺口：`control` 不校验窗口归属**（插件 A 能改插件 B 的窗口） |
| 开机自启 2 命令（`host_autostart_get/set`） | 写的是 OS 注册表，不是插件能力 | 低：仅主窗口 + 仅 `SettingsView` 调用 |
| 遗留会话回收（`plugin_reap_orphans`） | 前端重载后宿主还活着，上次 boot 的会话仍握着真实进程 | 低：仅主窗口，且在任何东西开会话**之前**调用 |

> **全局热键已不在例外里。** 它曾经是：「只有唤出主窗口一个，由前端直接注册，插件无法声明自己的热键」。
> 现在 `contributes.hotkeys` + `hotkey` 服务 + `ctx.onHotkey` 都在，宿主在 `activate()` **之前**代插件注册、
> `deactivate()` 时释放，按键以 `evt` 信封投递到 `hotkey:<action>`，宿主自己那一条也走同一个服务。
> 见 §8 的 P1-3。

---

## 7. 新插件能否直接调用已有接口？

**能。** 新写了 `examples/plugins/probe` 作为证据——它**不 import 任何模块**、不碰 Tauri API，只用 `ctx.*` 与 `ctx.protocol`，在 `activate()` 里依次跑完 **11 项**检查：

```
rpc(host/info) · storage set/get/keys · 方案表 · 会话表 · host/schema（协商面）
channel-json 流（3 帧 + end）· channel-raw 流（8 字节 LE + end）
event-bus 广播往返 · in-process 同步投递
热键：声明的那条能读回来 · 权限闸口拒绝未声明服务
```

任一项失败 → `activate()` 抛错 → 该插件在启动日志里显示 `error` 而不是 `active`。所以**启动日志本身就是结论**。

验证方式（两条，互为补充）：

1. **确定性**：`tests/plugin-interfaces.test.mjs` 加载真实的 `probe/main.js`，用真实的 `buildCtx` + 真实 hub/transports（只在 `invoke` 边界打桩）跑 `activate()`，并断言每一项接口都被走到、权限声明恰好 5 个（`rpc:storage` / `rpc:host` / `rpc:stream` / `rpc:bus` / `rpc:hotkey`）、视图按同一契约注册。
2. **真实环境**：把目录复制进 `{appData}/plugins/probe.demo`，Rescan/重启后看启动日志。

> 步骤数刻意写成**下界**（`total >= 8`）而不是精确值：`passed === total` 对「只跑了一步就停下」的
> sweep 是**平凡成立**的，所以需要一句话说明「步骤够多」，而下界是那个不需要每次加步骤就改的版本。
> （它已经悄悄落后过一次：这里曾写「9 项」，而插件跑的是 11 项。）

> 本次真实运行受限于本机 WebView2 环境（见文末），未能在 GUI 里复跑；确定性那条已通过。

---

## 8. 改进空间

### 已完成（本轮 P1 + P2）

| # | 原问题 | 处理 |
|---|---|---|
| P1-1 | `ctx.events.on` 同步 vs `ctx.bus.subscribe` 异步，方案抽象泄漏到 API 形状 | **统一**：`subscribe` / `once` / `publish` 在所有方案上都是异步，`ctx.events` 与 `ctx.bus` 只差默认方案；底层统一为 `hub.subscribe/publish(…, {scheme})` |
| P1-2 | `ctx.protocol` 在 `ctx.js` 与 `pluginwin-host.js` 各复制一份 | 抽成 `protocol/contract.js`，两处共用并 `Object.freeze`，加字段不会漏一处 |
| P1-3 | 插件无法声明全局热键（原设计 `contributes.hotkeys` 未实现） | 新增 `hotkey` 服务 + `ctx.onHotkey(action, fn)`；宿主在 activate 时**代插件注册**、deactivate 时释放；按键以 `evt` 信封投递到 `hotkey:<action>`；冲突只告警不致命 |
| P2-4 | `rpc` 无超时/取消 | `ctx.rpc(..., { timeoutMs })`，默认 45s，`0` 表示不限；在**传输层**强制并给出 `timeout` 错误码 |
| P2-5 | 无 schema 内省 | `host/schema` + `ctx.schema()`：协议版本 / 服务与动作 / 流提供者 / 方案表 |
| P2-6 | 版本协商只有"不匹配就拒绝" | 与 P2-5 合并：**先问后做**（`ctx.schema()` 即协商面），而不是靠失败去发现 |

顺带的两处收紧：
- **动作校验进网关**：`Service::actions()` 声明 + 网关先校验再分发，错误信息直接列出合法动作。
- **观察不等于能力**：订阅 / 读自己的热键 / 关闭自己开的流都不再需要权限；只有"发布到所有窗口""运行自带二进制""控制窗口"这类越出插件边界的动作才带权限。

### 仍待处理

**P0 — 已完成错误码闭集**

8. ~~**错误码没有闭集。**~~ → **已完成**：14 个码的闭集（`protocol/codes.rs` + JS 镜像），
   服务错误不再报 `{svc}/{act}`，`host/schema` 与 `ctx.protocol.Code` 都公布词表，
   并有跨语言漂移测试保证两份声明一致。详见 `docs/PROTOCOL.md` §6「Error codes」。

**P0 — 上行流已完成（附带一个必须说明的框架限制）**

7. ~~**上行没有推送通道。**~~ → **已完成**：新增 `channel-in` 方案 + `ctx.uplink(ch, {sink})`，
   提供与其他流同形的句柄（`send` / `close`）外加 `sendBatch` —— 1000 帧由 1000 次往返
   变成 1 次。帧经校验后交给命名的宿主侧 **sink**（首个是 `proc`：每帧写成一行
   `line-json` 送到 sidecar 的 stdin），sink 名单由 `host/schema` 公布。
   **限制**：Tauri 的 `Channel` 是单向的（JS 侧只有接收回调，没有 `send`），框架不提供
   插件→宿主的推送载体，所以载体是**批量 invoke** 而不是 Channel。API 形状仍是流，
   缺的是真正的推送载体 —— 这是框架约束，不是设计选择，已在 `docs/PROTOCOL.md` 写明。

**P2（剩余）**

9. **超时无法真正取消。** 目前只是调用方停止等待，宿主仍会做完。对同步服务无解；若将来服务改成异步，可在信封加 `deadline` 由宿主真正放弃。
10. **无 schema 的字段级信息。** `host/schema` 只到"有哪些动作"，不含参数形状；插件仍需看文档。

### 结构性例外（未变）

| 例外 | 为什么 | 风险 |
|---|---|---|
| 插件发现 3 命令（`plugin_scan` / `plugin_read_entry` / `plugin_open_dir`） | 宿主要在"还没有插件"时读取插件目录 | 低：仅宿主调用，含路径逃逸防护 |
| 窗口控制（`ctx.windows`） | Tauri 的 `WebviewWindow` 是命令式 API | 中：有 `win:manage` + ACL 两层，但不在信封体系内 |
| 全局热键的**注册** | 必须由 Rust 侧持有 OS 句柄 | 低：已收敛到 `hotkey` 服务，且只有宿主能代注册 |

---

## 附：本次核查遇到的环境问题（与代码无关）

在 GUI 里复跑时发现：`toolbox.exe` 能启动、`RunEvent::Ready` 能触发、WebView2 数据目录会被创建，但**本机不产生属于本应用的 `msedgewebview2` 渲染进程**，因此页面脚本从不执行（`eval` 被接受却无效果，窗口标题不变，网关一次都没被调用）。

排查过程（全部排除）：
- 前端无问题：Vite 正常服务 `index.html` 与全部模块；`npm run build` 通过。
- 不是包名/配置：换 `devUrl` 为 `127.0.0.1`（与 Vite 实际绑定地址一致，已保留此改动）无效；换全新 identifier（全新 WebView2 配置目录）同样无效。
- 不是残留进程：本机 25 个 `msedgewebview2` 全部属于其它程序（QuickClipboard / Clash Verge / cc-switch / SearchHost），与本应用无关。
- 不是代码：同一份二进制在此之前的运行中曾完整跑通 15/15；`cargo test` 39、`node --test` 42 全绿。

结论：**本机 WebView2 运行时的状态问题**。建议依次尝试：重启机器 → 修复/重装 WebView2 Evergreen Runtime → 再跑 `npm run tauri dev` 并查看 `%APPDATA%\com.tan18.toolbox\debug.log`（应为 15/15）。
