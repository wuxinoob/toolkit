# 常见功能的完整最小实现

每条都指向**能跑的现成代码**。别照抄，去读那个文件 —— 里面有注释讲为什么。

| 想做的事 | 现成参考 |
|---|---|
| 最小插件（一个视图） | `examples/plugins/fileprobe/` |
| 一次跑完所有接口（活的集成检查） | `examples/plugins/probe/` |
| 组件词汇表大全（tag 名单用 `ctx.ui.components()` 查） | `examples/plugins/gallery/` |
| 文件访问（选择器 / 拖放）的现场验证 | `examples/plugins/fileprobe/` |
| 剪贴板 / 截屏 / 拖放的现场验证 | `examples/plugins/senses/` |
| 内嵌终端 | `src/plugins/streamlab.js` |
| 管进程 + 定时 + 重启 | `src/plugins/procman.js` |
| 自绘标题栏的独立窗口 | `examples/plugins/eyecare/`（多窗口 + 自绘 chrome） |
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

## 用热键把插件叫出来

**先分清你的插件是哪种形状** —— 两者的做法**不一样**，用错的那个会静默失败。

```json
// plugin.json
"hotkeys": [{ "key": "ctrl+alt+n", "action": "open" }]
```

### A. 视图型（内容在主窗口里）

```js
export async function activate(ctx) {
  ctx.registerView('main', render);
  ctx.onHotkey('open', () => ctx.focusView('main'));
}
```

`focusView` 切的是**主窗口里的视图**，不需要权限。

### B. 窗口型（内容在自己的独立窗口里）

**`focusView` 对这种情况无效** —— 它管不到窗口。

```js
const LABEL = `plugin-${ctx.id.replace(/[^a-zA-Z0-9_-]/g, '-')}-main`;

export async function activate(ctx) {
  ctx.registerView('settings', renderSettings);   // 主窗口只放设置
  ctx.onHotkey('open', async () => {
    // 窗口可能已经关了 —— create 在已存在时是 no-op
    await ctx.windows.create(LABEL, {
      url: `pluginwin.html?plugin=${encodeURIComponent(ctx.id)}&label=${LABEL}`,
      title: '便签', width: 420, height: 560, center: true,
    });
    // 「呼出」用 raise，不是 focus
    await ctx.windows.control(LABEL, 'raise', true);
  });
}
```

- **`raise` = `unminimize` → `show` → `focus`**，按能工作的顺序
- **只调 `focus` 不够**：Windows 上对**最小化**的窗口 `setFocus` **不还原它**，
  热键按下去什么都没发生，而每个调用都返回 Ok —— **静默失败**
- 需要 `win:manage`

### 两种形状共同的注意事项

- **装上去默认是关的**，用户要在 Settings → Hotkeys 里打开（见上一节）
- **读不到 `store.activeViewId`**，所以做不出「再按一次切走」；
  热键只能「总是叫出来」。行为可预测，也够用

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
            url: `pluginwin.html?plugin=${encodeURIComponent(ctx.id)}&label=plugin-my-win`,
            title: 'My Window', width: 320, height: 420, center: true,
          });
          ctx.log.info('window', how);   // 'created' | 'exists'
        },
      }, 'Open'),
    ));
  });
}
```

**要点**：
- `url` 必须是 **`pluginwin.html?plugin=<你的 id>&label=<你的 label>`** ——
  不是 `index.html`。两个页面是两个应用：`index.html` 是外壳，`pluginwin.html`
  才会加载你的 `mountWindow(bridge)`。传错会在 `create()` 当场被拒。
- 窗口里跑的是 `pluginwin-host.js`，它会 Blob-import 你的入口 —— 参考 `examples/calc-plugin/`。
- ⚠️ **窗口里什么样式都没有。** `pluginwin.html` **不引任何样式表**，所以
  `flex` / `gap-2` 这类类名、`.tb-*`、`var(--color-*)` 令牌**全都不存在**，而且**都不报错** ——
  元素就是没样式。在窗口里注入自己的 `<style>`，并不忘写 `box-sizing: border-box`、
  `body { margin: 0 }` 和 `:focus-visible`（见 [ui.md](ui.md)）。

---

## 开一个自绘标题栏的窗口

```js
// label 决定哪个 capability 生效，所以必须以 `plugin-` 开头。
const label = `plugin-${ctx.id.replace(/[^a-zA-Z0-9_-]/g, '-')}-widget`;

const win = await ctx.windows.create(label, {
  url: `pluginwin.html?plugin=${encodeURIComponent(ctx.id)}&label=${label}`,
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
- ⚠️ **窗口里没有 Tailwind 工具类**（同上）—— 自绘就用 `.tb-*`、内联 `style`、
  或自己注入 `<style>`
- 完整参考 `examples/plugins/eyecare/`（创建方 + 窗口页都在一个文件里）

---

## 移动/缩放窗口：**绝不要每条系统消息过一次 IPC**

这是本项目最容易踩、也最难查的性能坑，因为它不报错、不掉帧警告，**只是整台机器发涩**。

### 坑长什么样

```js
// ❌ 每条 WM_SIZE 都跑一遍完整回路
window.addEventListener('resize', () => {
  reportSize();      // 内部：getBoundingClientRect() + publish
  reportLockRect();  // 内部：getBoundingClientRect() + publish
});
```

**Windows 在拖拽/缩放期间是连续发 `WM_SIZE` 的**，不是发一次。所以上面的写法
在用户拖窗口的那一秒里跑了**几十遍**，每一遍：

1. `getBoundingClientRect()` —— **强制同步布局**（`examples/plugins/eyecare/main.js` 里
   关于这点的注释是真的：它当场触发布局计算）
2. 一次 `publish` —— 广播到**每一个**窗口
3. 创建方窗口收到后调 `ctx.windows.control(label, 'size')` → 一次 `plugin_rpc`
4. 那是**原生 `SetWindowPos`** → 于是又产生一个 `resize` → **回到第 1 步**

**这是一个跨两个窗口加原生侧的自放大回路。** 它同时占住三样东西：插件窗口的
JS 线程（强制布局）、主线程（`SetWindowPos` + 同步网关）、以及所有窗口的事件处理
（广播扇出）。主窗口跟着一起卡，因为**这三样里有一样是全局的**。

### 怎么写才对

```js
// ✅ 一帧最多一次，且值没变就不发
let raf = 0;
const scheduleReports = () => {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; reportSize(); reportLockRect(); });
};
window.addEventListener('resize', scheduleReports);
```

两层保护各管一件事，**都要有**：

- **rAF 合并** —— 挡住"值还在变的时候跑得比有用更快"。下一帧再量一次也是同样的像素。
- **去重**（记住上次的值，相同就 return）—— 挡住"值已经停了但事件还在来"，
  也就是回路的收敛。`examples/plugins/eyecare/main.js` 的 `sizeReporter` 就是这一层。

同理，**拖拽**也要按帧合并（`pointermove` 本身每帧可能来好几次）：

```js
pill.addEventListener('pointermove', (e) => {
  /* 更新本地位置 */
  queueMove();          // rAF 合并后才 publish
});
```

### 更好的做法：让系统自己拖

如果只是"用户按住拖这个窗口"，**不要**用 `publish` + `control('position')` 模拟 ——
那是 60 次/秒的 IPC 往返加 60 次 `SetWindowPos`。插件窗口的 bridge 有原生的：

```js
bridge.drag();   // 等于 getCurrentWindow().startDragging()
```

交给操作系统的拖拽循环，零 IPC。**需要落盘最终位置**时，拖完读一次窗口位置即可，
而不是每帧同步一次。

> 只有"窗口大小由内容决定"这种系统算不出来的情况，才需要上面那套测量+上报 ——
> 而且那时它**必须**是合并的。

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
