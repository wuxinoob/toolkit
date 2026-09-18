# 通信架构评审（2026-09-17）

范围：源码阅读，以及真实 JS hub/stdio transport、模拟 RPC 边界的一次最小验证。未运行完整测试、Rust 程序或 GUI，业务代码不变。

## 定位与判断

项目是 Tauri/Vue 插件工具箱：ESM 插件提供 UI/编排，Rust 提供平台服务，sidecar 承载插件原生后端。保留控制/数据面、transport/codec 分离。下一步重点应是资源所有权、终止语义、并发生命周期和有界 IO，而非新增通信方案。

## 源码发现

- src/host/external.js:36：已有 id 跳过，Rescan 只增量发现，不处理更新、删除或错误记录重试。
- src/host/lifecycle.js:21：Disposer 不等待异步清理，没有关闭状态；订阅/流可能停用后才完成登记。
- src-tauri/src/services/proc.rs:267：kill_all_for 先 session::close 再 stop_one，终止回调已经删除，不能执行。移除 Child 对象不等于结束进程。
- src/protocol/transports/stdioLine.js:90：close 先 stopped=true，finish 因 guard 跳过 onEnd。最小验证得到 onEndCalls=0、remainingHubStreams=1。ctx 的清理直接调用 handle.close，存在 hub 残留路径。
- src/protocol/envelope.js:28 与 stdioLine.js:62：err 一律被视为终止；sidecar 一次业务请求失败不应停止整个会话读取。
- src-tauri/src/services/proc.rs:120：stdout VecDeque 无累计容量限制；单行 1MiB 不限制总内存。stdio 默认每消费一行等 50ms，连续输出理论上限约 20 行/秒，尚未计 IPC 开销。
- src-tauri/src/services/proc.rs:114：reader 在 EOF/读错误后持 Child mutex 阻塞 wait，kill 也需要该锁；stdout 关闭但进程仍运行时可能无法终止。这是静态路径判断，未做进程级复现。
- src/protocol/transports/pty.js:41：静默 120ms/最多 1500ms 的 drain 不能保证尾部输出先于 exit；PTY 创建后才登记 native session，且登记失败被忽略。

## 改进方向

Rust ProcessSupervisor 作为 OS 资源真相源，JS hub 作为代理。允许多张索引，但终止操作只能有一个所有者。原生分配 sessionId，并关联 pluginId/windowId/generation，ch 仅为逻辑名称。

控制保留 invoke：open/writeBatch/resize/cancel/close/query；输出使用 Channel，event-bus 用低频跨窗口通知，无须全部改成 WebSocket。

ResourceScope 应异步、幂等关闭，等待所有清理，自动清理晚到资源，结合 AbortSignal/generation 阻止旧代提交。并发 open 在 await 前预留状态。显式关闭、自然退出、启动失败、窗口销毁汇合至唯一 finalizer。

区分 request 完成、process exit、stdout/stderr EOF、session closed。原生协调 EOF 与 exit，避免持 kill 所需锁进行阻塞 wait。先有界合作退出，再终止进程树；Windows 可考虑 Job Object，不只依赖正常应用退出回调。

stdio push/batch 必须配端到端字节容量和消费确认，不能把无界队列搬到 WebView。协议回复不能静默丢弃；日志可配置丢旧并报告丢失数。stdout 协议和 stderr 诊断分离。

sidecar SDK 统一 pending map、request id、deadline、取消和进程退出后的请求拒绝。PTY 保持字节流和 resize，不因双向读写就称为业务 requestResponse。统一语义而非强迫二进制携带完整 JSON 信封。上行先测有界 writeBatch，再决定是否增加传输。

热更新先做内容摘要驱动的 added/changed/removed/retry reconciliation，再做 watcher。兼容校验、准备新代、停止旧代接单、清理资源、激活新代、提交状态；失败时尽可能重启旧版本，不承诺回滚任意副作用。Blob import 不构成隔离或强卸载，副作用应放在 activate，不兼容 HOST_API 不应仅告警。

能力表区分 duplex、correlatedRequestResponse、orderedWithinSession、backpressure、cancellable。查询 schema 动作名不等于版本协商；逐步补充字段契约和稳定错误码。

## 信任与验收

受信任本地插件是合理产品选择。但共享 JS 上下文的前端自报身份/权限是声明约束，不是强调用者认证，文档中无法绕过的表述应收紧。若支持不可信插件，应引入原生安装授权、隔离运行域和最小 ACL；同一 WebView 内 token 不能单独成为沙箱。未执行权限绕过操作。

优先修 killAll、close/onEnd、请求错误作用域、异步清理、wait/kill 锁；然后统一原生所有权/session/generation；再完善推送背压；最后热更新和字段级协商。

回归场景：并发同名 open、open 中停用、订阅晚到、重复 close、业务错误后继续请求、killAll 后 OS 进程确实消失、stdout 提前 EOF、超长行、慢消费者、尾部输出、窗口销毁、插件变更/移除/重试。进程测试需有界超时与兜底回收。观测队列高水位、pending 数、关闭延迟、迟到/丢弃帧、端到端吞吐、UI 延迟和内存峰值。
