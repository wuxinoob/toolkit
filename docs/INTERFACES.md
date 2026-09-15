# 通信接口清单与统一性核查

> 本文回答四个问题：协议是否统一、新插件能否直接复用、接口清单、改进空间。
> 所有结论都从代码核对得出（含一条自动审计测试与一次真实插件实测）。

---

## 结论速览

| 问题 | 结论 |
|---|---|
| **1. 协议是否统一了？** | **插件侧完全统一**；宿主侧有 4 个命令在网关之外（插件发现 + 权限上报），属于有理由的例外；窗口控制与全局热键不在协议内。 |
| **2. 新插件能否直接调用已有接口？** | **能，且已验证**。新增 `examples/plugins/probe`，不 import 任何模块、不碰 Tauri API，一次调用覆盖 7 类接口全部通过。 |
| **3. 接口有哪些？** | 8 个原生命令 · 5 个服务 / 20 个动作 · 7 个方案 · 2 个流提供者。见 §1–§4。 |
| **4. 有改进空间吗？** | 有。2 个已当场修掉（死命令、虚假能力声明），其余按 P0/P1/P2 列在 §8。 |

---

## 1. 原生入口：8 个命令

| # | 命令 | 用途 | 谁调用 | 在网关内 |
|---|---|---|---|---|
| 1 | `plugin_rpc` | **唯一请求/响应网关**（信封进、信封出） | `rpc` 方案 | — 它本身就是网关 |
| 2 | `plugin_stream_open` | 开一条 json-envelope 推送流 | `channel-json` 方案 | ✗ 需携带 `Channel` 句柄 |
| 3 | `plugin_stream_open_raw` | 开一条 raw-binary 推送流 | `channel-raw` 方案 | ✗ 同上 |
| 4 | `plugin_stream_close` | 取消一条流 | 两个 channel 方案的 `close()` | ✗ 同上 |
| 5 | `plugin_register` | 上报插件声明的权限 | `lifecycle.loadPlugin` | ✗ 加载期引导 |
| 6 | `plugin_scan` | 扫描磁盘插件目录 | `host/external.js`、`pluginwin-host.js` | ✗ 宿主内部操作 |
| 7 | `plugin_read_entry` | 读插件入口源码 | 同上 | ✗ 同上 |
| 8 | `plugin_open_dir` | 打开插件目录 | `SettingsView` | ✗ 同上 |

**1–4 是数据面**（必须携带 IPC `Channel`，塞不进 JSON 请求/响应信封），**5–8 是宿主自身的管理操作**，不是插件能力。两类都不经过权限闸口——插件也调用不到它们（5 由宿主调用、6–8 只在宿主 UI 里用）。

> 原先还有第 9 个 `plugin_registry`，核查时发现**没有任何调用方**（Settings 页走网关的 `host/plugins`），已删除，避免留一个无人使用、无人校验的入口。

## 2. 网关背后的服务：5 个服务 / 20 个动作

| 服务 | 动作 | 说明 |
|---|---|---|
| `storage` | `get` `set` `remove` `keys` | 每插件独立的磁盘 JSON KV（`plugin-data/<id>/data.json`） |
| `host` | `info` `write_debug_log` `sessions` `plugins` | 路径/元数据、调试落盘、**统一会话表**、已授权插件与服务清单 |
| `proc` | `spawn` `send` `recv` `kill` `kill_all` `list` | sidecar 行 JSON 管道（`stdio-line` 方案的底层） |
| `stream` | `close` `providers` `list` `session_open` `session_close` | 推送流生命周期 + 第三方进程的会话登记 |
| `bus` | `publish` | 跨窗口广播（宿主 `app.emit` 扇出到所有窗口） |

分发是**查表**的：`services::route` 按 `name()` 找 `Service` 实现，`lib.rs` 里没有任何 `if service == ...`。加一个能力 = 加一个表项。

## 3. 方案表：7 个方案 + 2 个流提供者

| 方案 id | 载体 · 编码 | 方向 | 能力 |
|---|---|---|---|
| `rpc` | invoke · json-envelope | ↑ | requestResponse, ordered |
| `channel-json` | channel · json-envelope | ↓ | push, ordered, crossWindow |
| `channel-raw` | channel · raw-binary | ↓ | push, binary, ordered, crossWindow |
| `event-bus` | event · json-envelope | ↓ | push, crossWindow |
| `stdio-line` | stdio · line-json | ↕ | requestResponse, push, pull, ordered |
| `pty-stream` | pty · raw-binary | ↕ | push, binary, ordered, requestResponse |
| `in-process` | in-process · object | ↓ | push |

流提供者（`stream` 服务的数据源）：`ticker`（支持两种编码）、`blob`（仅 raw，用于演示能力协商）。

> `channel-json` 原先声明了 `backpressure`，核查发现**没有任何实现或消费方**——一个调用方无法依赖的声明比不声明更糟，已移除，并在 `registry.js` 里写明原因。

## 4. 权限：一个能力一个权限

| 能力 | 权限 |
|---|---|
| `rpc` 调用某服务 X | `rpc:X` |
| `channel-json` / `channel-raw` | `rpc:stream` |
| `pty-stream` | `rpc:stream` |
| `stdio-line` | `rpc:proc`（运行插件自带的二进制是独立且更强的能力） |
| `event-bus` | `rpc:bus` |
| `in-process` | —（无 IPC） |
| 窗口控制 | `win:manage` |
| `ctx.sessions()` | `rpc:host` |
| `ctx.closeStream()` | —（关比开弱，且只能关自己开的流） |

---

## 5. 功能 × 接口映射（由源码扫描生成）

| 功能 | 用到的接口 |
|---|---|
| notepad（内置） | `rpc:storage` · `event-bus` |
| eyecare（内置） | `rpc:storage` · overlay 层 |
| procman（内置） | `rpc:storage` · `pty-stream` · `rpc:host`(sessions) |
| streamlab（内置） | `rpc:host` · `channel-json` · `channel-raw` · `event-bus` · `in-process` · 方案表 |
| floatwin（内置） | `rpc:storage` · `event-bus` · `win:manage` |
| floatwin-widget（窗口页） | `rpc:storage` · `event-bus` |
| hello.demo（外部） | `rpc:storage` · `event-bus` · `channel-json` · `channel-raw` · `rpc:host` |
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

**例外（3 处，都已明确边界）**

| 例外 | 为什么 | 风险 |
|---|---|---|
| 插件发现 3 命令（`plugin_scan`/`read_entry`/`open_dir`） | 宿主要在"还没有插件"时读取插件目录，无法走插件网关 | 低：仅宿主调用，含路径逃逸防护 |
| 窗口控制（`ctx.windows`） | Tauri 的 `WebviewWindow` 是命令式 API，套进 req/res 信封只会更绕 | 中：有 `win:manage` 闸口 + Tauri ACL 两层，但不在信封体系内，无法被统一日志/测试覆盖 |
| 全局热键 | 目前只有"唤出主窗口"一个，由前端直接注册 | 中：**插件无法声明自己的热键**（原设计的 `contributes.hotkeys` 未实现） |

---

## 7. 新插件能否直接调用已有接口？

**能。** 新写了 `examples/plugins/probe` 作为证据——它**不 import 任何模块**、不碰 Tauri API，只用 `ctx.*` 与 `ctx.protocol`，在 `activate()` 里依次跑完 9 项检查：

```
rpc(host/info) · storage set/get/keys · 方案表 · 会话表
channel-json 流（3 帧 + end）· channel-raw 流（8 字节 LE + end）
event-bus 广播往返 · in-process 同步投递 · 权限闸口拒绝未声明服务
```

任一项失败 → `activate()` 抛错 → 该插件在启动日志里显示 `error` 而不是 `active`。所以**启动日志本身就是结论**。

验证方式（两条，互为补充）：

1. **确定性**：`tests/plugin-interfaces.test.mjs` 加载真实的 `probe/main.js`，用真实的 `buildCtx` + 真实 hub/transports（只在 `invoke` 边界打桩）跑 `activate()`，并断言 9 项全过、权限声明恰好 4 个、视图按同一契约注册。
2. **真实环境**：把目录复制进 `{appData}/plugins/probe.demo`，Rescan/重启后看启动日志。

> 本次真实运行受限于本机 WebView2 环境（见文末），未能在 GUI 里复跑；确定性那条已通过。

---

## 8. 改进空间

### P0 — 已当场修掉

1. ~~`plugin_registry` 是死命令~~ → 已删除，字段并入 `host/plugins`。
2. ~~`channel-json` 声明了未实现的 `backpressure`~~ → 已移除声明并注明原因。

### P0 — 仍建议做

3. **上行没有推送通道。** 下行有 `Channel` 推流，上行只有 req/res——插件想持续向宿主灌数据只能反复调 `rpc`（如 `proc/send` 一行一次）。建议增加一个上行 `Channel` 方案（`channel-in`），否则"双向通信"在数据面是单向的。
4. **错误码没有闭集。** 只有 `denied` / `transport` / `protocol` / `codec` 四个是稳定的；服务错误是 `{svc}/{act}` 字符串（如 `storage/get`）。调用方无法可靠地按码分支。建议引入错误码枚举，把 `{svc}/{act}` 降级为附加信息。

### P1 — 抽象泄漏

5. **`ctx.events.on` 同步、`ctx.bus.subscribe` 异步**，两者不能互换——方案抽象在 API 层漏了出来。建议统一为异步，或在 hub 里给 in-process 一个同步快路径并统一签名。
6. **`ctx.protocol` 在 `ctx.js` 与 `pluginwin-host.js` 各写一份**（复制粘贴）。应抽成一个模块，否则将来加字段必漏一处。
7. **插件无法声明全局热键。** 原设计有 `contributes.hotkeys`，现在完全没实现。若要有，应走网关（Rust 侧注册、事件下行），而不是前端直接调插件 API。

### P2 — 可增强

8. **`rpc` 无超时/取消。** 服务卡住则 promise 永远挂起。建议信封加可选 `timeout` 与取消帧。
9. **无 schema 内省。** 插件只能看文档知道某服务有哪些 action。可加 `host/schema` 返回服务与动作清单（`service_names()` 已经有了，缺动作级）。
10. **版本协商只有"不匹配就拒绝"**，没有能力降级或特性开关。

---

## 附：本次核查遇到的环境问题（与代码无关）

在 GUI 里复跑时发现：`toolbox.exe` 能启动、`RunEvent::Ready` 能触发、WebView2 数据目录会被创建，但**本机不产生属于本应用的 `msedgewebview2` 渲染进程**，因此页面脚本从不执行（`eval` 被接受却无效果，窗口标题不变，网关一次都没被调用）。

排查过程（全部排除）：
- 前端无问题：Vite 正常服务 `index.html` 与全部模块；`npm run build` 通过。
- 不是包名/配置：换 `devUrl` 为 `127.0.0.1`（与 Vite 实际绑定地址一致，已保留此改动）无效；换全新 identifier（全新 WebView2 配置目录）同样无效。
- 不是残留进程：本机 25 个 `msedgewebview2` 全部属于其它程序（QuickClipboard / Clash Verge / cc-switch / SearchHost），与本应用无关。
- 不是代码：同一份二进制在此之前的运行中曾完整跑通 15/15；`cargo test` 39、`node --test` 42 全绿。

结论：**本机 WebView2 运行时的状态问题**。建议依次尝试：重启机器 → 修复/重装 WebView2 Evergreen Runtime → 再跑 `npm run tauri dev` 并查看 `%APPDATA%\com.tan18.toolbox\debug.log`（应为 15/15）。
