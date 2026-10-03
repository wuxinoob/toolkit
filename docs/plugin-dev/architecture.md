# 架构：五层与它们的边界

本页回答一个问题：**「我这个功能属于哪一层，边界在哪，宿主替我做了什么」。**

---

## ① 清单层 — `plugin.json`

**权威来源。** 代码里导出的 `manifest` 只**补缺**，`plugin.json` 覆盖它
（`mergeManifest`：`{...fromCode, ...fromJson}`，`contributes` 逐键合并）。

两者必须一致 —— 有审计测试盯着。**不一致时以 `plugin.json` 为准**，
所以改权限/贡献点改 JSON 就够了，不用动代码。

细节见 [manifest.md](manifest.md)。

**这一层决定你能做什么。** 权限是**闭集**，声明式能力（视图/热键/主题）
由宿主在 `activate()` **之前**代注册 —— 所以插件可以在自己的 `activate()` 里
就依赖自己的热键已经生效，不用和它赛跑。

---

## ② 契约层 — `ctx`

宿主注入给你的对象。**这是你的全部能力边界**：`ctx` 上没有的东西就是拿不到，
没有后门、没有全局变量可绕。

两个独立的变化轴，别混淆：

| 轴 | 是什么 | 版本号 |
|---|---|---|
| **HOST API** | `ctx` 的**形状**（有哪些方法、同步还是异步） | `manifest.api`（当前 **3**） |
| **线协议** | `ctx` 背后发出去的**信封**长什么样 | 信封里的 `v` |

**声明 `api` 很重要**：宿主拿它和你实际的行为比对，不一致时在插件行上写一条说明，
而不是让你在运行期收到一句莫名其妙的 `off is not a function`。

`ctx` 全表面见 [api.md](api.md)。

---

## ③ 视图层 / 窗口层 — 你画什么

**两条路，选一条或都用：**

### 视图（主窗口里的一块）

```js
ctx.registerView(viewId, (root) => { /* 往 root 里渲染 */ });
```

- `viewId` 要和你 `contributes.views[].id` 对得上（拼成 `pluginId/viewId`）
- `render` 是**同步**的 —— `ctx.ui.el()` 能同步用，因为组件工厂在**任何插件激活之前**
  就加载完了
- 宿主负责：挂载、卸载（切走时清空容器）、给你一层带 `data-plugin` 的作用域

### 窗口（独立窗口）

```js
await ctx.windows.create('plugin-my-win', {
  url: 'pluginwin.html?plugin=my.plugin&label=plugin-my-win',
  title: 'My Window', width: 400, height: 300,
});
```

- **`url` 必须是插件窗口那一页**（`pluginwin.html?plugin=<id>&label=<label>`）。
  `pluginwin.html` 和 `index.html` 是两个不同的应用：前者引插件样式表并调用你的
  `mountWindow`，后者是外壳。传 `index.html` 曾经会让宿主在插件窗口里再跑一个完整宿主
  （见 `src/main.js` 的注释），现在插件窗口根本不加载那一页，但错误仍在 `create()` 当场被拒。
  外部地址与 `/x`、`../x` 这类路径也一律拒绝。
- 窗口选项走**白名单**，不在名单上的会被拒绝并告诉你名字
- 自绘标题栏：传 `decorations: false`，然后自己画一条，用 `bridge.drag()` 拖。
  参考 `tests/fixtures/plugins/eyecare/`
- 窗口的尺寸/位置/置顶/透传**归创建它的窗口**（主窗口），不在插件窗口自己的权限里 ——
  「能改自己尺寸」和「能被拖动」不是一回事

---

## ④ 数据层 — 数据怎么走

**两个正交的轴**，方案 = 两者的组合：

| 轴 | 取值 |
|---|---|
| **transport** | `invoke` · `channel` · `event` · `stdio` · `pty` · `in-process` |
| **codec** | `json-envelope` · `line-json` · `raw-binary` · `object` |

**八个方案**登记在 `src/protocol/registry.js`（`src-tauri` 侧另有一份镜像）：

| 方案 id | 载体 · 编码 | 方向 |
|---|---|---|
| `rpc` | invoke · json-envelope | 上行 |
| `channel-in` | **invoke（批量）** · json-envelope | 上行 |
| `channel-json` | channel · json-envelope | 下行 |
| `channel-raw` | channel · raw-binary | 下行 |
| `event-bus` | event · json-envelope | 下行 |
| `stdio-line` | stdio · line-json | 双向 |
| `pty-stream` | pty · raw-binary | 双向 |
| `in-process` | in-process · object | 下行 |

**你通常不直接选它们** ——
你调 `ctx.rpc` / `ctx.stream` / `ctx.pty` / `ctx.sidecar` / `ctx.bus`，
每个方法背后是一个固定组合，且**形状一致**（方案差异只体现在默认值上）：

```js
ctx.rpc('storage', 'get', { key: 'k' })      // 请求/响应
ctx.stream('ticker', 'ch1', { onFrame })     // 宿主 → 你，推送
ctx.uplink('ch2', { sink: 'proc' })          // 你 → 宿主，批量
ctx.sidecar('ch3', { exe: 'helper' })        // 跑你自带的二进制
ctx.pty('ch4', { program: 'node' })          // 跑一个终端程序
ctx.bus.publish('topic', payload)            // 广播给所有窗口
```

**同步还是异步是统一的**：`subscribe` / `once` / `publish` 在所有方案上都是异步。
`ctx.events` 与 `ctx.bus` 只差**默认方案**，不是一个同步一个异步。

**上行流的载体是批量 invoke**，不是 Channel —— Tauri 的 `Channel` 是单向的，
JS 侧只有接收回调、**没有 `send`**。所以别去找「从 JS 推给 Rust」的 Channel。
这就是 `channel-in` 存在的理由，也是它为什么是八个方案里唯一一个
「载体不是自己的名字」的方案。

---

## ⑤ 表现层 — 长什么样

**样式靠 `.tb-*` 普通 CSS 类，不是组件库。** 原因见 `docs/UI.md` 开篇：
外部插件是 Blob URL 单文件 ESM，**import 不到任何东西** ——
所以 JS 组件库（shadcn / HeroUI）永远到不了你手上，Tailwind 工具类也只生成
「构建时扫描到的」类，而你的源码在项目之外。

**所以：**
- 用 `.tb-*` 类（`.tb-pane` / `.tb-card` / `.tb-btn` / `.tb-list` …）—— 永远输出，人人可用
- 布局用内联 `style`（不依赖构建扫描）
- 颜色一律走**令牌**（`var(--color-brand)` 等），这样自动跟随主题

**组件工厂 `ctx.ui.el(...)` 是首选**：它返回真 DOM，且发出的类基于令牌 →
自动跟随主题，**也自动带上你自己在 `contributes.theme` 里定义的主色**。

细节见 [ui.md](ui.md)。

---

---

## 观测层：出问题时你能看到什么

前面五层是**功能**。这一层是**可见性** —— 它不属于任何一层，
但少了它，前面五层出问题时你只能读代码猜。

**四个观测点，按「从外到内」排**：

| | 看什么 | 在哪 |
|---|---|---|
| **① 启动日志** | 每个插件的状态、分阶段与**分插件**耗时（内置的只有 `builtin.procman` / `builtin.streamlab`，其余是你自己装的） | `%APPDATA%\com.tan18.toolbox\debug.log` |
| **② 通信 trace** | 网关层的每一笔往来，**含权限拒绝** | 同一个文件，`hub.setTrace(true)` 打开 |
| **③ 调试句柄** | 运行时的 store / 事件 / 会话 / 流 | `window.__toolbox`（DevTools 控制台） |
| **④ 自检** | 15 项底层契约 | `await window.__toolbox.selftest()` |

### ① 启动日志

```
boot timing (ms): debug 10 | reap 12 | uikit 399 | schemes 402 | builtins 429 | external 640 | hotkey 646
  plugin load (ms): builtin.procman 24 | builtin.streamlab 3 | …
boot ok: 7 plugins, 9 views, active=builtin.procman/procman
  plugin my.plugin: error — [plugin:my.plugin] view "main" not declared in manifest.contributes.views
```

**`error — <原因>` 就是答案**，不用猜。而 `plugin load` 那一行是分插件的 ——
**内置插件的加载是串行 await**（`reconcilePlugins` 的 built-in pass），
所以一个插件慢会拖住后面所有插件的视图。
（插件总数 = 2 个内置 + 你自己装的那些，所以这个数字每台机器都不同。）

### ② 通信 trace

```js
window.__toolbox.hub.setTrace(true)                 // 本会话
localStorage.setItem('toolbox.traceRpc', '1')       // 持久
```

```
rpc -> my.plugin host/info 3ms ok
rpc -> my.plugin proc/spawn 1ms err: plugin `my.plugin` lacks permission `rpc:proc`
```

**这是唯一能看到「你没写的那些调用」的地方。** 插件的 `ctx.log` 只到 webview console
（**不在这个文件里**），它反映的是作者**想**说什么；trace 反映**实际发生**了什么。

> ⚠️ **第一列是「调用方自称的身份」，不是宿主核实的身份。**
> 这个区别本身是个已知问题 —— 见 [COMMS-AUDIT](../COMMS-AUDIT-2026-09-23.md)。
> trace 刻意把它印在最前面，因为**一个 `__host__` 出现在插件的调用里就是那个形状**。

### ③ 调试句柄

```js
window.__toolbox.store       // 插件表、视图表、booted
window.__toolbox.events      // 窗口内事件
window.__toolbox.sessions()  // 活会话
window.__toolbox.openStreams()
window.__toolbox.hub         // ⚠️ 见下
```

**`__toolbox.hub` 是特权入口** —— 它能以任何身份调网关。
开发时它是最好用的东西；但**它同时是当前权限模型的一个漏洞**
（见上面的审计），所以别把依赖它的东西写进插件。

### ④ 自检

`await window.__toolbox.selftest()` —— 15 项，覆盖信封契约、编解码、权限闸、
存储、流、pty、会话表、视图注册、sidecar。**改动底层后先跑它**，
它比你的功能测试更早知道哪里断了。

**它覆盖不到什么**：需要**真人**的东西 —— 原生对话框、系统拖放、OS 通知。
那部分用 [`tests/fixtures/plugins/fileprobe/`](../../tests/fixtures/plugins/fileprobe/)。

### 把检查放进 `activate()`，让它自己报错

**最值得抄的一个模式**：接口检查放 `activate()` 里，失败就抛。
启动日志里那个插件会是 `error` 而不是 `active` —— **不用点任何东西**。

```js
export async function activate(ctx) {
  if (typeof ctx.files?.pick !== 'function') throw new Error('ctx.files missing');
  // …
}
```

`tests/fixtures/plugins/probe/` 就是这么做的：一次跑完 11 项接口检查。
**插件最容易坏的地方是「宿主接口悄悄变了」，而它只在插件真被打开时才暴露。**

## 边界速查

| 你想要的 | 走哪一层 | 要权限吗 |
|---|---|---|
| 存一点数据 | ④ `ctx.storage` | `rpc:storage` |
| 读宿主信息 / 会话列表 | ④ `ctx.rpc('host', ...)` | `rpc:host` |
| 开一个推送流 | ④ `ctx.stream` | `rpc:stream` |
| 跑自带的二进制 | ④ `ctx.sidecar` | `rpc:proc` |
| 开一个终端程序 | ④ `ctx.pty` | `rpc:stream` |
| 广播给所有窗口 | ④ `ctx.bus.publish` | `rpc:bus` |
| **订阅**别人的广播 | ④ `ctx.subscribe` | **不要** |
| **读自己**的热键 | ③ `ctx.onHotkey` | **不要** |
| **关闭自己开的**流 | ④ `ctx.closeStream` | **不要**（关比开弱） |
| 注册一个视图 | ③ `ctx.registerView` | **不要** |
| 开/控制窗口 | ③ `ctx.windows` | `win:manage` |
| 注册全局热键 | ① `contributes.hotkeys` | `rpc:hotkey` |

> 这张表就是 `docs/INTERFACES.md` 的「一个能力一个权限」原则在你这一侧的体现。
> 拿不准时问自己：**这是「观察」还是「能力」？** 观察不用权限。
