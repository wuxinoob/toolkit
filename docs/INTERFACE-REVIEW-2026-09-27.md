# 接口分类、核查与优化方向（2026-09-27）

> 本文回答四件事：**接口分几类、每类被什么约束、现在被什么验证、下一步优化什么**。
> 所有结论都从代码核对得出；**能在测试里钉住的，都已经钉住**
> （`tests/plugin-docs.test.mjs`，见 §5）。

---

## 结论速览

| 问题 | 结论 |
|---|---|
| **接口是一种东西吗？** | 不是。有 **9 个面**，变化速度差两个数量级：线格式冻结在 `v=1`，而权限闸的身份却可被调用方伪造（见 §3 的 P0）。 |
| **文档与代码一致吗？** | **不一致过**。根 `README.md` 的内置插件表、方案表、测试计数都漂移了；`docs/plugin-dev/README.md` 的服务/动作计数漂移了。本轮已修，并加了测试（§6）。 |
| **哪一类接口最需要维护？** | **服务面**（9 服务 / 35 动作）与**契约面**（`ctx` / `bridge`）。前者靠 `Service::actions()` 自证，后者**没有任何自动校验** —— 这是最大的文档腐坏点。 |
| **最大的结构性缺口是什么？** | **权限闸可被伪造身份绕过**（`docs/COMMS-AUDIT-2026-09-23.md` §1，仍未修）。它不属于任何一类接口，而是**所有接口共享的前提**。 |

---

## 1. 为什么先分类

把「接口」当成一种东西，会得到两个错误结论：

- *「两个订阅接口不一致」* —— 实际是一个是**声明**（清单里写一行）、一个是**契约**（`ctx` 上一个方法），两者不该同形；
- *「加一个字段要改五处」* —— 只有**线格式面**会牵动两侧，声明面改一个 JSON 就够了。

分类的目的是给每类接口配一套**合适的验证强度**：冻结的东西用漂移测试钉死，
易变的东西用契约测试护住，宿主的私有实现根本不该出现在插件文档里。

---

## 2. 九个接口面

### A. 声明面 — `plugin.json`

| | |
|---|---|
| **是什么** | `id` / `api` / `permissions` / `contributes.{views,hotkeys,theme}` |
| **稳定度** | 高。加字段是加键，不改已有键的语义 |
| **谁依赖** | 宿主（发现、代注册、权限闸）与**用户**（在 Settings 里看得见） |
| **被什么验证** | `tests/plugins.test.mjs`（JSON 与代码里的 manifest 必须一致、能力必须为真）；`hygiene.test.mjs`（文档不重复） |
| **文档** | [`plugin-dev/manifest.md`](plugin-dev/manifest.md) |
| **缺口** | `contributes` 没有 JSON Schema，拼错键名只会被静默忽略（只有 `views` 因为 `registerView` 校验而幸免） |

### B. 契约面 — `ctx`（主窗口）与 `bridge`（插件窗口）

| | |
|---|---|
| **是什么** | 插件能调的全部方法：`storage` `rpc` `stream` `streamRaw` `uplink` `sidecar` `pty` `bus` `events` `onHotkey` `files` `clipboard` `screen` `windows` `ui` `registerView` `focusView` `onDrop` `sessions` `schemes` `schema` `protocol` `closeStream` `log` `cleanup` |
| **稳定度** | **中。** 由 `HOST_API` 版本号（当前 **2**）显式管理，与线协议版本独立 |
| **谁依赖** | 每一个插件。这是插件**唯一**的能力边界 |
| **被什么验证** | `tests/plugin-interfaces.test.mjs` 只跑 `probe` 用到的那一部分；**两侧的对等性**由 `tests/plugin-docs.test.mjs` 从代码解析后精确比对（本轮新增，此前完全没有） |
| **文档** | [`plugin-dev/api.md`](plugin-dev/api.md)（按任务组织）、[`PROTOCOL.md`](PROTOCOL.md) §4 |
| **缺口** | 见 §3 的 P1：`ctx` 与 `bridge` 会静默漂移 |

### C. 服务面 — 网关的 9 服务 / 35 动作

| | |
|---|---|
| **是什么** | `req → res｜err` 的请求/响应。`storage`(4) `host`(7) `proc`(6) `stream`(8) `bus`(1) `hotkey`(4) `notify`(1) `clipboard`(2) `screen`(2) |
| **稳定度** | 高。动作清单是**权威声明**：网关按 `Service::actions()` 校验，`host/schema` 由同一份生成 |
| **谁依赖** | `ctx.rpc` / `ctx.storage` / `ctx.clipboard` / `ctx.screen` … |
| **被什么验证** | Rust 侧 4 条单元测试（路由表唯一、动作非空且唯一、schema 与表一致、提供者表）；`tests/codes.test.mjs`（错误码跨语言漂移） |
| **文档** | [`INTERFACES.md`](INTERFACES.md) §2、[`PROTOCOL.md`](PROTOCOL.md) §5–§6、[`plugin-dev/api.md`](plugin-dev/api.md) |
| **缺口** | `host/schema` **只到动作名，不到参数形状**（`INTERFACES.md` §8 的 P2-10）。插件仍需读文档才知道 `params` 长什么样 |

### D. 流面 — 推送提供者

| | |
|---|---|
| **是什么** | 宿主主动推：`ticker`（两种编码）、`blob`（仅 raw）、`clipboard`（json，**自带权限 `rpc:clipboard`**） |
| **稳定度** | 中。加提供者是加一个表项 |
| **谁依赖** | `ctx.stream(provider, ch, …)` / `ctx.streamRaw` / `ctx.clipboard.watch` |
| **被什么验证** | `selftest` t07（json 流）、t08（raw 流）；Rust `stream_provider_table_is_registered` |
| **文档** | [`PROTOCOL.md`](PROTOCOL.md) §3、[`INTERFACES.md`](INTERFACES.md) §3 |
| **缺口** | 提供者的**参数与钳制范围**（`intervalMs` / `count` / `chunks` / `chunkBytes`）只在 Rust 源码里，文档未列 |

### E. 上行面 — sink

| | |
|---|---|
| **是什么** | 插件**推给宿主**：`ctx.uplink(ch, { sink })`，载体是**批量 invoke**（Tauri 的 `Channel` 单向，框架不提供反向 `send`） |
| **稳定度** | 低–中（目前只有一个 sink：`proc`） |
| **谁依赖** | 需要喂自己 sidecar 的插件 |
| **被什么验证** | `tests/uplink.test.mjs`（N 帧 = 1 次往返、批上限、能力声明、权限闸） |
| **文档** | [`PROTOCOL.md`](PROTOCOL.md) §3「Uplink streams」、[`plugin-dev/api.md`](plugin-dev/api.md) |
| **缺口** | sink 名单由 `host/schema.sinks` 公布，但文档没说明「加一个 sink 要做什么」 |

### F. 事件面 — 广播与窗口内事件

| | |
|---|---|
| **是什么** | 跨窗口 `event-bus`（`ctx.bus.*`）与窗口内 `in-process`（`ctx.events.*`）；保留 topic：`hotkey:<action>`、`host:drop` |
| **稳定度** | 中。形状由宿主保证（两者都异步、`subscribe`/`once`/`publish` 同形） |
| **谁依赖** | 多窗口插件、热键、文件拖放 |
| **被什么验证** | `selftest` t09（广播往返）、t14（in-process 零 IPC）；`tests/plugin-bridge.test.mjs` |
| **文档** | [`plugin-dev/api.md`](plugin-dev/api.md)「我要让两个窗口同步状态」 |
| **缺口** | ⚠️ **回调形状不一致**：`event-bus` 给完整信封，`in-process` 给裸 payload（`COMMS-AUDIT` §2）。这直接违反「方案差异只体现在默认值上」这条声明 |

### G. 宿主命令面 — 13 个 `#[tauri::command]`

| | |
|---|---|
| **是什么** | 5 个数据面入口（`plugin_rpc`、2×`stream_open`、`stream_close`、`plugin_dialog`）+ 8 个宿主管理操作（`plugin_register`、`plugin_scan/info/read_entry/open_dir`、`plugin_reap_orphans`、`host_autostart_*`） |
| **稳定度** | 数据面稳定；管理操作随时可换（插件调不到） |
| **谁依赖** | 只有宿主自己的代码 —— **除 `plugin_dialog` 外**，插件一律经 `ctx` |
| **被什么验证** | `hygiene.test.mjs`（数量、必须全为 `async fn`、`lib.rs` 不得按服务名分支）；`tests/main-thread.test.mjs`（阻塞命令必须 `spawn_blocking`） |
| **文档** | [`INTERFACES.md`](INTERFACES.md) §1 |
| **缺口** | 管理操作与数据面共用一个文档章节，读者容易误以为 13 个都是插件能力。表里已分列「谁调用 / 在网关内 / 闸口」，可以更突出 |

### H. 表现面 — UI 词汇表

| | |
|---|---|
| **是什么** | `.tb-*` 类 + 设计令牌 + `ctx.ui.el()` 组件工厂（tag = `.tb-*` 去前缀） |
| **稳定度** | 中。加组件是加一行 `import.meta.glob` 命中；**减令牌是破坏性变更** |
| **谁依赖** | 每个画界面的插件 |
| **被什么验证** | `tests/plugin-theme.test.mjs`；`tests/window-options.test.mjs`（插件窗口的宿主代码不许出现**任何**类名 —— 那个窗口零 CSS） |
| **文档** | [`UI.md`](UI.md)、[`plugin-dev/ui.md`](plugin-dev/ui.md) |
| **缺口** | 词汇表**其实是可以枚举的** —— `ctx.ui.components()` 就返回已装上的 tag 名，**但文档此前从没提过它**，所以插件作者只能读源码或抄一份会过期的节选。这是**文档缺口，不是 API 缺口**（本轮已在 `ui.md` 补上） |

### I. 线格式面 — 信封 / 编码 / 方案

| | |
|---|---|
| **是什么** | 一个 `Envelope`（7 种 `kind`）+ 4 种编码 + 8 个方案（transport × codec）+ 14 个错误码 |
| **稳定度** | **最高（冻结）**：`PROTOCOL_VERSION = 1`；两侧 `validate()` 拒绝不匹配版本 |
| **谁依赖** | 所有东西 |
| **被什么验证** | `tests/protocol.test.mjs`、`tests/sdk-parity.test.mjs`、`tests/codes.test.mjs`（Rust↔JS 漂移）、`selftest` t01–t03 |
| **文档** | [`PROTOCOL.md`](PROTOCOL.md)、[`MESSAGE-FRAMEWORK.md`](MESSAGE-FRAMEWORK.md)（设计来由）、[`plugin-dev/architecture.md`](plugin-dev/architecture.md) §④ |
| **缺口** | 无结构性缺口。这是全套接口里**唯一真正做到了「声明即验证」**的一层，可以作为其他层的模板 |

---

## 3. 核查结论：三类问题

### P0 — 权限闸可被伪造身份绕过（未修，阻断性）

`plugin_rpc(plugin_id, msg)` 里的 `plugin_id` **是调用方传进来的参数**，而
`is_allowed("__host__", …)` 无条件放行（`host/registry.rs`）。插件与宿主**共享同一个 JS 上下文**，
所以任何插件都能：

```js
window.__toolbox.hub.request('__host__', 'proc', 'spawn', { program: 'cmd', … });
```

拿到全部服务、全部权限。**这把 A–I 九个面里所有的「一个能力一个权限」一并作废** ——
因为绕过它不需要碰任何一个接口，只要换一个字符串。`lib.rs` 里「cannot be bypassed by
reaching invoke() directly」这句注释与事实相反。

加重项：`installDebug()` **无条件**把 `hub` 挂在 `window.__toolbox` 上（`debug.js`），
而 `hub.request` 的第一个参数就是身份。

**方向**：令牌即身份 —— `plugin_register` 时由 Rust 生成随机令牌存进 JS 模块作用域
（**不挂 window**），网关门禁改成 `plugin_rpc(token, msg)`。细节与工作量见
[`COMMS-AUDIT-2026-09-23.md`](COMMS-AUDIT-2026-09-23.md) §1。

### P1 — 契约面没有对等性校验（本轮已修）

`ctx`（主窗口）与 `bridge`（插件窗口）是**两份手写的实现**，
「哪些能力在插件窗口里也有」这件事**只写在 `api.md` 的一张表里**。
历史上它已经漂移过两次（`files` / `log` / `closeStream` 曾经缺席，
`api.md` 表下的注释记着），而**发现方式是用户报 bug**，不是测试。

**已完成（2026-09-27）**：

1. 两侧的能力集合由测试直接从 `ctx.js` / `pluginwin-host.js` 解析，
   经别名归一（`id`↔`pluginId`、`rpc`↔`request`）后**精确比对**：
   主窗口独有恰好是 5 个，插件窗口独有恰好是 4 个，多一个少一个都是红测试。
2. 差异清单从 `api.md` 里**删掉**，成为独立的一页
   [`plugin-dev/bridge.md`](plugin-dev/bridge.md)（唯一权威清单），
   `api.md` 只留摘要并链接过去 —— 同一份清单存在两处，就是先过期一处。
3. 测试同时盯着那张表与代码，所以「文档说过、代码没有」和
   「代码有了、文档没说」都会失败。

（上面第 1 条当时写的是「主窗口独有 5 个」。**第二天 `onDrop` 落地后就变成了 4 个** ——
同一个数字散落在四份文档里，改了其中三份、漏了这一份。`bridge.md` 的头条数字现在由
测试盯着，这一页只是叙述，所以它是最容易漏的那个位置。）

**随后按这个方向补上了一个真实缺口**：`onDrop` 原本在「只有主窗口」那一列里，
理由是「拖放要按当前显示的视图路由」。那是**把问题想复杂了** —— 插件窗口只属于一个插件，
归属写在 URL 里，路由这一层根本不存在。`bridge.onDrop` 已实现（纯净增益、不碰网关、
不需要新权限），差异因此从 5 + 4 收敛到 **4 + 4**。
方案与理由见 [`plugin-dev/FILE-ACCESS-PLAN.md` §8](plugin-dev/FILE-ACCESS-PLAN.md)，
权威清单见 [`plugin-dev/bridge.md`](plugin-dev/bridge.md)。

顺带查出来两个**此前没人写对**的地方（都已修）：

| 发现 | 事实 | 曾经怎么写的 |
|---|---|---|
| `log` 的落点 | `ctx.log` / `bridge.log` 都只是带前缀的 `console.*`，**两边都不落盘**；要进 `debug.log` 必须显式调 `host/write_debug_log`（需 `rpc:host`） | `api.md` 说「`ctx.log` 的输出会进宿主的调试日志」——**假的**，而且与 `pluginwin-host.js` 自己的注释、《FILE-ACCESS-PLAN》的说法互相矛盾 |
| `ui.notifyOS` 在插件窗口 | 不是「有意不镜像」，而是**连带缺席**：它被放进 `ui` 命名空间，然后跟着整块被跳过。它和 DOM / CSS 毫无关系，`bridge.request('notify','send', …)` 就是现成的替代 | 三处文档都把它笼统归入「`ui` 是有意不镜像的」，读者无从判断哪些是真做不到、哪些只是漏了 |

> **这两个都属于 P1 的同一类**：不是功能缺失，而是**没有人知道哪一半是有意的**。
> 「有意为之」这四个字必须能指出理由，否则它只是「没人查过」的体面说法。

**仍未做**：`ctx.ui.notifyOS` 的桥接（一行代码的事，但它是行为变更，留给下一轮）。

### P2 — 文档漂移（本轮已修）

没有测试盯着的数字，都会漂移。本轮修正的清单见 §6。**结论不是「更认真地写文档」，
而是「把可被机器读的事实从散文里删掉，或让测试读它」** —— 见 §5。

---

## 4. 优化方向（按投入产出排序）

| # | 方向 | 触及的面 | 收益 | 成本 |
|---|---|---|---|---|
| **O1** | 令牌即身份；`installDebug` 去掉 `hub` | 全部（P0） | 权限模型第一次真正成立 | 中高（`lib.rs` 3 命令 + `hub/ctx/lifecycle/external/debug` + 测试） |
| **O2** | ~~`ctx` / `bridge` 对等性测试 + 文档表自动比对~~ → **已完成**（`bridge.md` + `plugin-docs.test.mjs`） | B | 契约面漂移从「用户报 bug」变成「CI 报错」 | 低 |
| **O3** | 统一事件回调形状（两方案都给裸 payload，`svc` 放外层） | F | 消掉一个静默 `undefined` 陷阱 | 低–中（破坏性：要升 `HOST_API`） |
| **O4** | `host/schema` 增加**参数形状**（每动作的最小 schema） | C / D / E | 插件「先问后做」不再需要读文档 | 中 |
| **O5** | `contributes` 的 JSON Schema（至少校验键名与类型） | A | 拼错的贡献点不再静默忽略 | 低 |
| **O6** | ~~公布 UI 词汇表~~ → **API 已存在**（`ctx.ui.components()`），只是文档没写；本轮已补并加了「`ui` 成员必须逐个交代」的测试 | H | 「工厂有哪些 tag」不再靠读源码 | 低 |
| **O7** | 文档校验测试常态化（§5） | 全部 | 文档腐坏变成红灯而不是习惯 | 已完成基础 |

**不建议做的**：把参数形状复制进文档。那是 O4 要消灭的重复，不是要强化的规范。

---

## 5. 维护机制：让文档成为可测的产物

这个仓库已经有这个传统 —— `hygiene.test.mjs` 盯着 `INTERFACES.md` 的命令数、
`codes.test.mjs` 盯着 Rust↔JS 的错误码。**插件文档此前不在这个保护范围内。**

### 规则：文档里的事实分三种，处理方式不同

| 事实 | 例子 | 处理 |
|---|---|---|
| **可枚举的**（清单、计数、方案 id、权限名） | 「9 服务 35 动作」「8 个方案」「`rpc:storage` …」 | **测试读它** —— 不一致即失败 |
| **可推导的**（谁调用什么、哪个权限管哪个能力） | 权限 → 能力映射 | **测试从代码推导，与文档表比对** |
| **人文的**（为什么这样设计、踩过什么坑） | 「为什么 `raise` 而不是 `focus`」 | 不自动化。但**必须写清日期与来由**，因为它不可验证 |

### 新增/修改一个接口时的清单

细节见 [`plugin-dev/MAINTENANCE.md`](plugin-dev/MAINTENANCE.md) —— 一份可照着做的操作手册。

---

## 6. 本轮修正的文档漂移

| 位置 | 曾经写的 | 实际是 | 状态 |
|---|---|---|---|
| 根 `README.md` 方案表 | 7 行（缺 `channel-in`） | **8 个方案** | 已修 |
| 根 `README.md` 内置插件表 | Notepad / Eyecare / Processes / StreamLab / FloatWin | **只有 Processes(procman) 与 StreamLab** | 已修 |
| 根 `README.md` 布局树 | `plugins/ notepad eyecare procman streamlab floatwin` | `procman` `streamlab` | 已修 |
| 根 `README.md` | `npm run test # 62 node tests`、`node --test 221` | **241** | 已修 |
| 根 `README.md` | `host-checks` 27 条断言 | **29** | 已修 |
| `plugin-dev/README.md` 首段 | 「`INTERFACES.md`（8 个原生命令 / 6 服务 29 动作）」 | **13 命令 / 9 服务 / 35 动作** | 已修 |
| `plugin-dev/README.md` / `architecture.md` / `api.md` | 「实测九个内置插件总共 ~1.7s」 | 内置插件现为 **2 个** | 已修 |
| `plugin-dev/README.md` | 文件表缺 `MAINTENANCE.md` 等 | 补齐 | 已修 |
| `plugin-dev/api.md` | 「`ctx.log` 的输出会进宿主的调试日志」 | `log` 只到 console，**不落盘** | 已修 |
| `plugin-dev/api.md` / `architecture.md` / `debugging.md` | 对等表与「`ui` 有意不镜像」的说法把 4 个真实缺口和 1 个连带缺席混为一谈 | 拆成 [bridge.md](plugin-dev/bridge.md) 的逐条矩阵 | 已修 |
| `plugin-dev/{api,architecture,debugging}.md` | `../../COMMS-AUDIT-2026-09-23.md`（**链接指到仓库根**，404） | `../COMMS-AUDIT-2026-09-23.md` | 已修 |

对照：`hygiene.test.mjs` 里已经有一模一样的教训 ——
「`INTERFACES.md` 写 9 个命令而代码有 13 个」。**同一个病，不同的器官。**
