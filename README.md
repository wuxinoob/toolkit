<p align="center"><img src="src-tauri/icons/icon.svg" width="88" alt="Toolkit 图标"></p>

# Toolkit

基于 **Tauri 2、Vue 3 和 Rust** 的可扩展桌面工具箱。通过内置工具、外置 JavaScript 插件和原生 Sidecar，把进程管理、桌面操作与模型调用放在同一个工作台中。

[下载安装](https://github.com/wuxinoob/toolkit/releases/latest) · [插件商店](https://github.com/wuxinoob/toolkit_plugins) · [v0.1.8 更新说明](docs/releases/v0.1.8.md) · [插件开发](docs/plugin-dev/README.md) · [文档导航](docs/README.md)

目前交付 **Windows x64** 安装包（NSIS `.exe` / MSI `.msi`），运行依赖 WebView2 Runtime。

下方为 Windows 本地运行实拍。README 随 main 分支维护；已发布安装包的功能以 [Releases](https://github.com/wuxinoob/toolkit/releases) 对应版本说明为准。

![Toolkit 插件与软件商店运行界面](docs/assets/screenshots/plugin-store.jpg)

## 可以用来做什么

| 功能 | 说明 |
|---|---|
| **Processes：进程管理**（`builtin.procman`） | 保存运行配置，在终端中启动、查看输出和停止进程；支持定时启动与有上限的自动重启。 |
| **Store：插件与软件商店**（`builtin.store`） | 浏览、安装、更新和卸载外置插件；提供软件官网、winget 和安装包下载入口。 |
| **宿主模型服务** | 集中管理 API 连接、模型和插件授权。插件及原生 Sidecar 可直接调用已授权模型，无需各自保存 API key。 |
| **语言与主题** | 支持跟随系统、简体中文与 English，以及浅色和深色主题。宿主语言切换同步到已打开窗口，插件可使用共享语言 API。 |
| **桌面能力** | 为插件提供剪贴板文字/图片、截图、鼠标位置、窗口定位、全局热键、原生对话框与文件区间读写。 |
| **独立插件窗口** | 支持置顶、透明、自绘标题栏、物理像素定位和无激活展示，适合提示卡片、浮窗等工具。 |
| **StreamLab：通信实验台**（`builtin.streamlab`） | 对照请求、推送、广播、PTY 和 Sidecar 等通信方案，方便开发和诊断插件。 |

具体工具可以由插件扩展；宿主提供通用能力，工具的业务流程由插件实现。示例插件与测试夹具见 [tests/fixtures](tests/fixtures/README.md)，不等同于默认安装的功能清单。

## 插件商店

插件目录与发布包维护在 **[wuxinoob/toolkit_plugins](https://github.com/wuxinoob/toolkit_plugins)**。打开软件侧栏的 **插件商店**，即可浏览、安装和更新目录中的扩展；也可在该仓库查看插件源码与说明。

| 插件 | 用途 |
|---|---|
| 前端常用小工具 | 编码转换、JSON/YAML 格式化、二维码、正则与文本对比等。 |
| 开发助手 | Windows 端口、文件锁、环境变量与开发服务管理等工具。 |
| 护眼助手 | 休息提醒、悬浮胶囊与全屏休息遮罩。 |
| 拾光便签 | 独立悬浮便签、分类归档与 WebDAV 同步。 |

以上为商店扩展，需要单独安装；可用版本及具体能力以插件仓库为准。推荐软件区另提供官网、winget 与安装包入口。

## 开始使用

1. 在 [Releases](https://github.com/wuxinoob/toolkit/releases/latest) 下载 Windows 安装包并安装。
2. 从侧栏打开 **Processes、插件商店或 StreamLab**。手动安装时，将插件文件夹放入应用的插件目录，再在 **设置 → 重新扫描插件** 中加载。
3. 在 **设置 → 语言** 选择简体中文、English 或跟随系统。需要模型能力时，打开 **设置 → 语言模型 → 管理模型**，添加连接和模型、授权插件，再保存设置。

模型连接提供 **DeepSeek、OpenAI、Gemini、Claude、SiliconFlow** 快捷模板，支持 Chat Completions 和 Responses 兼容协议。可读取模型目录并测试生成；模板仅预填连接参数，实际能力仍取决于服务和所选模型。生成测试会调用供应商 API，可能产生费用。

API key 保存在 Windows Credential Manager，非敏感模型配置保存在应用数据目录。图片输入需单独开启；思考等级优先读取 API 声明，未提供时显示未知并允许手动配置。宿主管理默认值和允许范围，插件可按次选择；刷新目录不会覆盖已有配置。不传等级参数不等于关闭模型思考。完整说明见 [宿主模型与 Sidecar](docs/LLM.md)。

<details>
<summary>查看模型配置界面</summary>

![Toolkit 宿主模型配置与厂商快捷模板](docs/assets/screenshots/model-settings.jpg)

图中为 OpenAI 模板的未保存草稿，未填写 API key，也未发送模型请求。

</details>

关闭按钮按宿主策略隐藏主窗口，应用可继续在托盘运行；通过托盘菜单显示主窗口或退出。进程、后台 Sidecar 与窗口有各自的生命周期，退出应用会执行原生会话清理。

## 编写插件

一个外置插件包含 `plugin.json` 和单文件 ESM 入口；依赖应在发布前打包。插件安装目录可通过 Settings 的 **Open plugins directory** 打开。

```json
{
  "id": "my.plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "api": 14,
  "entry": "main.js",
  "contributes": {
    "views": [{ "slot": "tool", "id": "main", "title": "My Plugin" }]
  }
}
```

```js
export default {
  manifest: { id: 'my.plugin', name: 'My Plugin' },
  activate(ctx) {
    ctx.registerView('main', root => {
      root.textContent = 'Hello, Toolkit';
    });
  },
};
```

插件可以使用宿主 UI 工厂，也可以自行渲染 DOM；需要系统原生能力时可携带 Sidecar。宿主提供：

- **共享 SDK**：主窗口的 `ctx` 与插件窗口的 `bridge` 共用数据能力，差异见 [对等表](docs/plugin-dev/bridge.md)。
- **原生 Sidecar RPC**：通过 Windows 命名管道直接调用 Rust 宿主，模型调用和资源访问不依赖前端中转。
- **二进制与资源交接**：支持双向原始字节 IPC、分块读写、不可变资源引用，以及同插件窗口与 Sidecar 间的一次性交接。
- **有界通信与回收**：请求、流、进程、文件和内存资源分别管理超时、容量、取消与释放；大文件使用 `fs` 区间读取或 Sidecar 本地 IO。
- **类型与能力发现**：提供 [TypeScript 数据接口](sdk/types/README.md)、[Rust SDK](sdk/rust/toolkit-host/README.md) 和运行时 `schema()`。

宿主接口为 **HOST_API 14**，信封版本为 **1**。协议、字节和文件能力见 [PROTOCOL](docs/PROTOCOL.md)、[BINARY-IPC](docs/BINARY-IPC.md) 与 [插件 API](docs/plugin-dev/api.md)。

<details>
<summary>开发者：通信方案速查</summary>

请求使用 `rpc` / `rpc-raw`；批量上行为 `channel-in`；推送为 `channel-json` / `channel-raw`；跨窗口广播为 `event-bus`；子进程使用 `stdio-line` / `pty-stream`；窗口内事件为 `in-process`。各方案的流控与生命周期见协议文档。

</details>

插件按可信代码运行。共享 JavaScript 上下文和声明权限用于约束受支持的调用，不能隔离恶意插件；具体限制见 [信任边界](docs/ARCHITECTURE.md#信任边界)。

## 从源码运行

开发环境使用 Node.js 24 和 Rust/MSVC 工具链；Windows 原生依赖按 [Tauri 开发环境](https://v2.tauri.app/start/prerequisites/) 配置。

```powershell
npm install
npm run tauri dev
```

纯浏览器 `npm run dev` 可预览部分界面，完整桌面能力需要 Tauri 宿主。

干净检出后的检查顺序如下。先构建前端和原生检查入口，以生成权限审计所需的 ACL schema：

```powershell
npm run build
cargo run --locked --manifest-path src-tauri/Cargo.toml --example host-checks
npm test
```

原生回归使用 `examples` 作为可执行入口，覆盖进程、文件、截图、PTY、存储和模型管道；完整检查命令见 [架构与验证](docs/ARCHITECTURE.md)。运行时诊断写入应用数据目录的 `debug.log`，自检与故障排查见 [开发调试手册](docs/plugin-dev/debugging.md)。

本地构建安装包：

```powershell
npm run tauri -- build --no-sign
```

正式版本由 [Release workflow](.github/workflows/release.yml) 在 `v*` 标签触发后构建和发布。标签必须与应用配置版本一致；自动更新清单由实际产物和更新签名生成。更新签名与 Windows 代码签名是不同机制，签名私钥不进入仓库。

main 推送执行 CI，版本标签推送执行构建和发布。发版前同步 package.json、package-lock.json、Cargo.toml、Cargo.lock 与 tauri.conf.json 的应用版本，补充 `docs/releases/vX.Y.Z.md` 并提交，再推送对应标签；交付完成以 Release 页面中实际出现安装包为准。

## 项目结构

```text
src/host/            插件加载、共享 SDK、生命周期与外壳状态
src/plugins/         builtin.procman / builtin.streamlab / builtin.store
src/protocol/        请求、事件、流与传输适配
src-tauri/src/       Rust 服务、文件/字节资源、进程与原生接口
sdk/                 TypeScript 契约与 Rust Sidecar 客户端
tests/               自动回归与可运行插件夹具
docs/                架构、协议、插件手册和版本记录
```

## 界面语言与插件翻译

**设置 → 语言** 支持跟随系统、简体中文与 English，覆盖主导航、设置页、模型管理和托盘，切换无需重启。插件可通过 [ctx/bridge.i18n](docs/plugin-dev/api.md#我要让插件跟随宿主语言) 读取语言、翻译自己的词典并订阅变化，Sidecar 可直接查询 Rust 宿主。

![Toolkit 设置页与语言选择菜单](docs/assets/screenshots/settings-language.jpg)

宿主语言切换与插件语言 API 从 v0.1.8 提供。内置工具业务界面、第三方插件的翻译与安装器覆盖情况见 [i18n 升级计划](docs/I18N-UPGRADE.md)。
