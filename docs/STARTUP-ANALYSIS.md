# 开发启动延迟分析

分析日期：2026-11-05。依据本机 `debug.log`、`logs/flight.jsonl`、启动代码和开发依赖缓存。下文先保留修复前证据，已实现的优化见末节。未启动或重启用户应用。

## 重跑后确认的主要瓶颈：Tailwind 扫入 Cargo 构建缓存

上轮优化后，用户重跑仍慢。最新 14:21 的导航相对计时为：`html 135 | entry 10944 | shell-imported 11855 | mounted 11880 | show-requested 11880 | shown 11923 | host-imported 12088`。HTML 到入口正文等待 **10809 ms**，外壳导入 911 ms、挂载 25 ms、显示命令 43 ms，剩余大头已经缩小到入口之前。

`app.css` 原先只写 `@import 'tailwindcss'`，默认从工作目录扫描，而 `src-tauri/.gitignore` 只排除了 `target`，没有排除另一个原生检查构建目录 `target-check`。实际扫描列表有 **7030 个文件**，其中 **6336 个在 target-check 内**；列表中文件大小合计约 **3.38 GB**。这里的字节数是文件大小统计，不是磁盘 IO trace。

使用当前安装的 `@tailwindcss/node` 和 `@tailwindcss/oxide`，对同一份 CSS 做扫描范围 A/B，未运行用户应用：

| 指标 | 原默认仓库范围 | 只扫描前端 src |
|---|---:|---:|
| 扫描文件 | 7030 | 503 |
| 文件大小合计 | 3380498230 B | 997336 B |
| 候选 token | 215841 | 6498 |
| CSS 编译准备 | 59 ms | 67 ms |
| 扫描 | 12907 ms | 314 ms |
| 构建 CSS | 1632 ms | 169 ms |
| 合计 | **14598 ms** | **550 ms** |

前端样式表位于入口脚本之前；慢 CSS 还会阻塞后面的主题内联脚本及入口执行。这与 HTML 已到达、入口迟迟未开始、Rust 心跳持续推进的现场相符。相关规则见 [Tailwind 源检测](https://tailwindcss.com/docs/detecting-classes-in-source-files) 和 [HTML 样式阻塞脚本](https://html.spec.whatwg.org/multipage/semantics.html#interactions-of-styling-and-scripting)。上轮只验证 CSS HTTP 200，没有测首次生成耗时，遗漏了这个实际瓶颈。

本次已将导入限定为 `@import 'tailwindcss' source('../')`，相对于 `src/assets/app.css` 指向 `src`；同时将 `target-check` 标记为 Git 构建产物。缓存文件保留。新增回归使用真实编译器和 scanner，确认 App 源文件被扫描、测试专用 token 与 Cargo 产物不进入样式源，并生成实际布局规则。

修复后新 Vite 实例的首次 CSS 转换为 **1293 ms**，其中扫描 112 ms、依赖登记约 649 ms；再次请求命中缓存为 0 ms。它包含 Vite 开销，与上表直接编译口径不同。生产构建 7.62 秒，373 项 Node 测试通过。新增 `startup CSS requests (ms)` 会记录浏览器实际 CSS 资源请求耗时；完整 WebView 冷启动总时间仍待新日志对照。

## 最初分析的时间线

用户所报的最近一轮，换算为北京时间：

| 时间 | 事件 |
|---|---|
| 13:52:36.965 | WebView2 输出 DPI awareness 错误 |
| 13:52:37.038 | WebView2 输出 Edge LLM 不支持提示 |
| 13:52:37 | 宿主飞行记录开始，`ms=0` |
| 13:52:42 | 已过约 5 秒，原生兜底显示窗口；首个快照显示 main 可见，JSON 网关调用数仍为 0 |
| 13:52:46.081 | 前端进入 `boot()`，写下首条 boot 日志 |
| 13:52:48 | 前端完成初始化，累计耗时 2730 ms，6 个插件均 active |

这次等待约由 **9 秒 boot 前阶段 + 2.73 秒 boot 内阶段**组成。Rust 编译已在 0.56 秒结束；5 秒提示来自 `lib.rs` 的独立线程兜底，不是一个耗时 5 秒后失败的编译或网关命令。

同日四次新的宿主进程，宿主记录开始至首次前端 boot 的间隔分别约为 18、10、8、9 秒，随后 boot 内耗时分别为 4147、3197、2469、2730 ms。它们均完成初始化。最近一次前 10 秒，beat 从 5 增到 10，PTY 原生资源为零；这些证据不支持把当前启动等待归为之前的 PTY worker 饥饿。

## 修复前启动路径的问题

### 1. 首屏之前加载了插件、调试和设置页依赖

入口的依赖关系包括：

```text
main.js → 静态 boot.js → plugins.js → registry.js → 三个内置插件 → xterm 等依赖
                     → debug.js / selftest.js → 宿主内核与内置插件
main.js → await App.vue → 静态 SettingsView.vue → boot / lifecycle / plugins 与设置组件
```

ES 模块的静态依赖在模块正文执行前加载和求值。因而还没调用 `boot()`、没渲染首屏，已经需要加载上述依赖。`App.vue` 虽然在用户点击 Settings 时才渲染设置页，但设置页的静态 import 仍在初始加载路径上；入口只把 `boot` 改成动态 import，也会被这条设置页依赖路径重新连回宿主。

本机现有开发预构建缓存中，`@lucide_vue.js` 约 1.31 MB、`@xterm_xterm.js` 约 0.41 MB。体积说明启动路径包含较重依赖，不是对每个依赖耗时的测量。Vite 官方说明开发时按请求转换模块，依赖发现、聚合导出文件和请求瀑布都可增加首屏等待，见 [性能说明](https://vite.dev/guide/performance)。

**证据边界**：目前能确定延迟位于宿主启动后至前端 boot 前。没有浏览器网络瀑布或入口分段计时，尚不能把其中 9 秒全部归因于模块加载；WebView 导航、样式转换及挂载耗时也在这个范围内。

### 2. 隐藏窗口的显示依赖两次动画帧

`tauri.conf.json` 将主窗口设为 `visible: false`；`main.js` 挂载外壳后，经过两层 `requestAnimationFrame` 才调用 `show()`。隐藏页面的渲染机会可能被暂停或限制，因此这条链存在等待显示才能获得动画帧、又等待动画帧才显示的时序风险。

[HTML 渲染规范](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering) 在处理渲染更新前过滤 hidden 文档；[WebView2 可见性文档](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller#get_isvisible) 也说明隐藏状态会限制动画等活动。

本次前端 boot 到第 9 秒才开始，已经晚于原生 5 秒兜底，所以即使动画帧正常执行，也会触发该提示。现有日志没有记录两次 rAF 的时刻和页面 visibilityState，不能证明本次额外卡在 rAF 上。

### 3. boot 内主要在等待完整组件词汇表

最近一次日志是累计标记：`debug 18 | reap 25 | uikit 2243 | schemes 2251 | builtins 2504 | external 2709 | hotkey 2730`。

据此，`loadUiKit()` 本身约 2218 ms，内置插件激活约 253 ms，外部插件约 205 ms。`uiComponents.js` 枚举所有组件目录入口，`loadUiKit()` 再并行加载全部模块；这里确有约 2.2 秒启动成本。`plugin load` 的数字只反映激活执行，不能用来排除首屏之前已加载的插件模块成本。

现有 `boot timing` 从 `boot()` 正文开始计时，遗漏之前的 8–18 秒，所以它不能代表用户看到的总启动耗时。

## 三条输出如何解释

- `failed to set WebView dpi awareness of 2`：WebView2 的 DPI 设置错误。现有日志没有记录对应耗时或失败链；随后应用正常 boot，不能仅凭这条 ERROR 就认定它导致整个等待。
- `Edge LLM: Not supported on WebView2`：WebView2 内部模型功能提示。项目的启动路径没有使用这个功能，也没有证据将它与当前等待建立因果。
- `frontend did not reveal ... within 5s`：项目自己的兜底提示；说明前端尚未完成显示动作，不能直接证明前端异常、插件死锁或 IPC 故障。

## 修复前提出的优化顺序

1. 给 HTML 到达、入口模块正文开始、App 导入完成、挂载完成、两次 rAF 和 show 完成分别计时，补齐总启动耗时的缺口。
2. 首屏只加载必要外壳；设置页按需导入，内置插件模块与自检代码移出首屏依赖路径，检查反向 import 是否又把宿主连回入口。
3. 显示窗口以外壳 DOM 就绪为条件，避免让隐藏窗口依赖动画帧才能显示；保留原生异常兜底。
4. 再根据阶段测量优化完整组件词汇表的加载。仅增加 5 秒兜底时限不会减少实际等待。

尚未完成真实 WebView 冷启动秒数的前后对照，未对 DPI、GPU 或 WebView2 运行时配置作调整。

## 已实现的优化与验证（2026-11-05）

- 主窗口在 `mount()` 和 Vue `nextTick()` 完成后直接请求显示，去掉两层 rAF；隐藏页面不派发动画帧时，启动仍可继续。原生 5 秒异常兜底保留。
- 宿主模块改为显示请求完成后再动态导入。设置页改为异步组件，切断外壳经 Settings 静态导回宿主的路径；自检在实际调用时才加载。
- 主样式表在 HTML 中直接声明，让 Vite 更早处理 CSS，与入口依赖加载并行。
- 增加 HTML、入口、外壳模块、DOM 就绪、显示请求、显示返回和宿主模块完成的导航相对计时；进入 boot 后写入 `debug.log` 的 `startup timing (ms since navigation)`。旧的 `boot timing` 继续表示 boot 内累计时间。

首屏入口与 App 的本地静态脚本依赖按同一遍历口径由 **84 个降至 22 个**，不含 npm 包内部模块。生产构建清单确认宿主和 Settings 是动态入口，首屏所需 chunk 中未包含内置插件或 xterm 实现。这是加载范围的验证，不是启动秒数的实测收益。

验证：372 项 Node 测试通过；生产构建通过；临时 Vite 服务的首页、CSS、入口均 HTTP 200，CSS 返回 `text/css` 且包含应用样式。该 HTTP 检查经批准在沙箱外执行，结束后关闭服务，没有运行用户的 Toolkit 或插件。

下一次 `tauri dev` 的日志可以区分：`entry - html` 反映入口前等待，`shell-imported - entry` 反映外壳模块等待，`mounted - shell-imported` 反映挂载，`shown - show-requested` 反映显示命令往返，`host-imported - shown` 反映宿主加载。`shown` 是前端显示命令成功返回的时刻，不能替代原生兜底第一次显示窗口的时刻；显示失败时不会记录 `shown`。
