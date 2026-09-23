# File Probe — 文件访问的现场验证

验证两件**应用内自检覆盖不到**的事：原生对话框和系统文件拖放。
两者都需要**真人**点一下或拖一下，所以自检（跑在 webview 里、没有用户）做不到。

它同时也是这两个 API 的**可运行示例** —— 手册里写「调 `ctx.files.pick()`」，
读者会想看到一个真的在跑的。

## 装

复制这个目录到 `%APPDATA%\com.tan18.toolbox\plugins\`，然后点侧栏 **Rescan**。

## 它检查什么

**激活时自动跑**（不需要你动手，结果写进 `debug.log`）：

| 检查 | 期望 |
|---|---|
| `ctx.files.pick` / `save` / `message` 存在 | 三个都在 |
| `ctx.onDrop` 存在 | 在 |
| `ctx.onDrop` 订阅成功 | 不抛错 |
| `ctx.rpc('host','info')` 通了 | 权限闸放行 |

**任何一项失败，插件行会是 `error` 而不是 `active`** —— 启动日志直接告诉你，
不用点任何东西。（这个模式抄自 `examples/plugins/probe/`。）

**需要你动手的**（点按钮，然后看日志区）：

| 按钮 | 验的是 |
|---|---|
| **Pick a file** | `ctx.files.pick()` 单选 → 返回 1 条路径 |
| **Pick several** | 多选 → 返回 N 条 |
| **Pick a folder** | `folder: true` → 返回目录 |
| **Save as…** | `ctx.files.save()` → 返回路径或 `null` |
| **Message box** | 原生消息框弹出并能关掉 |
| **拖一个文件到窗口上** | `ctx.onDrop` 回调触发，日志区出现 `drop #1` |

**取消也是结果**：`pick` 取消 → `[]`，`save` 取消 → `null`。
两者都**不是错误**，日志里标成 `warn` 而不是 `bad`。

## 读日志

插件把每件事同时写到**两个地方**：视图里的日志区，和 `ctx.log` → `debug.log`。

**视图的日志区如果因为渲染 bug 空了，`debug.log` 里还有。** 这是刻意的 ——
调试插件自己出问题时，不能只靠它自己的界面。

```
[fileprobe] ctx.files.pick present
[fileprobe] subscribed to ctx.onDrop — drag a file onto this view
[fileprobe] drop #1 on view "fileprobe.demo/fileprobe": 2 path(s)
[fileprobe]   C:\Users\…\a.txt
[fileprobe] pick returned 1 path(s)
```

## 顺带开着通信 trace

如果你想看**网关层**发生了什么（而不仅是插件自己写的），打开 trace：

```js
window.__toolbox.hub.setTrace(true)
```

然后 `debug.log` 里会出现：

```
rpc -> fileprobe.demo host/info 3ms ok
rpc -> fileprobe.demo proc/spawn 1ms err: plugin `fileprobe.demo` lacks permission `rpc:proc`
```

**第一列是调用方自称的身份。** 这是刻意的 —— 见
[`docs/COMMS-AUDIT-2026-09-23.md`](../../../docs/COMMS-AUDIT-2026-09-23.md)。

## 这个插件刻意不做的事

**它不读文件内容。** 宿主没有 `ctx.fs`（fs 读写仍在待裁定，
见 [FILE-ACCESS-PLAN.md](../../../docs/plugin-dev/FILE-ACCESS-PLAN.md)），
所以拿到路径之后，读内容是插件自己起 sidecar 的事。

**它也不假装拖放能按元素定位。** Tauri 的拖放是**窗口级**的，
而且 `dragDropEnabled` 默认开启时会压制 HTML5 的 `ondrop` ——
所以画一个「把文件拖到这个框里」的精确目标会是**撒谎**。
那个虚线框只是视觉提示，真正收到的是整个窗口的拖放。
