# 本地读写：能写什么、写在哪、为什么

宿主的持久键值 API 是 `ctx.storage`。`ctx.files` 提供原生路径选择器，不读写文件内容；
插件可以通过 `sidecar` / `pty` 运行本地程序进行文件 IO。当前没有通用文件读写 API。

---

## 存储与文件相关入口

| 接口 | 权限 | 落点 | 性质 |
|---|---|---|---|
| `ctx.storage.get/set/remove/keys` | `rpc:storage` | `{appData}/plugin-data/<你的id>/data.json` | 键值，**整文件读写** |
| `ctx.files.pick/save` | `rpc:dialog` | 用户选取的路径 | 只返回路径，不读写内容 |
| `ctx.rpc('host','write_debug_log', {content})` | `rpc:host` | `{appData}/debug.log` | **只追加**，超 1MB 截断 |
| `ctx.sidecar(ch, {exe})` | `rpc:proc` | 你自带的二进制 | **任意**本地读写 |
| `ctx.pty(ch, {program})` | `rpc:stream` | 任何程序 | **任意**本地读写 |
| `plugin_read_entry`（原生命令） | — | 插件自己的入口文件 | **只读** |
| `plugin_open_dir`（原生命令） | — | 在资源管理器打开 `{appData}/plugins/` | **只打开，不读内容** |

持久键值和宿主诊断日志由 `storage.rs` 管理；插件目录发现与入口读取见 `external.rs`。
路径选择、拖放和后续读取流程见 [文件 API](api.md)。

> **这些路径不要硬编码。** 插件可以直接问宿主：`ctx.paths()`（`bridge.paths()`，
> 权限 `rpc:host`）返回 `pluginDataDir` / `pluginsDir` / `dataDir` 等**绝对路径**，
> 和上面这张表用的是同一个 `PathResolver` —— 详见 [api.md](api.md)。

### 关于 `sidecar` / `pty` 这条出口

本地程序使用启动用户的系统权限，文件操作范围不受 `ctx.storage` 命名空间或选择器路径限制。
SDK 权限用于声明受支持能力；当前插件身份与执行上下文尚不提供恶意插件隔离，见 [信任边界](../ARCHITECTURE.md#信任边界)。

---

## 数据落在哪

```
%APPDATA%\com.tan18.toolkit\        ← app_data_dir()，Tauri 按 identifier 解析
├── debug.log                        ← 宿主诊断日志（追加，1MB 上限）
├── plugins\                         ← 插件发现目录（drop-in）
│   └── <任意子目录>\  plugin.json + main.js
└── plugin-data\                     ← 每个插件一个目录
    ├── __host__\data.json           ← 宿主自己的
    ├── builtin.procman\data.json
    ├── builtin.streamlab\data.json
    └── msglog.demo\data.json
```

**还有第三个位置**（不在 appData，是缓存不是数据）：

```
%LOCALAPPDATA%\com.tan18.toolkit\EBWebView\   ← WebView2 的 profile
```

### 规划原则（从代码能看出来）

1. **一切经 `app_data_dir()`** —— 不硬编码路径，由 Tauri 按 identifier 解析
2. **代码与数据分离** —— `plugins/` 与 `plugin-data/` 分开，删数据不会删代码
3. **每插件一个数据目录**，目录名就是 `<id>`；正常调用按 id 分隔数据，目录布局不构成安全沙箱
4. **一个插件一个 `data.json`**，不是每键一个文件
5. **`debug.log` 有上限** —— 源码注释写明 *"keep debug.log a debug artifact, not a data store"*

### ⚠️ 改 identifier 会换掉整个数据目录

目录名是 `com.tan18.toolkit`。后果是：用户的设置、插件数据会根据当前 identifier 进行隔离。改 identifier 前先想清楚，改完要么写迁移，要么明确告知。

---

## `ctx.storage` 的真实语义

```js
await ctx.storage.set('config', { width: 260 });   // 整个文件重写
await ctx.storage.get('config');                    // → { width: 260 } | null
await ctx.storage.keys();                           // → string[]
await ctx.storage.remove('config');
```

**实现**（`services/storage.rs`）：同一宿主进程内按实际存储路径串行执行一次调用，读整个 `data.json` → 修改 map → 写入同目录临时文件并同步 → 原子替换。
同一插件的多个窗口不会因同时修改不同键而互相覆盖；不同插件无需共享一把 IO 锁。失败的写入保留旧文件。文件不存在才视为空数据；损坏 JSON、非对象根值或其他读取错误返回 `io`，不自动清空。

文件仍是 pretty-print JSON，没有 DB 或索引。连续调用不是事务，也不协调外部编辑器或多个 Toolkit 进程对同一目录的修改；原子替换不承诺断电时的完整耐久性。

### 因此三条实际约束

1. **别存大 blob。** 每次 `set` 都是全量重写 —— 存一个 5MB 的数组意味着每次改一个字段
   都写 5MB。大块数据放你**自己的数据目录下的独立文件**（经 sidecar/pty 写），
   `storage` 只放索引和配置。
2. **它是扁平的 key→value**，不是关系型。需要查询就自己建索引结构。
3. **没有跨调用事务。** `get` 后修改再 `set`，其他窗口仍可能在两次调用之间写入同一个键。
   同一个键的并发 `set` 以宿主实际执行顺序为准；需要一起保存的状态放在一次 `set` 中。

### 别用 `localStorage`

插件跑在 webview 里，`localStorage` **能用** —— 但那是**应用 origin 的**，
**所有插件共享**，键名一撞就互相踩。宿主自己的 UI 偏好用它，插件**一律走 `ctx.storage`**。

---

## 为什么不用 `tauri-plugin-store` / `sql` / `fs`

三个都**没引入**，而且都是**刻意的**：

| 插件 | 为什么不用 |
|---|---|
| **`store`** | 与现有 JSON KV、命名空间和统一错误语义重叠，会增加第二套持久化机制 |
| **`sql`** | 当前已确定的宿主需求是键值配置；出现关系查询需求时再评估数据库及迁移成本，单个插件也可自行使用 sidecar |
| **`fs`** | 当前没有已确定的通用文件读写服务需求；引入前需明确调用方身份、路径和授权语义，不能把现有 SDK 检查当作安全沙箱 |

**核对方法**（改这三个之前先跑一遍）：

```bash
grep -icE "tauri-plugin-(store|sql|fs)" src-tauri/Cargo.toml    # → 0
grep -ohE '"(store|sql|fs):[a-z-]*"' src-tauri/capabilities/*.json   # → 空
```

---

## 如果将来确实需要更多存储能力

**按这个顺序考虑**：

1. **先问是不是数据放错了地方** —— 大块数据不该进 `storage`（见上面约束 1）
2. **插件自己 sidecar 一个进程** —— 它想用什么存储都行（SQLite、文件、KV），
   宿主不介入，权限上它是 `rpc:proc`
3. **只有在多个插件反复需要同一件事时**，才考虑把它变成宿主服务 ——
   届时它必须：有自己的权限（`rpc:<svc>`）、有自己的动作清单、
   在 `Service::actions()` 里登记（那是网关校验与 `host/schema` 的唯一权威）

新增文件能力时先定义使用场景与边界，再决定宿主服务或插件自带进程的职责。
