# WebView 与宿主的二进制传输

`ctx.bytes` 和 `bridge.bytes` 用 JSON 请求读取字节。`binary.open` 为 WebView 和 Rust 宿主提供双向、有界的字节传输，可用于文件、剪贴板和原生处理能力的后续接入。

## 资源交接（HOST_API 13）

`binary.identity()` 返回原生分配的 `{owner}`；后台 Sidecar 的 `sidecars.list()` 也返回 owner（未启用 hostRpc 时为 null）。owner 是接收目标，不能用来冒充调用者。

发送方 `binary.export(id, {to: owner})` 仅接受封存资源，返回 `{token,to,expiresInMs}`；通过插件自己的消息传给接收方，接收方 `binary.import(ticket)` 领取具有新 id 的只读句柄（read/stat/close/source）。必须同插件且原生 owner 与 to 相同，票据只能领取一次，错误接收方不会消耗票据。

未领取票据在 30 秒后自动删除，发送方可 `binary.revoke(ticket)`；关闭发送资源或发送方退出也撤销未领取票据。领取后双方引用独立，发送方关闭不影响接收方，接收方关闭或退出释放其引用。已领取票据不能再由发送方撤销，业务取消由插件协议实现。

原生共享不可变 Arc 分配，不重复计费；读取到 WebView/Sidecar 仍有传输复制。最多 64 个引用、32 张未领取票据，64 MiB/16 分配预算不变。需要 rpc:binary，不支持跨插件交接。票据不能持久化供后续实例使用。

```js
const worker = (await ctx.sidecars.list()).find(item => item.key === 'worker');
if (!worker?.owner) throw new Error('worker host RPC is not running');
const image = await ctx.screen.captureResource();
const ticket = await ctx.binary.export(image.id, { to: worker.owner });
// 通过插件协议把 ticket 交给 worker，等待它确认 import 成功后关闭 image。
// 失败时撤销 ticket 并关闭 image；接收方最终也要关闭自己的引用。
```

## 图像生产预算

截图/剪贴板图像读取最多同时运行 2 个，共享 512 MiB 临时工作预算。截图按目标像素、原生瓦片与编码工作区估算；剪贴板在调用原生库前预留最大工作预算，实际像素上限仍在库返回后校验。这是准入控制，不是整个进程内存的测量或硬上限。

64 MP 是截图几何上限，单次工作估算超出预算仍会拒绝，应缩小矩形；并发占用预算时返回 conflict，等待后再请求。PNG 编码达到限制立即失败：capture 最大 8 MiB，captureResource 最大 16 MiB，剪贴板图片最大 8 MiB。与资源驻留预算分开计量，不能把 16 MiB 当作处理峰值内存。schema.screenCapture 公布限制。

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

单块上限为 256 KiB，单会话为 16 MiB，宿主为 64 MiB 和 16 个分配（包含已关闭但仍被借用的资源）。新会话按声明大小预留预算。句柄属于发起调用的窗口及插件，关闭可重复调用。插件停用通过现有 disposer 关闭，窗口销毁和主窗口启动回收遗留会话。操作超时表示调用方停止等待，传输槽会保持占用直至 IPC 返回。显式关闭可释放宿主持有的缓冲区。

## IPC

控制参数使用 JSON。写块使用完整的 `Uint8Array` 请求体，句柄和偏移由请求头传递。Rust 从 `tauri::ipc::Request` 读取原始字节。读块使用 `tauri::ipc::Response` 返回字节。兼容 Tauri 回退路径中的有界数字数组，每个值须为 0 至 255 的整数。

`host/schema.binaryTransfer` 公布能力版本和限额。JSON 信封版本为 1。raw RPC 复用超时逻辑、结构化错误和在途统计，`ctx.bytes` 的回退数组接受最多 8 MiB 的字节值。这个上限约束 JS 解码，IPC 自身的缓冲仍由 Tauri 管理。

Node 适配器和原生检查覆盖 2 MiB 以上的分块往返、重复块、容量预算、窗口归属和清理。真实 WebView2 的 IPC 回退仍需桌面验证。单次 IPC 会产生跨进程缓冲和复制，已在磁盘上的大型 Sidecar 输入输出适合通过文件交接。

## 文件大小与会话容量

16 MiB 是宿主保留的单个内存会话容量。按块发送限制了单次 IPC 的大小，已写入的块仍留在 Rust 的缓冲区，读取区间不会消耗或释放原数据。关闭会话且所有原生借用结束才释放这份缓冲区。多会话共享 64 MiB 的预留预算。WebView、Tauri IPC 和宿主会分别持有传输所需的缓冲区。文件资源、顺序消费和媒体区间的设计约束见 [通用数据协议](ARCHITECTURE.md#通用数据协议)。

`ctx.files.sha256()` 通过原生对话框选择文件，由 Rust 使用 1 MiB 缓冲区增量计算摘要。IPC 只回传路径、大小和摘要，文件大小独立于内存会话容量。

`ctx.fs` / `bridge.fs` 通过同样的原始字节 IPC 读写文件区间。每次最多 256 KiB，宿主保留文件句柄，块完成后可以释放传输缓冲区。文件总大小独立于 `binary.open` 的预算。接口见 [文件读写](plugin-dev/api.md#文件读写-ctxfs--bridgefs)。

## 封存资源与原生数据通道（HOST_API 10）

资源采用 uploading → sealed → close。`seal()` 只接受已写满声明长度的资源，返回 `{kind:'resource',id,size}`；之后禁止写入。`stat()` 返回 size/written/sealed。`binary.upload(bytes)` 逐块上传并封存，返回带 source 的现有句柄，失败自动关闭。

所有生产者、WebView 原始字节会话和 Sidecar 上传共用同一份 64 MiB / 16 分配预算。资源引用按原生 Caller 隔离，不存在隐式跨窗口/跨进程共享；HOST_API 13 可通过一次性票据显式交接。同一分配的多个引用只计一份驻留字节预算。关闭撤销对应句柄，预算在最后引用或原生借用释放后归还。图片不是消费即释放的流；处理超大文件仍使用 fs 或原生文件 IO。

Sidecar 声明 rpc:binary 并启用 hostRpc 后，宿主注入 TOOLKIT_RESOURCE_PIPE。该独立命名管道与控制通道使用相同本机 DACL 和进程 PID 校验。JSON 控制服务 binary 提供 open/seal/stat/close/close_all，字节不经过 stdio、JSON 数组或 Base64。控制 host/schema.resources 声明 rawLane/version/maxChunkBytes。

每次数据操作：u32LE 长度前缀的 JSON 头 `{op:'write'|'read',id,offset,length}`，write 后紧跟 length 个原始字节（最多 256 KiB）。响应为同样 JSON 帧：成功 `{ok:true,length,offset?}`，紧跟 length 个下载字节；失败 `{ok:false,code,message}`，没有数据。每条数据管道逐次完成请求/响应，SDK 同步排队；取消、超时或半包均丢弃管道，不自动重放。控制通道始终可独立取消模型。数据/控制断开或进程退出清理实例资源与任务。未使用数据管道的旧客户端可以继续只连接控制管道。原始数据操作中途取消后，需要重新启动 Sidecar RPC 实例，不能对已关闭的命名管道重新连接。
