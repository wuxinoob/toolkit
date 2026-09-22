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
- **本项目是 Tailwind v4.3，且没有 `tailwind.config.js`**（v4 是 CSS-first：`@theme` / `@source`）。
  **`safelist` 在 v4 里已被移除**（`node_modules/tailwindcss/dist/lib.mjs` 里搜不到这个词），
  等价物是 `@source inline("...")`（支持花括号展开与范围，如 `{hover:,}bg-red-{50,{100..900..100},950}`），
  排除用 `@source not inline(...)`。**别照抄 v3 的 `tailwind.config.js` 方案** —— 那个文件不存在。
  v4 自动扫描项目内除 `.gitignore`/`node_modules`/二进制/CSS/lockfile 外的所有文件，
  所以 `src/plugins/*.js` **本来就被扫**（实测：shell 的工具类与任意值 `max-w-[900px]` 都进了产物）。
- **不要给插件加 Tailwind safelist**（已评估并否决，2026-09-19）：外部插件在
  `%APPDATA%\com.tan18.toolbox\plugins\` 下，**构建发生在插件存在之前**，白名单只能是固定词汇表，
  覆盖不了组合空间（颜色×明度×属性×变体×断点），漏掉的类名静默失效 —— 和拼错 `.tb-*` 同类问题
  但词汇表大得多、无文档。当前做法（手写 `.tb-*` 常驻 CSS + 内联样式做布局）已经解决同一问题，
  且产物只有 28K / **6KB gzip**（拉入 376 个组件后已涨到 **164K / 26KB gzip**，见下文）。内置插件实测用 **0 个** Tailwind 工具类。
  真要更多自由度 → 走 L4（shadow DOM），而不是扩大白名单。
- **「导出类名字典」（`UI_TEMPLATES = { buttonPrimary: '…' }`，CVA 那套）在本项目同样不适用**
  （2026-09-19 评估）：对内置插件，常量与内联写法**都在扫描范围内、效果完全相同**，
  它带来的是可维护性而非扫描能力；对外部插件**结构性失效** —— 常量在宿主源码树里，
  而 Blob URL 插件 import 不了任何东西。本质上它是 `.tb-*` 的较弱版本：
  `UI_TEMPLATES.buttonPrimary` ≡ `.tb-btn`，区别是前者依赖扫描且外部够不到，
  后者是 CSS 永远输出且人人可用。**本项目已选后者，别往回退。**
  另：**当前没有也不建议引入 UI 组件库**（全项目仅 3 个 `.vue`，`src/components/` 只有 ViewHost）。
  若将来只为外壳引入 shadcn-vue，必须先把它的 token 层映射到本项目已有的 `--color-*`，
  否则会出现第三套颜色；且要清楚它**只覆盖外壳**，插件仍走 `.tb-*`。
- **让外部插件用上「组件库级」美化：推荐 `ctx.ui` 组件工厂（已评估，尚未实现）**。
  拆解：组件库 = 样式 + 行为。样式外部插件今天就能拿到（`.tb-*` + token）；**缺的是行为**
  （对话框焦点陷阱、下拉键盘导航这类需要 JS 的东西），因为要 import。
  - **关键观察：宿主已经解决过同一问题一次** —— `ctx.protocol` 就是把插件 import 不了的东西
    **作为参数递过去**。组件工厂是同一手法的新用法，不是新机制。
  - 设计约束：① 标签名 = `.tb-*` 去前缀（`el('card')` → `<div class="tb-card">`），
    只有一份词汇表，工厂不可能与 CSS 漂移，现有审计可扩展成"工厂接受的每个标签都有对应类"；
    ② 返回真 DOM 节点，插件没有框架；③ `variant`/`size` 映射到 `tb-*-variant`；
    ④ 事件处理器由宿主挂载并交给 ctx disposer 释放（避免监听器泄漏）；
    ⑤ 发出的类基于 token → 自动跟随主题、自动尊重 `contributes.theme`；
    ⑥ 同时挂到 `bridge`（`makeBridge` 已镜像 ctx），插件窗口同样可用；
    ⑦ **不需要新权限**（只构造 DOM，符合"观察不等于能力"）；⑧ 走 `HOST_API` 版本号。
  - 落地顺序：先做插件真会伸手的 6 个原语（card/button/input/row/badge/pane），别一次做全。
  - 与 `contributes.theme` 组合：工厂发出的类基于 token，而插件主题覆盖作用于它自己的子树
    → **用工厂搭的界面自动带上插件自定义主色，插件零代码**。这比"给插件一套组件库"更好，
    后者会绕过主题系统。
  - 次选：C「宿主类包」其实就等于**把 `.tb-*` 做厚**（项目一直在做，无需新机制）；
    陷阱是别搬 shadcn 的类名进来（会出现第三套颜色）。
  - 逃生舱：B「插件自带 CSS」= 自由度上限，但**必须先有 L4**，否则裸 `<style>` 是全局的。
- **复用 shadcn-vue 实现方案 A：可行（2026-09-19 核实）**。官方文档确认
  **完整支持 Tailwind v4**（"Full support for the new `@theme` directive and `@theme inline`"），
  所以版本不卡。它的 token 机制与本项目**同构**（自定义属性 + `var()` 间接层），
  适配是"映射"而非改造。组件是 **copy-in**（"no hidden abstractions"，代码进你的仓库、可改、
  升级手动）。额外依赖：`reka-ui`（行为原语）、`lucide-vue-next`、`tailwind-merge`+`clsx`（`cn()`）、
  `tw-animate-css`。toast 已废弃改用 `sonner`。每个原语带 `data-slot` 属性。
  - **三个必须处理的适配点**：① **`dark:` 变体必须重定向** —— shadcn 组件类带 `dark:` 前缀，
    Tailwind 默认跟随 `prefers-color-scheme`，而本项目用 `data-theme`；v4 一行：
    `@custom-variant dark (&:where([data-theme='dark'], [data-theme='dark'] *));`
    **不改这行，组件在浅色主题下会有一半是深色。**
    ② **token 命名要合并不能并存** —— shadcn 的 `--primary`/`--background`/`--card` vs 本项目的
    `--color-brand`/`--color-canvas`/`--color-surface`。只加别名迟早分叉；建议按 shadcn-vue v4 的
    推荐形态重构：原始值放 `:root` / `:root[data-theme='light']`，`@theme inline` 里
    `--color-brand: var(--brand)`、`--color-primary: var(--brand)` —— 这样别名自动跟随主题，
    **而且现有那条"每个颜色 token 必须在两套主题里都有定义"的测试会直接覆盖新 token，守卫不用改。**
    ③ **复合组件的 teleport 会逃出插件作用域** —— Dialog/DropdownMenu/Tooltip 走 reka-ui，
    默认 teleport 到 `document.body`，就**不在 `[data-plugin='x']` 子树里了，`contributes.theme`
    对弹层失效**（会出现"按钮是紫的、弹窗是蓝的"这种极难查的现象）。工厂必须把 portal 目标
    默认设成插件自己的容器（reka-ui 的 `Portal` 支持 `to`）。
  - **API 形状要调整**：有状态组件不能返回裸 DOM 节点。无状态原语返回 `HTMLElement`；
    有状态组件返回句柄 `{ el, open(), close(), destroy() }`，且 `destroy()` 必须接到 ctx disposer
    （`app.unmount()`），否则插件卸载后 Vue 实例还在。
  - **组件白名单 vs 上一轮否决的工具类白名单，不是一回事**：前者单位是**组件**（可枚举、有名字、
    有 props 文档、漏了会直接报错、可审计、走 HOST_API 版本号）；后者是**工具类**（组合爆炸、
    无文档、漏了静默失效）。**"被设计的 API" 可行，"没被设计的集合" 不可行。**
  - **最大代价：外壳要不要一起迁**。工厂渲染 shadcn 而外壳仍是 `.tb-*` → 两种视觉语言
    （几何/圆角/间距不同）。倾向**外壳一起迁**（只有 3 个 `.vue`，成本不高），
    否则不是"复用组件库"而是"又造了一套"。体积也会明显增长（**实测已经是 164K raw / 26KB gzip**）。
  - 落地顺序：token 合并 + `@custom-variant dark`（地基，可独立验证）→ 迁外壳验证映射 →
    抽工厂（6 个原语 + portal 修正）→ 审计（工厂词汇表 == 已安装组件）→ 组合组件（teleport/destroy）。

## shadcn-vue 实际落地记录（2026-09-19，外壳已迁完）

- **组件用 `npm run shadcn:pull`（`scripts/shadcn-pull.mjs`）拉**，不用 CLI：
  `npx shadcn-vue add` 报 "Failed to fetch from registry"，但 registry 本身 HTTP 200 可达
  —— 是 CLI 的 fetch 层的问题。脚本直接拉 registry JSON 落盘，并记录来源 URL + 每个文件的
  sha256（`.shadcn-lock.json`），解决 copy-in 模型"不知道是哪个上游版本"的问题。
  - **registry 的 `dependencies` 字段不可信**：button 只声明 reka-ui，但它的 index.ts
    import 了 `class-variance-authority`。脚本改为从**实际文件内容**扫 bare import 才不漏。
  - 注册表里组件是 **TypeScript**，保留原样（Vite 剥类型，上游更新可直接套用）。
- **`typescript` 必须是 `^5`，不能用 7。** `@vue/compiler-sfc` 解析
  `defineProps<ImportedType>()` 的导入类型时需要文件系统访问权，走的是 `ts.sys`；
  **TS 7 没有 `ts.sys`**，于是报 "No fs option provided to compileScript in non-Node
  environment"（装 TS 之前是 "Failed to load TypeScript"）。这是个很绕的报错链。
- **shadcn 的原始变量名必须做成"兼容层"，不能只做 Tailwind 别名**：组件不只吃 utility
  class，还在**内联样式里直接读上游变量名** —— sonner 用 `var(--popover)` /
  `var(--border)` / `var(--radius)`。缺了它们，声明在计算值阶段失效，元素静默回退。
  所以 token 层是**四层**：规范值（`:root`，每主题一处）→ shadcn 兼容名
  （第二个 `:root`，`var()` 引用规范值）→ `@theme inline` 别名（两套命名指向同一个
  规范变量，永不漂移）→ `.tb-*` 原语。
- **`vue-sonner/style.css` 必须自己 `@import`**（组件不 import 它自己的 CSS）。
  缺了之后 toaster 的 `data-y-position="bottom"` 是对的但 `position: static`
  —— 它照样渲染，只是停在普通流里，看起来像"位置配错"。未分层的 CSS 优先于
  Tailwind 的 `@layer`，所以 import 位置无所谓。
- **lucide 用 `@lucide/vue`**（新组件 12 处全用它），被弃用的 `lucide-vue-next` 已移除。
- **`store.js` 不依赖渲染器**：toast 改为可插拔 sink（`setToastSink`）。store 管"何时
  产生消息"，外壳管"怎么显示"（App.vue 装 sonner）。默认 sink 是自过期队列，
  所以 `node --test` 仍能 import store。
- 外壳只用 Tailwind 工具类 + shadcn 组件，**只剩 `.tb-overlay` 一个 `.tb-*`**
  （插件 overlay 挂载点，本就该宿主提供）。

## ctx.ui 组件工厂（已实现，src/host/ui.js）

插件 import 不了组件库，但宿主可以**把构造函数递给它** —— 和 `ctx.protocol` 完全
同一个手法。`loadUiKit()` 在 lifecycle 里、任何插件激活前 await 一次，于是
`el()`/`render()` 保持同步（插件在同步的 render 回调里建 DOM）。

- **`el(tag, props, children)` 返回描述符，不是 DOM 节点**，`render(container, tree)`
  一次挂载整棵树。理由：**插槽结构的组件（Select/Tabs/Dialog）用"append 子节点"
  表达不了** —— 会把下拉项塞进触发按钮里。非组件 tag 落到普通 HTML 元素；
  带连字符的未知名会抛错（必是拼写错误）。
- **词汇表是派生的，不是手写清单**：`import.meta.glob('../components/ui/*/index.ts')`
  → kebab-case 出 84 个 tag。所以不可能与 src/components/ui 漂移。
- **`import.meta.glob` 不能加 `typeof` 守卫**：Vite 会把调用替换成对象字面量，
  于是 `typeof` 是 `'object'`，三元永远走 `{}` 分支 —— **词汇表静默为空且不报错**。
  所以 glob 单独放在 `src/host/uiComponents.js`，由 `loadUiKit()` 动态 import
  （Node 没有这个宏，该模块必须对测试进程不可达）。
- **portal 目标**：reka-ui 的 portal 默认 teleport 到 `document.body`，那在插件的
  `[data-plugin]` 子树**之外** → `contributes.theme` 会美化按钮却不美化下拉菜单。
  上游 wrapper 不转发 portal 目标，已补 `portalTo`（见下）并把它盖到树上每个
  portal 类描述符上。实测：弹层 `--primary` = 插件的紫、父节点 = 插件容器。
- **测试桩**：`tests/browser-stubs-loader.mjs` 有两条 load 钩子 —— 把
  `uiComponents.js` 换成真实目录映射，把每个组件 `index.ts` 换成**导出名真实、
  实现为空**的桩。于是 boot 测试里 `el('card-header')` 仍能解析、拼错仍抛错。
  任何 import `lifecycle.js`/`ctx.js` 的测试都必须 `register` 这个 loader。
- 开发期验证页：`dev/ui-probe.js` + `ui-probe.html`（build 只取 index.html，不进产物）。
  插件在 Tauri 外无法激活，所以这是唯一能看到 `ctx.ui` 输出的地方。

## token 分层的方向：shadcn 名必须是规范层（踩过）

**utility 解析成 `var(<规范名>)`，所以只有规范名能被覆盖。** 我最初把项目名当规范层、
shadcn 名当兼容层，于是 `--color-primary: var(--brand)`、`bg-primary` 编译成
`var(--brand)` —— **插件按 shadcn 文档设 `--primary` 时一个颜色都不会变**。
类看起来可覆盖，实际不是。靠**看截图**发现（按钮上写着 "Purple" 却是蓝的）。

正确方向：**shadcn 的名字持有值（规范层），项目名是别名**。代价是
`--card`/`--popover`、`--secondary`/`--muted`/`--accent` 这些"在本应用里是同一角色"
的令牌成了各自持值的独立变量（值重复）。这是可覆盖性的必要代价，已加测试钉住
它们在每个主题内保持同色。

守卫：`theming: every variable a utility resolves to holds a value, not another alias`
—— 直接防上面那个 bug 复发。


## 插件视图迁移（5 个内置插件已全部完成）

- **`render()` 语义是"替换"**，按容器记 app、重画时先 unmount 上一个。原来是 append，
  插件每次按键重画列表就**泄漏一个 Vue app**（都活着、都不可达）。
- **`el()` 兼容变参**：`el(tag, props, children)` 只收一个 children，但调用起来和 Vue 的
  `h` 长得一样，很容易写成 `el(a,b,c,d)` —— 第四个参数**静默丢弃**，元素整块消失，
  看起来像布局 bug。现在 `el('div', {}, [a,b])` / `el('div', {}, a)` / `el('div', {}, a, b)` 都行。
- **`ctx.ui.native(tag, props, children)`**：显式要普通 HTML 元素、绕过词汇表。
  必须存在，因为**词汇表遮蔽了同名 HTML 标签**：`el('select')` 是 shadcn 的 Select
  （reka-ui，按钮 + 弹层），`<option>` 子节点会渲染成散落文本。
- **reka-ui 的 Select/Checkbox 渲染的是 button，不是表单控件** → 用 `FormData` 读的表单里
  它们会**静默消失**。procman 的 profile 表单因此保留下拉与开关为原生控件
  （`native('select')` / 原生 `<input type=checkbox>`），文本与数字字段用 shadcn Input/Textarea
  （它们本来就是原生元素，FormData 看得到）。
- **内置插件也不用 Tailwind 工具类**，只用组件工厂 + `.tb-*` + 内联布局样式。
  内置插件源码在仓库里、Tailwind 会为它生成工具类，但**外部插件源码在项目外、Tailwind
  永远看不到**；内置插件用了就成了误导性示范。
- **组件的 `size` 才是尺寸的正确入口**：传 `class="tb-btn-sm"` 不缩小按钮 ——
  utility 只设 padding，shadcn 的 `h-9` 仍然赢高度。用 `size: 'icon-xs'` 等。
- 迁移手法：procman 用 `data-act`/`data-ch`/`data-id` 做事件委托，所以**只换 DOM 构建、
  保留这些钩子，处理函数一行不用改**。

## dev/plugin-preview.js（重要验证工具）

**插件在 Tauri 之外无法激活**（loader 第一件事是向原生权限网关注册），所以迁移插件本来
是完全盲改。这个页面用 mock ctx（与 host/ctx.js 同形状）驱动插件真实的 activate 与
registerView：

    npm run dev -> http://127.0.0.1:1420/plugin-preview.html?plugin=notepad

`ctx.ui` 是**真的组件工厂**，`ctx.protocol` 是**真的契约**；storage/bus 内存版；
进程/流调用直接 reject（依赖它们的插件会走错误路径，那本身也值得看）。

踩过的三个坑：① `registry` 不是 registry.js 的导出（用 `describeSchemes`）；
② **页面里已有 `#app`，不要再建一个同 id 的** —— app.css 给 `#app{height:100%}`，
那个空的首元素把内容整体推下一整个视口，症状是"DOM 里有文字、截图全黑"；
③ **panel 要给显式高度**，插件视图普遍用 `height:100%`，否则塌成内容高度、看着像布局坏了。

## 2026-09-21 UI 调研（未改代码，报告在 docs/UI-REVIEW-2026-09-21.md）

- **`--border` 与 `--input` 是同一个值**（两个主题都是）—— 这是"线条观感不佳"的根因：
  **一种线干两份活**。区域分隔线要轻、控件轮廓要明确，绑在一起只能取中间值、两头不满意。
  改的话要同时改 `tests/plugins.test.mjs` 里"同角色令牌保持同色"那条（把 `['--border','--input']` 移出）。
  实测边框对比度其实只有 1.18–1.36:1（已属"微妙"区间），所以**问题不是线重，是线多 + 一个值两份活**。
- **`native-select` 的展开弹层无法美化** —— 实测打开前后 **DOM 节点数一个没变**
  （1614 → 1614），弹层在 DOM 之外由浏览器/OS 绘制。这是平台硬限制，不是没优化。
  组件本身（真实 `<select>` + `appearance-none` + 自绘 chevron）收起状态是能美化的。
- **procman 两个"新建"入口结构性冲突**：快速表单的 4 个字段是 profile 表单 16 个字段的
  **严格子集**，且快速表单自带 "save as profile" 勾选框 → **它已经能建 profile**。
- **procman 列宽**：250 + 270 = 520px，占默认 1080px 窗口的 **48%**，中间终端只剩 ~560px。
- **gallery 滚动问题复现不了**：三种窗口尺寸下全页始终只有 `main` 一个滚动容器，
  文档不滚、侧栏不动（已用注入 4000px 视图实测）。需要用户补截图。
- **自定义窗口栏**：Tauri v2 用 `decorations: false` + `data-tauri-drag-region`
  （只对直接标注的元素生效）+ `core:window:allow-{minimize,toggle-maximize,start-dragging}`
  三个权限。Windows 上**确定会失去 Snap Layouts**（悬停最大化按钮的分屏选择器）。
  本项目所有窗口都由 JS 创建（`ctx.js:200` `new WebviewWindow(label, options)`），
  所以插件窗口也能带 `decorations`。**前置问题：插件窗口的标题栏归谁画？** 这个比
  "要不要自绘"更关键。


## 双滚动条 bug 的根因（已修，2026-09-21）

**`main` 有 `overflow-auto` 但 `position: static`。** CSS 规范：**滚动容器只裁剪
「以它为包含块」的绝对定位后代**，而成为包含块需要 `position` 非 static。所以插件视图里
任何 `position: absolute` 元素（reka-ui 的 slider/switch/隐藏 label 里到处都是）
**逃出 `main` 的裁剪**，转而以 `relative` 的根 div 定位，**把文档撑高**。

症状：两个滚动条（`main` 一个、文档一个）+ 拖文档滚动条时侧栏跟着走。
实测（真实 app，gallery 页）：文档 scrollHeight **4830** / 视口 720，侧栏 `top` **-300**。
修复：`<main class="relative min-w-0 flex-1 overflow-auto p-3.5">` → 文档 **720**、
侧栏 `top` **0**、`window.scrollTo` 完全滚不动。
守卫：`layout: the main scroll container is also a containing block`。

**一般规律：任何 `overflow: auto/scroll` 的盒子，如果要裁剪内部内容，
都应该同时是 `position: relative`。** 否则绝对定位后代逃逸。

## 边框令牌已拆开（2026-09-21 落地）

`--border` 与 `--input` **原本是同一个值** → 同一条线要同时满足两个相反诉求
（分隔线要退场、控件轮廓要明确），取中间值两头都不满意。这就是"窗口划分的线条
视觉效果不佳"的根因。现已拆开：深色 `#1c212b` / `#333b4a`，浅色 `#e9edf4` / `#c8d1e0`。

`tests/plugins.test.mjs` 的「同角色令牌保持同色」已把这两个**移出分组** ——
注意这条测试原本正是把它们钉在一起的东西，改动时要一起改。

对照页 `style-options.html` 保留（三个选项并排、深浅各一套），B（再加
`--border-subtle`）和 C（card 去边框）仍未做。

### 对照页的技术点：主题用 iframe，不用嵌套 data-theme

令牌声明在 `:root[data-theme='light']` 上 —— **嵌套元素写 `data-theme` 拿不到**，
因为选择器只匹配根元素。与其在页面里复制一份令牌值（会漂移），不如**每个主题一个
iframe**：独立 document，`:root` 真的是根，真样式表原样生效。这个手法适用于任何
"同页面并排展示多主题"的对照页。

## 浏览器测不出来 → 用 CDP 进真实 app（重要手段）

**headless 浏览器打 dev server 只能看到「页面」，看不到「app」** ——
插件激活、原生权限闸、窗口布局都不存在。所以**浏览器复现不了的问题，别继续在浏览器里找**。

    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" npm run tauri dev
    node scripts/app-eval.mjs "<async 函数体>"      # 或 --file probe.js

`scripts/app-eval.mjs`：零依赖（Node 内置 WebSocket 直接讲 CDP），
`Runtime.evaluate` + `awaitPromise` + `returnByValue`。配合 `window.__toolbox`
（`boot.js` 早期安装，boot 失败也存在）可以脚本化驱动真实 app。

**上面那个 bug 就是靠这个找到的** —— 浏览器里三种尺寸都复现不了。

原生窗口截图：`GetWindowRect` 返回的是**扩展边框**（含 Win 不可见的调整边框），
直接用 `CopyFromScreen` 会偏 ~7px/边、看起来像"内容溢出边缘"。
要用 `GetClientRect` + `ClientToScreen` 才像素精确。驱动鼠标用
`SetCursorPos` + `mouse_event`，坐标**必须从刚读到的窗口 rect 算**（窗口会移动）。

这套已写进 skill `tauri-headless-verification` 的 Step 7。

## 前端重载会遗留宿主侧会话（已修，2026-09-21）

**症状**：应用内自检从 15/15 掉到 13/15，且此后每次都 13/15 ——
`t10: session __host__/selftest-pty is already open` / `t11: session leaked`。

**根因**（boot 日志里两次 boot 相隔 1.8 秒，然后才跑自检）：HMR 整页重载替换了前端
JS 上下文，但**宿主进程还活着**，于是上一次 boot 开的会话留在注册表里 ——
而它**握着真实的 OS 进程**。所以这是泄漏不是条目过期：重载十次攒十个孤儿，
自检也开始报**假失败**。

`RunEvent::Exit` 和 Ctrl+C 处理器都 `kill_all()`，但**重载两条路都不经过**。
修法：新增 `plugin_reap_orphans`，`boot()` 在任何东西开会话**之前**调用；
**只允许主窗口**（命令内检查 `window.label() == "main"`）—— 应用命令不走 ACL，
标签检查就是闸门。真启动时是 no-op。

## ⚠️ 绝对不要硬杀 Tauri 应用（我把开发环境弄坏了）

反复 `Stop-Process -Force` 硬杀 → **累积 26 个孤儿 msedgewebview2 进程**，
并把 WebView2 profile 搞成坏状态：**应用能起窗口但窗口全白**，页面根本不加载
（因此没有 boot 日志、CDP 也不起来）。

**判据（已做 A/B 验证）**：
1. 同一份代码在浏览器里渲染正常（dev server HTTP 200，shell 正常渲染）
2. `cargo check` 与 142/142 测试都过
3. **把我改的 `lib.rs` + `boot.js` 回退到改动前、重新编译，窗口依然全白** ⇒ 排除我的代码
4. 换一个全新的 WebView2 profile（把 `EBWebView` 改名）**也没用** ⇒ 不是 profile 数据

⇒ **不是代码**。但**也不是环境坏了** —— 用户自己跑 `npm run tauri dev` 时应用正常显示，
且日志里是 **15/15 passed**（08:52）。

**真正的原因：我用后台任务（非交互 shell）启动时窗口全白，交互式终端启动就正常。**
所以"窗口全白"是**我的启动方式**的产物，不是代码也不是环境。
**推论：应用内验证必须由用户在交互终端里做，或者改用别的方式；不要据此判断代码有问题。**

教训：诊断"窗口全白"时，先确认**自己能不能复现**，再下"环境坏了"的结论 ——
我一度写下了错误的结论（说是硬杀弄坏的），实际用户那边一直好好的。

**要让它自己关**（关窗口 → `RunEvent::Exit` → `kill_all()`）。
**修复办法**：重启机器，或清 `%LOCALAPPDATA%\com.tan18.toolbox\EBWebView`
（webview 缓存/profile，会丢 localStorage 里的主题与设置，不碰 `%APPDATA%` 的插件数据）。

排查这类"窗口全白"的顺序：① 进程有没有窗口句柄（`MainWindowHandle`）
② 前端在浏览器里能不能渲染（排除代码）③ 才去怀疑环境。

## 启动白屏 2.3 秒：根因是 WebView2 profile 被换掉了（2026-09-21）

**排查过程（先用测量排除，别猜）**：

| 假设 | 测法 | 结果 |
|---|---|---|
| 我的代码阻塞首帧 | 看 `main.js` | ❌ `app.mount('#app')` 在 `boot()` **之前**且不 await |
| 前端慢 | headless 量 FCP（冷，清空 `.vite` 后） | ❌ **440ms** |
| 系统代理拦 127.0.0.1 | 查 WinINET + env | ❌ 无代理 |
| WebView2 运行时升级 | 查版本 | ❌ 仍是 153.0.4234.48 |
| 我的改动 | 回退重编译 A/B | ❌ 窗口照样白 |

**真因**：我为测"profile 是否坏了"把 `EBWebView` 改名，应用随即**新建了一个全新 profile**，
而**原来的暖 profile 被留在了 `EBWebView.bak`**。
`du -sh` 一量就清楚：**新 87M vs 原 234M**。冷 profile 要重建 GPU/shader/Code Cache
并做首轮组件初始化 → 每次启动多几秒白屏。

**已恢复**（把 234M 的原 profile 换回来，删掉 87M 那个）。

**教训**：为了排查而改名 profile 之后，**一定要记得换回来**；
判据是 `du -sh`，不是"看起来目录都在"。

## 白屏已从结构上修掉：窗口等首帧画完再显示（2026-09-21）

**三处必须一致**（`tests/window-options.test.mjs` 有一条握手契约测试钉住）：

| 文件 | 作用 |
|---|---|
| `tauri.conf.json` | `"visible": false` |
| `src/main.js` | 首帧画完后 `show()`。**必须两个 `requestAnimationFrame`** —— `mount()` 返回时浏览器还没画，一个 rAF 仍与合成器赛跑 |
| `src-tauri/lib.rs` | 兜底：5 秒后仍不可见就显示，并打一行 stderr |

**兜底是"隐藏启动"能安全发布的原因**：前端若因 JS 报错 / dev server 挂了 /
页面空白而走不到 `show()`，窗口永远不出现 —— 比白屏更糟。
capability 里 `core:window:allow-show` 本来就有。

**为什么值得做**：暖 profile 会掩盖白屏，**新用户第一次启动时最严重** ——
而那恰恰是最该留好印象的场景。

## 启动期是"启动中"还是"空的"——不能混为一谈（2026-09-21）

窗口改成"首帧画完就显示"之后，暴露出下一层：**窗口出现时插件还没加载完**
（插件在 `boot()` 里才加载），于是用户看着空侧栏等几秒。

**之前启动期显示的是空状态文案** —— "No plugin views yet / Drop a plugin folder…"，
在插件正在加载时这么说是**错的**，读起来像加载失败。
现在按 `store.booted` 分流：`!booted` → "Starting up… / Loading plugins."，
侧栏也补一行 "Loading plugins…"（用户看的正是那块）。`store.booted` 本来就有。

**日志里现在有一行启动时间账**：

    boot timing (ms): debug 2 | reap 15 | schemes 18 | builtins 1900 | external 2100 | hotkey 2120

它**特意放在每个插件状态行和自检之前** —— 那些是诊断信息，
耗时不该算进用户等待的插件列表。没有这一行，"启动慢"是无法回答的问题。

**已排除的假设**：Vite 转换插件模块慢 —— 实测每个内置插件模块首次转换只要
10–25ms（notepad 26 / eyecare 9 / procman 19 / streamlab 6 / floatwin 11）。
所以瓶颈在 `bootPlugins` 里插件的**激活**本身。

## 插件开发手册在 docs/plugin-dev/（2026-09-22）

面向**写插件的人**，七个文件：README（上手 + 五层总览）、architecture（分层与边界）、
manifest（plugin.json 参考）、api（ctx 按任务组织）、ui（.tb-* + 令牌 + 组件工厂）、
**debugging（归因手册：症状 → 查什么）**、recipes（最小实现 + 指向现成代码）。

协议/内部实现**不重复**，只引用 `docs/PROTOCOL.md` / `INTERFACES.md` / `UI.md` /
`MESSAGE-FRAMEWORK.md`。**加插件相关文档时先看这里，别另起一套。**

写的时候核对源码查出来的、容易记错的几点：

- **`ctx.registerView(id)` 会校验 id 是否在 `contributes.views` 里声明**，没声明直接抛错 ——
  视图的 slot/title/icon 来自声明，不来自代码
- **`contributes.hotkeys` 的声明本身就是权限**，不需要额外声明 `rpc:hotkey`
- **窗口的 size/position/alwaysOnTop 归创建它的窗口**，不在插件窗口自己的权限里
- **`ctx.events` 是窗口本地的（in-process），`ctx.bus` 才跨窗口** —— 两者都是异步形状

## 启动耗时归因：日志里有 `plugin load (ms):`（2026-09-22）

`bootPlugins` **串行 await** —— 一个插件的 `activate()` 慢，**后面所有插件**的视图都要等它。
实测九个内置插件共 **1662ms**（`builtins` 那一段），这就是"启动后侧栏空几秒"的原因。
日志里现在有两行：`boot timing (ms):`（分阶段）+ `plugin load (ms):`（**分插件**）。

已排除：Vite 转换插件模块慢（每个模块首次转换只要 10–25ms）。

## Tailwind v4：裸 `border` 的颜色是 currentColor（踩过，2026-09-21）

**v4 的 preflight 把 `border-color` 默认成 `currentColor`**（v3 是主题边框色）。
于是任何写了裸 `border`、没写颜色的元素，边框 = **文字色**。

实测症状：浅色主题下每个 outline 按钮的边框是 `rgb(23,26,33)`（近黑）——
因为它的 border 和 color 是**同一个值**。深色主题没暴露，因为那一档有 `dark:border-input`。

修了两层：
1. **系统性**：`@layer base` 里恢复 `*,::after,::before,::backdrop,::file-selector-button
   { border-color: var(--color-border) }`。shadcn 的 v4 说明也要求补这条。
   它同时保护**插件自己写的裸 `border`** —— 那是无法逐个审计的部分。
2. **具体**：Button 的 outline variant 改用 `border-input`（两个主题都是），
   进了拉取脚本的 `LOCAL_PATCHES`，重拉自动重放。

**排查手法**：`getComputedStyle` 同时打印 border 和 color —— 两者相同就是 currentColor。

## 窗口栏机制（已审计，2026-09-21）

**三个 capability 文件按 window LABEL 分域**：`main` / `floatwin` / `plugin-*`。
插件窗口各只拿三个权限（`core:default` + `start-dragging` + `close`）—— 恰好是自绘
标题栏需要的。尺寸/位置/置顶/透传刻意留在**创建它的**主窗口。
**三个都没有 `remote`**，所以指向远端 origin 的窗口拿不到任何 IPC（Tauri 默认）。

**补上的缺口**：`ctx.windows.create(label, options)` 原本把 options **原样**塞进
`new WebviewWindow(label, options)` —— 本宿主里唯一没有白名单的入口。
影响面不大（capability 按 label 匹配，插件能拿到的 label 只给三个权限，没有选项能提权），
但 `url` 能替换宿主页、跳过 `pluginwin-host.js`（那个把 bridge 交给插件的加载器）。
现在选项走白名单 + url 必须是 `index.html?…`，校验放在异步查找**之前**。

**主窗口若要自绘**还需两处：`tauri.conf.json` 的 `decorations: false`，
以及 capability 加 `allow-{minimize,toggle-maximize,start-dragging}`（现在都没有）。
Windows 上会失去 **Snap Layouts**。

**测试手法**：`tests/window-options.test.mjs` 里有一条**从插件源码抽出真实选项**
再比对白名单 —— 手写清单会在有人给插件加选项时漂移。这个模式可复用到其他"清单必须
覆盖现有用法"的场合。

详见 `docs/UI.md` →「Who draws the window frame」。

## procman 已按用户裁定重构（2026-09-21）

用户的裁定是**同一件事的三面 —— 一个 profile 拥有一个进程**：

- **列**：`250px 1fr 270px` → **`340px 1fr`**。终端 ~560px → ~824px。
  右列那 270px 是常驻只读信息，而中间区本来就是"当前会话"的语境。
- **表单**：快速表单（4 字段，且它自己的字段是 profile 表单的**严格子集**、
  还自带 "save as profile" → 两个入口都能建 profile）与 profile 表单（16 字段）
  **合并成一个**，搬进 **Dialog**（560px 宽，不再挤在 250px 左列）。
- **取消多开**：`launchProfile` 发现该 profile 已有进程时**聚焦它**而不是再起一个。
  restart 不受影响 —— 退出的进程不计入 `runningFor`。

**连带效果**：独立的 Sessions 列表可以**取消** —— 状态并入 profile 行，
详情并入左列底部。因为"选中会话的详情"现在就是"选中 profile 的详情"。
新增 `sessionOf(profileId)` 返回该 profile 的会话（不论状态）。

1287 → 1211 行；`innerHTML =` 0 处；`pm-sessions`/`pm-form` 引用 0 处。

**Dialog 在工厂里的用法**：`el('dialog', { defaultOpen: true, 'onUpdate:open': (o) => { if (!o) close() } }, ...)`。
整个树每次状态变化都重建（不是 patch），所以"打开"是渲染的属性 ——
`defaultOpen` 就够了，不需要受控状态。

## 组件词汇表：上游 66 个组件全部拉入（376 个 tag）

第一轮只拉了 23 个（插件真会伸手的那一小撮），现已补齐全部 66 个。
`examples/plugins/gallery/` 是活示范（`permissions: []`，零 import）。

- **上游有 4 个名字不是注册表组件**，是文档里的组合模式：数据表格 = Table + 排序分页、
  排版 = h1/p/code + token、日期选择器 = Popover + Calendar、Toast 已废弃改 sonner。
- **`number-field` 是"可加减的输入框"**（NumberField/Content/Decrement/Input/Increment）。
  第一轮确实漏了 —— 只有 `input type=number`，没有步进器。
- **代价**：CSS 28K → 164K raw（6KB → 26KB gzip），因为 Tailwind 会把
  `src/components/ui/` 下所有组件的类都编进去，用不用都一样。JS 按组件分包、懒加载
  （chart 123KB / form 38KB / useCalendar 36KB 都是按需）。要收窄就传显式清单给
  `scripts/shadcn-pull.mjs`。

### 拉全之后暴露并修掉的四个真 bug

1. **工厂挂载的树拿不到宿主的 provide**：每棵树都是 `createApp().mount()`，
   **新 app 不继承宿主的 provide 树** → `Tooltip` 报
   `Injection Symbol(TooltipProviderContext) not found`（错误信息完全看不出插件错在哪）。
   新增 `ROOT_PROVIDERS`，挂载前自动套一层 provider；reka-ui 的 provider 只渲染 slot、
   不产生额外元素，无布局影响。
2. **`() => out` 闭包读到的是变量**：`out = h(Provider, {}, () => out)` 里 slot 返回自己
   → `Maximum call stack size exceeded`。要先 `const inner = out` 捕获当前值。
3. **词汇表混进 `form_item_injection_key`**：判断"是不是组件"用的是"首字母大写且是对象"，
   而 reka-ui 的 `FORM_ITEM_INJECTION_KEY` 两条都满足。收紧为 PascalCase 且不含下划线。
4. **portal 转发只覆盖 5 个，实际有 14 个**：tooltip / popover / hover-card /
   dropdown-menu / context-menu / menubar / drawer / sheet / alert-dialog / combobox
   + dialog 的 scroll 变体、menubar 的 sub 变体。补丁表改为由 `PORTAL_CONTENTS` 生成，
   `forwardPortalTo` 兼容上游两种 props 写法（`XProps` 与 `XProps & {...}`）。
   **补丁每次拉取自动重放**，拉取因此幂等。
   `*-sub-content` 不进 `PORTALLED`：它们渲染在父 portal 内部，继承父的目标。

审计 `factory: every tag a plugin names exists` 现在**也扫 examples** ——
gallery 是别人照抄的样板，那里的错 tag 最误导人。

## 词汇表遮蔽 HTML 标签名 —— `form` 与 `select` 两个坑

**`el('form')` 是上游的 Form 组件（校验包装器），不是原生 `<form>`。**
它的 submit 事件不是原生事件，`ev.preventDefault` 根本不存在 → 处理器直接抛错。
**最阴的地方**：表单能渲染、能看、能填，**只有真的提交才炸**。
用 CDP 抓控制台才看到真因（`ev.preventDefault is not a function`）。
两处表单都改用 `native('form', …)`。已加守卫
`el('form') is never what a plugin wants`。

**`select` 是判断题，不加规则**：`el('select')` 是要样式化的 Select（按钮 + 弹层，
通常就是你想要的），`native('select')` 是要 `FormData` 能读到的真控件。
两者在不同场合都正确，一刀切的规则反而是错的。

一般规律：**组件与同名 HTML 元素里，Input/Button/Label/Table/Textarea 渲染的就是
那个原生元素（放心用）；form / select 不是。** 插件里凡是"要被 `FormData` 读"
或"要接原生事件"的控件，一律走 `native()`。

## 主窗口已无原生控件

原来还剩 4 个（procman 表单里的 2 个下拉 + 2 个勾选框），原因是 `FormData` 读不到
reka-ui 的 Select/Checkbox（渲染的是 button）。改为**每个控件写进 `state.draft`、
提交处理器读它**，代价是十几行状态接线。已实测往返：改名 → Save → 列表更新、表单关闭。

仍然保留原生外观的三类（刻意）：插件**自己的窗口**（独立 document）、
**窗口标题栏/边框**（OS 画）、**xterm 终端**（canvas）。

## 部署脚本：发现，不要列举

`npm run deploy:examples` 原来硬编码示例数组，gallery 加进来时它根本不知道 ——
**而且运行照常成功，这种遗漏是看不见的**。改成从各示例自己的 `plugin.json` 发现。

## 环境：后台进程要挂在工具的 task 上

`nohup npx vite &` 起的 dev server 会随 shell 退出而死；要用工具的后台任务机制。
（之前活了 22 小时的那个正是这么起的 —— 也正是它占着 1420 让 `tauri dev` 报错。）
用完务必关掉，否则下次 `tauri dev` 会因为 beforeDevCommand 失败而 CLI 退出、
窗口却留着。


`npm run tauri dev` 的 beforeDevCommand 是 `npm run dev`。**如果 1420 被占**（比如我
之前留着的 dev server），vite 会失败，但 `cargo run` 已经先把 app 启动了 ——
app 连上那个占着端口的 server 照常显示，而 CLI 因 beforeDevCommand 非零退出。
症状就是"命令退出了但窗口还在"。**用完 dev server 一定要关。**
本机 `taskkill` 在 Git Bash 里参数会被吞；用 PowerShell 的 `Stop-Process -Id <pid> -Force`
（PowerShell 工具不返回 stdout，用 netstat 复核）。


## 静态审计：守卫自己出错比没有守卫更糟（三个真实 bug）

1. **正则字面量**：`codeOnly()` 不认正则，每个插件 `esc()` 里 `/[&<>"']/g` 的 `"`
   被当成字符串起点，**吞掉文件剩下部分** —— `esc` 之后的声明全消失、之前的调用点
   还在，成了幽灵死调用。已修：表达式位置的 `/` 开正则，处理转义与字符类。
2. **用 codeOnly 抽 tag 名 → 永远抽不到**：`codeOnly` 把字符串字面量抹成空格，
   而 tag 名**就是**字符串字面量，于是 `el('card', …)` 变成 `el( , …)`，抽到 0 个、
   **永远报成功**。抽 tag 要用只去注释、保留字符串的 `withoutComments`。
   → 凡是"从源码抽字面量"的审计，都要问一句"我用的剥离函数会不会把我要找的东西剥掉"。
3. **匹配器太窄**：innerHTML 匹配要求点号前是标识符，漏掉
   `root.querySelector('.x').innerHTML = …` 这种最常见写法，对着明显违规的代码报成功。

**教训**：写完守卫必须**注入违规、确认它变红**。绿而不能红的守卫是最坏的情况 ——
它让人以为有保护。另外**非空断言**很值：`assert.ok(seen.size >= 10, '抽取器没工作')`
直接抓出了第 2 类空转。还有：**例外清单要断言它命中了**，否则可能是死代码
（我给 floatwin-widget 开的例外就是 —— 它根本不在 BUILTIN 里）。

## 组件工厂的 tag 校验：白名单，不是形状

「非组件 tag 落到普通 HTML 元素」原来用形状判断（无连字符的小写名），于是
`el('crad')` 渲染成惰性元素、看起来像"组件没显示" —— 与拼错 `.tb-*` 同类的静默失败。
改成**真实 HTML 标签白名单**，拼错即抛错并列出可用组件。

白名单**故意不含 html/head/body/script/style/link/meta/title/base**：主窗口里
`el('style', {}, '…')` 就是一次全局样式注入，正是 contributes.theme 作用域要防的事；
插件要自带 CSS 走它自己的窗口。审计用的是**同一份白名单**，保证测试与运行时一致。

## 插件窗口的样式路径（第 5 步结论）

**今天就已成立，不需要新代码**：插件窗口是独立 WebviewWindow = 独立 document，
注入 `<style>` **物理上不可能到达主窗口** —— 结构性保证，不需要沙箱/shadow DOM/审查。
L4 只在「插件 CSS 要进主窗口」时才需要，这条方案恰好避开。

关键 CSS 事实**实测过**：app.css 的 body 背景在 `@layer base` 里，插件的 `<style>`
未分层 → **未分层优先于任何 @layer，与顺序无关**（实测 before rgb(14,16,21) →
注入后 rgb(1,2,3)）。所以插件窗口**自动获得 token 与 `.tb-*`，想覆盖就覆盖**。

取舍：窗口里写死颜色的插件**不跟随深浅色**；要跟随就用 `var(--color-*)`。两种都支持。
`examples/calc-plugin` 是这条路径的活示范。详见 `docs/UI.md`
「Where each half of the app gets its styles」。


## 验证工具：scripts/shot.mjs（重要）

应用主题在首帧就由 `prefers-color-scheme` 决定，一次性的 `--screenshot` 只能拍到
headless 浏览器碰巧报告的那一种配色。**要验证浅/深成对，必须在导航前模拟配色** ——
这需要走 CDP。用 Node 22 内置 WebSocket 直接讲 CDP，零依赖。

    node scripts/shot.mjs <url> <out.png> --theme dark|light [--size WxH] [--eval "<expr>"]
    --no-shot  只求值不截图，可当无头断言工具

`--eval` 在真实页面里取表达式值：截图告诉你"哪里看起来不对"，它告诉你"为什么"。
配合 `npm run dev`（vite 在 1420）可以核对任何界面。注意：浏览器里没有 Tauri，
`boot()` 会在热键注册处失败并弹一条错误 toast —— 这是预期的，反而顺带证明了 toast 链路通了。
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
