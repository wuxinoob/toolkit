# 文档导航

## 当前参考

| 入口 | 用途 |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 模块边界、资源生命周期、当前重构和后续优先级 |
| [PROTOCOL.md](PROTOCOL.md) | 信封、方案、调用与流的契约 |
| [BINARY-IPC.md](BINARY-IPC.md) | 内存字节传输、分块、回退与生命周期 |
| [INTERFACES.md](INTERFACES.md) | 原生命令、服务、权限及结构性例外 |
| [UI.md](UI.md) | 外壳样式、插件 UI 和组件规则 |
| [plugin-dev](plugin-dev/README.md) | 插件作者手册；维护者看其中的 MAINTENANCE |
| [FREEZE-ROOT-CAUSE.md](FREEZE-ROOT-CAUSE.md) | 冻结根因、PTY 修复和原生回归 |
| [STARTUP-ANALYSIS.md](STARTUP-ANALYSIS.md) | 开发启动时间线、首屏依赖与窗口显示时序 |
| [DEVELOPMENT-LOG.md](DEVELOPMENT-LOG.md) | 自动开发阶段、验证结果与下一步 |
| [I18N-UPGRADE.md](I18N-UPGRADE.md) | 中英语言、多窗口、原生托盘与插件国际化的分阶段计划 |
| [v0.1.7](releases/v0.1.7.md) | 模型服务、原生 Sidecar、资源交接与通信修补的阶段说明 |
| [v0.1.4](releases/v0.1.4.md) | 冻结与启动修复的版本说明、兼容性和验证范围 |

## 历史与计划

[archive](archive/README.md) 保存旧设计和已完成的评审，不能用于判断现有 API。
[FREEZE-REPORT.md](FREEZE-REPORT.md) 是定位前的现场快照，其中假设的结论以根因分析为准。
[通信审计](COMMS-AUDIT-2026-09-23.md) 的身份信任问题仍是已知限制；[接口评审](INTERFACE-REVIEW-2026-09-27.md) 仅记录当时分类和待办。
旧文件访问评估已由 [现行文件接口](plugin-dev/api.md#文件读写-ctxfs--bridgefs) 和 [资源生命周期](ARCHITECTURE.md#通用数据协议) 取代并删除。

- [宿主模型服务与 Sidecar 直连](LLM.md)：配置、授权、流控、原生 SDK 与验收边界。
