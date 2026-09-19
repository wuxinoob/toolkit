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
- **6 服务 / 29 动作**：storage(get/set/remove/keys) · host(info/write_debug_log/sessions/plugins/schema/unregister) · stream(close/providers/list/session_open/session_close/open_in/write_in/close_in) · proc(spawn/send/recv/kill/kill_all/list) · bus(publish) · hotkey(register/unregister/unregister_all/list)。
- **8 方案**：rpc · channel-in · channel-json · channel-raw · event-bus · stdio-line · pty-stream · in-process。流提供者：ticker / blob。
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

## 错误码与上行流（P0，已完成）
- **错误码是闭集**：14 个码定义在 `protocol/codes.rs`，`protocol/codes.js` 是镜像，
  **`tests/codes.test.mjs` 解析两个文件比对**。服务错误用 `ServiceError`（`Result<_, ServiceError>`），
  不再报 `{svc}/{act}`；`host/schema` 与 `ctx.protocol.Code` 都公布词表。
  改这类代码时注意：**编译器抓不到**经 `From` 静默变成 `internal` 的点
  （`?` 作用在 `Result<_, String>`、`Err("...".into())`、`ok_or("...")`），必须手工枚举定性。
- **上行流 `channel-in`**：`ctx.uplink(ch, {sink})` → 同形句柄 + `sendBatch`；帧交给命名的
  宿主侧 sink（首个是 `proc`，每帧一行 line-json 进 sidecar stdin），sink 名单在 `host/schema`。
- **框架事实：Tauri 的 `Channel` 是单向的**（JS 侧只有接收回调，**没有 `send`**），
  所以没有插件→宿主的推送载体 —— 上行流的载体是**批量 invoke**，这是框架约束而非设计选择。
  遇到"想从 JS 推给 Rust"的需求，不要再去找 Channel。

## 调试闭环（关键基建，别删）
- `boot()` 把启动过程自报到 `{appData}/debug.log`：`--- boot ---` / `message plane:` / `boot ok:` / 每插件状态 / `BOOT FAILED: <stack>`。**排查运行期问题先看这个文件。**
- dev 启动自动跑应用内自检（`src/core/selftest.js`，t01–t15），报告同样落盘；随时可 `await window.__toolbox.selftest()`。
- `window.__toolbox`：store/events/logger/logs/schemes/transports/sessions/openStreams/selftest。

## 界面：设计系统是 CSS，不是组件库
- **外部插件是 Blob URL 单文件 ESM，无法 import 任何东西** → JS 组件库（shadcn-vue / HeroUI）
  永远到不了它们；Tailwind 工具类也只生成"扫描到的"类，插件源码在项目外 → 同样到不了。
  所以观感靠 **`src/assets/app.css` 里的 `.tb-*` 普通 CSS 类**（`@theme` 令牌 +
  `@layer components`），插件只用类名即可。详见 `docs/UI.md`。
- **HeroUI 官方只有 React**；shadcn-vue 是成熟 Vue 方案，而 shadcn 的观感来自 token 层。
- **主题是 `<html>` 上的一个属性，不是换样式表**：`@theme` 定义深色，`:root[data-theme='light']`
  覆盖同一批 token。这是唯一能让 Blob URL 插件被主题化的方式 —— 它们 import 不了东西，
  但**能继承自定义属性**。`src/host/theme.js`（system/light/dark，跟随
  prefers-color-scheme，localStorage 持久化，跨窗口用 `storage` 事件**推送**而非轮询）；
  每个窗口 mount 前各调一次 `initTheme()`。`index.html` 有内联预置脚本 —— 打包后 CSS 是
  独立 `<link>`，先于模块生效，不预置则浅色用户每次开窗闪一帧深色。
- **加颜色 token 必须同时改 `@theme` 和浅色块**，否则该颜色在浅色下仍是深色值，静默出错。
  `tests/plugins.test.mjs` 会失败。浅色 `--color-brand` 用 #2f6bd8（深色的 #6f9cf5 在白底上
  文字对比度不够）。`accent-color` 让裸 checkbox/radio/range 自动跟随主题。
- **两个不能继承 token 的特例**：xterm 是 canvas，必须给具体对象（procman 的
  `readTermTheme()` 从 document 读 token 构造，并订阅主题变化重新着色 —— 唯一一处 token
  被复制进 JS）；透明窗口（floatwin）需要 alpha，用
  `color-mix(in srgb, var(--color-surface) 97%, transparent)`，仍然零 JS。
- **控件样式的三档边界**（详见 `docs/UI.md`）：完全可改（`appearance:none` 自己重画）／
  只能改色（`accent-color`）／完全够不到（`<select>` 弹层、date 日历、color 取色器、
  窗口标题栏 —— 唯一杠杆是 `color-scheme`）。规则：**把闭合态做足，弹层交给 color-scheme**。
- **状态写在 ARIA 里，不另设修饰类**：选中行 `aria-selected`、tab `aria-selected`、
  开关 `aria-pressed`，样式表挂属性选择器 —— 同一份标记对读屏器和主题都正确，不会漂移。
- **overlay 容器不用 absolute、不设 pointer-events:none**：前者让空容器吞掉全应用点击，
  后者被子元素继承会让 overlay 按钮永远点不动。插件自己定位（eyecare 用 `.tb-screen`）。
- Tailwind 工具类用于外壳与**内置**插件（它们被打包）；`.tb-*` 用于所有地方。
- **类名方案的成本是拼错的类名不报错、只是不生效** → 有测试核对插件用到的每个 `.tb-*`
  都在样式表里有定义。
- **`contributes.theme`：插件声明式覆盖设计令牌（已实现，`src/host/pluginTheme.js`）**。
  插件写 `{dark:{'--color-brand':…}, light:{…}}`，宿主生成
  `:root[data-theme='dark'] [data-plugin='x']{…}`。**两套主题都提前生成、靠 data-theme
  选择** —— 切主题不需要任何 JS 重注入。
  - 作用域三处：`ViewHost` 设视图挂载点、`ctx.ui.mountOverlay` 设 overlay 内容、
    插件窗口设到 `<html>`（`[data-plugin='x']` 匹配任何元素含根元素，一条选择器全覆盖）。
  - **值校验是安全核心**：CSS 声明以 `;`/`}` 结束、`<style>` 以 `<` 结束，所以直接拒绝
    `; { } < > \ @` 与换行 —— 这些字符不在，值就只能是值。另拒 `url(`/`image-set(`/
    `expression(`/`-moz-binding(`（`url()` 会把颜色令牌变成对任意主机的请求）。
  - 坏贡献**只报告不致命**（进插件日志 → debug.log）：失败模式是静默的，令牌名写错
    插件只是"看起来正常"。
  - **必须同时声明两套主题**，只声明 dark 的插件在一个主题下会半残（有测试拦）。
  - 范例是 `examples/plugins/hello`（`main.js` 里零 CSS，紫色全来自声明）。
  - 导出 `serializeThemeCss` 供 `scripts/build-theme-preview.mjs` 复用，
    预览与宿主跑同一份序列化代码，不可能漂移。
- **UI 自由度四级阶梯**（`docs/UI.md`）：L0 用 token / L1 插件自建调色板 /
  **L2 `contributes.theme` 已实现** / L3 注入插件自带 CSS（没有 L4 别做：未加作用域的
  插件 CSS 能重写整个应用）/ L4 shadow DOM + 所有 shadow root 共享同一个
  `adoptedStyleSheets` 的 CSSStyleSheet（O(1)，自定义属性可穿透 shadow 边界）。


## 子进程管理：profile（自启 / 定时 / 重启）
- session = 运行实例；**profile = 持久化描述**（跑什么、怎么跑、**什么时候跑**）。
- 计划**从上次触发起算**（睡过一夜只跑一次，不补跑一串）；**手动停止不被重启策略撤销**；
  重试次数跨重启累加；停用插件时清掉所有定时器。
- 规则在 `src/plugins/procman-supervisor.js`（**纯函数**，可脱离时钟与 pty 测试）。

## 约定与坑
- **Tauri capability 会静默拒绝 JS 调用**（错在监听器里被吞，界面上只表现为"没反应"）：
  改 `src/**` 里任何 `getCurrentWindow()` / `WebviewWindow` 调用后，必须同步
  `src-tauri/capabilities/*.json`。`tests/capabilities.test.mjs` 会核对（从构建生成的
  `acl-manifests.json` 展开 `core:default` 得到实际授权集）。
  - **`onCloseRequested` 需要 `allow-destroy`，不是 `allow-close`** —— Tauri 的实现是
    `handler(); if (!prevented) destroy()`。`core:window:default` 只有 28 项**只读**权限，
    两个都没有；没有监听器时关闭走原生路径，一旦有监听器就必须自己授权。
  - `ctx.windows.onCloseRequested` 已包 try/catch：处理函数抛错会让窗口**永久关不掉**。
- **Rescan 是对账，不是发现**：新目录加载、摘要变化则 deactivate→重载→激活、摘要相同
  完全不动、目录消失则卸载并**撤销原生授权**、失败按内容记忆（同内容不重试，变了才重试）。
  摘要由原生 `plugin_scan` 返回（FNV-1a 覆盖 plugin.json + 入口），必须**跨进程稳定**
  → 不能用 `DefaultHasher`。重新加载**不改变**持久化的启用状态。
- **撤销授权只有宿主能做**：`host/unregister` 校验调用方是 `__host__`，插件不能撤销别人的。
- **会话的停止必须 `take_stop`，不能 `close` 之后再 `stop_one`**：`close()` 会把 Session
  连同 stop 闭包一起 remove（"只注销不停止"），再 `stop_one` 找不到记录、闭包永不执行。
  `proc/kill_all` 曾因此一个进程都没杀却回报 `{"killed": N}`。
- **Rust 侧杀进程按 pid（`session::pid_stop`），不要抢 `Mutex<Child>`**：reader 线程在
  stdout EOF 后会**持锁**阻塞在 `wait()`，抢锁的 kill 会永久挂住（连退出流程一起）。
- **`Disposer.run()` 会 await 异步清理且幂等**：调用点必须 `await`，否则资源可能在
  拆卸之后才完成登记。
- 外部插件是 **Blob URL 单文件 ESM**，不能 import 协议模块 → 用 `ctx.protocol` / `bridge.protocol`。
- 测试外部插件加载时，把 **`URL.createObjectURL` 重定向到 `data:` URL**，Node 就能真正
  `import()` 插件源码，不必 mock 掉加载路径。
- **pty 直接驱动 `plugin:pty|*` 命令，不用 `tauri-pty` 的 JS wrapper**（该包已从
  `package.json` 移除）：wrapper 的读循环以 EOF 结束就**静默 return**，调用方看不到
  "输出结束"。
  - **平台事实：Windows 上 ConPTY 的 reader 在子进程退出后不返回 0（EOF），会一直挂着**
    （伪控制台只在 master 被 drop 时才关闭）。所以"等 EOF 再问 exitstatus"会**死锁** ——
    这个坑已在真机上踩过。现在的做法：读循环与 exitstatus **并发**观察，读循环自己结束
    则精确；否则进程消失后等数据流静默（120ms/上限 1000ms）—— **这一段是启发式，别声称确定性**。
  - **`spawn` 返回的是插件自己的会话句柄（从 0 开始的计数器），不是 OS pid** ——
    当 pid 用会让退出流程 `taskkill` 到无关进程。pty 会话注册时**不带 pid**。
  - 登记失败要 **kill 子进程并让 open 失败**，不能 catch 掉（否则成为孤儿）。
- **示例插件部署用 `npm run deploy:examples`**（从 identifier 推导应用数据目录，替换式）。
  手工 `cp -r` 已经两次导致"应用里跑的还是旧插件"。
- 涉及全局态的 Rust 测试用 `services::serial()` 串行化；JS 侧跑真实 boot 前必须 `resetHost()`（清 store + deactivate 释放定时器），否则进程不退出、`node --test` 会被 SIGTERM。
- `npm run test` = `node --test`（不要写 `node --test tests/`，Windows 下会被当模块路径）。
- 浏览器专用依赖在 Node 下要 stub：`tests/browser-stubs-loader.mjs` + `module.register()`。
- `target/` 可能被杀软/文件锁干扰，出现 `拒绝访问` 或 rustc ICE → `rm -rf target/debug/incremental` 后重编。
- **本机无法在 `.git/refs/heads/` 下创建新目录**：`git branch a/b` 静默失败（`update-ref` 甚至返回 0），
  手动 mkdir 出的目录下一条命令就消失 → **用不带斜杠的分支名**。另有 `tests/`、`docs/` 整个目录被删过
  （`git checkout -- .` 可恢复）、`.git` 整个消失过（见 2026-09-15）。写 `.git` 的操作建议放到沙箱外执行。
- 应用数据目录：`%APPDATA%\com.tan18.toolbox\{debug.log, plugins/, plugin-data/}`；WebView2 配置目录 `%LOCALAPPDATA%\com.tan18.toolbox\EBWebView`。
- 静态审计支持 `// audit-ignore-next-line` 标记（用于插件里的故意负向测试）。
- **重构删了函数、漏了一个调用点**这类 bug 有专门的静态审计
  （`plugins: no plugin calls a function it never declares`）：`codeOnly()` 剥掉注释与
  字符串/模板字面量的**文本**但保留 `${}` 里的代码（否则大段 HTML 模板会被当代码读），
  收集声明名（声明/导入/形参/对象方法简写），找出所有裸调用（排除 `x.foo()` 与关键字），
  差集即违规。**删函数时静态检查不会报错，只有点到那个按钮才炸** —— 已踩过。
- 本环境限制：`wmic` 被安全策略禁用；PowerShell 工具不返回 stdout → 让它把结果写入文件再读。
- **headless Edge 可以真正"看到"界面**（本机没有 playwright，也没有其浏览器缓存）：
  `"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu
  --no-sandbox --hide-scrollbars --window-size=W,H --virtual-time-budget=9000
  --screenshot=out.png file:///…`。`--virtual-time-budget` 是等 iframe 加载的关键，
  截图能拿到 iframe 内容。**改完主题/样式后用它核对，比开两个窗口来回切快得多。**
- `docs/theme-preview.html` 由 `npm run preview:theme`（`scripts/build-theme-preview.mjs`）
  从 **dist 里的构建产物**生成，两套主题并排（两个 iframe，因为选择器是 `:root[data-theme]`）。
  读构建产物而不是源码，所以顺带能抓到 Tailwind 漏掉的 token；生成前校验关键选择器存在，
  否则拒绝产出误导性的预览。**需先 `npm run build`。**
- **本机 `cargo test` 的测试二进制无法加载**（STATUS_ENTRYPOINT_NOT_FOUND）：根因是 tauri-build 的 manifest 只链进 bin 目标（无 manifest → 绑 comctl32 v5，代码导入 v6）。`build.rs` 已把 `resource.lib` 转发给 `-examples` → **用 `cargo run --example host-checks` 做 Rust 侧验证**（16 项）。cargo 没有 `-tests` link-arg，通用 `rustc-link-arg` 会与 bin 冲突（LNK1123）。
- rustc ICE / `拒绝访问` = 增量缓存被杀软损坏 → `rm -rf target/debug/incremental` + `CARGO_INCREMENTAL=0`。
- 排查"应用起来了但 JS 不执行"：Rust 侧 `eprintln!` 探针 → `webview.eval()` 写 `document.title` 再 `w.title()` 读回 → `tasklist` 比对 `msedgewebview2` 数量是否随应用启动而增加。

## 验证命令
`cargo test`（39，本机不可用见下）· `cargo check --all-targets`（零代码警告，**要在 `src-tauri/` 下跑**，仓库根没有 Cargo.toml）· `node --test`（129）· `npm run build` · `cargo build` · `npm run deploy:examples`（把示例部署进应用数据目录）
`cargo run --example host-checks`（16 项，替代不可用的 cargo test）· `npm run bench`（codec 实验，**刻意不并入 npm test**：时间敏感）
`npm run preview:theme`（生成两套主题并排的设计系统预览，需先 build）
应用内：`npm run tauri dev` 后看 `%APPDATA%\com.tan18.toolbox\debug.log` 的 15/15。

**codec 实测结论**（详见 PROTOCOL.md §2）：字节流必须 raw（4 KiB 块 JSON 慢 126×、大 3.6×）；
raw 解码返回 subarray 视图故几乎免费（41 ns），成本在产出侧；line-json 比 json-envelope 贵 25–60%，它存在是因为 sidecar 需要分隔符。

详细协议见 `docs/PROTOCOL.md`；接口清单与统一性核查见 `docs/INTERFACES.md`；设计与现状分析见 `docs/MESSAGE-FRAMEWORK.md`。
