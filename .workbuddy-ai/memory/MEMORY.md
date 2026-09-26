# toolbox — 项目长期笔记（索引）

> **细节/原因读同目录 `NOTES.md`（14 节）**；设计文档 `docs/{PROTOCOL,INTERFACES,UI,MESSAGE-FRAMEWORK}.md`、`docs/plugin-dev/`。
> `D:\code\rust\toolkit`（目录名保留），应用名 **Toolbox**，identifier `com.tan18.toolbox`。旧 `ARCHITECTURE.md` 与代码不符，**以代码为准**。主题：统一前后端插件消息传递框架，**不增加主程序复杂度**。

## 架构（不要倒退）
- **两正交轴** transport × codec，方案 = 组合，登记在 `src/protocol/registry.js`。**一个信封** `{v,kind,id,ch,svc,act,topic,code,msg,p}`，JS/Rust 各一份镜像。
- **四条硬规则**：① 宿主只查表不特判（`lib.rs` 禁止 `if service == ...`）② 编码是数据不是分支 ③ 每个 transport 必备 mock/可注入 ④ capabilities 装配期协商。
- **双权限闸** JS `ctx`（快速失败）+ Rust `host/registry.rs`（权威、fail-closed）。**观察 ≠ 能力**。**跨窗口只走 event-bus**，禁止 storage 轮询同步。
- **`Service::actions()` 是动作清单唯一权威**（同时供网关校验与 `host/schema`）；**能力声明必须为真**。
- **外部插件**：`plugin.json` 权威（`mergeManifest` 逐键覆盖），代码内 `manifest` 只补缺，两者必须一致（有审计）。首次发现即启用，显式禁用持久。
- **错误码是闭集**（14 个，`codes.rs` ↔ `codes.js` 有测试比对），服务错误用 `ServiceError`。**编译器抓不到**经 `From` 静默变 `internal` 的点 → 必须手工枚举定性。
- **Tauri `Channel` 单向**（JS 没有 `send`）→ 插件→宿主上行靠**批量 invoke**。别再去找 Channel。
- **`win:self` 做不到**：Tauri 窗口命令**不校验调用者身份**（目标由调用者传的 `label` 决定，ACL 只按调用窗口授权、**没有 scope**）。插件窗口动自己的正解是 `bridge.drag()`；「限自己」要放**宿主层**（`control` 归属校验，**当前缺失**）。

## 接口（权威：`docs/INTERFACES.md`）
- **9 个原生命令 · 9 服务 / 35 动作 · 8 方案 · 3 流提供者**（ticker / blob / clipboard）。
- **服务权限是派生的**：`plugin_rpc` 做 `is_allowed(id, &format!("rpc:{svc}"))` → 注册服务即得权限，白名单也由 `serviceNames()` 派生。**只有非服务型权限（`rpc:dialog` / `win:manage`）才手写。**
- **规律：拉取 → 服务，推送 → 流提供者**（剪贴板读/写 = `clipboard/*` 服务，变化 = 提供者 `clipboard` 流；截屏 = `screen/*` 服务，无流）。**`StreamProvider::permission()` 默认 `None`**，`open_json`/`open_raw` 检查它；名单在 `host/schema` 的 `providerPermissions`。
- **形状规则**：方案差异只能体现在**默认值**上，不能体现在形状上。`rpc` 超时在**传输层**强制（默认 45s，0=不限），**不要在信封加 `deadline`**。

## 命令与 ACL
- **每个 `#[tauri::command]` 必须 `async fn`**（非 async 命令跑在**主线程** = 给所有窗口泵消息的那条线程）。真阻塞 I/O 再套 `spawn_blocking`。守卫 `tests/main-thread.test.mjs`。**症状永远是"界面卡"**。
- **`capabilities/*.json` 是源；运行期用编译进二进制的 ACL（Cargo 会缓存）**。全窗口权限被拒时先 `wc -c target/debug/build/toolbox-*/out/capabilities.json` —— **`2` = 空 ACL** → `cargo clean -p toolbox`。守卫 `tests/capabilities.test.mjs`。清缓存前必须优雅关掉应用。

## 窗口 / 页面
- **分发改按窗口 label，不按 URL 参数**：只有 label=`main` boot 宿主，其余走 `pluginwin-host.js`。`else` 分支会让插件窗口跑起**第二个完整宿主**。守卫 `tests/window-options.test.mjs`。
- **两个窗口 = 两个页面**（`index.html`→`app.css`；`pluginwin.html`→`plugin.css`），共享 `design-system.css`。样式表是 `<link>`、在模块之前生效 → **只能在页面层选**。插件窗口 948 KB → **61 KB**。
- **插件窗口里没有 Tailwind 工具类**（写了**静默失效**）→ 用 `.tb-*` / 内联 `style`。**不要给插件加 safelist**（外部插件是 Blob URL 单文件 ESM，import 不了任何东西）。
- **插件窗口一律 `visible:false` 创建，等 UI 报 `hello` 再 `show()`**。
- **`ctx.windows.control` 每次 = 2 次 IPC 往返** → 拖动时逐帧连带动多窗口 = 卡顿。**几何上报必须 rAF 合并 + 去重**（拖拽期 `resize` 与 `SetWindowPos` 会成**自放大回路**）；拖窗口用原生 `bridge.drag()`。
- **透明置顶窗口上不要 `backdrop-filter: blur()`，也不要留无限动画**。
- **窗口尺寸尽量由内容实测上报**（`max-content` + 同步 `getBoundingClientRect()`）；**上报必须去重**；**单轴上报不许把另一轴清零**。
- **`setIgnoreCursorEvents(true)` 是窗口级标志** → 透传窗口收不到**任何**鼠标事件（含 `pointermove`）。**`ctx.log` 只到 webview console，不写 `debug.log`** → 插件的失败原因必须显示在界面上。

## 生命周期 / 权限
- **停用插件 = 宿主强制回收一切**：订阅 / 热键 / 主题 / 视图 / streams / sidecars / ptys / **窗口**。**新增任何「插件获得一个句柄」的 API，都必须同时 `disposer.track` 它的释放**。复用（label 已存在）的窗口**不**回收。
- **`host` 服务的写动作必须 host-only**（`unregister` / `stop_session`）。守卫 `tests/host-kernel.test.mjs`。
- **`stream/close` 按调用者插件 id 定位** → 宿主停别人的会话得走 `host/stop_session {plugin, ch}`。
- **托盘**：主窗口 ✕ = 隐藏，退出只在托盘右键菜单。**托盘建不起来是致命错误**。**主窗口上插件的 `onCloseRequested` 不触发** → 必须由宿主中转。

## 契约 / 测试
- **改契约必须留迁移路径** —— 判据是「**用户机器上已装的是什么**」，不是「仓库里还有谁在用」。**在边界处翻译而不是拒绝**（`normalizePluginWindowUrl`）。踩过：URL 契约改严 → **所有已装插件开不出窗口**，症状是「什么都没有」（调用方都套了 `catch`）。
- **测试里不要硬编码内置插件名单**：`src/host/registry.js` 是权威清单，从注册表派生。已有 4 处犯过。
- **插件列表顺序只在 `store.js` 一处**（`sortPluginList`/`sortViewList`，键 = 内置优先 + **显示名**字母序）。**作用在数组上而非渲染时**，5 个写入点都接了 —— 新增写入点必须同时接。
- **断言只匹配「期望的那种错误」会把「另一种错误」当成成功** → 报错类断言要覆盖整个校验面。
- **审计没扫的命名空间 = 静默失效的承诺**：`requiredPermissions` 曾漏看 `ctx.clipboard`/`ctx.screen`，于是 `senses` 漏声明 `rpc:screen` 被放过去、运行时才炸。**新增能力命名空间必须同时加审计规则**。
- **`ctx` 与 `bridge` 是同一契约的两个视图**，差异必须登记在案（`tests/sdk-parity.test.mjs` 双向断言；含 `ctx.rpc` ≡ `bridge.request`）。**把「缺」变成记录在案的决定。**
- **同一编辑失误会同时污染文档与代码**：`ctx.focusView` 曾被粘贴两遍（**后一份静默覆盖**），三份文档各有整节重复。守卫 `tests/docs.test.mjs`。
- **写「提取源码」的守卫：`\s` 匹配换行** → `^\s*name\s*:` 会跨行、每个键报两次（用 `[ \t]`）；锚点选错返回空集 → **必须断言解析规模**，否则守卫在空集上永远报绿。
- **用对象当查找表要防原型链** → `Object.hasOwn`。
- **⚠️ 绝对不要硬杀 Tauri 应用**（累积孤儿 `msedgewebview2`、弄坏 WebView2 profile → 窗口全白）。**应用内验证必须由用户在交互终端做。**
- **任何含反引号 / `$` 的文本先写进文件再用 `-F` 读**（bash 会做命令替换，`git commit -m "…\`x\`…"` 会把消息吃掉）。
- **`git restore <path>` 会连工作区未提交的修改一起回滚**（多会话同仓库）；**`git add <已删除的路径>` 会整条失败**。
- **示例部署用 `npm run deploy:examples`**（手工 `cp -r` 已两次导致"应用里跑的还是旧插件"）。

## 验证
`cd src-tauri && cargo check --all-targets`（零警告）· `cargo run --example host-checks`（Rust 侧自检，**`cargo test` 在本机跑不起来**）· `npm test` · `npm run build|deploy:examples|preview:theme|bench`。应用内：`npm run tauri dev` 后看 `debug.log` 的 15/15。
