# 文件访问：可行性分析与方案

> **状态（2026-09-26 更新）**：**已评估，暂不实施。**
> 已落地的部分是 **① 拖拽 drop-in** 和 **② 原生选择器** ——
> 见 [api.md](api.md#我要让用户给我一个文件)。
> 两者都**只给路径**，读取留给插件自己的 sidecar。
> **③ 读文件（fs）已选定路线 D（宿主代理 + 目录授权）**，在**自用**前提下按 §七 的方案 A 实现。
> **§一–§六 是 2026-09-23 的原分析，保留不改** —— 它是 D 的由来，但结论已被 **§七** 取代。

**结论先说**：三个目标**都能做**，但**「默认信任插件」会推翻本项目唯一的一条安全承诺**。
下面把事实、代价和三条路线摆清楚，等你选。

---

## 一、先回答：Tauri v1 有没有现成的？

**有，但形态完全不同 —— v1 里 fs 不是插件，是核心 API。**

| | **v1** | **v2（本项目）** |
|---|---|---|
| fs 归属 | **核心**（`@tauri-apps/api/fs`） | **插件**（`tauri-plugin-fs` v2.5.2） |
| 配置位置 | `tauri.conf.json` → `allowlist.fs` | `src-tauri/capabilities/*.json` |
| 授权粒度 | 按方法布尔开关：`all` / `readFile` / `writeFile` / `readDir` / `exists` … | 按权限集：`fs:allow-*-read` / `fs:allow-*-write` … |
| scope | `allowlist.fs.scope: ["$HOME/**"]` | capability 里的 `allow` / `deny` |
| 生效时机 | **编译期**（Cargo allowlist feature） | **运行时**（capability） |
| 独立插件 | **没有** —— v1 的插件系统只是参数 HashMap，不是权限机制 | 有，且插件自带权限 |

**v1 的做法其实只有一步**：

```json
{ "tauri": { "allowlist": { "fs": {
  "all": true,
  "scope": ["$HOME/**", { "allow": ["$DOCUMENT/**"], "deny": ["$DOCUMENT/secret/**"] }]
}}}}
```

**v2 要三步**（依赖 + `.plugin()` + capability 里手写 scope），但换来的是
**运行时可控 + 可审计 + 按窗口分域**。

**所以「v1 有现成的」答案是：v1 有，但它不是一个能搬到 v2 的插件 —— 是 v2 把它拆成了插件。**

---

## 二、三个目标的可行性

### ① 拖拽 drop-in —— **可行，而且不需要 fs 插件**

`onDragDropEvent` 是**核心 API**（`@tauri-apps/api/webview`），不是插件：

```js
const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
  if (event.payload.type === 'drop') console.log(event.payload.paths);
});
```

payload 是判别联合：`{type:'over', position}` / `{type:'drop', paths}` / `{type:'leave'}`。

**⚠️ 两个坑，必须写进文档：**

1. **它只给路径，不给内容。** 想读文件内容仍然要 fs（或插件自己的进程）。
   —— 这决定了 ① 和 ③ 是**同一件事的两半**，不能只做一半。
2. **`dragDropEnabled` 默认是 `true`，而它会压制 HTML5 的 `ondrop`。**
   所以插件作者按 Web 习惯写 `ondrop` / `ondragover` **会收不到任何东西**，
   而且**不报错**。要用 HTML5 拖拽必须显式把它设成 `false`。
   （已在 `tauri-utils` 的 `config.rs:1947` 核实该字段存在，默认 `true`。）

### ② 选文件 —— **可行，`tauri-plugin-dialog` v2.7.3**

原生选择器。同样**只给路径**。

### ③ 读文件 —— **可行，`tauri-plugin-fs` v2.5.2**

**但它的模型是「权限 + scope 两个都要」**：

- **权限**决定*能做什么操作*（`fs:allow-*-read` / `-write` / `-meta`）
- **scope**决定*能碰哪些路径*
- **只给权限不给 scope → 什么路径都读不了**（报 `forbidden path`）
- 路径必须基于某个 `$ALIAS`，**`..` 被禁止**
- `fs:default` **只覆盖应用自己的目录**（`$APPDATA` 等）+ 建目录 —— **对用户文件没用**

---

## 三、代价：这会推翻一条已有的安全承诺

我在 `docs/plugin-dev/storage.md` 里写过：

> **`tauri-plugin-fs` —— 这个最值得说：不引入是安全决定，不是遗漏。**
> 它给前端**任意路径**读写，而本项目的安全模型是「一个能力一个权限 + fail-closed 白名单」。
> 引入 fs 等于**开一个绕过整个权限体系的洞**。

**加了宽 scope 之后，这句话就不成立了。** 而且有一个**关键的不对称**：

> **fs 的权限按 window label 匹配，而所有插件都跑在主窗口里。**
> 所以**没有「每个插件各自的文件权限」这个东西** ——
> 给主窗口一个宽 scope，等于给**每一个插件**（包括用户之后才丢进来的）同样的权限。

**这是本项目唯一一处做不到「一个插件一个权限」的地方。**
（其余能力都是插件自己在 `plugin.json` 里声明、宿主按插件 id 判定。）

---

## 四、三条路线

### A. 全信任（你说的「默认信任插件」）

```json
{ "identifier": "fs:allow-read", "allow": [{ "path": "$HOME/**/*" }] },
{ "identifier": "fs:allow-write", "allow": [{ "path": "$HOME/**/*" }] }
```

| | |
|---|---|
| ✅ | 最灵活，插件想读什么读什么；改动最小 |
| ✅ | 完全可行 |
| ❌ | **任何插件可读 `~/.ssh`、任意项目源码**，且用户无从察觉 |
| ❌ | 必须**撤回 `storage.md` 里那条安全声明**，并说明为什么改变 |
| ❌ | 与「插件首次发现即启用」叠加 → **丢进来一个插件就等于给它整个 home 目录** |

### B. 读宽写窄

读 `$HOME/**/*`，写只给应用目录。折中，但读取的风险和 A 一样。

### C. 能力式：授权来自**用户的一次动作**（我推荐）

**不给宽 fs scope。** 改由宿主代读：

| 用户动作 | 谁监听 | 授权来源 |
|---|---|---|
| 把文件拖进窗口 | **宿主**监听 `onDragDropEvent` | **这一拖就是授权** |
| 在原生选择器里选了文件 | **宿主**开 `tauri-plugin-dialog` | **这一点就是授权** |
| 插件要读某个路径 | 宿主只读**用户刚交出来的那些路径** | 上一行的授权 |

```js
// ⚠️ 路线 D 的示意代码 —— readText / ctx.files.onDrop **都不存在**，
//    这是「如果采用路线 D 会长什么样」，不是可以照抄的 API。
//    真实存在的是：ctx.files.pick / save / message，以及 ctx.onDrop（见 api.md）。
const files = await ctx.files.pick({ multiple: true });   // 用户选了什么
const text  = await ctx.files.readText(files[0]);         // 只读用户交出来的
ctx.files.onDrop((paths) => { … });                        // 用户拖进来的
```

| | |
|---|---|
| ✅ | **保住「一个能力一个权限」** —— 文件访问的授权是**用户的一次动作**，不是插件的一句声明 |
| ✅ | 三个目标全满足（拖拽 / 选择 / 读取） |
| ✅ | 丢进来一个陌生插件**不会**自动获得整个 home 目录 |
| ⚠️ | 宿主多一层 API（`ctx.files`）；要新增一个服务 + 权限 `rpc:files` |
| ⚠️ | 插件拿不到「随便读任意路径」—— 真需要的走自己的 sidecar（`rpc:proc`，本来就能读写任意路径） |

**C 的本质**：把「信任」从**插件声明**挪到**用户动作**。这和本项目
`contributes.hotkeys` 的取舍是同一个手法 —— 那里也是「宿主代办，插件只声明意图」。

---

## 五、无论选哪条，都要一并做的

1. **文档更正**：`storage.md` 里那条「不引入 fs 是安全决定」要么改写成 A/B/C 的实际选择，
   要么删掉。**不能让文档和代码互相打脸。**
2. **`dragDropEnabled` 写进 `debugging.md`**：默认 `true` 会静默压制 HTML5 `ondrop`。
   这是"按 Web 习惯写、但什么都没发生"的经典陷阱。
3. **scope 的 `deny` 要显式写**：至少 `$APPLOCALDATA/EBWebView`
   （WebView2 的 profile —— `fs:default` 默认拒绝它，自己写 scope 时要带上）。
4. **capability 的分域**：`fs` 的权限加在 **`default.json`（main 窗口）**。
   插件窗口（`plugin-*`）**不要**给 —— 它们本来就不该直接读磁盘。

---

## 六、我的建议

**走 C，把 A 当作逃生舱。**

理由不是保守，而是**一致性**：本项目其余每一处都是「能力由插件声明、宿主按 id 判定、
未声明即拒绝」。文件访问是唯一一个**结构上做不到**这一点的能力（因为插件共享主窗口）。
C 用「用户动作即授权」绕开了这个结构性缺陷 —— 而 A 是**接受**它。

**如果选 A**，那也是完全合理的取舍（很多桌面应用就是这么做的），
但需要你明确认可两件事：
1. **文档里的安全声明要撤回**，并说明改变的理由；
2. **接受「插件首次发现即启用」+ 「宽 fs scope」的组合。**

   已在源码核实这条不是猜测 —— `lifecycle.js` 的 `adoptNewPlugin`：

   ```js
   if (known.has(id)) return enabled.has(id);
   known.add(id);
   enabled.add(id);      // ← 首次发现即启用，不需要用户点任何东西
   return true;
   ```

   两条加在一起意味着：**丢一个文件夹进去 = 给了一个陌生程序整个 home 目录的读写权，
   而用户没有做过任何同意的动作。**

**要不要我把这个组合也做成一个「首次启用需确认」的闸口？** 那是另一个话题，
但如果走 A，它几乎是必须的。

---

## 七、路线 D：宿主代理 + 目录授权（2026-09-26 评估，**暂不实施**）

### 7.0 前提变了

**前提：自用，不管恶意代码。** 于是 §三 里那条「这会推翻唯一的安全承诺」不再是决策依据 ——
fs 访问的定位从「**隔离**」变成「**便利 + 知情**」。

但有一条约束**与安全无关、依然成立**：

> **外部插件是 Blob URL 单文件 ESM，`import` 不了任何东西。**
> 所以无论走哪条路，**宿主必须是中间人** —— `ctx.fs` / `bridge.fs` 一定要有。
> 这不是安全决定，是打包模型的硬约束。（`ctx.files` 的对话框已经在用同一手法。）

### 7.1 四个实现选项

| | 做法 | 成本 | 评价 |
|---|---|---|---|
| **A** | **宿主自己实现 `fs` 服务**（Rust `std::fs`），走现有网关，不做 scope 判定 | ~150 行 Rust + 注册服务 + 文档。**不加依赖、不碰 capability** | ✅ **选定** |
| B | 引入 `tauri-plugin-fs`，运行时 `app.fs_scope().allow_directory(path, true)` 加目录 | 新依赖 + capability 配置 + 包装层 | 值，但价值主要在「scope 强制」—— 正是自用要放弃的那部分 |
| C | 扩展现有 `files` 服务（`ctx.files.readText`） | 最省事 | 把「用户对话框」和「文件 I/O」混进一个服务，语义变糊 |
| D′ | 什么都不做，插件自带 sidecar exe 读写 | 零宿主改动 | 每个插件要带二进制，且前端拿不到内容 |

**为什么选 A 而不是 B**：B 白拿的是路径/平台差异 + scope 机制，而 scope 机制在自用前提下没有用；
换来的是一堆配置面（依赖 + capability + **静态 scope 与运行时 scope 的合并语义未实测**）。
A 还顺带保住「所有插件能力都走网关」这个统一性 —— 于是 `fs` 会自动出现在
`host/schema`、通信 trace 和静态审计里，这些是白拿的。

**已核实（供将来实施时参考）**：
- `FsExt` 存在：`fs_scope() -> Scope` / `try_fs_scope()` / `fs()`（docs.rs `tauri-plugin-fs`）
- `tauri::scope::fs::Scope` 有 `allow_directory(path, recursive)` / `allow_file` /
  `forbid_directory` / `forbid_file` / `is_allowed` / **`listen()`（scope 变化会发事件）**
- 它的 capability 必须**权限 + scope 两个都给**：只给 `fs:allow-exists` 不给 scope → 运行时 `forbidden path`

### 7.2 前端与文件接口的交互清单

**三条通路**

| 通路 | 发起方 | 路径 |
|---|---|---|
| 读写 | 视图插件 | `ctx.fs.*` → `plugin_rpc` → `fs` 服务 → `std::fs` |
| 读写 | 插件窗口 | `bridge.fs.*` → **同一条网关、同一个服务** |
| 给路径 | 宿主 | 拖放 / 原生对话框 → 路径交给插件 |

**数据形态（接口要覆盖的形状）**

| 交互 | 载荷 | 需要决定 |
|---|---|---|
| 拖放 / `pick` / `save` | 路径数组 / 路径 \| null | 取消 = `[]` / `null`（已定） |
| 读文本 | string | **编码**（UTF-8 / BOM / GBK）、**大小上限** |
| 写文本 | — | 覆盖还是追加？**要不要原子写**（临时文件 + rename） |
| 读二进制 | Uint8Array | 走信封要 base64（**+33%**）；大文件得走 `channel-raw` |
| 目录列表 | `[{name,path,isDir,size,mtime}]` | 排序？含隐藏文件？递归？ |
| 元信息 / 存在性 | size/mtime/isDir、bool | — |
| 建目录 / 删除 / 改名 | — | **最容易误伤，第一期不做** |
| 监听变化 | 事件流 | 需要 fs 插件的 `watch`，或自己轮询 |

**时序与性能（会被真实咬到的）**

- **逐行读大文件**：一次 IPC 拿整个文件 vs 分块流。100 MB 日志走信封会卡住网关（JSON + base64）
- **批量读**：开 10 个文件 = 10 次往返 → 要不要 `readMany(paths)`
- **相对路径的基准**：插件传 `'data.txt'` 时相对谁？**建议只接受绝对路径**
- **Windows 文件占用**：被别的进程打开时读/写都会失败 → 错误码要能区分
  「不存在 / 被占用 / 无权限」，否则插件只能显示一句没用的报错
- **取消与进度**：对话框取消、写大文件没有进度

**与已有三个东西的分工（不写清就会乱用）**

| | 是什么 | 什么时候用 |
|---|---|---|
| `ctx.storage` | 宿主管理、按插件命名空间的小 JSON | 插件的配置和状态 |
| `ctx.files` | **用户给路径**（原生对话框） | 让用户挑文件 |
| `ctx.fs`（新） | **插件读写路径** | 读用户给的、或自己知道的路径 |
| `ctx.sidecar` | 插件自带进程 | 二进制处理、大文件、系统调用 |

### 7.3 分阶段建议（真要做的时候）

- **第一期**：`readText` / `writeText` / `readDir` / `exists` / `stat`，**只收绝对路径**，文本大小给上限
- **第二期**：二进制（走 `channel-raw`）、批量、`watch`
- **不做**：`remove` / `rename` / `mkdir`
- 配套：`ctx.fs` **和** `bridge.fs` 都要有（否则又是「看界面放哪」）；
  加一个 `examples/plugins/` 下的现场验证插件（像 `senses` 那样，激活即跑一遍读写检查）

### 7.4 顺带查明的两件事

**① 插件自己的窗口收不到拖放 —— 不是框架限制，是没接线。**

- `onDragDropEvent` 是 **per-webview 的方法**，**不需要任何权限**（官方 JS API 文档未标注 permission），
  `dragDropEnabled` 默认开启 → 插件窗口**本来就能**监听
- 但 `watchDrops()` 只在 `boot()` 里调用，而 `boot()` **只跑在主窗口**（窗口按 label 分发）；
  `pluginwin.js` → `mountPluginWindow()` 从不调它
- 而且即使监听了，**路由规则也不适用**：`ctx.onDrop` 按 `store.activeViewId` 过滤，
  而**视图只存在于主窗口**，插件窗口没有 view 这个概念
- **正解比这简单得多**：让插件窗口**自己监听自己的拖放**，把路径直接投给它自己的订阅者 ——
  **不需要任何路由，也不需要窗口归属**。主窗口之所以要路由，是因为一个窗口里装着**多个**插件的视图；
  插件窗口只属于一个插件，归属是**已知的**（`?plugin=<id>` 就在 URL 里）。
  > 这里先前写的「需要窗口归属」是**把问题想复杂了** —— 那是「让主窗口替插件窗口路由」的错路。
  > 正确做法是「谁收到谁处理」，于是路由这一层根本不存在。
- 所以要修只需要三步：① 插件窗口 `mountPluginWindow()` 里注册 `onDragDropEvent`；
  ② `bridge.onDrop(fn)` 注册进一个**局部**集合（不是主窗口那张按 topic 的全局表）；
  ③ `dispose()` 清空那个集合。**不需要新权限**（`core:default` 已覆盖事件监听）。
- 现状：往插件窗口拖文件**完全没反应、也不报错**（`dragDropEnabled` 默认开启还会压掉 HTML5 `ondrop`）

**② `ui` 记为「主窗口才有」（已定，不再镜像）。**
`ctx.ui` 是 Vue + shadcn 组件词汇表（当前 377 个导出，见 [ui.md](ui.md)），观感来自 **Tailwind 工具类**；
而插件窗口的样式表**故意不含工具类**（`plugin.css` = theme + preflight + `.tb-*`，实测 19 KB CSS + 5 KB JS）。
镜像它意味着给每个插件窗口加回 ~122 KB utilities，或另做一份裁剪版 —— 不值。

---

## 八、让 `onDrop` / `focusView` 在插件窗口也能用（方案，2026-09-26）

**先分清三件事 —— 两项能解决，一项是「类别错误」：**

| 能力 | 插件窗口能否支持 | 性质 |
|---|---|---|
| `onDrop` | ✅ **能** | 窗口级事件，插件窗口本来就能监听；**而且比主窗口更简单**（不需要路由） |
| `focusView` | ✅ **能** | 它本质是「请主窗口把我的视图切到前台」= 一条跨窗口请求 |
| `registerView` | ❌ **不能，且不应该** | 视图的 `render` 是**一个 JS 闭包**，必须在**主窗口的 realm** 里执行 |

### 8.1 `onDrop`（纯增益，不碰网关）— ✅ **已实施（2026-09-27）**

> **实施结果**：`bridge.onDrop(fn)`、窗口自己的 `onDragDropEvent` 监听、
> `dispose()` 清空处理器都已落地（`src/host/pluginwin-host.js`）。
> 形状与 `ctx.onDrop` 一致（`fn(paths, info)`，返回 Promise of 取消函数），
> 唯一差别是 `info` 为 `{ label }` 而不是 `{ viewId }`。
> 行为测试在 `tests/plugin-bridge.test.mjs`（交付、取消、一个处理器抛错不影响其他、
> `dispose` 后失效）；对等性由 `tests/sdk-parity.test.mjs` 与
> `tests/plugin-docs.test.mjs` 双向盯着。文档见 [bridge.md](bridge.md) §1。
> **本节的方案文本原样保留**，因为「为什么不需要权限、为什么不需要路由」的理由比代码更难复原。

主窗口需要路由，是因为**一个窗口里装着多个插件的视图**；插件窗口只属于一个插件，
归属已知（URL 里的 `?plugin=<id>`）→ **路由这一层根本不存在**。

1. `pluginwin-host.js` 加一个模块级 `dropHandlers` 集合；
   `bridge.onDrop(fn)` 注册进去，返回取消函数（与 `ctx.onDrop` 同形状：**返回 promise**）
2. `mountPluginWindow()` 在 bridge 建好后注册 `getCurrentWebview().onDragDropEvent(...)`，
   `drop` 时把 `paths` 投给 `dropHandlers`
3. `dispose()` 清空该集合（局部集合，清空即可）
4. `over` 相不上报（会刷屏），与主窗口一致；`enter`/`leave`/`drop` 上报

**不需要新权限**：`onDragDropEvent` 无 permission 要求，插件窗口的 `core:default` 已覆盖事件监听。
**注意**：`dragDropEnabled` 默认开启 → 插件窗口的 HTML5 `ondrop` 同样被压掉，
所以文档要写清「插件窗口用 `bridge.onDrop`，别写 HTML5 的」。

**诊断**：插件窗口的日志只到 webview console（`ctx.log` 同理）。
要进 `debug.log` 就得走 `host/write_debug_log`（需要 `rpc:host`），失败则退回 console。

### 8.2 `focusView`（跨窗口请求 + 本地校验）— ⏳ **尚未实施**

> 本节仍是**方案**。截至 2026-09-27，`bridge.focusView` 在代码里**不存在** ——
> 照抄下面的代码会拿到 `undefined is not a function`。
> 要「呼出窗口」现在用 `ctx.windows.control(label, 'raise', true)`，见 [bridge.md](bridge.md) §2。

它做不了「切换」这件事本身（视图不在插件窗口），但它可以**请求**。

1. 新保留 topic `host:focus-view`，**与 `host:drop` 并列定义在 `events.js`**（单点，两处不许各写一份字面量）
2. `bridge.focusView(viewId)`：
   - **先本地校验**：`manifest.contributes.views` 里有没有这个 id —— 没有就 **reject**。
     这一步保住了 `ctx.focusView` 刻意要的性质：**「拼错会抛，不会静默什么都不做」**
     （否则看起来就像「热键突然失效了」）
   - 通过则 `hub.publish(pluginId, FOCUS_VIEW_TOPIC, { viewId }, { scheme: 'event-bus' })`
3. 主窗口在 `boot()` 里**订阅一次**：取 `env.p?.viewId` 与 **`env.svc`（信封带发布者）**，
   校验 `store.views` 里存在 `${env.svc}/${viewId}` → 存在才切。
   **这条校验就是「只能切自己的视图」**，与 ctx 侧同一条规则
4. 切换动作抽成**一个共享函数**，`ctx.focusView` 与这个订阅者都调它 —— 否则两份实现迟早漂移

**代价（要说清）**：`bridge.focusView` 需要 **`rpc:bus`**（跨窗口消息走 event-bus，而发布有闸），
而 `ctx.focusView` **不需要权限**。这个不对称可接受（`rpc:bus` 本来就是「跨窗口通信」的权限），
但要么写进文档，要么改用 `host/focus_view` 动作（闸口 `rpc:host`）—— 后者的代价是动服务表 + schema + 测试。
**取前者**：少动一处，且 `host:drop` 已是同类先例。

**已知限制**：这是**发布**（fire-and-forget），插件拿不到「主窗口确实切了」的回执。
拼错由第 2 步本地拦住，所以只剩「合法但主窗口还没注册该视图」这一种静默情形 ——
而视图在 `activate()` 时就注册了，早于任何窗口打开。

### 8.3 `registerView` —— 做不到，而且不该做

**不是遗漏，是类别错误。** `registerView(viewId, render)` 的第二个参数是**一个 JS 函数**。
视图渲染发生在**主窗口**，而插件窗口是**另一个 document、另一个 JS realm** ——
那里的 Blob URL 模块实例，主窗口**拿不到**。跨 realm 传函数在结构上不可能
（这不是权限问题，是 JS 的边界）。

**而这个需求已经被满足了**：外部插件的 `activate(ctx)` **本来就跑在主窗口**（`ctx` 就在那里构建），
`mountWindow(bridge)` 才跑在插件窗口。所以插件要视图，就在 `activate(ctx)` 里注册 ——
那是唯一能工作的位置：

```js
// activate(ctx) —— 主窗口
export async function activate(ctx) {
  ctx.registerView('main', renderLauncher);
  ctx.onHotkey('open', () => ctx.windows.control(LABEL, 'raise', true));
}
// mountWindow(bridge) —— 插件窗口
export function mountWindow(bridge) {
  bridge.onDrop((paths) => { … });          // §8.1 ✅ 已实施
  bridge.focusView('main');                 // §8.2 ⏳ 仍是方案，还没有这个 API
}
```

**插件窗口想「影响」主窗口的视图内容**（例如侧栏条目上显示计数）→ 用 event-bus 反向推：
主窗口 render 里 `ctx.bus.subscribe(...)`，插件窗口 `bridge.publish(...)`。**这是已有能力，不需要新东西。**

### 8.4 实施顺序

| # | 内容 | 风险 |
|---|---|---|
| 1 | ~~`bridge.onDrop` + 插件窗口自己听拖放~~ → **已完成 2026-09-27** | 低：纯增益，不碰网关 |
| 2 | `bridge.focusView` + `host:focus-view` + 主窗口校验归属 + 抽出共享的切换函数 | 中：新增一条跨窗口通路，要有测试 |
| 3 | 文档：`onDrop` 已完成（`bridge.md` 矩阵 + `api.md` 摘要）；`focusView` 仍待第 2 项 | 低 |
| 4 | ~~守卫：`sdk-parity` 的 `INTENTIONAL_CTX_ONLY` 缩到 `registerView`/`windows`/`ui`~~ → **已完成**（现为这 4 个：`focusView` / `registerView` / `windows` / `ui`；`registerView` 的理由「跨 realm 传函数不可能」写在 `bridge.md` §8.3 与本页 §8.3） | 低 |

**顺带修掉的一个守卫缺陷**：`sdk-parity` 的键提取器要求 `name:` 带冒号，
于是**简写属性（`id,` / `manifest,` / `pluginId,` / `label,`）全都看不见** ——
其中 `label` 是插件窗口独有的。一个看不见名字的守卫，无法把「多出来的不对称」报出来，
而那正是它唯一的职责。已改为 `[:,]`，并把 `ctx.cleanup`
（写在对象字面量**之后**的赋值）也纳入解析，两个对等性守卫因此不再各说各话。

---

## 九、引入 fs 的评估：负面清单、复杂度、最小接口（讨论记录，2026-09-27，**未实施**）

> **状态：讨论记录，不是决定。** 本次没有动任何代码、接口、权限或依赖。
> 记下来的原因见本页顶部那三条规矩 —— 这次讨论的结论（尤其「plugin-fs 对外部插件无效」
> 与「授权粒度是窗口不是插件」）比结论本身更容易被重新推导一遍。
>
> **触发条件**（比日期有用）：当某个插件需要「下载文件到用户指定目录」这类
> **必须与用户文件系统交互**的事情时，回来读这一节，走 §9.5 的路线 B。

### 9.1 一个关键事实：plugin-fs 单独引入，对「插件」几乎没用

外部插件的入口是从 **Blob URL** 动态 import 的（`src-tauri` 之外那一条：
入口源码 → Blob → `import()`），**bare/relative import 解析不了**。
所以 `@tauri-apps/plugin-fs` 的 JS API **到不了第三方插件手里** —— 它连 import 都做不到。

受惠的只有两种代码：**打包进应用的内置插件**，和**宿主自己**。
要让外部插件用上，必须由宿主代它调用 —— 所以这题的实质不是
「要不要加一个依赖」，而是**「要不要给宿主加一个 fs 服务」**。

### 9.2 负面清单（不是为了劝退，是为了记账）

| # | 影响 | 说明 |
|---|---|---|
| 1 | **授权粒度是窗口，不是插件** | ACL 按 window label 匹配，而所有插件的 `activate()` 都跑在主窗口 → 给 main 一个 fs scope 等于给**每一个**插件（含用户以后丢进来的）同样的权限。连带后果：`plugin.json` 里写 `fs:read` 会是一句**假话** —— ACL 不看插件清单，只有本项目的网关才看 |
| 2 | **`fs:default` 恰好覆盖宿主自己的目录** | `$APPDATA` 就是 `data_root`：`plugin-data/<id>/data.json`、`debug.log`、`plugins/` 全在它下面 → 会打破 [storage.md](storage.md) 声称的「每插件一个目录，天然隔离」。ACL 表达不了「这个插件」这个主语，想保住隔离只能在宿主侧判定 |
| 3 | **可观测性掉线** | trace 只包住 hub 的四个方法（`request` / `publish` / `subscribe` / `stream`），直接 `invoke` 不产生任何 trace 行 → 造出一整类**看不见的活动**，而 [debugging.md](debugging.md) 把 trace 说成「唯一能看到你没写的那些调用」的地方。同样不进会话表、没有 disposer 兜底 |
| 4 | **错误码与协商面出现两套** | 失败会以 Tauri 自己的字符串回来，不是那个闭集；`ctx.schema()` 不再等于「这个宿主支持什么」（它由服务表生成） |
| 5 | **两种授权模型并存** | `ctx.files.pick` / `ctx.onDrop` 的整个前提是「授权 = 用户的一次动作」；有了宽 fs 之后同一件事有两种说法，文档与评审都要同时带上 |
| 6 | **文档会自相矛盾** | [storage.md](storage.md) 有一条明确的「不引入 fs 是安全决定」，§六 的建议建立在它之上 |
| 7 | **构建与测试的连带** | 新 Rust 依赖 + 新 ACL manifest 条目（编译产物现在是 `core` / `dialog` / `pty` / `notification` 等，没有 `fs`），**必须重新构建** —— `tests/capabilities.test.mjs` 会比对编译产物，而本仓库有过「Cargo 缓存出空 ACL、源码看着对、运行时全拒」的前车之鉴 |
| 8 | **scope 写错就是全盘** | 而且错在 `default.json` 一侧，影响面是所有插件 |

**对单人开发而言，1–2 的「安全」代价可以忽略**（插件都是自己写的）。
真正还在付的代价是 **3–6**：可观测性、错误码、两套模型、文档互相打脸 ——
这些与「有没有恶意插件」无关。

### 9.3 复杂度：架构已经付过账的部分

选**网关服务**（而不是直接给 ACL）之后，下面这些是**零成本**的：

| 通常要做的 | 在本项目 |
|---|---|
| 别阻塞主线程 | **免费**：`plugin_rpc` 已经是 `async` + `spawn_blocking` 才进 `services::route`，服务里直接写阻塞 `std::fs` 就是对的。（对比 `plugin_dialog` 之所以是裸命令，是因为模态框需要主线程泵消息。） |
| 权限闸 | **免费**：`rpc:fs` 自动被 JS 闸 + Rust 注册表两道管住 |
| 错误码 | **免费**：`io` / `denied` / `not_found` / `bad_params` 已够用，不用碰 `codes.rs`（也就不会惊动跨语言漂移测试） |
| trace / schema / 会话表 / teardown | **免费**：前提是走网关 |
| 可测性 | **免费**：照抄 `storage.rs` 的 `*_at` 纯路径核心，`dispatch_at(&root, plugin_id, …)` 不需要 Tauri runtime |
| capability 文件、原生命令 | **不用碰**：走网关不需要新 `#[tauri::command]`，也不动 `default.json` |

### 9.4 三个真正的坑（会写错，不是工作量大）—— 实现前先验证

1. **Windows 上 `std::fs::canonicalize` 返回 `\\?\C:\…`**。拿它去比对一个未规范化的根会
   **永远不相等**，于是 scope 要么静默全拒、要么静默全放。本项目 Windows 优先，这是最可能踩的一条。
   **未在本仓库核实**，实现时要先打印出来看一眼。
2. **写一个还不存在的文件时 `canonicalize` 会失败** —— 必须先规范化**父目录**再拼文件名。
   而「下载到用户指定目录」**正好就是这个 case**：`ctx.files.save()` 只返回用户选的路径，
   **不创建文件**（`lib.rs` 里就是 `blocking_save_file()` 取一个 path）。
3. **`$PLUGINDIR` 现在拿不到** —— 原生注册表只存 `HashSet<String>`（权限），
   插件目录只有 `plugin_scan` 返回给前端、宿主自己不保留；内置插件更是没有目录。
   要用它就得改 `plugin_register` 的签名 + `host/registry.rs` 的数据结构 + `registerWithHost` 的调用方，
   也就是**碰权限主干**。

### 9.5 两条路线，成本差很多 —— 建议 B

**A：别名 scope 系统**（manifest 里写 `"fs": { "read": ["$APPDATA/my.plugin/**"] }`）
通用，但要写 scope 解析 / 规范化 / 包含判定，要改权限主干（坑 3），要踩坑 1–2。**建议拆两次做。**

**B（推荐）：用户授权路径表。** 不引入别名词汇，不碰权限主干：

- `ctx.files.pick` / `ctx.files.save` 返回路径时，**宿主把该路径记进一张宿主侧的表**（按 plugin id 分组）；
- fs 的每个动作先查表：这个插件被授予过这个路径（或它的父目录）吗？没有 → `denied`；
- **不需要 manifest 声明 scope**，所以 `plugin_register`、`host/registry.rs` 一行都不用改；
- 坑 1 基本消失：比对的是「对话框刚给的路径」的规范形式，而不是「任意路径 vs 手写的根」；
- **storage.md 那条安全声明不需要撤回**，只需一条带日期的补充：
  「fs 存在，但**碰不到任意路径**，只能碰用户当场交出来的那些」——
  整个「授权 = 用户的一次动作」的故事保住了。

代价：每个新目录要用户选一次；要不要跨重启记住授权是个可以单独决定的小问题（存 `plugin-data/<id>/` 即可）。

### 9.6 建议的最小接口

```js
// 权限：rpc:fs        授权来源：用户授权路径表（路线 B）
await ctx.fs.readText(path)          // → string
await ctx.fs.writeText(path, text)   // 覆盖写；父目录不存在 → not_found
await ctx.fs.readBytes(path)         // → base64（带上限）
await ctx.fs.writeBytes(path, b64)
await ctx.fs.list(dir)               // → [{name, path, dir, size, mtime}]
await ctx.fs.stat(path)              // → {exists, dir, size, mtime}
```

**先不加**：`remove` / `rename` / 任意路径 / 目录 watch。
要看目录变化就加**流提供者**（那样它进会话表、`dispose()` 免费帮你关），**不要**加事件主题。

**一个容易漏的上限**：网关是 JSON，所以字节只能走 base64，10 MB 会变成 ~13 MB 的 JSON 过 IPC。
`screen` 已经有 `MAX_PIXELS` 这种上限先例 —— fs 也该有一个（单次 8–16 MB，超了报错）。
**大文件不要走网关**：要么分块，要么用 sidecar（`rpc:proc` 本来就能读写任意路径）。

`ctx.fs` / `bridge.fs` 要同时加，否则就是又一次「同一段代码在视图里能用、在窗口里 `undefined is not a function`」
（见 [bridge.md](bridge.md)）；对等表与权限表会被 `tests/plugin-docs.test.mjs` 逼着更新。

### 9.7 storage 与 fs 的边界（提出来就是为了定死它）

**分工**：`storage` 放**默认配置与本地存储**；`fs` 只在**必须与用户文件系统交互**时用
（下载文件到用户指定目录、读用户拖进来的文件）。

这**正好就是 [storage.md](storage.md) 已有的建议**（「大块数据放你自己的数据目录下的独立文件，
`storage` 只放索引和配置」）—— 所以 fs 相当于把那条建议变成 API，两份文档不会互相打脸。

**唯一要写清的边角**：`storage` 是**整文件重写**（每次 `set` 都重写整个 `data.json`）。
建议明确 `plugin-data/<id>/data.json` 归 storage 管，fs 只碰别的文件 ——
否则会出现「两个都能写、语义不同」的重叠区。
