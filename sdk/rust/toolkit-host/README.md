# toolkit-host

HOST_API 14 的界面语言能力需要 plugin.json 声明 rpc:i18n。`client.locale().await?` 直接经原生命名管道返回 mode、locale、resolvedLocale、revision；显示使用 resolvedLocale。此查询不经过前端，也不创建或修改语言设置。本版不提供 Sidecar 语言推送，按业务需要读取；JS 插件的词典与订阅见 [插件 i18n](../../../docs/plugin-dev/api.md#我要让插件跟随宿主语言)。

Windows Sidecar 的异步宿主 RPC 客户端。直接连接宿主注入的命名管道，不依赖 WebView 或 stdout 转发。完整协议与配置见 [docs/LLM.md](../../../docs/LLM.md)。

在自己的 crate 中使用仓库路径依赖（打包时只需携带编译后的 exe）：

```toml
[dependencies]
toolkit-host = { path = "path/to/toolkit/sdk/rust/toolkit-host" }
serde_json = "1"
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
```

```rust,no_run
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let host = toolkit_host::Client::connect_from_env().await?;
    let profiles = host.profiles().await?;
    let profile = profiles[0]["id"].as_str().ok_or("no model profile granted")?;
    let mut generation = host.stream(json!({
        "profile": profile,
        "messages": [{"role":"user","content":[{"type":"text","text":"hello"}]}]
    })).await?;
    while let Some(event) = generation.next().await? {
        // stdout 仍可用于插件自己的消息协议；此处只写 stderr。
        eprintln!("{event}");
    }
    Ok(())
}
```

`Client` 可 clone，同一连接上的请求通过 ID 关联，可并发等待 `next` 与 `cancel`。`generate(request)` 提供最多 4 MiB 的有界聚合结果。`Generation::cancel()` 发送取消；Drop 尽力发送取消，连接断开后宿主会回收此实例所有请求。没有自动重连或付费请求重放。

HOST_API 12 的 `profiles()` 返回 `reasoning: null | {defaultEffort, allowedEfforts}` 和 `capabilities.reasoning`。不传 `reasoningEffort` 时由宿主采用默认值，插件无需重复填入；按任务覆盖时，在 `stream` 或 `generate` 的 JSON 请求中加入 `"reasoningEffort":"low"`，并先确认等级属于所选配置的 `allowedEfforts`。未启用时显式指定返回 `unsupported`，越界返回 `bad_params`。这一策略和前端插件一致，校验及供应商适配由 Rust 宿主执行。

在插件中通过 `ctx.sidecars.start({key:'worker',exe:'worker.exe'})` 显式启动后台实例，或为既有 stdio Sidecar 加 `hostRpc:true`。清单需声明 `rpc:proc`、`rpc:llm`，用户还需在宿主设置中授权模型配置。环境变量只包含 IPC 地址，不包含 key。

其他语言可按长度前缀信封实现相同协议；调用 `host/schema` 查询当前连接开放的服务，不要假设所有宿主服务都能从原生管道访问。

HOST_API 13 的原生 schema 与 WebView 共用能力版本和参数/返回定义，按连接开放的动作过滤；fs 仍仅提供给前端。资源交接：`host.resource_identity()` 取得接收 owner，发送方 `resource.export(to)` 生成一次性票据，接收方 `host.import_resource(ticket)` 返回自己的只读 Resource，仍可 source/read/stat/close。票据必须同插件且指向此实例，30 秒过期；未领取时可用 `host.request("binary","revoke", json!({"token":ticket["token"]}))` 撤销。关闭发送资源会撤销未领取票据，领取后双方独立释放引用。详见 [资源交接](../../../docs/BINARY-IPC.md#资源交接host_api-13)。


HOST_API 10 提供原始字节资源（另需 rpc:binary）。Sidecar 自行读取文件，然后上传，JSON 请求只含引用：

```rust,no_run
let bytes = std::fs::read("image.png")?;
let resource = host.upload_resource(&bytes).await?;
let result = host.generate(serde_json::json!({
    "profile": "vision",
    "messages": [{"role":"user","content":[
        {"type":"text","text":"Describe this image"},
        {"type":"image","source":resource.source()}
    ]}]
})).await?;
resource.close().await?;
```

大文件可用 open_resource(size) 后逐块 write（256 KiB）并 seal；资源最大 16 MiB。read 按块返回，stat 查询状态，close 显式释放，Drop 尽力关闭。对象不是消费即释放的流，大于资源容量的文件继续本地流式处理。connect_from_env 自动使用 TOOLKIT_RESOURCE_PIPE；控制与字节管道独立，原始传输取消/超时会丢弃管道，宿主清理该实例。没有自动重放。使用原生 screen/capture_resource 的结果时，在同一实例调用模型，随后 binary/close。
