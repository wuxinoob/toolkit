# toolbox — 项目长期笔记

## 项目定位
- 本仓库目录 `D:\code\rust\toolkit`（**目录名保留 toolkit，不要改**），应用名 **Toolbox**，identifier **`com.tan18.toolbox`**。
  - 曾用 identifier `com.tan18.toolkit`，与旧程序 eyecare 冲突（共享应用数据目录），已更名。
- 重构来源：`D:\code\rust\eyecare\eyecare`（旧形态）。旧文档 `eyecare/docs/ARCHITECTURE.md` **只作参考，与代码明显不符**；判断以实际代码为准。

## 重构主题（用户明确目标）
统一前后端插件之间的**消息传递框架**。范围：多子进程管理、插件进程生命周期 IO、多种 IO 消息类型、命令行子进程流式字符传递、前后端双向通信。
要求：**用不同方案做实验，并把不同方案统一组织在一起，而不是平白增加主程序复杂度。**

## 已落地的架构（不要倒退）
- **两正交轴**：transport（invoke/channel/event/stdio/pty/in-process）× codec（json-envelope/line-json/raw-binary/object）。方案 = 两者组合，登记在 `src/protocol/registry.js`。
- **一个信封**：`{v,kind,id,ch,svc,act,topic,code,msg,p}`，kind ∈ req/res/err/evt/data/end/exit。JS 与 Rust 各一份镜像，校验规则只写一处。
- **四条硬规则**：① 宿主只查表不特判（`lib.rs` 内禁止 `if service == ...`）；② 编码是数据不是代码分支；③ 每个 transport 必备 mock/可注入；④ capabilities 装配期协商。
- **统一 SessionRegistry**：sidecar/stream/pty 同表，退出只 `kill_all()` 一次；第三方拥有的进程用 `pid_stop` 按 pid 杀树。
- **双权限闸口**：JS `ctx`（快速失败）+ Rust `host/registry.rs`（权威、fail-closed，未注册即拒绝）。`__host__` 是宿主身份。
- **一个能力一个权限**：`stdio-line`→`rpc:proc`；`channel-*`/`pty-stream`→`rpc:stream`；`event-bus`→`rpc:bus`；`in-process` 无；窗口→`win:manage`；`ctx.sessions()`→`rpc:host`；`ctx.closeStream` 不设闸（关比开弱）。会话生命周期在 `stream` 服务，不在 `host`。
- **跨窗口只走 event-bus 广播**，禁止用 storage 轮询做同步。
- **外部插件**：`plugin.json` 是权威清单（`mergeManifest`），代码里的 `manifest` 只补缺；两者必须一致（有审计测试）。首次发现即启用（`adoptNewPlugin`），显式禁用持久。

## 接口清单（详见 docs/INTERFACES.md）
- **8 个原生命令**：`plugin_rpc`（网关）· `plugin_stream_open{,_raw}` · `plugin_stream_close` · `plugin_register` · `plugin_scan` · `plugin_read_entry` · `plugin_open_dir`。
- **6 服务 / 25 动作**：storage(get/set/remove/keys) · host(info/write_debug_log/sessions/plugins/schema) · proc(spawn/send/recv/kill/kill_all/list) · stream(close/providers/list/session_open/session_close) · bus(publish) · hotkey(register/unregister/unregister_all/list)。
- **7 方案**：rpc · channel-json · channel-raw · event-bus · stdio-line · pty-stream · in-process。流提供者：ticker / blob。
- 示例 **`examples/plugins/probe`（Plane Probe）**：一次调用跑完 11 项接口检查，失败即 `activate()` 抛错 → 启动日志显示 error。既是"新插件零改动复用接口"的证据，也是活的集成检查。
- **能力声明必须为真**：曾声明 `channel-json` 支持 backpressure 但无实现，已移除。不要声明调用方无法依赖的能力。
- **观察不等于能力**：订阅 / 读自己的热键 / 关闭自己开的流都不需要权限；只有发布广播、运行自带二进制、控制窗口才带权限。
- **动作清单权威**：`Service::actions()` 同时用于网关校验与 `host/schema`，不可能漂移。

## API 形状规则（不要倒退）
- **方案差异只能体现在"默认值"上，不能体现在"形状"上**：`subscribe`/`once`/`publish` 在所有方案上都是异步，`ctx.events` 与 `ctx.bus` 只差默认方案。
- 插件声明式能力（`contributes.hotkeys`）由**宿主代注册**，且必须在 `plugin.activate()` **之前**完成。
- `ctx.protocol` 由 `protocol/contract.js` 单点提供并 freeze，两个窗口面共用。
- `rpc` 超时在**传输层**强制（默认 45s，0=不限）；**不要在信封加 `deadline`** —— 同步网关无法兑现。
- 插件的故意负向测试用 `// audit-ignore-next-line` 标记（静态审计会跳过下一行）。

## 调试闭环（关键基建，别删）
- `boot()` 把启动过程自报到 `{appData}/debug.log`：`--- boot ---` / `message plane:` / `boot ok:` / 每插件状态 / `BOOT FAILED: <stack>`。**排查运行期问题先看这个文件。**
- dev 启动自动跑应用内自检（`src/core/selftest.js`，t01–t15），报告同样落盘；随时可 `await window.__toolbox.selftest()`。
- `window.__toolbox`：store/events/logger/logs/schemes/transports/sessions/openStreams/selftest。

## 约定与坑
- 外部插件是 **Blob URL 单文件 ESM**，不能 import 协议模块 → 用 `ctx.protocol` / `bridge.protocol`。
- `tauri-pty` 包没有 `main`/`exports` 字段，必须写 `tauri-pty/dist/index.es.js` 才能在 bundler 与 `node --test` 下都解析。
- 涉及全局态的 Rust 测试用 `services::serial()` 串行化；JS 侧跑真实 boot 前必须 `resetHost()`（清 store + deactivate 释放定时器），否则进程不退出、`node --test` 会被 SIGTERM。
- `npm run test` = `node --test`（不要写 `node --test tests/`，Windows 下会被当模块路径）。
- 浏览器专用依赖在 Node 下要 stub：`tests/browser-stubs-loader.mjs` + `module.register()`。
- `target/` 可能被杀软/文件锁干扰，出现 `拒绝访问` 或 rustc ICE → `rm -rf target/debug/incremental` 后重编。
- 应用数据目录：`%APPDATA%\com.tan18.toolbox\{debug.log, plugins/, plugin-data/}`；WebView2 配置目录 `%LOCALAPPDATA%\com.tan18.toolbox\EBWebView`。
- 静态审计支持 `// audit-ignore-next-line` 标记（用于插件里的故意负向测试）。
- 本环境限制：`wmic` 被安全策略禁用；PowerShell 工具不返回 stdout → 让它把结果写入文件再读。
- **本机 `cargo test` 的测试二进制无法加载**（STATUS_ENTRYPOINT_NOT_FOUND）：根因是 tauri-build 的 manifest 只链进 bin 目标（无 manifest → 绑 comctl32 v5，代码导入 v6）。`build.rs` 已把 `resource.lib` 转发给 `-examples` → **用 `cargo run --example host-checks` 做 Rust 侧验证**（16 项）。cargo 没有 `-tests` link-arg，通用 `rustc-link-arg` 会与 bin 冲突（LNK1123）。
- rustc ICE / `拒绝访问` = 增量缓存被杀软损坏 → `rm -rf target/debug/incremental` + `CARGO_INCREMENTAL=0`。
- 排查"应用起来了但 JS 不执行"：Rust 侧 `eprintln!` 探针 → `webview.eval()` 写 `document.title` 再 `w.title()` 读回 → `tasklist` 比对 `msedgewebview2` 数量是否随应用启动而增加。

## 验证命令
`cargo test`（39，本机不可用见下）· `cargo check --all-targets`（零代码警告）· `node --test`（62）· `npm run build` · `cargo build`
`cargo run --example host-checks`（16 项，替代不可用的 cargo test）· `npm run bench`（codec 实验，**刻意不并入 npm test**：时间敏感）
应用内：`npm run tauri dev` 后看 `%APPDATA%\com.tan18.toolbox\debug.log` 的 15/15。

**codec 实测结论**（详见 PROTOCOL.md §2）：字节流必须 raw（4 KiB 块 JSON 慢 126×、大 3.6×）；
raw 解码返回 subarray 视图故几乎免费（41 ns），成本在产出侧；line-json 比 json-envelope 贵 25–60%，它存在是因为 sidecar 需要分隔符。

详细协议见 `docs/PROTOCOL.md`；接口清单与统一性核查见 `docs/INTERFACES.md`；设计与现状分析见 `docs/MESSAGE-FRAMEWORK.md`。
