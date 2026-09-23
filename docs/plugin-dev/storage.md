# 本地读写：能写什么、写在哪、为什么

**先给结论**：宿主**只给一个数据 API**（`ctx.storage`），**没有**任意路径读写。
但插件可以通过 `sidecar` / `pty` 跑进程绕过这条限制 —— 这是设计取舍，不是漏洞。

---

## 全部接口（六条）

| 接口 | 权限 | 落点 | 性质 |
|---|---|---|---|
| `ctx.storage.get/set/remove/keys` | `rpc:storage` | `{appData}/plugin-data/<你的id>/data.json` | 键值，**整文件读写** |
| `ctx.rpc('host','write_debug_log', {content})` | `rpc:host` | `{appData}/debug.log` | **只追加**，超 1MB 截断 |
| `ctx.sidecar(ch, {exe})` | `rpc:proc` | 你自带的二进制 | **任意**本地读写 |
| `ctx.pty(ch, {program})` | `rpc:stream` | 任何程序 | **任意**本地读写 |
| `plugin_read_entry`（原生命令） | — | 插件自己的入口文件 | **只读** |
| `plugin_open_dir`（原生命令） | — | 在资源管理器打开 `{appData}/plugins/` | **只打开，不读内容** |

**宿主里只有两个服务碰文件系统**：`storage` 和 `external`（插件目录扫描）。
`session` / `proc` / `stream` / `uplink` / `bus` / `hotkey` **全是纯内存**。

### 关于 `sidecar` / `pty` 这条出口

它们不是"文件 API"，但效果上**能读写任何东西** —— 你跑一个进程，那个进程的权限就是
你的权限。**所以「插件读不到任意文件」这个说法不成立。**

准确的说法是：**宿主不为插件提供一条绕开进程的文件捷径。**
一个桌面程序本来就能起进程，这不是我们要拦的事；要拦的是"插件用一行 JS 就拿到
整个磁盘"。**你走进程，那是你的选择，也是可见的。**

---

## 数据落在哪

```
%APPDATA%\com.tan18.toolbox\        ← app_data_dir()，Tauri 按 identifier 解析
├── debug.log                        ← 宿主诊断日志（追加，1MB 上限）
├── plugins\                         ← 插件发现目录（drop-in）
│   └── <任意子目录>\  plugin.json + main.js
└── plugin-data\                     ← 每个插件一个目录
    ├── __host__\data.json           ← 宿主自己的
    ├── builtin.notepad\data.json
    ├── builtin.floatwin\data.json
    └── msglog.demo\data.json
```

**还有第三个位置**（不在 appData，是缓存不是数据）：

```
%LOCALAPPDATA%\com.tan18.toolbox\EBWebView\   ← WebView2 的 profile
```

### 规划原则（从代码能看出来）

1. **一切经 `app_data_dir()`** —— 不硬编码路径，由 Tauri 按 identifier 解析
2. **代码与数据分离** —— `plugins/` 与 `plugin-data/` 分开，删数据不会删代码
3. **每插件一个数据目录**，目录名就是 `<id>` —— **天然隔离**，插件 A 拿不到 B 的
4. **一个插件一个 `data.json`**，不是每键一个文件
5. **`debug.log` 有上限** —— 源码注释写明 *"keep debug.log a debug artifact, not a data store"*

### ⚠️ 改 identifier 会换掉整个数据目录

目录名是 `com.tan18.toolbox`。**曾用 `com.tan18.toolkit`，与旧程序 eyecare 冲突
（共享应用数据目录），所以改了。** 后果是：用户的设置、插件数据全部"消失"——
**其实在旧目录里**。改 identifier 前先想清楚，改完要么写迁移，要么明确告知。

---

## `ctx.storage` 的真实语义

```js
await ctx.storage.set('config', { width: 260 });   // 整个文件重写
await ctx.storage.get('config');                    // → { width: 260 } | null
await ctx.storage.keys();                           // → string[]
await ctx.storage.remove('config');
```

**实现**（`services/storage.rs`）：读整个 `data.json` → 改内存里的 map → **写回整个文件**。
pretty-print 的 JSON，没有 DB、没有索引、没有事务。

### 因此三条实际约束

1. **别存大 blob。** 每次 `set` 都是全量重写 —— 存一个 5MB 的数组意味着每次改一个字段
   都写 5MB。大块数据放你**自己的数据目录下的独立文件**（经 sidecar/pty 写），
   `storage` 只放索引和配置。
2. **它是扁平的 key→value**，不是关系型。需要查询就自己建索引结构。
3. **没有事务。** 连续 `set` 是多次独立写；中途崩溃可能停在中间状态。
   要么一次 `set` 写完整状态，要么接受这个风险。

### 别用 `localStorage`

插件跑在 webview 里，`localStorage` **能用** —— 但那是**应用 origin 的**，
**所有插件共享**，键名一撞就互相踩。宿主自己的 UI 偏好用它，插件**一律走 `ctx.storage`**。

---

## 为什么不用 `tauri-plugin-store` / `sql` / `fs`

三个都**没引入**，而且都是**刻意的**：

| 插件 | 为什么不用 |
|---|---|
| **`store`** | 与自研 `storage` **功能重叠**。自研版已有每插件目录、权限闸、fail-closed 注册、统一错误码；而 store **没有插件隔离的概念**。引入会多一套并行语义 |
| **`sql`** | 本项目存储是键值，**没有任何查询需求**。引入等于多一个 SQLite 依赖 + 迁移机制。**某个插件真要关系型数据，应该由它自己 sidecar 一个 SQLite** —— 而不是把 SQL 能力塞进宿主给所有人 |
| **`fs`** | **安全决定。** 它给前端**任意路径**读写，而本项目的模型是「一个能力一个权限 + fail-closed 白名单」。引入 fs 等于**开一个绕过整个权限体系的洞** —— 任何插件都能读 `~/.ssh`、任何项目源码 |

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

**不要**为了让某个插件方便就引入 `tauri-plugin-fs`。那一个依赖就会让上面整张
权限表失去意义。
