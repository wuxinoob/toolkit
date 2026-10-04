# toolbox — 项目长期笔记（索引）

> **这是索引，不是手册**：只放**触发条件 + 规则**，原因/细节一律在 `NOTES.md`（14 节）。
> 设计文档 `docs/{PROTOCOL,INTERFACES,UI,MESSAGE-FRAMEWORK}.md`、`docs/plugin-dev/`。
> ⚠️ **约 10 KB 是自动注入上限，超过会被截断** → 加规则前先删或合并。
> `D:\code\rust\toolkit`（目录名保留），应用名 **Toolkit**，identifier `com.tan18.toolkit`。旧 `ARCHITECTURE.md` 与代码不符，**以代码为准**。主题：统一前后端插件消息传递框架，**不增加主程序复杂度**。

## 架构（不要倒退）
- **两正交轴** transport × codec，方案 = 组合，登记在 `src/protocol/registry.js`。**一个信封** `{v,kind,id,ch,svc,act,topic,code,msg,p}`，JS/Rust 各一份镜像。
- **四条硬规则**：① 宿主只查表不特判（`lib.rs` 禁止 `if service == ...`）② 编码是数据不是分支 ③ 每个 transport 必备 mock/可注入 ④ capabilities 装配期协商。
- **双权限闸** JS `ctx`（快速失败）+ Rust `host/registry.rs`（权威、fail-closed）。**观察 ≠ 能力**。**跨窗口只走 event-bus**，禁止 storage 轮询同步。
- **`Service::actions()` 是动作清单唯一权威**（同时供网关校验与 `host/schema`）；**能力声明必须为真**。
- **外部插件**：`plugin.json` 权威（`mergeManifest` 逐键覆盖），代码内 `manifest` 只补缺，两者必须一致（有审计）。首次发现即启用，显式禁用持久。
- **错误码是闭集**（14 个，`codes.rs` ↔ `codes.js` 有测试比对），服务错误用 `ServiceError`。**编译器抓不到**经 `From` 静默变 `internal` 的点 → 必须手工枚举定性。
- **`win:self` 做不到**：Tauri 窗口命令**不校验调用者身份** → 插件窗口动自己用 `bridge.drag()`；「限自己」要放**宿主层**（`control` 归属校验，**当前缺失**）。

## 接口（权威：`docs/INTERFACES.md`）
- **13 个原生命令 · 9 服务 / 35 动作 · 8 方案 · 3 流提供者**（ticker / blob / clipboard）。命令在 `lib.rs`（9）+ `services/external.rs`（4）；**数据面 5 条**走 `host/registry.rs` 权威闸口，**其余 8 条是宿主管理操作**（闸口 `require_main`，仅 3 条）。
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
- **`ctx.windows.control` 每次 = 2 次 IPC 往返** → 拖动时逐帧连带动多窗口 = 卡顿。**几何上报必须 rAF 合并 + 去重**（拖拽期 `resize` 与 `SetWindowPos` 会成**自放大回路**）；拖窗口用原生 `bridge.drag()`。
- **渲染细节见 `NOTES.md` §6–§7**：透明窗口别用 `backdrop-filter`、别留无限动画；尺寸由内容**实测上报**（去重、单轴不清零）；`setIgnoreCursorEvents(true)` 是窗口级（透传窗口收不到**任何**鼠标事件）；`ctx.log` 只到 webview console → 插件失败原因必须显示在界面上。
- **插件窗口的 `onDrop` / `focusView` 可解，`registerView` 不行**（`render` 是闭包、跨 realm 传函数不可能 —— 而它在 `activate(ctx)` 里本来就能用）。注意 `onDrop` **不是**框架限制、也**不需要窗口归属**。方案见 `NOTES.md` §14.23。**fs 已评估、暂不实施**（路线 D / 方案 A）→ `NOTES.md` §14.20–§14.22、`docs/plugin-dev/FILE-ACCESS-PLAN.md` §七–§八。

## 生命周期 / 权限
- **停用插件 = 宿主强制回收一切**：订阅 / 热键 / 主题 / 视图 / streams / sidecars / ptys / **窗口**。**新增任何「插件获得一个句柄」的 API，都必须同时 `disposer.track` 它的释放**。复用（label 已存在）的窗口**不**回收。
- **释放流用 `hub.close(pluginId, ch)`，不是 `handle.close()`** —— 传输层只「告诉宿主停」，hub 自己的注册表（`already open` 的判据）只有 `hub.close` 会清；**等终止 `end` 帧来清不算**（帧没到就永远占着，插件再也开不了那个 ch）。`bridge.dispose()` 曾完全不释放流 → **关插件窗口会留下跑着的 pty/sidecar**（那个窗口是唯一会关它们的东西）。
- **托盘**：主窗口 ✕ = 隐藏，退出只在托盘右键菜单。**托盘建不起来是致命错误**。**主窗口上插件的 `onCloseRequested` 不触发** → 必须由宿主中转。

## 契约 / 测试
- **改契约必须留迁移路径** —— 判据是「**用户机器上已装的是什么**」，不是「仓库里还有谁在用」。**在边界处翻译而不是拒绝**（`normalizePluginWindowUrl`）。踩过：URL 契约改严 → **所有已装插件开不出窗口**，症状是「什么都没有」（调用方都套了 `catch`）。
- **断言只匹配「期望的那种错误」会把「另一种错误」当成成功** → 报错类断言要覆盖整个校验面。
- **正则断言实现 = 把 bug 钉死成期望值**（`tests/file-access.test.mjs` 曾 `assert.match(/mine.has(...)/)`，于是 file drop 整个坏掉的期间它一直是绿的 —— **本仓库第三次同类错误**）。判据：**这条断言在功能完全坏掉时会变红吗？** 不会 → 改写成行为测试。
- **⚠️ 「现在是什么」要在使用时求值，不能在初始化时快照**：`ctx.onDrop` 曾在**订阅时**快照自己视图 id 的集合，而插件靠 `ctx.registerView` 注册视图、**「先接输入后挂视图」是自然写法** → 快照是**空集** → **每个 drop 静默被拒一辈子**。判据：被判断的东西是不是**之后才会被创建**的（视图/句柄/注册项）？
- **审计没扫的命名空间 = 静默失效的承诺**：`requiredPermissions` 曾漏看 `ctx.clipboard`/`ctx.screen`，于是 `senses` 漏声明 `rpc:screen` 被放过去、运行时才炸。**新增能力命名空间必须同时加审计规则**。
- **⚠️ `ls.clear()` 不清 `store.settings`** → 测试之间通过 store 泄漏状态，**顺序决定它是否通过而它看起来是绿的**。**依赖什么状态就要清什么状态**。同名重复测试里后一份常是**过时版本、断言相反行为**，靠泄漏才通过 —— 当成缺陷查。
- **断言的性质要写「运行中的东西」，不是「发布的东西」**：`t13` 曾要求每个**随仓库发布的**内置插件都有视图 → 用户合法关掉一个就 14/15。改成「每个 `active` 的插件都有它声明的视图」+ **跳过的点名**（同 t15 的 SKIPPED）。
- **`tests/hygiene.test.mjs` 管住「没有编译器的东西」**：文档不许重复 `##`、测试不许重名、`INTERFACES.md` 的命令数 = 源码 `#[tauri::command]` 数、`lib.rs` 不许对服务名特判。**能被代码算出来的数字交给测试比对。**
- **`ctx` 与 `bridge` 是同一契约的两个视图**，差异必须登记在案（`tests/sdk-parity.test.mjs` 双向断言；含 `ctx.rpc` ≡ `bridge.request`）。行为也要测，不只是接口面（`tests/plugin-bridge.test.mjs`）。
- **`arr.reverse()` / `arr.sort()` 原地改并返回同一个数组** → `const f = arr.reverse(); arr.length = 0;` 会把 `f` 也清空（`bridge.dispose()` 曾因此变成**彻底的空操作**）。先 `[...arr]`。
- **⚠️ 绝对不要硬杀 Tauri 应用**（累积孤儿 `msedgewebview2`、弄坏 WebView2 profile → 窗口全白）。**应用内验证必须由用户在交互终端做。**
- **任何含反引号 / `$` 的文本先写进文件再用 `-F` 读**（bash 会做命令替换）。
- **`git restore <path>` 会连工作区未提交的修改一起回滚**；**`git add <已删除的路径>` 会整条失败**（重命名后别再把旧路径传进去）。
- **示例部署用 `npm run deploy:examples`**（手工 `cp -r` 已两次导致"应用里跑的还是旧插件"）。

> **验证命令、磁盘测量、codec 基准、`拒绝访问` 修法** → `NOTES.md` §12–§13；`README.md` 也有一份。
