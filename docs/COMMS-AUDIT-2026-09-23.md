# 通信审计（2026-09-23）

对着代码逐条查的，不是印象。**第 1 条是 P0，会绕过整个权限体系。**

---

## 1. 🔴 P0：权限闸可以被伪造身份绕过

### 事实链

**① `is_allowed` 对 `__host__` 无条件放行**（`host/registry.rs:42`）：

```rust
pub fn is_allowed(plugin_id: &str, perm: &str) -> Result<(), String> {
    if plugin_id == HOST_IDENTITY {
        return Ok(());            // ← 一切权限
    }
    ...
}
```

源码注释自己写着：*"The host itself is not a plugin: `HOST_IDENTITY` is implicitly
allowed everything"*。

**② `plugin_id` 是调用方传进来的参数**（`lib.rs`）：

```rust
fn plugin_rpc(app: AppHandle, plugin_id: String, msg: Envelope) -> ... {
    host::registry::is_allowed(&plugin_id, &format!("rpc:{svc}"))
```

**③ 应用命令不走 ACL。** Tauri 的默认行为是「`invoke_handler` 里注册的命令对所有窗口开放」
（官方文档原话）。`plugin_rpc` 是应用命令，capability 里也没有它 —— 所以任何窗口都能调。

**④ 插件和宿主跑在同一个 JS 上下文里。** 插件视图就在主窗口，共享 realm。

### 结论

**任何插件**（哪怕 `permissions: []`）都可以：

```js
// 最直接的一条 —— 连 invoke 都不用伪造
window.__toolbox.hub.request('__host__', 'proc', 'spawn', {
  program: 'cmd', args: ['/c', 'anything'],
});

// 或者绕过 debug 句柄
window.__TAURI_INTERNALS__.invoke('plugin_rpc', {
  pluginId: '__host__',
  msg: { v: 2, kind: 'req', id: 1, svc: 'proc', act: 'spawn', p: {...} },
});
```

**拿到全部服务、全部权限** —— 包括 `proc/spawn`（执行任意程序）、`win/manage`、
别人的 `storage`。**整个「一个能力一个权限」的模型在这里失效。**

### 而且网关的注释是错的

`lib.rs` 里写着：

> The authoritative permission gate. The JS `ctx` gate is a convenience check;
> **this one cannot be bypassed by reaching invoke() directly.**

**这句话不成立** —— `plugin_id` 正是调用方给的。它防住了「绕过 `ctx` 直接 invoke」，
但没防住「直接 invoke 并自称是宿主」。

### 加重因素：`installDebug()` 把 `hub` 挂在 window 上

```js
// debug.js:23
const api = { version, store, events, logger, logs, hub, schemes, transports, ... };
Object.assign(globalThis.window, { __toolbox: { ...api } });
```

**`hub` 本身被暴露**，而且 `boot()` 里是**无条件**调用的（不是 dev-only）。
所以上面那段第一行就够了 —— 不需要知道 `invoke` 的参数形状。

### 修法

**根因**：宿主无法区分「宿主自己的 JS」和「自称是宿主的插件 JS」——
两者都是同一个 webview 里传一个字符串。

**唯一正确的修法：让身份不可伪造 —— 令牌即身份。**

1. `plugin_register` 时由 **Rust 生成随机令牌**，返回给该身份，**存在 JS 模块作用域**
   （**不要**挂到 `window`）
2. 网关签名从 `plugin_rpc(plugin_id, msg)` 改成 `plugin_rpc(token, msg)` ——
   **令牌本身就是身份**，不再是「id + 可伪造的自称」
3. Rust 侧用令牌反查 id，再判权限
4. 宿主自己的令牌只在 host 模块作用域里 —— 插件读不到别的模块作用域，
   所以拿不到宿主的令牌

**为什么这样够**：插件之间、插件与宿主之间是**不同的模块作用域**。
插件能读 `window`，但令牌不在 `window` 上。

**同时要做的**：
- **`installDebug` 去掉 `hub`**（或者干脆 dev-only）。
  注意：**只去 `hub` 不够** —— 令牌修完之前，裸 `invoke` 那条路还在。
  但两条一起做才完整。
- `plugin_stream_open` / `_raw` / `_close` 也要一起改（它们同样收 `plugin_id`）

**工作量**：`lib.rs`（3 个命令）+ `hub.js` + `ctx.js` + `lifecycle.js` +
`external.js` + `debug.js` + 若干测试。**不小，所以先报告不擅自改。**

---

## 2. 🟡 事件回调的形状不一致

| 方案 | 回调收到 |
|---|---|
| `event-bus`（`ctx.bus.*`） | **完整信封** `{kind, svc, topic, p}` |
| `in-process`（`ctx.events.*`） | **裸 payload** |

这与本项目反复声明的「**方案差异只体现在默认值上，不体现在形状上**」矛盾 ——
在这里，形状本身不同。

**后果**：`ctx.events.on('t', (x) => x.p)` 拿到 `undefined`，而
`ctx.bus.subscribe('t', (x) => x.p)` 是对的。写错的人不会报错，只会静默拿到 `undefined`。

（`SUPPLEMENT.md` 里那位作者踩的正是这个 —— 他把它当成"要写兼容解包"的规矩，
其实是两个方案的形状没对齐。）

**修法**：二选一 —— 要么 `in-process` 也包信封（更一致），
要么两边都给裸 payload 并在信封层之外提供 `svc`（更友好）。
**我倾向后者**，因为插件要的几乎总是 payload，而 `svc` 只在热键那种场景需要。

---

## 3. 🟡 没有任何通信日志

实测：`src/core/logger.js` 里**没有** request/response/envelope/traffic 任何一项；
全项目**没有** `TB_DEBUG` / `LOG_LEVEL` / `debugTraffic` 之类的开关。

**后果**：插件作者问「我的 `ctx.rpc` 到底发出去了吗、宿主回什么了」时**无从回答**。
`debug.log` 里只有各插件自己 `ctx.log` 写的行，看不到网关层的往来。

**这是「debug 归因」最大的缺口** —— 上面第 1 条能藏这么久，一部分原因就是
**没有地方能看到「谁调了什么」**。

**修法**：加一个受开关控制的通信 trace，写到 `debug.log`：

```
rpc → __host__ proc/spawn (ch=…)        3ms  ok
rpc → my.plugin storage/get (key=x)    1ms  ok
rpc → my.plugin proc/spawn             denied: plugin lacks permission `rpc:proc`
```

**关键是第一列要打印「自称的身份」** —— 这样 `__host__` 出现在一个插件的调用里
会立刻显形。**它同时也是验证第 1 条修好了没有的手段。**

---

## 4. 🟢 已经查过、没问题的

| 检查项 | 结论 |
|---|---|
| 信封校验 | JS 与 Rust 两侧都有 `validate()`，形状规则单点定义 |
| 权限判定 | 未注册的 id **fail-closed**（不是「默认允许」） |
| 错误码 | 闭集，14 个码，两侧镜像且有测试比对 |
| 同步/异步形状 | `subscribe`/`once`/`publish` 在所有方案上都是异步 ✅ |
| 上行流 | 批量 invoke（Tauri 的 `Channel` 单向，这是框架约束） |
| 会话生命周期 | 统一表，退出只 `kill_all()` 一次；HMR 重载已加回收 |

---

## 优先级

| | 项 | 为什么 |
|---|---|---|
| **P0** | 身份可伪造 | 绕过全部权限，可执行任意程序 |
| P1 | 通信日志 | 没有它，P0 这类问题只能靠读代码发现 |
| P2 | 回调形状不一致 | 静默 `undefined`，但影响面小 |
