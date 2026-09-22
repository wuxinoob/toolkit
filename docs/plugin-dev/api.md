# `ctx` 参考 — 按任务组织

**`ctx` 是你的全部能力边界。** 上面没有的东西就是拿不到 ——
没有全局变量可绕，没有后门。

> 为什么必须这样：外部插件是 **Blob URL 单文件 ESM，import 不到任何模块**。
> 所以宿主把需要的东西**作为参数递给你**。这不是限制，是唯一可行的形态。

---

## 我要存一点数据

```js
await ctx.storage.get('key')          // → value | null
await ctx.storage.set('key', value)   // value 必须能 JSON 序列化
await ctx.storage.remove('key')
await ctx.storage.keys()              // → string[]
```

**权限**：`rpc:storage` · **落盘位置**：`{appData}/plugin-data/<你的 id>/` ——
每个插件一个目录，互相看不见。

---

## 我要让两个窗口同步状态

```js
// 广播（所有窗口都能收到）
await ctx.bus.publish('my.topic', { n: 1 });     // 权限 rpc:bus

// 订阅（不要权限）
const off = ctx.bus.subscribe('my.topic', (env) => {
  // ⚠️ 回调收到的是**完整信封**，你的 payload 在 `env.p` —— 不是回调参数本身
  console.log(env.p);
});
off();   // 取消

// 想写得宽容一点（跨版本更稳）：
const payload = env?.p ?? env?.payload ?? env;

// 只收一次
ctx.bus.once('my.topic', (env) => {});
```

**跨窗口只走 bus 广播，不要用 storage 轮询做同步** —— 那是设计上被否掉的做法。

**同一个 API，两个默认值**：

| | 默认方案 | 范围 |
|---|---|---|
| `ctx.events.*` | `in-process` | **本窗口内**，零 IPC，同步送达 |
| `ctx.bus.*` | `event-bus` | **跨窗口**广播 |

两者**都是异步形状** —— 方案差异只体现在默认值上，不体现在形状上。
所以你可以把 `ctx.events` 换成 `ctx.bus` 而不改代码结构。

> 注意：`in-process` 是**窗口本地**的。插件视图在哪个窗口，它的 `events`
> 就只在那个窗口内。想跨窗口用 `ctx.bus`。

---

## 我要用一个热键

### 声明式（推荐，**不需要权限**）

```json
// plugin.json
"hotkeys": [{ "key": "ctrl+alt+m", "action": "toggle" }]
```

```js
ctx.onHotkey('toggle', (env) => {
  // env.p 是 { key: 'ctrl+alt+m' }
});
```

**宿主在你 `activate()` 之前就注册好了**，所以可以放心依赖。
**为什么不要权限**：注册是**宿主以 `__host__` 身份代办的**，只把 `owner: <你的 id>`
带过去 —— 你没有触达 OS 的快捷键 API，只是声明了「我要这个键」。

**`key` 的语法**是 Tauri 的 `Shortcut`：修饰键 `+` 键名。
`ctrl` / `control` / `alt` / `shift` / `super` / `cmdorctrl`，
键名可以是单字符（`p`、`k`）或具名键（`F1`、`Space`、`Enter`、`Escape`、`ArrowUp`…）。

### 事件是怎么送到你的

```
OS 按下  →  Rust handler  →  app.emit(evt, topic = "hotkey:<action>")
         →  JS listen(BROADCAST_EVENT)  →  按 topic 分发  →  ctx.onHotkey
```

**信封里带着 owner**（`env.svc`）—— 所以**别的插件碰巧用了同名 action 时你收不到**。
宿主替你过滤了，你不用自己判。

### 命令式（运行时增删，**需要 `rpc:hotkey`**）

```js
await ctx.rpc('hotkey', 'register',   { key: 'ctrl+alt+n', action: 'next' });
await ctx.rpc('hotkey', 'unregister', { key: 'ctrl+alt+n' });
await ctx.rpc('hotkey', 'unregister_all', {});
const { keys } = await ctx.rpc('hotkey', 'list', {});
```

四个动作：`register` / `unregister` / `unregister_all` / `list`。

**什么时候用命令式**：热键由用户配置决定，事先不知道。
否则用声明式 —— 它不需要权限，而且会出现在 `plugin.json` 里，别人看得见。

### 注册失败不会抛，所以你要主动查

**一个快捷键被别的程序占用是常见的，不该阻止插件激活** —— 所以失败只写一条
`ctx.log.warn`，不抛错。代价是**你默认不知道成没成**。

**要确认就查**（`probe` 插件就是这么做的）：

```js
const { keys } = await ctx.rpc('hotkey', 'list', {});
if (!keys.includes('ctrl+alt+m')) ctx.log.warn('hotkey not registered — 可能被占用');
```

或者启动时用 `ctx.ui.notify` 告诉用户「热键 X 没注册上」，让他自己改。

---

## 我要跑一个进程

```js
// 一个终端程序（pty）
const h = await ctx.pty('term1', {
  program: 'node', args: ['-e', 'console.log(1)'],
  cols: 80, rows: 24,
  onFrame: (f) => { /* 字节/文本帧 */ },
  onEnd: () => {},
});
h.send('input\n');       // 写进去
await h.close();

// 跑你自己带的二进制（sidecar）
const s = await ctx.sidecar('helper1', {
  exe: 'my-helper.exe', args: ['--serve'],
  onFrame: (f) => {},
});
```

**权限**：`pty` → `rpc:stream`；`sidecar` → `rpc:proc`。
**两个不同的权限是刻意的** —— 「开一个流」和「运行我自带的二进制」不是一回事。

参考实现：`builtin.procman`（pty）、`examples/` 里的 sidecar 示例。

---

## 我要开一个流

```js
// 宿主 → 我，推送（provider 决定数据从哪来）
const h = await ctx.stream('ticker', 'ch1', { onFrame: (f) => {} });

// 二进制帧版本，同一个信封形状
const h2 = await ctx.streamRaw('blob', 'ch2', { onFrame: (f) => {} });

// 我 → 宿主，批量上行（省 IPC：1000 帧 = 1 次往返）
const up = await ctx.uplink('ch3', { sink: 'proc' });
up.sendBatch(frames);

await ctx.closeStream('ch1');   // 关自己开的流：不要权限
```

**权限**：开流要 `rpc:stream`；**关不要**（关比开弱）。

**上行流的载体是批量 invoke，不是 Channel。** Tauri 的 `Channel` 是**单向**的 ——
JS 侧只有接收回调，**没有 `send`**。所以「从 JS 推给 Rust」没有 Channel 可用，
这是框架约束不是设计选择。

---

## 我要问宿主一些事

```js
await ctx.rpc('host', 'info')        // 数据目录、活会话数…
await ctx.rpc('host', 'sessions')    // 会话表
await ctx.rpc('host', 'plugins')     // 插件表
await ctx.rpc('host', 'schema')      // 服务/动作/权限词表 —— 可自省
await ctx.sessions()                 // = rpc('host','sessions')
await ctx.schema()                   // = rpc('host','schema')
```

**权限**：`rpc:host`。

**`ctx.schema()` 值得先看** —— 它公布服务、动作、权限的完整词表，
所以你不用猜有什么可调。这也是 `docs/INTERFACES.md` 里说的
「动作清单权威：`Service::actions()` 同时用于网关校验与 `host/schema`，不可能漂移」。

通用出口：`ctx.rpc(svc, act, params)`，权限按 `rpc:<svc>` 判。

---

## 我要画界面

```js
const { el, render, native, notify } = ctx.ui;

ctx.registerView('main', (root) => {
  render(root, el('div', { class: 'tb-pane tb-pane-pad' },
    el('card', {}, el('card-header', {}, el('card-title', {}, 'Hi'))),
    el('button', { variant: 'default', onClick: () => notify('clicked') }, 'Go'),
  ));
});
```

- `el(tag, props, ...children)` — 返回**真 DOM 节点**。tag 名 = `.tb-*` 类去掉前缀
- `render(host, node)` — 替换 host 的内容
- `native(tag, …)` — 需要**真原生元素**时用。例如 `el('form')` 拿到的是 Form **组件**
  （上游的校验包装），它的 submit 事件没有 `preventDefault`；要原生行为就用 `native('form')`
- `notify(msg, type)` — 走宿主的 toast

**样式规则见 [ui.md](ui.md)**。一句话：用 `.tb-*` 类 + 令牌，布局用内联 style。

---

## 我要开一个窗口

```js
const how = await ctx.windows.create('my-win', {
  url: 'index.html?mode=pluginwin&plugin=my.plugin&label=my-win',
  title: 'My Window', width: 400, height: 300,
  decorations: false,        // 自绘标题栏
  transparent: true, alwaysOnTop: true, skipTaskbar: true,
});
// → 'created' | 'exists'

await ctx.windows.control('my-win', 'size', { width: 500, height: 400 });
await ctx.windows.control('my-win', 'alwaysOnTop', true);
await ctx.windows.exists('my-win');
ctx.windows.onCloseRequested(async () => { /* 清理 */ });
```

**权限**：`win:manage`。

**三个约束，前两个宿主会直接拒绝，第三个要你自己注意**：

1. **`label` 必须以 `plugin-` 开头**（或正好是 `floatwin`）。
   **这是最容易踩的坑。** Tauri 按 **window label** 匹配 capability，而给插件窗口授权的
   只有两个文件：`pluginwin.json` 的 `["plugin-*"]` 和 `floatwin.json` 的 `["floatwin"]`。
   **别的 label 匹配不到任何 capability → 那个窗口没有任何权限** ——
   拖不动，关闭按钮静默失败（ACL denial）。宿主现在会**直接拒绝**并给你建议的 label：

   ```js
   await ctx.windows.create('my-win', …)
   // ❌ Error: window label "my-win" matches no capability, so the window would have no
   //    permissions (it could not be dragged, and its close button would fail with an
   //    ACL denial). Use "plugin-my-win" instead.
   ```

   推荐写法：`` `plugin-${ctx.id.replace(/[^a-zA-Z0-9_-]/g, '-')}-main` ``

2. **`url` 必须是应用自己的入口页**（`index.html?...`）。传外部 URL 会被拒绝 ——
   那会替换掉宿主页、跳过 `pluginwin-host.js`（把 `bridge` 交给你的加载器）

3. **窗口选项走白名单**。不在名单上的会被拒绝**并告诉你名字**，不会静默忽略

### `transparent: true` 只在真的需要异形窗口时用

综合管理窗口**不要**开透明 —— 纯色原生渲染更稳、更省 GPU。
如果确实要（悬浮挂件、圆角卡片），**必须**给根容器一个兜底背景色，否则在 Windows
WebView2 下会呈现**彻底穿透的空洞**：

```css
.my-window-root {
  background-color: var(--color-canvas);
  border-radius: 12px;
  border: 1px solid var(--color-line);
}
```

### 关闭窗口：为什么不能只调 `bridge.close()`

`bridge.close()` 是异步的，**权限不足时它会 reject**。不 catch 就静默失败 ——
按钮点了没反应。而且**独立窗口自己没有 `win:manage`**，所以它无法调用
`windows.control` 自救。

**可靠的做法是让主窗口兜底**（主窗口有 `win:manage`）：

```js
// 主窗口 activate(ctx) 里：代关
ctx.bus.subscribe('my.plugin:close-window', async (env) => {
  const label = env?.p?.label;
  if (label) await ctx.windows.control(label, 'close').catch(() => {});
});

// 独立窗口里：三层兜底
async function closeMe() {
  try { await bridge.close(); return; } catch {}
  try { await bridge.bus.publish('my.plugin:close-window', { label: bridge.label }); return; } catch {}
  window.close();
}
```

**注意 label 已经是 `plugin-*` 了**，所以第一层正常就该成功 —— 兜底是防万一。

**窗口操作的分工**：`size` / `position` / `alwaysOnTop` / `clickThrough` 等
**归创建它的窗口**（主窗口），不在插件窗口自己的权限里 ——
「能改自己尺寸」和「能被拖动」不是一回事。

自绘标题栏时，插件窗口的 capability 恰好给两个权限：
`core:window:allow-start-dragging` + `allow-close`。
用 `bridge.drag()` 拖。参考 `builtin.floatwin`。

### `bridge`（独立窗口）≠ `ctx`（主窗口）

**它们不是同一个对象，能力也不对等。** 独立窗口里只有 `bridge`：

| 能力 | 主窗口 `ctx` | 独立窗口 `bridge` |
|---|---|---|
| `storage` | ✅ | ✅ |
| `bus`（订阅 / 发布 / once） | ✅ | ✅ |
| `onHotkey` | ✅ | ✅ |
| `windows.create` / `windows.control` | ✅ | ❌ **没有** |
| `registerView` | ✅ | ❌ **没有** |
| `drag()` / `close()` | ❌ 不需要 | ✅ **独有** |

**所以独立窗口想再开一个窗口，要请主窗口代劳** ——
`bridge.bus.publish('my.plugin:open-window', {...})`，主窗口订阅后 `ctx.windows.create(...)`。
**窗口的创建与尺寸控制权专属创建方**，这是刻意的。

### 自绘标题栏：拖拽区会吃掉点击

`-webkit-app-region: drag` 的区域里，**所有点击都被系统当成窗口移动指令** ——
按钮点不动、输入框拿不到焦点。**区域内的可交互控件必须显式取消拖拽**：

```css
.my-titlebar { -webkit-app-region: drag; user-select: none; }
.my-titlebar button,
.my-titlebar input { -webkit-app-region: no-drag; }
```

---

## 我要写日志 / 报错

```js
ctx.log.info('message');     // 带 [plugin:<id>] 前缀
ctx.log.warn('…');
ctx.log.error('…');
ctx.ui.notify('给用户看的一句话', 'error');
```

`ctx.log` 的输出会进宿主的调试日志 —— 排查时这是**唯一在 webview 之外**留痕的通道，
所以重要状态**一定要写**。

---

## 我要自省协议

```js
ctx.protocol          // 冻结的信封契约、kind 词表、Code 词表
ctx.schemes()         // 当前可用方案
```

`ctx.protocol` 由 `protocol/contract.js` 单点提供并 `freeze()`，
**两个窗口面共用** —— 所以插件窗口和主窗口看到的是同一份契约。

---

## 生命周期

```js
export default {
  manifest: { id, name },
  async activate(ctx) { },   // 宿主 await 它（所以：要快，见下）
  deactivate() { },          // 清理你自己 new 出来的东西
};
```

**`activate()` 会被 `await`，而且是串行的。** 一个插件慢，后面所有插件的视图都要等。
实测九个内置插件总共 ~1.7s，这就是启动时侧栏空几秒的原因。

**怎么做**：
- 慢活（网络、子进程、大文件）**不要**在 `activate()` 里 await
- 或者先 `ctx.registerView()` 把视图注册出来，再异步补内容
- 通过 `ctx` 注册的东西（订阅、流、窗口、热键）**由宿主自动释放**，
  你只需清自己 new 的定时器和外部引用

参考 [debugging.md](debugging.md#启动慢)。
