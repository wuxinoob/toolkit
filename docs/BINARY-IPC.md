# WebView 与宿主的二进制传输

`ctx.bytes` 和 `bridge.bytes` 用 JSON 请求读取字节。`binary.open` 为 WebView 和 Rust 宿主提供双向、有界的字节传输，可用于文件、剪贴板和原生处理能力的后续接入。

## 插件接口

主窗口和插件窗口共用 `binary.open(size, { timeoutMs })`，需要 `rpc:binary`。`size` 是本次会话声明的最大字节数。返回的句柄提供 `id`、`maxChunkBytes`、`write(offset, bytes)`、`read(offset, maxBytes)` 和 `close()`。省略 `maxBytes` 时按单块上限读取。

每次写入确认当前已收到的字节数。首次写入从 0 开始，后续块连续写入。重发已确认的相同字节会得到当前确认位置，跳跃偏移或改写已有字节返回 `conflict`。读取返回从指定偏移开始的已有字节，读到当前位置末尾返回空字节数组。每个句柄逐块等待确认。

```js
const transfer = await ctx.binary.open(input.byteLength);
try {
  let offset = 0;
  while (offset < input.byteLength) {
    const chunk = input.subarray(offset, offset + transfer.maxChunkBytes);
    offset = await transfer.write(offset, chunk);
  }

  const firstChunk = await transfer.read(0);
  // firstChunk 是 Uint8Array，可继续按偏移读取。
} finally {
  await transfer.close();
}
```

单块上限为 256 KiB，单会话为 16 MiB，宿主为 64 MiB 和 16 个会话。新会话按声明大小预留预算。句柄属于发起调用的窗口及插件，关闭可重复调用。插件停用通过现有 disposer 关闭，窗口销毁和主窗口启动回收遗留会话。操作超时表示调用方停止等待，传输槽会保持占用直至 IPC 返回。显式关闭可释放宿主持有的缓冲区。

## IPC

控制参数使用 JSON。写块使用完整的 `Uint8Array` 请求体，句柄和偏移由请求头传递。Rust 从 `tauri::ipc::Request` 读取原始字节。读块使用 `tauri::ipc::Response` 返回字节。兼容 Tauri 回退路径中的有界数字数组，每个值须为 0 至 255 的整数。

`host/schema.binaryTransfer` 公布能力版本和限额。JSON 信封版本为 1。raw RPC 复用超时逻辑、结构化错误和在途统计，`ctx.bytes` 的回退数组接受最多 8 MiB 的字节值。这个上限约束 JS 解码，IPC 自身的缓冲仍由 Tauri 管理。

Node 适配器和原生检查覆盖 2 MiB 以上的分块往返、重复块、容量预算、窗口归属和清理。真实 WebView2 的 IPC 回退仍需桌面验证。单次 IPC 会产生跨进程缓冲和复制，已在磁盘上的大型 Sidecar 输入输出适合通过文件交接。

## 文件大小与会话容量

16 MiB 是宿主保留的单个内存会话容量。按块发送限制了单次 IPC 的大小，已写入的块仍留在 Rust 的缓冲区，读取区间不会消耗或释放原数据。关闭会话才释放这份缓冲区。多会话共享 64 MiB 的预留预算。WebView、Tauri IPC 和宿主会分别持有传输所需的缓冲区。文件资源、顺序消费和媒体区间的设计约束见 [通用数据协议](ARCHITECTURE.md#通用数据协议)。

`ctx.files.sha256()` 通过原生对话框选择文件，由 Rust 使用 1 MiB 缓冲区增量计算摘要。IPC 只回传路径、大小和摘要，文件大小独立于内存会话容量。

`ctx.fs` / `bridge.fs` 通过同样的原始字节 IPC 读写文件区间。每次最多 256 KiB，宿主保留文件句柄，块完成后可以释放传输缓冲区。文件总大小独立于 `binary.open` 的预算。接口见 [文件读写](plugin-dev/api.md#文件读写-ctxfs--bridgefs)。
