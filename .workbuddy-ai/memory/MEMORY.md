# toolbox — 项目长期笔记（索引）

> 完整明细见同目录 `NOTES.md`（13 节）。设计文档 `docs/{PROTOCOL,INTERFACES,UI,MESSAGE-FRAMEWORK}.md`、`docs/plugin-dev/`。
> `D:\code\rust\toolkit`（目录名保留），应用名 **Toolbox**，identifier `com.tan18.toolbox`，源自 `D:\code\rust\eyecare\eyecare`。旧 `ARCHITECTURE.md` 与代码不符，**以代码为准**。主题：统一前后端插件消息传递框架，**不增加主程序复杂度**。

## 最高优先硬规则

- **两正交轴** transport × codec，方案 = 组合，登记在 `src/protocol/registry.js`。**一个信封** `{v,kind,id,ch,svc,act,topic,code,msg,p}`，JS/Rust 各一份镜像。
- **四条硬规则**：① 宿主只查表不特判（`lib.rs` 禁止 `if service == ...`）② 编码是数据不是分支 ③ 每个 transport 必备 mock/可注入 ④ capabilities 装配期协商。
- **双权限闸** JS `ctx`（快速失败）+ Rust `host/registry.rs`（权威、fail-closed）。**观察 ≠ 能力**。**跨窗口只走 event-bus**，禁止 storage 轮询同步。
- **动作清单权威**：`Service::actions()` 同时供网关校验与 `host/schema`；**能力声明必须为真**。
- **每个 `#[tauri::command]` 必须 `async fn`** —— Tauri 把**没有 async 的命令跑在主线程**，而那是给**所有**窗口泵消息的一条线程。阻塞 I/O 的命令再套 `spawn_blocking`（`async` 只挪出主线程；阻塞调用会占住 runtime worker，worker 数 = 核数）。守卫 `tests/main-thread.test.mjs` 扫全部命令。**症状永远是"界面卡"而不是"命令阻塞"** —— 所以必须机器把关。
- **外部插件**：`plugin.json` 权威（`mergeManifest` 逐键覆盖），代码内 `manifest` 只补缺，两者必须一致（有审计）。首次发现即启用，显式禁用持久。
- **错误码是闭集**（14 个，`codes.rs` ↔ `codes.js` 有测试比对），服务错误用 `ServiceError`。**编译器抓不到**经 `From` 静默变 `internal` 的点 → 改这类代码必须手工枚举定性。
- **Tauri `Channel` 单向**（JS 没有 `send`）→ 插件→宿主上行靠**批量 invoke**。别再去找 Channel。
- **外部插件是 Blob URL 单文件 ESM，不能 import** → JS 组件库与 Tailwind 工具类到不了它们；**不要给插件加 safelist**。
- **内置插件只留覆盖消息面的**：`src/host/registry.js` 是权威清单（现在只有 `procman` + `streamlab`）。**测试里不要硬编码插件名单** —— 从注册表派生（`builtinSources()` 或读 `registry.js` 的 import），否则删/加插件时它们静默空过。已有 4 处犯过这个错。
- **`capabilities/*.json` 是源文件；运行期用的是编译进二进制的 ACL**（`tauri-build` → `OUT_DIR/capabilities.json`，**Cargo 会缓存**）。**源文件正确 ≠ 应用有权限**。全窗口权限被拒（`event.listen` / `window.get_all_windows` / `pty.spawn` 一起挂）时先 `wc -c src-tauri/target/debug/build/toolbox-*/out/capabilities.json` —— **`2` 就是空 ACL**，`cargo clean -p toolbox` 重建。守卫在 `tests/capabilities.test.mjs`。清缓存前**必须优雅关闭正在跑的应用**，否则 `os error 5` / `LNK1104`。
- **插件列表显示顺序**：规则只在 `store.js` 一处（`sortPluginList` / `sortViewList`，键 = 内置优先 + **显示名**字母序，不是 id）。**作用在数组上而非渲染时**，5 个写入点都接了排序调用 —— 新增写入点必须同时接。
- **插件窗口一律 `visible:false` 创建，等 UI 报 `hello` 再 `show()`**（否则"创建时白屏几秒"）。
- **`ctx.windows.control` 每次 = 2 次 IPC 往返** → **拖动时逐帧连带动多个窗口 = 卡顿**。**几何上报必须 rAF 合并 + 去重**（两层各管一件事）：`resize` 在拖拽期按 `WM_SIZE` **连续**触发，而 `SetWindowPos` 又产生新的 `resize` → **跨两窗口 + 原生侧的自放大回路**。用户按住拖窗口**不要**用 publish+`control('position')` 模拟，用原生 `bridge.drag()`。
- **透明置顶窗口上不要 `backdrop-filter: blur()`，也不要留无限动画**（拖动任何窗口/整块表面每帧重合成）。
- **窗口尺寸尽量由内容实测上报**（`max-content` + 同步 `getBoundingClientRect()`，无闪烁）；**上报必须去重**，**单轴上报不许把另一轴清零**。
- **flex 行里的裸文本是匿名 flex item**：CJK min-content = **一个字符** → **逐字换行**（像"竖排文字"，不是 `writing-mode`）。**flex 子项不收缩到 min-content 以下** → 溢出被 `overflow:hidden` 裁掉。
- **`screen.avail*` 是工作区（已扣任务栏），`screen.width/height` 是整屏**；`create`/`control` 都是逻辑尺寸（DIP）。**`window.screen` 只描述当前窗口所在那块屏** → 跨屏遮罩不可行。
- **`ctx.log` 只到 webview console，不写 `debug.log`** → 插件的失败原因必须显示在界面上。
- **`setIgnoreCursorEvents(true)` 是窗口级标志** → 透传窗口收不到**任何**鼠标事件（含 `pointermove`）。
- **⚠️ 绝对不要硬杀 Tauri 应用**（累积孤儿 `msedgewebview2`、弄坏 WebView2 profile → 窗口全白）。**应用内验证必须由用户在交互终端做。**
- **示例部署用 `npm run deploy:examples`**；手工 `cp -r` 已两次导致"应用里跑的还是旧插件"。
- **`git restore <path>` 按索引恢复，会连工作区里未提交的修改一起回滚**（本项目有多个并发会话在动同一仓库 → 动它之前先确认别处没在改）。反过来，恢复被误删的文件时它是**纯增量**的，不会覆盖已存在的东西。
- **`git add <已删除的路径>` 会整条失败**（git 先校验全部 pathspec）→ 已暂存的删除不要再 add。
- **窗口分发改按窗口 label，不按 URL 参数**：只有 label 是 `main` 的窗口 boot 宿主，其余走 `pluginwin-host.js`。**不要再写成 `if (mode === 'pluginwin') … else <boot 宿主>`** —— 那个 `else` 会让插件窗口跑起第二个完整宿主（重复注册热键、每个插件再激活一次、procman 再 auto-start 真实进程）。URL 校验也要求 `index.html?…&mode=pluginwin`（两个条件：入口页 + mode）。守卫在 `tests/window-options.test.mjs`。
- **两个窗口 = 两个页面**：`index.html` → `src/main.js` → `assets/app.css`（外壳）；`pluginwin.html` → `src/pluginwin.js` → `assets/plugin.css`（插件窗口）。**一个页面的样式表是 `<link>`，在模块之前生效 → 只能在页面层选，JS 分支拦不住。** 两份共享 `assets/design-system.css`（令牌 + 64 个 `.tb-*`）。实测插件窗口 948 KB → **61 KB**。插件窗口的 URL 是 `pluginwin.html?plugin=…&label=…`。
- **⚠️ 插件窗口里没有 Tailwind 工具类**（`plugin.css` 只有令牌 + `.tb-*`）。写了**静默失效** —— 元素就是没样式、不报错。用 `.tb-*` / 内联 `style` / 自己的 `<style>`。守卫在 `tests/window-options.test.mjs`（断言插件窗口路径的类名全是 `.tb-*`）。
- **改契约必须留迁移路径** —— 判断依据不是「仓库里还有谁在用」，而是「**用户机器上已装的是什么**」。本仓库踩过：把插件窗口 URL 从 `index.html?mode=pluginwin&…` 改成 `pluginwin.html?…` 时直接拒绝旧写法 → **所有已装插件开不出窗口**（第三方插件改不到，插件目录里那份是副本），而症状是「什么都没有」（每个调用方都套了 `catch`，插件照常激活，只有窗口不出现）。**做法：在边界处翻译而不是拒绝**（`normalizePluginWindowUrl` 返回规范形状，用返回值创建窗口，旧写法零成本）。
- **托盘与关闭到托盘**：主窗口 ✕ = 隐藏（`boot.js` 的 `installCloseToTray`），退出只在托盘右键菜单（`app.exit(0)` → `RunEvent::Exit` → `kill_all()`）。**托盘建不起来是致命错误**（否则应用无法从自己界面退出）。`store.settings.closeToTray` 持久化 —— 注意 `saveSettings` 只写手挑的子集。**主窗口上插件的 `onCloseRequested` 不触发**（窗口没关），所以那条 API 必须由宿主中转。
- **停用插件 = 宿主强制回收一切**：订阅 / 热键 / 主题 / 视图 / streams / sidecars / ptys / **窗口**。窗口是最后补上的那一块（`ctx.windows.create` 曾是唯一没有 `disposer.track` 的资源获取点）。**新增任何「插件获得一个句柄」的 API，都必须同时 `disposer.track` 它的释放** —— 否则停用会留下没人能关的东西（插件的 JS 上下文已经没了）。复用（label 已存在）的窗口**不**回收：那可能是别的插件建的。
- **`host` 服务的写动作必须 host-only**（`unregister` / `stop_session`）：`rpc:host` 是发给插件的，读授权悄悄变成写权力是权限模型腐烂的方式。守卫在 `tests/host-kernel.test.mjs`。
- **`stream/close` 按调用者插件 id 定位** → 宿主（`__host__`）匹配不到别人的会话。宿主想停一条得走 `host/stop_session {plugin, ch}`。
- **用对象当查找表要防原型链**：`NEEDS[m]` 对 `toString`/`constructor`/`valueOf` 会取到 `Object.prototype` 上的函数 → 假失败。用 `Object.hasOwn`。
- **断言只匹配「你期望的那种错误」，就会把「另一种错误」当成成功** —— 本仓库已两次踩到（URL 校验的文案改了，而测试只查旧文案 → 被拒绝了却算通过）。**报错类断言要覆盖整个校验面。**
- **`cargo test` 在本机跑不起来**（Windows：`tauri-build` 只给 bin 目标嵌 manifest，测试二进制加载即 `STATUS_ENTRYPOINT_NOT_FOUND`）。Rust 侧用 `cargo run --example host-checks`（现 27 项）。README 曾写「cargo test 39 项」，是不实的。
- **`win:self` 做不到**：Tauri 的窗口命令**不校验调用者身份** —— 目标窗口由调用者传的 `label` 决定（`window/plugin.rs` 的 `get_window`），ACL 只按调用窗口授权（`webview/mod.rs` 的 `resolve_access`），window 插件的权限**没有 `scope`**。给插件窗口窗口权限 = 它能操作任意窗口（含主窗口），且能绕开 bridge 直接 `__TAURI_INTERNALS__.invoke`。「限自己」要放在**宿主层**（`control` 的归属校验，当前**缺失**——插件 A 能改插件 B 的窗口）。插件窗口动自己的正解是 `bridge.drag()`（原生，零 IPC）。

## 验证命令

`cd src-tauri && cargo check --all-targets`（零警告；仓库根没有 Cargo.toml）· `cargo run --example host-checks`（Rust 侧 16 项，替代不可用的 `cargo test`）· `npm test` · `npm run build|deploy:examples|preview:theme|bench`。应用内：`npm run tauri dev` 后看 `debug.log` 的 15/15。
