# `plugin.json` 参考

**这是权威清单。** 代码里 `export default { manifest }` 只**补缺**，
`plugin.json` 覆盖它（`contributes` 逐键合并）。两者不一致时以 JSON 为准 ——
所以改权限、改标题、改图标，改 JSON 就够了，不用动代码。

宿主有一条审计测试盯着「JSON 与代码里的 manifest 必须一致」。

---

## 顶层字段

```json
{
  "id": "my.plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "api": 2,
  "entry": "main.js",
  "description": "一句话说明这个插件干什么",
  "contributes": { },
  "permissions": [ ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 全局唯一。**同时是数据目录名**（`{appData}/plugin-data/<id>/`），也是 `ctx` 报错前缀 `[plugin:<id>]` |
| `name` | ✅ | 侧栏与错误信息里显示的名字 |
| `version` | | 仅展示 |
| `api` | **强烈建议** | 你按哪个 **HOST API** 版本写的。当前是 **2**。填错或漏填 → 宿主在你的插件行上写一条说明，而不是让你在运行期撞上 `off is not a function` |
| `entry` | ✅ | 入口文件，相对插件目录 |
| `description` | | 仅展示 |
| `contributes` | | 声明式贡献点，见下 |
| `permissions` | | 权限清单，见下 |

---

## `contributes` — 声明式贡献点

**宿主代注册**，且**在你的 `activate()` 之前**完成。所以你可以放心在自己的
`activate()` 里就依赖它们已经生效。

### `views` — 主窗口里的视图

```json
"views": [
  { "id": "main", "slot": "tool", "title": "My Plugin", "icon": "lucide:puzzle" }
]
```

| 键 | 说明 |
|---|---|
| `id` | 视图 id，**`ctx.registerView(id, …)` 必须用它** |
| `slot` | 侧栏分组：`tool`（默认）/ `panel` / `system` |
| `title` | 侧栏里显示的文字 |
| `icon` | 侧栏里的图标。见下 |

**`icon` 支持三种写法**：

```json
"icon": "lucide:terminal"   // ← 推荐。宿主渲染真图标，跟随主题
"icon": "lucide:puzzle"                 // ← emoji，一直可用，但跨平台渲染不一致
"icon": "lucide:tpyo"       // ← 拼错：回退到通用图标，并在控制台警告
```

- **`lucide:<name>`** —— 宿主从一份**固定的词汇表**里取图标渲染成 SVG。
  `ctx.schema()` 之外，可用名字在 `src/host/icons.js` 的 `ICON_NAMES` 里
  （50 个：`terminal` / `folder` / `chart-line` / `settings` / `database` / `shield` …）
- **为什么不是「任意 lucide 图标」** —— `@lucide/vue` 导出 **6330** 个图标（源码 16MB）。
  按名字全量查表会让打包器无法摇树，包体翻倍（现在 1.6MB）—— 只为侧栏一个小图标。
  词汇表是刻意的；**加一个图标很便宜**（一行 import + 一行映射）
- **拼错不会留白** —— 回退到通用图标并在控制台说明。**不会**把
  `lucide:tpyo` 这个字符串直接显示出来

**关键契约：`ctx.registerView(id, render)` 会校验 `id` 是否已在 `views` 里声明**，
没声明会直接抛错：

> `[plugin:my.plugin] view "main" not declared in manifest.contributes.views`

这是刻意的 —— 视图的 slot/title/icon 来自声明，不是来自代码。
**你不可能只注册一个「没有名字的视图」。**

### `hotkeys` — 全局热键

```json
"hotkeys": [
  { "key": "ctrl+alt+shift+p", "action": "probe" }
]
```

- **这个声明本身就是权限** —— 注册由宿主以 `__host__` 身份代办，你只是声明意图。
  （**但运行时增删**要 `rpc:hotkey`，见 [api.md](api.md#我要用一个热键)）
- 在插件里用 `ctx.onHotkey('probe', fn)` 接；回调收到完整信封，`env.p` 是 `{ key }`
- **冲突会被报告，但不会致命** —— 一个快捷键被占用不该阻止插件激活。
  代价是**失败只 warn 不抛**，所以想确认就查 `hotkey/list`
- `key` 用 Tauri 的 `Shortcut` 语法：`ctrl+alt+shift+p`、`cmdorctrl+k`、`F1`…

**完整说明（含事件链路、owner 过滤、命令式接口）在
[api.md](api.md#我要用一个热键)。**

### `theme` — 插件自己的主题覆盖

```json
"theme": {
  "light": { "--color-brand": "#7c3aed" },
  "dark":  { "--color-brand": "#a78bfa" }
}
```

宿主把这段作用在**你插件视图的子树**上（`[data-plugin="<id>"]`）。
所以：

- 你**不需要**为「跟随主题」写任何代码 —— 用令牌就够了
- 用组件工厂搭的界面会**自动**带上你的主色（工厂发出的类基于令牌）
- **弹层会逃出这个作用域** —— Dialog/Dropdown/Tooltip 默认 teleport 到
  `document.body`，就出了 `[data-plugin]` 子树，于是「按钮是紫的、弹窗是蓝的」。
  工厂已经把 portal 目标指到你自己的容器；**手写这些组件时要自己传 `portalTo`**

---

## `permissions` — 权限清单

**一个能力一个权限。** 拿不准时问自己：**这是「观察」还是「能力」？**
观察不用权限。

| 权限 | 给什么 | 典型用途 |
|---|---|---|
| `rpc:storage` | 读写你自己的数据目录 | 存设置、缓存 |
| `rpc:host` | 宿主信息、会话表、schema | 诊断面板 |
| `rpc:stream` | 开推送流 / 跑终端程序 | 实时日志、内嵌终端 |
| `rpc:proc` | 运行**你自带的**二进制 | 用 Rust/Go 写的 helper |
| `rpc:bus` | **发布**广播 | 跨窗口同步状态 |
| `rpc:hotkey` | 注册**非声明式**的热键 | 动态热键 |
| `win:manage` | 开 / 控制窗口 | 独立窗口、悬浮窗 |
| `rpc:dialog` | 开原生选择器 / 保存框 / 消息框 | `ctx.files.pick` |

**不需要权限的**（「观察」侧）：

| 想要 | 怎么做 |
|---|---|
| 订阅别人的广播 | `ctx.subscribe(...)` |
| 读**自己**的热键 | `contributes.hotkeys` + `ctx.onHotkey` |
| 关闭**自己开的**流 | `ctx.closeStream(ch)` —— 关比开弱，所以不设闸 |
| 注册视图 | `ctx.registerView(...)` |
| 读 `ctx.protocol` / `ctx.log` / `ctx.ui` | 直接读 |

**两个闸口，两道都要过**：JS 侧 `ctx`（快速失败，给你可读的错误）+
Rust 侧 `host/registry.rs`（权威，fail-closed，未注册即拒绝）。
所以**光在 `plugin.json` 里写权限不够** —— 首次加载时插件要向宿主注册，
注册用的就是这份清单。

---

## 完整最小示例

```json
{
  "id": "my.plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "api": 2,
  "entry": "main.js",
  "description": "示例",
  "contributes": {
    "views": [{ "id": "main", "slot": "tool", "title": "My Plugin", "icon": "lucide:puzzle" }],
    "hotkeys": [{ "key": "ctrl+alt+m", "action": "toggle" }]
  },
  "permissions": ["rpc:storage"]
}
```

```js
export default {
  manifest: { id: 'my.plugin', name: 'My Plugin' },

  async activate(ctx) {
    // 声明式热键已生效，可以放心依赖
    ctx.onHotkey('toggle', () => ctx.log.info('hotkey fired'));

    ctx.registerView('main', (root) => {
      const { el, render } = ctx.ui;
      render(root, el('div', { class: 'tb-pane tb-pane-pad' }, 'Hello'));
    });
  },

  deactivate() {
    // ctx 的 disposer 会自动释放你通过它注册的东西；
    // 这里只清你自己 new 出来的（定时器、外部订阅…）
  },
};
```

---

## 目录放哪

| | 路径 |
|---|---|
| 插件目录 | `%APPDATA%\com.tan18.toolbox\plugins\<任意子目录>\` |
| 你的数据目录 | `%APPDATA%\com.tan18.toolbox\plugin-data\<你的 id>\` |

放进插件目录后**首次发现即启用**；显式禁用会持久记住。
开发时改完代码点侧栏的 **Rescan**，不用重启。
