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
// 插件侧（示意）
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
- 所以要让插件窗口支持拖放，需要另一条规则：「**窗口 X 上的 drop 给拥有 X 的那个插件**」——
  而它需要**窗口归属**，这正是 `ctx.windows.control` 缺失的同一块
- 现状：往插件窗口拖文件**完全没反应、也不报错**（`dragDropEnabled` 默认开启还会压掉 HTML5 `ondrop`）

**② `ui` 记为「主窗口才有」（已定，不再镜像）。**
`ctx.ui` 是 Vue + 376 个 shadcn 组件，观感来自 **Tailwind 工具类**；
而插件窗口的样式表**故意不含工具类**（`plugin.css` = theme + preflight + `.tb-*`，实测 19 KB CSS + 5 KB JS）。
镜像它意味着给每个插件窗口加回 ~122 KB utilities，或另做一份裁剪版 —— 不值。
