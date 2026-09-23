# 常见功能的完整最小实现

每条都指向**能跑的现成代码**。别照抄，去读那个文件 —— 里面有注释讲为什么。

| 想做的事 | 现成参考 |
|---|---|
| 最小插件（一个视图） | `examples/plugins/fileprobe/` |
| 一次跑完所有接口（活的集成检查） | `examples/plugins/probe/` |
| 组件词汇表大全（376 个 tag） | `examples/plugins/gallery/` |
| 文件访问（选择器 / 拖放）的现场验证 | `examples/plugins/fileprobe/` |
| 内嵌终端 | `src/plugins/streamlab.js` |
| 管进程 + 定时 + 重启 | `src/plugins/procman.js` |
| 自绘标题栏的独立窗口 | `src/plugins/floatwin.js` + `floatwin-widget.js` |
| 独立窗口（普通） | `examples/calc-plugin/` |

---

## 存一个设置并读回来

```js
async activate(ctx) {
  ctx.registerView('main', (root) => {
    const { el, render } = ctx.ui;
    render(root, el('div', { class: 'tb-pane tb-pane-pad' },
      el('div', { class: 'tb-field' },
        el('span', { class: 'tb-label' }, 'Name'),
        el('input', {
          class: 'tb-input',
          defaultValue: this._name ?? '',
          onInput: (e) => { this._name = e.target.value; },
        }),
      ),
      el('button', {
        class: 'tb-btn tb-btn-primary',
        onClick: async () => {
          await ctx.storage.set('name', this._name);
          ctx.ui.notify('saved', 'success');
        },
      }, 'Save'),
    ));
  });

  this._name = await ctx.storage.get('name');
}
```

**要点**：`storage` 落在 `{appData}/plugin-data/<你的 id>/`，每插件一个目录。
需要 `rpc:storage`。

---

## 跨窗口广播（同步两个窗口的状态）

```js
// 发（需要 rpc:bus）
await ctx.bus.publish('my.changed', { n: 42 });

// 收（不要权限）
const off = ctx.bus.subscribe('my.changed', (env) => {
  console.log(env.p);   // { n: 42 }
});

// 离开时
deactivate() { off(); }
```

**要点**：`env` 是完整信封 —— `env.p` 是你的 payload，`env.svc` 是发布者。
**不要用 storage 轮询做同步**，那是被否掉的做法。

---

## 内嵌一个终端

```js
const h = await ctx.pty('term', {
  program: process.platform === 'win32' ? 'powershell.exe' : 'bash',
  cols: 80, rows: 24,
  onFrame: (frame) => term.write(frame.p),
  onEnd: () => ctx.log.info('pty ended'),
});

term.onData((d) => h.send(d));      // 键盘输入送进去
await h.close();                    // 或 ctx.closeStream('term')
```

**要点**：需要 `rpc:stream`。`streamlab.js` 里有完整的 xterm 集成、主题跟随、
尺寸自适应（`fit` 要在容器可见后再调，否则算出来是 0 列）。

---

## 跑一个自带的二进制

```js
const s = await ctx.sidecar('helper', {
  exe: 'my-helper.exe',            // 相对你的插件目录
  args: ['--serve'],
  onFrame: (f) => { /* 一行一个 JSON */ },
  onEnd: () => {},
});
```

**要点**：需要 `rpc:proc`（**不是** `rpc:stream`）——
「开一个流」和「运行我自带的二进制」是两个不同强度的能力。

---

## 加一个热键

```json
// plugin.json —— 声明即可，不需要权限
"hotkeys": [{ "key": "ctrl+alt+m", "action": "toggle" }]
```

```js
ctx.onHotkey('toggle', () => { /* … */ });
```

**装上去它默认是关的** —— 用户要在 **Settings → Hotkeys** 里打开，键才真的被占用。
这是刻意的：插件不该装上就占全局快捷键。所以**别假设它是活的**，
需要确认就查 `hotkey/list`。

**用户改键不用改你的代码** —— `onHotkey` 按 `action` 订阅，不认 key。

参考 `examples/plugins/probe/`（它用 `hotkey/list` 验证注册结果）。

## 定时 + 自启 + 崩溃重启

```js
// plugin.json 里声明视图，然后：
ctx.registerView('main', renderPanel);

// 定时（自己管定时器，deactivate 里清掉）
this._timer = setInterval(() => this._tick(), 60_000);

deactivate() {
  clearInterval(this._timer);       // 自己 new 的，自己清
}
```

**要点**：`procman.js` 是完整实现 —— profile 持久化、`autoStart`、
`schedule`（daily / interval）、`restart`（never / on-failure / always + 重试次数 + 退避）。
**一个 profile 只拥有一个进程**：重复运行会聚焦已有进程而不是再起一个。

---

## 开一个独立窗口（普通）

```json
// plugin.json
"permissions": ["win:manage"]
```

```js
async activate(ctx) {
  ctx.registerView('main', (root) => {
    const { el, render } = ctx.ui;
    render(root, el('div', { class: 'tb-pane tb-pane-pad' },
      el('button', {
        class: 'tb-btn tb-btn-primary',
        onClick: async () => {
          const how = await ctx.windows.create('plugin-my-win', {
            url: `index.html?mode=pluginwin&plugin=${encodeURIComponent(ctx.id)}&label=plugin-my-win`,
            title: 'My Window', width: 320, height: 420, center: true,
          });
          ctx.log.info('window', how);   // 'created' | 'exists'
        },
      }, 'Open'),
    ));
  });
}
```

**要点**：`url` 的**三个参数一个都不能少**（`mode` / `plugin` / `label`）。
窗口里跑的是 `pluginwin-host.js`，它会 Blob-import 你的入口并调用
`mountWindow(bridge)` —— 参考 `examples/calc-plugin/`。

---

## 开一个自绘标题栏的窗口

```js
const win = await ctx.windows.create('plugin-widget', {
  url: 'index.html?mode=floatwin',   // 或你自己的 mode
  width: 260, height: 120,
  transparent: true,
  decorations: false,                // ← 自绘的前提
  shadow: false,                     // 圆角卡片不要方形阴影框
  alwaysOnTop: true,
  skipTaskbar: true,
  resizable: false,
});
```

然后在窗口页里画一条 bar 并让它可拖：

```js
bar.addEventListener('mousedown', (e) => {
  if (e.buttons === 1) bridge.drag();   // → startDragging()
});
```

**要点**：
- 插件窗口的 capability 恰好给两个权限：`start-dragging` + `close`
- **尺寸/位置/置顶/透传归创建它的窗口**（主窗口），不在插件窗口自己的权限里
- 完整参考 `floatwin.js`（创建方）+ `floatwin-widget.js`（窗口页）

---

## 让插件出问题时**启动日志直接变红**

把接口自检放进 `activate()`，失败就抛：

```js
async activate(ctx) {
  const r = await ctx.rpc('storage', 'set', { key: '__probe', value: 1 });
  if (!r) throw new Error('storage write failed');
  // …任何一步失败都抛
}
```

**这样启动日志里这个插件就是 `error` 而不是 `active` —— 不用点任何东西。**

`examples/plugins/probe/` 就是这么做的：一次调用跑完 11 项接口检查。
它既是「新插件零改动复用接口」的证据，也是一个**活的集成检查**。

**这个模式值得抄** —— 插件最容易坏的地方是「宿主接口悄悄变了」，
而它只在你的插件真的被打开时才暴露。放进 `activate()` 就变成了启动即知。
