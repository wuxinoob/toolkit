# Message Log — 观测层的现场视图

把**观测层**（`architecture.md` 的「观测层」一节）从文档变成能看的东西。
四个源，一个界面：

| 源 | 是什么 | 怎么产生 |
|---|---|---|
| `[trace]` | **每一种消息**：rpc / pub / sub / evt / open / frame / end | `hub.setTrace(true)` —— 本插件开 |
| `[event]` | 窗口内事件（`in-process`，零 IPC） | `ctx.events.emit` |
| `[bus]` | 跨窗口广播（`event-bus`） | `ctx.bus.publish` |
| — | 会话表 | `ctx.sessions()` |

**`[trace]` 不只 rpc** —— 它包在 hub 的四个入口上（`request` / `publish` /
`subscribe` / `stream`），所以流里的**每一帧**、**到达的每个事件**都在里面。
`sidecar` / `pty` / `uplink` / `streamRaw` 都走同一个 `stream()`，因此一个点全覆盖。

## 装

复制这个目录到 `%APPDATA%\com.tan18.toolkit\plugins\`，点侧栏 **Rescan**。

## 为什么它走 `window.__toolbox` 而不是 `ctx`

**这是刻意的，而且是本插件最重要的一句话：**

> **trace 不是插件 API。**「看所有插件的往来」是**调试能力**，不是**插件能力** ——
> 把它做成 `ctx.observe` 就等于让任何插件读到别的插件的全部调用，
> 那是把隐私漏洞包装成功能。

**测试插件**正是它该待的地方，**调试句柄**正是它该走的门。
`window.__toolbox` 是宿主自己的诊断面，从这里用它是对它身份的诚实。

（这也是为什么它需要 `rpc:host` 之类的权限来查会话 —— 而 trace 那部分不需要权限，
因为它走的是调试句柄，不走网关。）

## 按钮

| 按钮 | 做什么 | 看什么 |
|---|---|---|
| **trace ON/off** | 开关通信 trace | 关掉后网关往来不再出现（但事件还在） |
| **local / bus ON/off** | 按源过滤 | 关掉的源不再触发重绘 |
| **Emit local** | `ctx.events.emit` | `[event]` 出现一行，**且没有 trace 行**（零 IPC） |
| **Broadcast** | `ctx.bus.publish` | `[bus]` 一行 **+ `[trace]` 一行**（走网关） |
| **OS notification** | `ctx.ui.notifyOS` | **Windows 操作中心弹出** + `[trace]` 的 `notify/send ok` |
| **Sessions** | `ctx.sessions()` | 会话表，含 pid / bytesOut |
| **Clear** | 清屏 | — |

## 验证 OS 通知：看两处

**「OS 通知能用吗」这个问题需要两个证据，缺一不可**：

1. **`[trace]` 里出现 `rpc -> msglog.demo notify/send Nms ok`**
   → 证明**调用到了宿主**（权限闸放行、服务返回成功）
2. **Windows 操作中心的右下角弹出通知**
   → 证明**宿主到了操作系统**

**只看到 (1) 说明宿主收到了但系统拒绝了**（通知权限被关、专注助手开着）。
**只看到 (2) 而没有 (1)** 是不可能的 —— 那说明通知不是这个插件发的。

`notifyOS` 返回 `false` 就是 (1) 成功但 (2) 失败的信号。

## 一个值得注意的对比

按 **Emit local** 和 **Broadcast**，看 trace 的差别：

- **local** 只有 `[event]` 一行 —— `in-process` 是窗口内的 Map，**零 IPC**
- **broadcast** 有 `[bus]` + `[trace]` 两行 —— `event-bus` **走网关**

**同一个 `ctx.*` 形状，两个完全不同的代价。** 这就是「方案差异」的实际含义。

## 已知的一处不一致

`ctx.events`（in-process）回调拿到**裸 payload**，`ctx.bus`（event-bus）拿到**完整信封**
（payload 在 `env.p`）。本插件按各自的形状写，注释里标了。
详见 [`docs/COMMS-AUDIT-2026-09-23.md`](../../../docs/COMMS-AUDIT-2026-09-23.md) 第 2 条。
