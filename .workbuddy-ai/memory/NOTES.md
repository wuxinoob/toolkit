# toolbox — 项目长期笔记（完整版）

> 本文件是 `MEMORY.md`（索引/最高优先条目）的**完整版**，因体积超过自动注入上限而拆出。需要细节时读这里。
> 设计文档：`docs/{PROTOCOL,INTERFACES,UI,MESSAGE-FRAMEWORK}.md` 与 `docs/plugin-dev/`。

## 1. 定位

`D:\code\rust\toolkit`（目录名保留），应用名 **Toolbox**，identifier `com.tan18.toolbox`。源自 `D:\code\rust\eyecare\eyecare`；旧 `ARCHITECTURE.md` 与代码不符，**以代码为准**。主题：统一前后端插件消息传递框架，**不增加主程序复杂度**。

## 2. 架构硬规则（不要倒退）

- **两正交轴**：transport（invoke/channel/event/stdio/pty/in-process）× codec（json-envelope/line-json/raw-binary/object）；方案 = 组合，登记在 `src/protocol/registry.js`。**信封** `{v,kind,id,ch,svc,act,topic,code,msg,p}`，kind ∈ req/res/err/evt/data/end/exit，JS/Rust 各一份镜像。
- **四条硬规则**：① 宿主只查表不特判（`lib.rs` 禁止 `if service == ...`）② 编码是数据不是分支 ③ 每个 transport 必备 mock/可注入 ④ capabilities 装配期协商。
- **统一 SessionRegistry**：sidecar/stream/pty 同表，退出只 `kill_all()` 一次；第三方进程按 pid 杀树。
- **双权限闸**：JS `ctx`（快速失败）+ Rust `host/registry.rs`（权威、fail-closed）。`__host__` 是宿主身份。
- **一个能力一个权限**：`stdio-line`→`rpc:proc`；`channel-*`/`pty-stream`→`rpc:stream`；`event-bus`→`rpc:bus`；`in-process` 无；窗口→`win:manage`；`ctx.sessions()`→`rpc:host`。`ctx.closeStream` 不设闸。会话生命周期在 `stream` 服务，不在 `host`。
- **观察 ≠ 能力**：订阅、读自己的热键、关自己开的流、注册视图 → 都不要权限。**跨窗口只走 event-bus**，禁止 storage 轮询同步（`ctx.events` 窗口本地，`ctx.bus` 跨窗口）。
- **外部插件**：`plugin.json` 权威（`mergeManifest` 逐键覆盖），代码内 `manifest` 只补缺；两者必须一致（有审计）。首次发现即启用（`adoptNewPlugin`），显式禁用持久。
- **能力声明必须为真**（曾谎称 `channel-json` 支持 backpressure）。**动作清单权威**：`Service::actions()` 同时供网关校验与 `host/schema`，不可能漂移。

## 3. 接口

- **8 个原生命令**：`plugin_rpc` · `plugin_stream_open{,_raw}` · `plugin_stream_close` · `plugin_register` · `plugin_scan` · `plugin_read_entry` · `plugin_open_dir`。
- **6 服务 / 29 动作**：storage(get/set/remove/keys) · host(info/write_debug_log/sessions/plugins/schema/unregister) · stream(close/providers/list/session_open/session_close/open_in/write_in/close_in) · proc(spawn/send/recv/kill/kill_all/list) · bus(publish) · hotkey(register/unregister/unregister_all/list)。
- **8 方案**：rpc · channel-in · channel-json · channel-raw · event-bus · stdio-line · pty-stream · in-process。
- **API 形状规则**：方案差异只能体现在**默认值**，不能体现在形状（所有 subscribe/once/publish 都是异步）。`ctx.protocol` 由 `protocol/contract.js` 单点提供并 freeze。
- `rpc` 超时在**传输层**强制（默认 45s，0=不限）；**不要在信封加 `deadline`**（同步网关无法兑现）。
- `contributes.hotkeys` 由**宿主代注册**，必须在 `plugin.activate()` **之前**完成。故意负向测试用 `// audit-ignore-next-line` 标记。

## 4. 错误码与上行流

- **错误码是闭集**：14 个在 `protocol/codes.rs`，`codes.js` 是镜像，`tests/codes.test.mjs` 比对两文件。服务错误用 `ServiceError`，不报 `{svc}/{act}`。**编译器抓不到**经 `From` 静默变 `internal` 的点（`?` 作用在 `Result<_,String>`、`Err("".into())`、`ok_or("")`）→ 改这类代码必须手工枚举定性。
- **上行流 `channel-in`**：`ctx.uplink(ch,{sink})` → 同形句柄 + `sendBatch`；sink 名单在 `host/schema`。
- **Tauri `Channel` 单向**（JS 只有接收回调，没有 `send`）→ 插件→宿主没有推送载体，上行靠**批量 invoke**。别再去找 Channel。

## 5. 界面（CSS + 令牌 + 组件工厂）

> 设计系统全貌在 `docs/UI.md`。下面只列**容易踩的坑**。

- **外部插件是 Blob URL 单文件 ESM，不能 import** → JS 组件库与 Tailwind 工具类都到不了它们。观感靠 `src/assets/app.css` 的 `.tb-*` + `@theme` 令牌。**不要给插件加 safelist**（构建早于插件存在，漏掉的类名静默失效）；内置插件也不用工具类。
- **`ctx.ui`**（`src/host/ui.js`）：`el(tag,props,children)` 返回**描述符**，`render(container,tree)` 一次挂载整棵树；**`render()` 语义是替换**（按容器记 app，重画先 unmount），否则每次重画泄漏一个 Vue app。`ctx.ui.native(tag,…)` 要普通 HTML 元素。**新 app 不继承宿主 provide** → 有 `ROOT_PROVIDERS` 自动套一层。
- **词汇表是派生的**（`import.meta.glob` → 376 tag）。glob **不能加 `typeof` 守卫**（Vite 替换成对象字面量 → 词汇表静默为空），故单独放 `src/host/uiComponents.js`，由 `loadUiKit()` 动态 import（Node 下不可达）。
- **tag 校验用真实 HTML 标签白名单**（拼错即抛错）；白名单**故意不含 html/head/body/script/style/link/meta/title/base**（主窗口里 `el('style',…)` 就是全局样式注入）。
- **`form`/`select` 是组件不是同名元素**：`el('form')` 的 submit 不是原生事件。要被 `FormData` 读或接原生事件的控件走 `native()`。Input/Button/Label/Table/Textarea 就是原生元素。尺寸入口是组件的 `size`（`class="tb-btn-sm"` 无效，shadcn 的 `h-9` 赢高度）。
- **reka-ui `SelectRoot` 受控陷阱**：`passive: props.modelValue === void 0` —— 传了 `modelValue` 即切受控。**面板刻意不重渲染（避免丢输入焦点）时必须用非受控 `defaultValue`**，否则 Select 看起来"拒绝变更"。（procman 同款写法）
- **portal 目标**：reka-ui 默认 teleport 到 `document.body`（在 `[data-plugin]` 之外）→ 已补 `forwardPortalTo` 覆盖 14 个 portal 组件（补丁表由 `PORTAL_CONTENTS` 生成，拉取时自动重放，幂等）。
- **shadcn-vue**：`npm run shadcn:pull`（不用 CLI，CLI 报 "Failed to fetch from registry"），记录 URL+sha256 到 `.shadcn-lock.json`；registry 的 `dependencies` 不可信，脚本从**实际文件内容**扫 bare import。**`typescript` 必须 `^5`**（`@vue/compiler-sfc` 需要 `ts.sys`）。
- **token 四层**：规范值（`:root`）→ shadcn 兼容名（`var()`）→ `@theme inline` 别名 → `.tb-*` 原语。**shadcn 原始变量名必须做兼容层**（组件内联样式直接读 `var(--popover)`/`var(--border)`/`var(--radius)`）。**方向：shadcn 名持有值，项目名是别名** —— 反过来会让 `bg-primary` 编译成 `var(--brand)`，插件按 shadcn 文档设 `--primary` 时一个颜色都不变。守卫 `theming: every variable a utility resolves to holds a value`。
- **Tailwind v4 裸 `border` 颜色是 `currentColor`** → `@layer base` 恢复 `border-color: var(--color-border)`。排查：`getComputedStyle` 同时打印 border 与 color，相同即 currentColor。
- **令牌语义**：`--border` 是**区域分隔线**（要退场），`--input`/`--line-strong` 是**控件**（要看得见）。**滚动条滑块、拖拽把手不能用分隔线令牌**（ScrollArea 滑块由 reka-ui 画，`::-webkit-scrollbar-thumb` 到不了 → 上游 `bg-border` 改 `--line-strong` 并入 LOCAL_PATCHES）。
- **主题是 `<html>` 上的属性**（`@theme` 定义深色，`:root[data-theme='light']` 覆盖同一批 token）—— 唯一能让 Blob URL 插件被主题化的方式。`src/host/theme.js`：system/light/dark、跟随 `prefers-color-scheme`、localStorage 持久化、跨窗口用 `storage` 事件**推送**；每窗口 mount 前调 `initTheme()`；`index.html` 有内联预置脚本（否则浅色用户开窗闪一帧深色）。**加颜色 token 必须同时改 `@theme` 和浅色块**（否则浅色下仍是深色值，静默出错）。**两个不能继承 token 的特例**：xterm（canvas，`readTermTheme()` 从 document 读）、透明窗口需 alpha（`color-mix`）。
- **`contributes.theme`**（`src/host/pluginTheme.js`）：**两套主题都提前生成、靠 data-theme 选择**，切主题不需 JS 重注入。作用域三处：`ViewHost` 挂载点、`ctx.ui.mountOverlay` 内容、插件窗口 `<html>`。**值校验是安全核心**：拒 `; { } < > \ @` 与换行，另拒 `url(`/`image-set(`/`expression(`/`-moz-binding(`。**必须同时声明两套主题**（有测试拦）。范例 `examples/plugins/hello`。
- **UI 自由度阶梯**（`docs/UI.md`）：L0 token / L1 插件自建调色板 / L2 `contributes.theme` / L3 注入插件 CSS / L4 shadow DOM 共享 `adoptedStyleSheets`。**没有 L4 之前别做 L3**。
- **overlay 容器不用 `absolute`、不设 `pointer-events:none`**（前者吞掉全应用点击，后者被子元素继承）。**状态写在 ARIA 里**（`aria-selected`/`aria-pressed`），样式挂属性选择器。
- **侧栏图标支持 `lucide:<name>`**（固定 50 个词汇表；拼错 → 回退通用图标 + 警告，**绝不渲染原文**）。
- **控件样式三档**：完全可改（`appearance:none`）／只能改色（`accent-color`）／完全够不到（`<select>` 弹层、date 日历、取色器、标题栏 —— 唯一杠杆是 `color-scheme`）。
- **双滚动条 bug（已修）**：`main` 有 `overflow-auto` 但 `position:static` → 绝对定位后代逃出裁剪把文档撑高。守卫 `layout: the main scroll container is also a containing block`。**规律：任何 `overflow:auto/scroll` 的盒子要裁剪内容，都应同时 `position:relative`。**
- **对照页主题用 iframe**，不用嵌套 `data-theme`（令牌声明在 `:root[data-theme]` 上，嵌套元素拿不到）。

## 6. 窗口

- **capability 按 window LABEL 分域**：`main` / `floatwin` / `plugin-*`。插件窗口各只拿三个权限（`core:default` + `start-dragging` + `close`）。尺寸/位置/置顶/透传留在**创建它的**主窗口。都没有 `remote`。
- **`ctx.windows.create` 走白名单 + url 必须是 `index.html?…`**，校验在异步查找**之前**。白名单：`url title width height x y center transparent decorations shadow alwaysOnTop skipTaskbar resizable maximizable minimizable closable focus visible`。**没有 `fullscreen`**。
- **`ctx.windows.control`**：`size/position/clickThrough/alwaysOnTop/skipTaskbar/show/hide/focus/close`（**没有** getPosition / fullscreen / setOpacity）→ 要"记住位置"只能自己算绝对坐标。**每次 `control` = 2 次 IPC 往返**（`getByLabel()` + setter），`gated` 是**同步**函数。**拖动时逐帧连带动多个窗口 = 卡顿**（见 §7）。
- **`screen.avail*` 是工作区（已扣任务栏），`screen.width/height` 是整屏** → 要盖任务栏必须用整屏 + 外扩。任务栏厚度 = `width-availWidth` / `height-availHeight`；`availLeft/Top` 只在任务栏停在该边时偏移 → 可反推显示器原点。**`create`/`control('size'/'position')` 都是逻辑尺寸（DIP）**，与 `screen` 同单位空间 → 缩放天然一致。**`window.screen` 只描述当前窗口所在的那块屏**，宿主未暴露显示器枚举 → 跨屏遮罩不可行。
- **`window.screenX` ≠ 窗口左上角**（`decorations:false` 下仍差 ~10px）→ 主窗口无法精确反推悬浮窗坐标，**只能由该窗口自己 `getBoundingClientRect()` 上报**。
- **插件窗口宿主**：`index.html?mode=pluginwin&plugin=<id>&label=<label>`（三参数缺一不可），由 `pluginwin-host.js` Blob-import 入口并调 `mountWindow(bridge)`。
- **Tauri capability 会静默拒绝 JS 调用**（错在监听器里被吞，界面只表现为"没反应"）：改 `src/**` 里任何 `getCurrentWindow()`/`WebviewWindow` 调用后必须同步 `src-tauri/capabilities/*.json`（`tests/capabilities.test.mjs` 核对）。**`onCloseRequested` 需要 `allow-destroy`**；`ctx.windows.onCloseRequested` 已包 try/catch。
- **测试手法**：`tests/window-options.test.mjs` 从**插件源码抽出真实选项**再比对白名单（手写清单会漂移）。
- **启动白屏已从结构上修掉**（三处必须一致，有握手契约测试）：`tauri.conf.json` `visible:false`、`src/main.js` 首帧后 `show()`（**必须两个 `requestAnimationFrame`**）、`lib.rs` 5s 兜底 + stderr。
- **自绘窗口栏（未做）**：`decorations:false` + `data-tauri-drag-region` + 三权限；Windows 上确定失去 Snap Layouts。

## 7. 插件侧性能与窗口显示（eyecare 移植得出）

- **透明置顶窗口上不要用 `backdrop-filter: blur()`**：模糊目标包含"窗口背后的一切"，拖动**任何**窗口都会让合成器每帧重算 → 整机发涩；全屏遮罩上代价最大。用纯色/半透明 scrim 代替。
- **全屏透明窗口上不要留无限动画**（`animation:… infinite`）：整块表面每秒重合成 60 次 —— 症状是「只有遮罩显示时才卡」。
- **拖拽只动被拖的那个窗口**：`control` 每次 2 次 IPC 往返，拖动时逐帧把锁窗/菜单窗一起搬 = 每帧 6 次往返。锁窗/菜单窗在拖拽结束时统一归位。
- **拖拽热路径用独立 bus topic**：`bus.publish` 给**每个订阅者各投递一次**，共享 topic 在 5 个窗口 = 每帧 5 次 webview 投递。
- **透传命中区（hit-box）必须由被透传的那个窗口实测上报**：硬编码偏移会在字体/字重变化后漂移；窗口大小按实测 rect 设，且**只在需要时创建**。命中区上的 hover 提示用**内嵌描边**（`box-shadow: inset`），外发光画在窗口外会被裁掉 → 看起来像"被切掉的扁椭圆"。
- **窗口尺寸尽量由内容实测上报，而不是硬编码常量**：在 `max-content` 下 `getBoundingClientRect()` 同步量（强制 reflow 但不绘制 → 无闪烁）。**上报必须去重**，否则「量→改窗→重量」成环。**单轴上报不许把另一轴清零**。
- **`overflow-y:auto` 的滚动容器 `max-content` 高度不可靠**（实测少 ~16px）→ 要测量先去掉滚动。
- **宽度影响高度 → 测量时必须把宽度钉在设计常量上**，否则同一内容在不同窗口宽度下量出不同高度。
- **flex 行里的裸文本是匿名 flex item**：CJK 的 min-content 是**一个字符**，宽度不足时**逐字换行**（看起来像"竖排文字"，其实不是 `writing-mode`）。**flex 子项不会收缩到 min-content 以下** → 溢出被父级 `overflow:hidden` 裁掉（症状：控件"看不见"）。修法：文字项 `flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`，控件 `flex:0 0 auto` + `white-space:nowrap`。
- **`display:flex` 不改 `flex-direction` 就是 ROW** → 切换显示状态时**不要把 `display` 写进 inline style**（会与样式表里的 direction 脱节），用 class 切换。
- **插件窗口一律 `visible:false` 创建，等 UI 报 `hello` 后再 `show()`**：`mountWindow` 跑完前窗口只是 UA 白色页面背景 —— 这就是"创建时白屏几秒"。要配 5s 兜底 show + warn 日志。
- **重窗口（全屏遮罩等）提前预热 + 用 `hide()` 而非 `close()` 复用**：只付一次加载代价。
- **sidecar 只在真正需要时运行**：常驻轮询 helper 会一直占进程并让信封过宿主；只在消费它的阶段启动，阶段结束立刻 `closeStream`（且要在动画 `await` **之前**释放）。
- **`lineJson.decode` 只解一行、不做分帧**，且要求 string；分帧是 transport（`stdioLine`）的职责。
- **`focus:false` 的窗口永远拿不到焦点** → `window.addEventListener('blur', …)` 结束拖拽只会误触发；改用 window 级 `pointerup`/`pointercancel`。
- **同层 `alwaysOnTop` 窗口的 z 序 = 创建顺序** → 后建的遮罩会盖住先建的胶囊，需要重新 `show()` 抬升。
- **WebView2 默认右键菜单**（重载/检查元素）必须 `preventDefault()` 抑制；要覆盖整页得挂 `document`/`window` 级监听。
- **计时/参数改动要"立即生效"**：只在"改的键 === 当前阶段对应的键"时重置该阶段（work 期看 `workMinutes`，rest 期看 `restMinutes`）。
- **`setIgnoreCursorEvents(true)` 是窗口级标志** → 透传窗口收不到**任何**鼠标事件（含 `pointermove`）。**`ctx.log` 只到 webview console，不写 `debug.log`** → 插件的失败原因必须显示在界面上，否则用户与开发者都看不到。

## 8. 调试工具链

- **`{appData}/debug.log` 是第一站**：`--- boot ---` / `message plane:` / `boot ok:` / 每插件状态 / `BOOT FAILED: <stack>` / boot timing / 自检报告。
- **应用内自检** `src/core/selftest.js`（t01–t15）：`await window.__toolbox.selftest()`。`window.__toolbox`：store/events/logger/logs/schemes/transports/sessions/openStreams/selftest。
- **浏览器测不出来 → 用 CDP 进真实 app**：headless 浏览器只能看到"页面"，看不到"app"（插件激活、权限闸、窗口布局）。`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" npm run tauri dev` + `node scripts/app-eval.mjs "<async 函数体>"`（或 `--file probe.js`）。零依赖（Node 内置 WebSocket 讲 CDP）。
- **`scripts/shot.mjs`**：`<url> <out.png> --theme dark|light [--size WxH] [--eval "<expr>"]`，`--no-shot` 只求值（可当无头断言工具）。**验证浅/深成对必须在导航前模拟配色**。
- **headless Edge 能真正"看到"界面**：`msedge.exe --headless=new --disable-gpu --no-sandbox --hide-scrollbars --window-size=W,H --virtual-time-budget=9000 --screenshot=out.png file:///…`（`--virtual-time-budget` 是等 iframe 的关键）。**`--screenshot` 必须绝对路径**。**它不绘制 `type=number` 等表单控件** → 表单截图要用 `scripts/shot.mjs`。
- **`--force-device-scale-factor>1` 会缩小 CSS 视口**（`--window-size` 是设备像素）→ 得到的是另一个布局，不是"放大"。放大截图要用 `transform:scale()` 页面。
- **`dev/plugin-preview.js` + `plugin-preview.html`**：Tauri 之外唯一能看到 `ctx.ui` 输出的地方。坑：① `registry` 不是 `registry.js` 的导出（用 `describeSchemes`）；② **页面里已有 `#app`，别再建同 id 的**（症状是"DOM 里有文字、截图全黑"）；③ panel 要给显式高度。
- **临时探针页手法**：用 mock bridge（`label/protocol/publish/subscribe/request`）调 `mod.mountWindow(bridge)`，状态挂 `window.__probe`，再 `probe.emit(topic,p)` / `probe.sent(act)` 驱动与断言。**参数别用 `?state=<json>`**（URL 编码后 `JSON.parse` 报错），用 `?preset=` 表。用完即删。
- 原生窗口截图：`GetWindowRect` 返回**扩展边框**（偏 ~7px/边）→ 用 `GetClientRect` + `ClientToScreen`。
- **测试外部插件加载**：把 `URL.createObjectURL` 重定向到 `data:` URL，Node 就能真 `import()` 插件源码。浏览器专用依赖在 Node 下要 stub：`tests/browser-stubs-loader.mjs` + `module.register()` —— **任何 import `lifecycle.js`/`ctx.js` 的测试都必须 register 它。** 插件测试里 `globalThis.window.screen` 要同时给 `width/height` 与 `availWidth/availHeight`。

## 9. 静态审计

`tests/plugins.test.mjs` 逐插件检查：manifest 一致性、权限覆盖、视图声明、tag 存在、无死调用、无 `invoke()`/`@tauri-apps` 裸 import、无硬编码颜色、视图不用 `.innerHTML =`。也扫 `examples`。教训（**写完守卫必须注入违规、确认它变红**）：① `codeOnly()` 不认正则字面量 → 吞掉文件后半，产生幽灵死调用；② **用 `codeOnly` 抽 tag 名永远抽不到**（tag 名就是字符串字面量）→ 永远报成功，要用只去注释的 `withoutComments`；③ innerHTML 匹配器太窄。另：**非空断言很值**；**例外清单要断言它命中了**。**删函数时静态检查不会报错，只有点到那个按钮才炸**。

## 10. 插件手册与视图

- **手册 `docs/plugin-dev/`**，只引用不重复 `PROTOCOL.md`/`INTERFACES.md`/`UI.md`/`MESSAGE-FRAMEWORK.md`。**加插件文档先看这里，别另起一套。** 易错：`ctx.registerView(id)` **校验 id 是否在 `contributes.views` 声明**（没声明直接抛）；`contributes.hotkeys` 声明**本身就是权限**；窗口 size/position/alwaysOnTop 归创建它的窗口。
- **五个内置插件视图迁移已完成**：procman 用 `data-act`/`data-ch`/`data-id` 事件委托，**只换 DOM 构建、保留钩子**。**主窗口已无原生控件**（`FormData` 读不到 reka-ui 的 Select/Checkbox → 控件写进 `state.draft`）。刻意保留原生外观三类：插件**自己的窗口**、**标题栏/边框**（OS 画）、**xterm**（canvas）。
- **`examples/plugins/gallery/`** 是组件词汇表活示范（`permissions: []`，零 import）。
- **插件窗口是独立 document**，注入 `<style>` 物理上到不了主窗口 —— 结构性保证。app.css 的 body 背景在 `@layer base` 里，插件 `<style>` 未分层 → **未分层优先于任何 @layer，与顺序无关**。所以插件窗口自动获得 token 与 `.tb-*`。
- **示例部署用 `npm run deploy:examples`**（从各示例自己的 `plugin.json` 发现，替换式）。**手工 `cp -r` 已两次导致"应用里跑的还是旧插件"**。若目标被占用，脚本的 trash 会失败 → 临时用 `cp -f` 覆盖并用 `cmp` 校验。

## 11. 子进程 / 会话

- session = 运行实例；**profile = 持久化描述**。计划**从上次触发起算**（睡过一夜只跑一次）；**手动停止不被重启策略撤销**；重试次数跨重启累加；停用插件清所有定时器。规则在 `src/plugins/procman-supervisor.js`（**纯函数**）。procman 布局定为 `340px 1fr`，两个"新建"入口合并进 Dialog（560px）。
- **`proc/kill_all` 曾一个没杀却回报 `{"killed":N}`**：`close()` 把 Session 连 stop 闭包一起 remove，再 `stop_one` 找不到 → **停止必须 `take_stop`，不能 `close` 之后再 `stop_one`**。
- **Rust 杀进程按 pid（`session::pid_stop`），不要抢 `Mutex<Child>`**：reader 线程在 stdout EOF 后**持锁**阻塞在 `wait()`，抢锁的 kill 会永久挂住（连退出流程一起）。
- **pty 直接驱动 `plugin:pty|*`，不用 `tauri-pty` 的 JS wrapper**（已移除）：wrapper 读循环遇 EOF 静默 return。**Windows ConPTY 的 reader 在子进程退出后不返回 EOF** → "等 EOF 再问 exitstatus"会**死锁**；现在读循环与 exitstatus **并发**观察，读循环自己结束则精确，否则等数据流静默（120ms/上限 1000ms）—— **这一段是启发式，别声称确定性**。**`spawn` 返回插件自己的会话句柄（从 0 计数），不是 OS pid**。登记失败要 **kill 子进程并让 open 失败**，不能 catch 掉（否则成孤儿）。
- **Rescan 是对账不是发现**：新目录加载、摘要变化则 deactivate→重载→激活、摘要相同完全不动、目录消失则卸载并**撤销原生授权**、失败按内容记忆。摘要由原生 `plugin_scan` 返回（FNV-1a 覆盖 plugin.json + 入口），必须**跨进程稳定** → 不能用 `DefaultHasher`。**撤销授权只有宿主能做**（`host/unregister` 校验调用方是 `__host__`）。
- **前端重载会遗留宿主侧会话（已修）**：HMR 换掉前端 JS 上下文但宿主还活着，上次 boot 的会话仍**握着真实 OS 进程**（自检 15/15 → 13/15，且是**假失败**）。修法 `plugin_reap_orphans`，`boot()` 在任何东西开会话**之前**调用，**只允许主窗口**（命令内检查 `window.label() == "main"`）。
- **`Disposer.run()` 会 await 异步清理且幂等**：调用点必须 `await`。

## 12. 环境与约定（本机特有）

- **`npm run tauri dev` 的 beforeDevCommand 是 `npm run dev`**。**1420 被占**时 vite 失败，但 `cargo run` 已启动 app —— app 连上那个 server 照常显示，而 CLI 因 beforeDevCommand 非零退出。症状"命令退出了但窗口还在"。**用完 dev server 一定要关。** 后台进程要挂在工具的 task 上（`nohup npx vite &` 起的会随 shell 退出而死）。
- 本机 `taskkill` 在 Git Bash 里参数被吞；用 PowerShell `Stop-Process -Id <pid> -Force`（该工具不返回 stdout，用 netstat 复核）。
- **⚠️ 绝对不要硬杀 Tauri 应用**：反复 `Stop-Process -Force` 会累积孤儿 `msedgewebview2` 并弄坏 WebView2 profile（症状：窗口全白、页面不加载）。**要让它自己关**。修复：重启机器，或清 `%LOCALAPPDATA%\com.tan18.toolbox\EBWebView`。
- **"窗口全白"的判据**（已 A/B）：浏览器里渲染正常 + `cargo check` 与测试都过 + 回退改动重编依然白 + 换新 profile 也没用 ⇒ **不是代码也不是环境，是非交互 shell 启动的产物**。用户自己 `npm run tauri dev` 一切正常。**推论：应用内验证必须由用户在交互终端里做。** 排查顺序：① 进程有没有 `MainWindowHandle` ② 前端能否渲染 ③ 才怀疑环境。
- **为排查改名 profile 后一定要换回来**（判据是 `du -sh`）：曾把暖 profile 留在 `EBWebView.bak`（新 87M vs 原 234M），导致每次启动多几秒白屏。
- 本环境：`wmic` 被禁用；`csc.exe` 被拦截（用 mingw `gcc`）；PowerShell 工具不返回 stdout（写文件再读）。**本机无法在 `.git/refs/heads/` 下建目录**：`git branch a/b` 静默失败 → **用不带斜杠的分支名**。
- **`cargo test` 的测试二进制无法加载**（STATUS_ENTRYPOINT_NOT_FOUND，tauri-build manifest 只链进 bin）→ **用 `cargo run --example host-checks`**（16 项）。**rustc ICE / `拒绝访问`** = 增量缓存被杀软损坏 → `rm -rf target/debug/incremental` + `CARGO_INCREMENTAL=0`。
- `npm test` = `node --test`（**不要写 `node --test tests/`**）。涉及全局态的 Rust 测试用 `services::serial()`；JS 侧跑真实 boot 前必须 `resetHost()`（清 store + deactivate 释放定时器），否则进程不退出、被 SIGTERM。
- 应用数据目录：`%APPDATA%\com.tan18.toolbox\{debug.log, plugins/, plugin-data/}`；WebView2 配置 `%LOCALAPPDATA%\com.tan18.toolbox\EBWebView`。
- 排查"应用起来了但 JS 不执行"：Rust 侧 `eprintln!` 探针 → `webview.eval()` 写 `document.title` 再 `w.title()` 读回 → `tasklist` 比对 `msedgewebview2` 数量是否随应用启动而增加。

## 13. 验证命令

```
cd src-tauri && cargo check --all-targets   # 零警告（仓库根没有 Cargo.toml）
cargo run --example host-checks             # Rust 侧自检，替代不可用的 cargo test
npm test                                    # node --test
npm run build / npm run deploy:examples / npm run preview:theme / npm run bench
```
应用内：`npm run tauri dev` 后看 `debug.log` 的 15/15。**codec 实测**（`docs/PROTOCOL.md` §2）：字节流必须 raw（4 KiB 块 JSON 慢 126×、大 3.6×）；raw 解码返回 subarray 视图故几乎免费（41 ns）；line-json 比 json-envelope 贵 25–60%，它存在是因为 sidecar 需要分隔符。

## 14. 近期新增硬规则（2026-09）

### 14.1 主线程与命令
- **每个 `#[tauri::command]` 必须 `async fn`**。Tauri 把**没有 `async` 的命令跑在主线程**，而那是给**所有**窗口泵消息的一条线程 → 命令里任何阻塞都变成"整个界面卡"。`async` 只是把它挪出主线程；真正的阻塞 I/O 还要再套 `spawn_blocking`（否则占住 runtime worker，worker 数 = 核数）。守卫 `tests/main-thread.test.mjs` 扫全部命令。**症状永远是"界面卡"而不是"命令阻塞"**，所以必须机器把关。
- `plugin_rpc` 的权限闸必须在 `spawn_blocking` **之外**（闸是同步的、快的；放进去等于白挪）。

### 14.2 capability / ACL
- `src-tauri/capabilities/*.json` 是**源文件**；运行期用的是 `tauri-build` 编译进二进制的 ACL（`OUT_DIR/capabilities.json`），**Cargo 会缓存它**。所以"源文件正确 ≠ 应用有权限"。全窗口权限被拒（`event.listen` / `window.get_all_windows` / `pty.spawn` 一起挂）时先 `wc -c src-tauri/target/debug/build/toolbox-*/out/capabilities.json` —— **`2` 就是空 ACL**（`{}`），`cargo clean -p toolbox` 重建。守卫 `tests/capabilities.test.mjs`（编译产物 + 源文件双重核对）。**清缓存前必须优雅关闭正在跑的应用**，否则 `os error 5` / `LNK1104`。

### 14.3 窗口分发与页面拆分
- **窗口分发改按窗口 label，不按 URL 参数**：只有 label 是 `main` 的窗口 boot 宿主，其余走 `pluginwin-host.js`。**不要写成 `if (mode === 'pluginwin') … else <boot 宿主>`** —— 那个 `else` 会让插件窗口跑起第二个完整宿主（重复注册热键、每个插件再激活一次、procman 再 auto-start 真实进程）。URL 校验要求"入口页 + mode"两个条件。守卫 `tests/window-options.test.mjs`。
- **两个窗口 = 两个页面**：`index.html` → `src/main.js` → `assets/app.css`（外壳）；`pluginwin.html` → `src/pluginwin.js` → `assets/plugin.css`（插件窗口）。**一个页面的样式表是 `<link>`，在模块之前生效 → 只能在页面层选，JS 分支拦不住。** 两份共享 `assets/design-system.css`（令牌 + `.tb-*`）。实测插件窗口 948 KB → **61 KB**。插件窗口 URL = `pluginwin.html?plugin=…&label=…`。

### 14.4 生命周期回收与 host 权限
- **停用插件 = 宿主强制回收一切**：订阅 / 热键 / 主题 / 视图 / streams / sidecars / ptys / **窗口**。窗口是最后补上的那一块（`ctx.windows.create` 曾是唯一没有 `disposer.track` 的资源获取点）。**新增任何"插件获得一个句柄"的 API，都必须同时 `disposer.track` 它的释放** —— 否则停用会留下没人能关的东西（插件的 JS 上下文已经没了）。复用（label 已存在）的窗口**不**回收：那可能是别的插件建的。
- **`host` 服务的写动作必须 host-only**（`unregister` / `stop_session`）：`rpc:host` 是发给插件的，读授权悄悄变成写权力是权限模型腐烂的方式。守卫 `tests/host-kernel.test.mjs`。
- **`stream/close` 按调用者插件 id 定位** → 宿主（`__host__`）匹配不到别人的会话。宿主想停一条得走 `host/stop_session {plugin, ch}`。

### 14.5 契约迁移
- **改契约必须留迁移路径** —— 判断依据不是「仓库里还有谁在用」，而是「**用户机器上已装的是什么**」。本仓库踩过：把插件窗口 URL 从 `index.html?mode=pluginwin&…` 改成 `pluginwin.html?…` 时直接拒绝旧写法 → **所有已装插件开不出窗口**（第三方插件改不到，插件目录里那份是副本），而症状是「什么都没有」（每个调用方都套了 `catch`，插件照常激活，只有窗口不出现）。**做法：在边界处翻译而不是拒绝**（`normalizePluginWindowUrl` 返回规范形状，用返回值创建窗口，旧写法零成本）。

### 14.6 托盘与关闭到托盘
- 主窗口 ✕ = 隐藏（`boot.js` 的 `installCloseToTray`），退出只在托盘右键菜单（`app.exit(0)` → `RunEvent::Exit` → `kill_all()`）。**托盘建不起来是致命错误**（否则应用无法从自己界面退出）。`store.settings.closeToTray` 持久化 —— 注意 `saveSettings` 只写手挑的子集。**主窗口上插件的 `onCloseRequested` 不触发**（窗口没关），所以那条 API 必须由宿主中转。

### 14.7 工具与踩坑
- **任何含反引号 / `$` 的文本都要先写进文件，再用 `-F` 读** —— bash 在双引号里会做命令替换，`git commit -m "…\`x\`…"` 会把消息吃掉（本仓库已踩两次：`python -c` 与 `git commit -m`）。判断标准：**这段文本会不会经过 bash？** 会 → 用文件。
- **用对象当查找表要防原型链**：`NEEDS[m]` 对 `toString`/`constructor`/`valueOf` 会取到 `Object.prototype` 上的函数 → 假失败。用 `Object.hasOwn`。
- **断言只匹配「你期望的那种错误」，就会把「另一种错误」当成成功** —— 本仓库已两次踩到（URL 校验的文案改了，而测试只查旧文案 → 被拒绝了却算通过）。**报错类断言要覆盖整个校验面。**
- **`git restore <path>` 按索引恢复，会连工作区里未提交的修改一起回滚**（本项目有多个并发会话在动同一仓库 → 动它之前先确认别处没在改）。反过来，恢复被误删的文件时它是**纯增量**的，不会覆盖已存在的东西。
- **`git add <已删除的路径>` 会整条失败**（git 先校验全部 pathspec）→ 已暂存的删除不要再 add。

### 14.8 为什么 `win:self` 做不到
- Tauri 的窗口命令**不校验调用者身份** —— 目标窗口由调用者传的 `label` 决定（`window/plugin.rs::get_window`），ACL 只按调用窗口授权（`webview/mod.rs::resolve_access`），window 插件的权限**没有 `scope`**。给插件窗口窗口权限 = 它能操作任意窗口（含主窗口），且能绕开 bridge 直接 `__TAURI_INTERNALS__.invoke`。「限自己」要放在**宿主层**（`control` 的归属校验，当前**缺失** —— 插件 A 能改插件 B 的窗口）。插件窗口动自己的正解是 `bridge.drag()`（原生，零 IPC）。

### 14.9 流提供者权限（本轮新增）
- **`StreamProvider::permission()` 默认 `None`**；`open_json`/`open_raw` 检查它 → 提供者可以要求自己的权限（提供者 **`clipboard`** → `rpc:clipboard`），名单在 `host/schema` 的 `providerPermissions`。守卫在 `examples/host-checks.rs` 的 `provider-permissions-are-published`。
- **规律：拉取 → 服务（service），推送 → 流提供者（stream provider）**。剪贴板读/写是服务（`clipboard/read`、`clipboard/write`），剪贴板**变化**是流（提供者 `clipboard`）。截屏是服务（`screen/monitors`、`screen/capture`），**没有**对应的流。
- **服务权限是派生的**：`plugin_rpc` 里 `is_allowed(plugin_id, &format!("rpc:{svc}"))` → 注册一个服务就自动得到 `rpc:<服务名>`。所以 `rpc:screen` 在源码里搜不到字符串，但**确实被强制**；`tests/plugins.test.mjs` 的白名单也是 `serviceNames().map(n => \`rpc:${n}\`)` 派生的，不会漂移。**只有非服务型权限（`rpc:dialog` / `win:manage`）才需要手写进白名单。**
