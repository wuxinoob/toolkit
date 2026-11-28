# 宿主模型服务与 Sidecar 直连

实现版本：HOST_API 14；信封和原生 Sidecar RPC 版本均为 1。

## 配置与边界

Settings → Language models 打开独立宿主设置窗口。先添加连接（API 格式、完整基础 URL，如 `https://api.openai.com/v1`），再添加模型配置（模型 ID、连接、输出 token 上限、超时、允许使用的插件），选择默认配置并保存。测试按钮会发送一个短请求，可能消耗所配置服务的额度。

连接支持 `openai-chat`（Chat Completions 兼容协议）和 `openai-responses`（Responses 协议）。模型 ID 由用户填写，不在启动时拉取远端模型目录。HTTPS 默认需要 API key；HTTP 仅接受 loopback，可不配置 key。不同服务的协议兼容性仍取决于其实现；请求失败不会切换服务、重试或重放。

### 常用平台快捷模板

Connections 下的 Quick templates 提供以下模板（2026-11-21 核对官方文档）。单击会新建连接草稿，预填名称、格式和基础 URL。随后输入 key，并在对应连接卡片点击 Add model；新模型会关联这条连接。模型 ID、默认配置和插件授权由用户设置，最后点击 Save settings。Custom connection 可添加其他兼容服务；地址和格式都可继续修改。

| 模板 | API 格式 | 基础 URL | 官方来源 |
|---|---|---|---|
| DeepSeek | `openai-chat` | `https://api.deepseek.com` | [API 入门](https://api-docs.deepseek.com/) |
| OpenAI | `openai-responses` | `https://api.openai.com/v1` | [Responses 入门](https://developers.openai.com/api/docs/quickstart) |
| Gemini | `openai-chat` | `https://generativelanguage.googleapis.com/v1beta/openai` | [官方兼容接口](https://aistudio.google.com/docs/openai) |
| Claude | `openai-chat` | `https://api.anthropic.com/v1` | [官方兼容接口](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk) |
| SiliconFlow | `openai-chat` | `https://api.siliconflow.cn/v1` | [Chat Completions](https://docs.siliconflow.cn/docs/api/chat-completions-post) |

Gemini 使用 Google AI Studio 的 Gemini API key；SiliconFlow 预置中国站点，模型 ID 需包含控制台给出的完整提供者前缀。Claude 模板使用工作区范围的 API key；需要额外 `anthropic-workspace-id` 请求头的账户或服务账户 key 尚不能直接使用此模板。Gemini 与 Claude 复用官方兼容协议，插件和 Sidecar 的调用接口保持一致。

### 凭据与调用权限

非敏感配置保存在 `{appData}/llm.json`；API key 保存在当前 Windows 用户的 Credential Manager，目标名为 `com.tan18.toolkit/llm/<connectionId>`。JSON、插件 SDK、Sidecar 环境变量、能力发现与诊断日志不返回 key。只有固定的 `host-llm-settings` 原生窗口能执行设置管理命令；通用窗口创建命令保留这个标签。修改配置或 key 会取消现有请求，删除连接同时删除对应凭据。

模型管理窗口在原生事件线程创建，Windows 下复用主窗口的 WebView2 环境；并发打开合并为同一个窗口。创建阶段、浏览器 PID、运行时版本和 `ProcessFailed` 写入 `debug.log`，不包含 key 或模型输入。`0x80010108` 表示 WebView2/COM 断连，错误提示会要求重启 Toolkit；宿主不会自动重启并中断用户会话。共享环境可避免新窗口重新解析运行时，但不能修复已经退出的浏览器进程。

插件须声明 `rpc:llm`，并由用户在模型配置中授权插件 ID。这两层都通过才可生成；`profiles()` 只列出该插件获准使用的配置。它返回 `id`、`name`、`default`、`capabilities`、`maxOutputTokens` 和 `reasoning`，不返回基础 URL 或凭据。未授权的默认配置不会自动替换成其他配置，插件可以显式传入获授权的 profile。

插件的模型选择控件应在界面挂载时调用 `profiles()`，区分正在加载、无授权配置和 RPC 失败，不能以空下拉框代替这些状态。宿主保存配置后可在窗口重新获得焦点、用户刷新或生成前重新读取。这个查询不调用供应商 API，也不开始模型生成。listener 已采用此流程，并提供刷新按钮。

支持文本和图片输入、流式文本输出；文件附件、工具调用暂不支持。图片仅在模型配置显式启用 Allow image input 后发送。服务与传输围绕通用调用上下文和分块消费设计，插件负责提示词、会话、工具执行和业务流程。新增能力不应添加某个插件专用的宿主方法。宿主不读取账户余额，不推算金额，不自动购买额度。

### API 可用性测试与模型能力发现

连接卡片的 **Test API & discover models** 使用当前地址、格式及填写的 key 请求基础 URL 下的 `/models`。地址和 key 可以尚未保存；未填写新 key 时使用该连接已保存的凭据。检查仅用于本次诊断，保存仍通过 Save settings 执行。网络操作在 Rust 中进行，凭据不进入插件或目录结果。

成功时显示模型目录、耗时和服务声明的元数据：模型类型、输入/输出模态、上下文、输出上限、思考等级及默认等级。可以按 ID、名称、所有者搜索，点击 **Use model** 新建关联配置，Model ID 输入框也提供目录补全。目录中的上限用于新配置的初值，不改写已有模型设置。

发现按可复用元数据字段解析，不通过模型名称猜测能力。例如 [DeepSeek 的模型目录](https://api-docs.deepseek.com/api/list-models/)提供模态及思考等级；[OpenAI 目录](https://developers.openai.com/api/reference/resources/models/methods/list)主要提供模型标识和所有者；[Claude 目录](https://platform.claude.com/docs/en/api/models/list)还提供嵌套的能力声明。解析支持布尔能力字段及 `capabilities.*.supported`，输入 token 上限与总上下文容量分别展示。缺失或无法识别的字段保留为未知；目录声明不会自动开启模型的图片权限，也不代表远端实际调用已经验证。

思考等级的目录结果区分三种状态，不把缺失字段当作“不支持”：

| 归一字段 `reasoningEfforts` | 含义 | 设置页行为 |
|---|---|---|
| `null` | 未声明、仅声明总体支持但未列出等级，或无法识别 | 显示未知；允许按 API 文档手动填写，无预填等级 |
| `[]` | 明确空列表、总体 effort 支持为 false，或所列等级全部为 false | 显示 API 声明无可用等级；不自动启用等级控制 |
| 非空列表 | API 明确声明的等级 | 展示等级及有效的声明默认值，可用于新配置或显式采用 |

模型卡片的 **Query API effort declarations / 查询 API 等级声明** 复用连接目录检查。**Apply API-declared levels and default / 采用 API 声明的等级与默认值** 才会替换当前配置的等级列表与默认值，保留已有 Chat 输出 token 字段等设置；仍需保存。修改模型或连接后展示对应模型的本次查询结果，不把其他模型的声明沿用为当前声明。重新打开设置页时目录回到未知，已保存的本地策略仍保留。这里没有新增插件或 Sidecar 的凭据查询权限。

目录读取成功只证明该接口返回了可解析的目录。它不能证明每个模型可生成、账户有足够额度、指定思考参数生效或所有其他模态可用。HTTP 404/405/501 显示目录接口不可用，保留手填模型及生成测试入口；401/403、429、网络、JSON 和响应大小错误分别报告，原始错误正文不回传，避免服务在正文中回显 key。请求总时限为 15 秒，JSON 最大 1 MiB，最多展示 2048 个模型；部分结果明确标记，页面每次显示最多 100 条搜索匹配。目录是当前页的临时结果，修改地址、格式或输入 key 后失效。

模型卡片的 **Test saved model** 使用保存后的真实模型配置执行文本生成，输出上限取配置上限与 256 token 的较小值，可能消费供应商额度。报告耗时、结束原因、usage 和最多 512 字符的响应预览，截断时显示标记。仅收到非空白文字才标记文本生成验证通过，判断依据是完整输出流而非预览；收到完整流但没有可见文字时，显示请求已结束和具体结束原因，不将其算作文本输出验证成功。配置或 key 尚未保存时禁用此按钮，避免测试旧设置。Cancel test 取消生成测试。

### 生成参数由谁配置

当前接口如下，前端与原生 Sidecar 共用同一份请求契约：

| 参数 | 宿主设置 | 插件单次请求 |
|---|---|---|
| API key、基础 URL、API 格式、模型 ID | 宿主管理 | 选择已授权的 `profile`，不提供凭据 |
| 输出 token | 配置默认值及上限 `maxOutputTokens` | 可传更小的 `maxOutputTokens` |
| 超时 | 配置原生 deadline `timeoutMs` | 可主动取消 |
| 温度 | 尚无宿主默认值 | 可选 `temperature`，模型是否接受由服务决定 |
| 思考等级 | 启用后配置 `reasoning.defaultEffort` 与 `allowedEfforts` | 可选 `reasoningEffort`，必须属于允许列表；省略或 null 沿用宿主默认值 |
| 思考 token 预算 | 暂不支持 | 暂不支持 |

### 思考等级（HOST_API 12）

在模型卡片启用 **Enable reasoning effort parameters / 启用思考等级参数**，填写允许等级并选择默认等级。API default 表示不发送等级参数。允许列表支持 1–16 个不重复名称，每个为 1–32 位小写字母、数字、`-` 或 `_`，不固定为三档。旧配置默认关闭，保持原请求行为。从目录新增模型时可使用服务明确声明的等级和默认值；目录查询不会修改已有配置。没有等级声明时，手动启用得到空草稿，至少填写一个等级后才能保存，也可取消等级参数控制。编辑列表会去重；移除当前默认等级时回到 API 默认，不擅自选择另一档。

插件可见的 `reasoning` 为 `null` 或 `{defaultEffort, allowedEfforts}`；`capabilities.reasoning` 表示此配置是否启用等级控制。这里描述的是宿主允许的调用参数，并非远端能力实测结果。现有插件即使不读取新增字段，也会自动使用宿主配置的默认值。禁用等级控制时显式传入等级返回 `unsupported`，超出允许列表返回 `bad_params`；Rust 在读凭据和发送 HTTP 前检查，前端与原生 Sidecar 一致。

默认值来源：目录提供 `effort.supported_levels` / `effort.default_level` 或 `capabilities.effort.<level>.supported` 时使用声明值，不按模型名猜测。缺失声明时不再预填 low/medium/high；声明默认值不属于有效列表时回到 API 默认。API 声明与当前本地允许列表分别展示，二者可能因用户修改或目录更新而不同。Test saved model 仅验证本次请求的文本生成，既不逐档探测，也不能证明服务确实执行了对应思考强度。

等级参数控制与模型是否思考分别处理：取消控制、选择 API 默认都会省略等级字段，不表示关闭思考。DeepSeek 的 `effort.supported_levels` 按其文档仅列出开启思考后的强度，不含关闭用的 `none`；宿主不会据此推断 none 不支持，也不会自动追加 none。需要关闭思考时须核对平台的参数语义；当前两种适配器只映射等级字段，尚无独立的通用 thinking 开关。

| 情况 | 插件可见配置或请求字段 | 生成 API 的字段 |
|---|---|---|
| 未启用控制 | 配置 `reasoning: null`；请求省略 reasoningEffort 或传 null | 省略思考等级字段，服务仍可采用自己的默认思考行为 |
| 启用但默认由 API 决定 | 配置 `reasoning: {defaultEffort:null, allowedEfforts:[…]}`；请求省略或 null | 同样省略字段 |
| 显式等级 | 请求 `reasoningEffort:"low"`，必须在允许列表中 | Chat 为 `reasoning_effort:"low"`；Responses 为 `reasoning:{effort:"low"}` |
| 显式 none | `reasoningEffort:"none"`，必须纳入允许列表且由远端支持 | 发送 none 字符串；与省略参数不同 |

请求 null 表示**继承宿主默认值**。宿主默认是 high 时，传 null 仍发送 high，不能借此清除默认值。宿主也无默认值时省略字段，不发送 `reasoning_effort:null` 或 `reasoning:{effort:null}`。

Chat 适配器发送 `reasoning_effort`，Responses 发送 `reasoning: {effort}`。启用等级控制的 Chat 配置还可选择输出上限字段：OpenAI 通常使用 `max_completion_tokens`，兼容平台可能使用 `max_tokens`；常用平台模板预填相应初值，用户仍须按实际接口调整。此适配设置不暴露给插件。未启用的旧 Chat 配置继续发送 `max_tokens`；Responses 使用 `max_output_tokens`。推理模型的输出上限通常包含思考消耗，过小的上限可能导致没有可见文字。

等级采用宿主默认值与允许范围、插件单次覆盖、Rust 校验及协议适配的职责划分。OpenAI 的 [reasoning effort](https://developers.openai.com/api/docs/guides/reasoning)随模型而异；Claude 官方 [OpenAI 兼容接口](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)会忽略 `reasoning_effort`，因此该连接禁止启用此控制，原生 Anthropic thinking 协议尚未实现。其他兼容服务接受参数也不证明参数实际生效。Test saved model 显示本次请求采用的等级，但不将它当作思考强度验证。未知生成字段仍被拒绝，不进行无约束 JSON 参数透传。

## JavaScript 插件

主窗口 `ctx.llm` 与插件窗口 `bridge.llm` 形状一致。

```js
// plugin.json: "api": 14, "permissions": ["rpc:llm"]
const profiles = await ctx.llm.profiles();
const request = {
  profile: profiles[0].id, // 可省略，使用用户设定的默认配置
  messages: [{ role: 'user', content: [{ type: 'text', text: '解释这段代码' }] }],
  maxOutputTokens: 1024, // 可省略；不能超过模型配置的上限
};
const result = await ctx.llm.generate(request);
console.log(result.output[0].text, result.usage);
```

需要按任务选择等级时先读取宿主允许范围；省略字段始终沿用默认值：

```js
const profile = profiles.find(p => p.reasoning?.allowedEfforts.includes('low'));
if (profile) {
  await ctx.llm.generate({ ...request, profile: profile.id, reasoningEffort: 'low' });
}
```

`messages` 接受 `system`、`user`、`assistant`，内容为文本块及 user 图片块数组；`temperature` 可选，范围 0–2，但具体模型可能拒绝此参数。宿主不隐式保留对话历史。

```js
const controller = new AbortController();
for await (const event of ctx.llm.stream(request, { signal: controller.signal })) {
  if (event.type === 'text-delta') appendText(event.text);
  if (event.type === 'completed') console.log(event.finishReason, event.usage);
  // await handleChunk(event); 消费完当前块后再拉取下一块。
}
// controller.abort()、提前 break、插件停用、窗口释放都会请求原生取消。
```

公共事件：

```json
{"type":"text-delta","index":0,"text":"你好"}
{"type":"completed","finishReason":"stop","usage":{"inputTokens":3,"outputTokens":2,"totalTokens":5}}
```

结束原因是 `stop`、`length`、`content_filter` 或 `other`。供应商没有上报的 usage 字段保持 `null`。中途断流或供应商错误会拒绝生成；流消费者可能已显示部分文字，不能将这部分当成完整结果。`generate()` 返回 `{output:[{type:'text',text}], finishReason, usage}`，聚合输出最多 4 MiB；更长输出使用 `stream()`，由消费方控制留存。

## 原生 Sidecar

运行 Sidecar 需要 `rpc:proc`；调用模型还需 `rpc:llm` 和同一插件的模型授权。启动时开启 `hostRpc`，宿主注入 `TOOLKIT_HOST_PIPE`，子进程通过自己的 SDK 直接连接 Rust。标准输入输出继续用于插件自己的协议，不承担宿主模型流。

```js
// 原生后台实例：初次启动由插件激活逻辑显式执行。
// 同一 key 和运行模式重复启动会复用已有实例。
await ctx.sidecars.start({ key: 'worker', exe: 'worker.exe', args: [] });
// 默认 hostRpc:true；原生进程可以在页面刷新、关闭后继续工作。
await ctx.sidecars.list(); // [{key, pid, background, hostRpc}]
await ctx.sidecars.stop('worker');
```

`ctx.sidecars` 与 `bridge.sidecars` 相同。普通 `ctx.sidecar(key, {exe,args,hostRpc:true})` 也可开启直连，但保持原有窗口持有及 stdio 消费生命周期。后台实例不自动恢复跨宿主重启的任务，不自动重启崩溃进程；刷新后插件可按同一 key 复用。插件停用会停止其后台实例。

Rust 客户端见 [toolkit-host SDK](../sdk/rust/toolkit-host/README.md)：

```rust
let host = toolkit_host::Client::connect_from_env().await?;
let mut generation = host.stream(serde_json::json!({
    "messages": [{"role":"user","content":[{"type":"text","text":"hello"}]}]
})).await?;
while let Some(event) = generation.next().await? {
    // 在这里处理并释放当前事件；不会在客户端累积完整响应。
}
```

Sidecar 的退出、管道断开、显式停止、插件停用或宿主退出会取消原生请求；窗口重载只清理窗口自己的模型请求。模型请求与进程实例代次绑定，旧任务不能在新实例中继续。SDK 的 `Generation::cancel()` 显式取消；Drop 在仍有 Tokio runtime 时发送尽力取消，进程和连接释放仍由宿主兜底。

## 通用协议与流控

原生管道使用 `u32 little-endian 长度 + UTF-8 JSON`，单帧最大 1 MiB，读取长度后先校验再分配。仅允许本机连接，使用 owner-only DACL、唯一首实例，并校验连接进程的 OS PID 等于宿主刚启动的子进程 PID。身份由宿主创建进程时绑定，不接受客户端传入插件身份或管理身份。

```json
{"v":1,"kind":"req","id":1,"svc":"llm","act":"profiles","p":{}}
{"v":1,"kind":"res","id":1,"p":[]}
{"v":1,"kind":"err","id":1,"code":"denied","msg":"..."}
```

`host/schema` 是管道内的能力发现动作，列出此连接实际开放的服务及动作。服务通过 `Service::sidecar_handler` 显式注册，开放 LLM、binary 和 screen；不透传整个宿主服务表或设置管理接口。以后新增服务可复用相同的调用上下文、权限、分帧和清理边界。

两端共同使用 `llm/profiles`、`start`、`next`、`cancel`、`cancel_all`。`start` 返回生成 ID 和解析默认值后的 `reasoningEffort`（未指定为 null），后者表示请求参数而非远端执行证明。`next({id})` 最多等待 20 秒返回下一事件；超时仅返回内部 `waiting`，两个 SDK 自动继续等待。一个任务只能有一个未完成的 `next`。读写循环独立，等待 `next` 时仍能通过同一连接取消任务或发起其他请求；每连接最多 32 个在途调用。断流明确失败，不悄悄丢帧。

`cancel_all` 默认只清理当前调用者（插件 + 窗口或原生实例）。主窗口在插件停用时可以用 `{scope:'plugin'}` 清理该插件的全部生成。设置管理取消所有生成时，会同时阻止此前正在准备凭据的请求继续发布。

| 预算 | 首版边界 |
|---|---|
| 输入 | 1–512 条消息，序列化内容不超过 256 KiB；文本总量同样受限 |
| 每个输出事件 | 最大 16 KiB；文本 delta 按 UTF-8 字符边界切为最多 2048 字节 |
| 生产队列 | 每任务最多 16 个事件，事件载荷预算不超过 256 KiB，不含解析器和传输缓冲 |
| SSE | 每行与单个 data 事件最多 64 KiB |
| 并发 | 全局最多 8 个运行任务；最多保留 32 个任务，每插件最多 4 个 |
| 输出 token / 原生超时 | 按用户模型配置执行；可配置 1–32768 token、1–600 秒 |
| 慢消费者 | 队列满暂停生产；30 秒未推进则失败；原生总超时始终有效 |
| 结果回收 | 完成事件被取走、取消或出错即释放；结束后未取走的结果最多保留 60 秒 |

拉取下一块就是消费额度的推进，无额外 ACK 消息；运行时不依赖 Tauri Channel。原生 Sidecar 的可选 raw lane 承载分块字节，单帧限制不应被扩展成“大文件任务总量限制”。图片与文件能力遵循 [通用数据协议](ARCHITECTURE.md#通用数据协议) 中的资源与分块方案。

当前插件按可信代码运行，JS 插件与主窗口共享执行环境；这些权限和窗口检查不是针对恶意同进程插件的完整沙箱。原生 PID 校验也不等同于隔离同用户恶意进程的所有攻击。

## 验证

`cargo run --locked --manifest-path src-tauri/Cargo.toml --example llm-checks` 使用本机 SSE 模拟服务与真实 Windows 命名管道，不访问外部模型或用户 key。覆盖两种适配器、拆分 UTF-8、未知 usage、断流、授权、取消和原生超时、有界慢消费者、真实后台 Sidecar、同连接并发取消、窗口归属隔离、退出/断线回收、错误 PID 拒绝。Windows Credential Manager 读写只使用唯一的临时假凭据并删除。

JS SDK 与配置回归见 `tests/llm-client.test.mjs`、`tests/llm-reasoning.test.mjs`；原生检查同时验证等级元数据、默认继承、单次覆盖、两种 HTTP 字段映射、允许范围与真实 Sidecar 请求。CI 与发布门禁包含原生检查。真实供应商兼容性和交互体验仍需使用用户配置验证。

`cargo run --locked --manifest-path src-tauri/Cargo.toml --example model-window-checks` 是 Windows 隐藏窗口回归：使用临时 WebView 数据目录，检查实际 COM 环境与浏览器 PID 相同、并发创建去重、调用者限制、关闭后重开和前台焦点保持。测试不显示窗口、不加载用户插件、不使用用户模型配置；需要可用的 WebView2 Runtime。

隔离设置页可手动检查：先在普通终端运行 `npm run dev -- --port 1429 --strictPort`，再运行 `cargo run --locked --manifest-path src-tauri/Cargo.toml --example llm-checks -- --ui`。此模式使用临时模型配置、内存假凭据及本机模拟 API，不加载插件；测试窗口使用独立应用标识，与已运行的正式版隔离。开发服务与窗口须能互相访问本机回环端口，沙箱内的监听服务可能无法被外部 WebView 访问。

## 图片内容与资源借用（HOST_API 10）

`{type:'image', source:{kind:'resource',id}, detail:'auto'|'low'|'high'}` 只允许出现在 user 消息，source 可携带宿主返回的 size 元数据（提供时必须与实际大小相符）；资源必须属于同一插件和同一窗口/原生实例且已经封存。宿主检查实际 PNG/JPEG/WebP 格式与尺寸，不依赖扩展名或客户端 MIME；不会打开任意路径或远端 URL。其他角色仍接受 text 块。

模型配置 allowImages 默认 false；用户显式开启后 profiles().capabilities.images 为 true，这表示宿主允许并可适配图片，不表示远端视觉能力已经验证。目录嗅探不自动修改此设置，现有 Test saved model 仍只测试文字。文本及引用元数据仍受 256 KiB 限制，图片字节不计入这份 JSON 预算。

每请求最多 8 张图片，每张 16 MP、合计 32 MP 和 16 MiB 编码文件字节；重复引用也计入发送总量。全局在途图片输入预算 64 MiB，和通用资源预算分别约束持有及编码工作。取消时已开始的阻塞编码可能短暂继续，预算跟随该工作直到释放。资源借用保留至 HTTP 结束/取消。

Chat 适配为 image_url.url，Responses 为 input_image.image_url；仅在供应商 HTTP 边界转为 data URI。JSON 在后台线程有界组装，仍存在 Base64、JSON 和 HTTP 缓冲复制，不宣称零复制或 HTTP 上传流式处理。API key 不进入资源或 Sidecar。所有权与 raw lane 见 [二进制资源协议](BINARY-IPC.md)。

前端用 binary.upload 或 screen.captureResource 创建资源；Sidecar 用 Rust SDK 的 upload_resource/open_resource 创建，并可读块、封存与关闭。HOST_API 13 可通过 binary.export/import 的指定接收方票据，在同一插件的窗口与 Sidecar 之间显式交接封存资源；领取后使用自己的新 source，不能直接使用其他 Caller 的 id。Sidecar 继续自行读写本地文件；宿主不接管 Sidecar 文件句柄。交接与回收规则见 [二进制资源协议](BINARY-IPC.md)。
