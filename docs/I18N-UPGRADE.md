# i18n 整体升级计划

状态：2026-11-28 宿主语言基础和插件 i18n API 已合入 main，纳入 v0.1.8 发布范围。Settings 通过统一 Select 组件选择跟随系统 / 简体中文 / English；主导航、Settings、模型设置、托盘和标题同步，三个 WebView 入口更新 html.lang。HOST_API 升至 14，提供 ctx/bridge.i18n、nameKey/titleKey 元数据翻译及 Sidecar 原生语言读取，信封仍为 v1。v0.1.7 标签不含这些改动。内置业务界面、安装器、宿主通知及错误映射、双语文档继续后续阶段。

当前落点：src/i18n/locale.js 是无 Vue 依赖的同步客户端；state.js 接原生命令和事件；vue.js 适配 Vue I18n。shell/settings/llm 词典按入口加载，经 Vite 官方插件预编译。src-tauri/src/locale.rs 管理 preferences.json 的 language 字段，保留其他偏好、原子保存，并在释放状态锁后向主线程派发托盘更新与有修订号的广播。首屏不会等待偏好 IO；原生配置到达前使用系统语言回退。

## 目标与范围

首批支持简体中文 zh-CN 与英语 en-US，默认跟随系统，用户可手动选择。覆盖主窗口、Settings、独立模型设置窗口、托盘、宿主通知、内置插件、外置插件语言元数据及安装器。品牌、协议字段、服务名、插件 ID、视图 ID、热键动作、文件路径、模型 ID 保持稳定；用户内容、终端输出、模型输出及第三方错误正文不自动翻译。

入口为 src/main.js、src/llmsettings.js 与 src/pluginwin.js；语言偏好统一由原生持久化，不并入 src/host/store.js 的 localStorage。纯浏览器预览另用 toolkit.preview.language，不会改动桌面应用的设置。模型设置仍是独立 WebView，公共日历控件跟随 ConfigProvider 的语言或插件显式传入的 locale。

## 语言状态与多窗口

宿主持有一份持久化语言偏好，建议保存在应用数据目录的 preferences.json，单次读改写复用现有原子落盘模式。保存 mode（system/manual）与手动 locale；resolvedLocale 是按当前系统解析的结果，不作为第二份独立设置持久化。

优先级：用户手动选择 → 系统语言匹配 → en-US。只有明确的中文简体区域或文字系统匹配 zh-CN；zh-TW、zh-HK 等不能静默当作简体，暂回退 en-US。无效或旧配置回退默认，不覆盖其他设置。规范化 BCP 47 标签，日期/数字格式使用当前语言的 Intl 配置，避免字符串拼接、手工复数与单位顺序。

原生层为语言快照提供修订号并发送轻量变更事件。主窗口、模型窗口与新建/重新打开的插件窗口读取同一份初始快照；消息只携带语言元数据，接收方不再反向写入，防止同步循环。切换语言更新 DOM、窗口标题和托盘，不重启应用、不重载插件、不停止 PTY/Sidecar，也不丢失编辑中的表单。

## 执行顺序与建议版本

以下按阶段验收推进，不预设后续发布日期。v0.1.7 发布门禁未通过；v0.1.8 合并模型/通信能力与已完成的宿主语言基础、插件语言契约，其余翻译继续后续阶段。

| 阶段 | 范围与主要落点 | 验收后进入下一阶段 |
|---|---|---|
| 0：盘点与基线 | 盘点 App.vue、SettingsView、LlmSettingsView、内置插件、托盘和原生消息；区分界面文案、用户内容与诊断日志，记录首屏基线。 | 有词条清单、命名规则、两语言最小目录及启动/窗口基准。 |
| 1：宿主基础，建议 v0.1.8 | 原生持久化 localeMode/locale；纯 JS 语言核心与 Vue I18n Composition API 适配；Settings 语言选择，主窗口、模型窗口和新窗口同步快照；更新 lang 属性。 | 首次启动、系统语言、手动覆盖、重启恢复和并发切换一致；无状态循环及明显首屏回退。 |
| 2：宿主完整界面，随 v0.1.8 或下一补丁 | 外壳、设置、模型管理、原生托盘/标题/通知、错误映射；按页面拆包词典，公共 UI 组件读取选定 locale。 | 中英词条与参数齐全；表单、快捷键、进行中的模型生成和终端均能在切换后继续使用。 |
| 3：插件契约纳入 v0.1.8，业务翻译后续推进 | ctx/bridge.i18n、nameKey/titleKey 与原生 Sidecar 读取已实施（HOST_API 14）；Processes/Store/StreamLab 业务文案尚待迁移，信封保持 1。 | 老插件原样工作，新插件两端语言与清理一致；翻译不改变 id、摘要、授权或业务数据。 |
| 4：交付与稳定，建议 v0.2.0 | NSIS/MSI、更新产物、双语开发文档、长文案/缩放/辅助功能与实际安装升级。 | 覆盖安装、升级、回滚、多显示器和生产构建；中英功能覆盖达到同一标准。 |

## 前端与原生职责

Vue 界面优先采用 Vue I18n 的 Composition API。语言解析、持久化和变更协调保持轻量；Vue 适配层负责渲染与消息格式，避免让公共插件 SDK 依赖 Vue 或让独立模型设置入口加载宿主插件内核。首屏所需的小词典随入口提供，设置页等大型词典与其页面按需加载，检查新增包体和启动计时。

文案用稳定语义键，如 settings.models.title、process.status.running。相同英文词在不同上下文不强行合并；占位参数使用对象，禁止把路径或模型名拼进键中。两种语言的键与占位符需要一致；缺失键回退 en-US，开发环境给出不含用户内容的诊断。发布前必须通过缺失键检查。HTML 文案使用组件插值，不通过 v-html 拼接外部内容。

Rust 管托盘、原生窗口标题和系统通知中的宿主文案。界面错误逐步采用稳定 messageKey/params，保留现有 code/msg 兼容回退；协议错误码不翻译，技术日志保留可检索的稳定内容。不能按英文错误字符串匹配翻译，不能将供应商错误正文、凭据或提示词作为插值参数。

## 插件与 Sidecar 的兼容契约

ctx 与 bridge 已提供相同的只读 i18n 能力：get/resolvedLocale、t/createTranslator、onChange，均需 rpc:i18n。快照沿用 mode/locale/resolvedLocale/revision；get 为 Promise，onChange 同步返回取消函数，回调是原始快照，不是信封。订阅纳入 disposer；只保留一个清理器，不随反复订阅积累。仅宿主设置可改全局语言，插件可以单独选择业务输出语言。

清单现支持可选 i18n.messages、fallbackLocale、nameKey、视图 titleKey；原 name/title 是回退。翻译只影响设置列表、热键归属名和侧栏，不改 ID、源清单、排序依据或 digest，不触发重新激活。descriptionKey 等更多元数据留待有展示入口时增加。小型词典可放清单，业务词典可用 createTranslator 打包进 main.js，无须 fs 权限。词典仅支持平铺字符串与命名插值，不使用 Vue、HTML 或可执行消息函数；复杂格式由插件的 Intl 或自带库处理。

Sidecar 经 i18n/get 或 Rust Client::locale 按需直读 Rust；本版不提供语言变化推送，避免把原生 RPC 变成前端代理。语言元数据与文本处理、LLM 提示词语言分别配置。TypeScript/schema、Rust 客户端和权限发现已同步；旧插件保持原显示字段可运行。

## 当前实现与后续验收

本轮 Node 回归覆盖语言标签、旧快照竞态、现有/新开窗口同步、失败回退、监听器释放、双语键与参数、实际 Settings 控件切换及热键捕获保留。locale-checks 原生入口覆盖设置保存/重开、其他偏好保留、无效值、失败写入和系统语言解析。前端构建检查预编译词典；原生回归已加入本地 CI/Release 工作流。

浏览器已验证设置中英互换、已开模型页同步、新页继承，以及未保存表单值保留；该验证使用纯浏览器预览，原生管理命令在此环境不可用。尚需真实安装环境检查启动计时、混合 DPI、托盘更新、多窗口长文案与辅助功能。旧错误正文、技术诊断、插件自有界面、厂商返回内容保留原文；宿主业务通知和插件契约分阶段迁移。安装器语言尚未调整。本轮遵照用户要求保留本地改动，不执行 git commit 或 push；后续版本号由验收结果决定。

## 安装器与发布

安装器语言独立于应用内偏好。NSIS 可配置 languages 与 displayLanguageSelector，按系统或用户选择显示；MSI 需单独验证语言产物。先保留现有更新资产命名规则，再检查 make-latest-json.mjs 的安装包选择，不因语言后缀把错误包写入更新清单。安装器语言不会覆盖已经保存的应用语言偏好。

## 验证与回滚

- 单元检查：语言标签归一、回退链、缺失键和参数、复数、日期/数值、原生文案映射。
- 集成检查：三个 WebView 入口、原生托盘、动态开窗、旧插件及原生 Sidecar、权限与生命周期。
- 界面检查：中英文 Settings/模型页/内置工具，长文案、缩放、多显示器、快捷键标签与屏幕阅读器名称。
- 回滚：保留原展示字段和可读 msg；旧版本忽略新增偏好键仍可运行，不迁移或翻译业务数据，不改变资源身份或协议错误码。

参考：[Vue I18n Composition API](https://vue-i18n.intlify.dev/guide/advanced/composition)、[词典按需加载](https://vue-i18n.intlify.dev/guide/advanced/lazy)、[Tauri 安装器配置](https://v2.tauri.app/reference/config/#nsisconfig)。具体模块划分与兼容方式以上述项目约束为准。
