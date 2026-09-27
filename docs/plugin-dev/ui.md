# 界面怎么做

> 完整的样式体系（令牌表、主题机制、组件工厂的设计取舍）在 **`docs/UI.md`**。
> 本页只讲**插件作者要做的选择**。

---

## 一条约束决定了全部

**外部插件是 Blob URL 单文件 ESM，import 不到任何东西。**

推论，每一条都直接影响你的写法：

| 你想要的 | 为什么拿不到 |
|---|---|
| shadcn-vue / HeroUI | 要 `import`，你 import 不了 |
| Tailwind 工具类 | v4 只生成**构建时扫描到的**类，而你的源码在项目之外 |
| 任何 npm 包 | 同上 |

**所以本项目的美化走 `.tb-*` 普通 CSS 类** —— 它们**永远在产物里**，人人可用，
不需要构建期知道你的存在。

---

## 三件套：类名 + 令牌 + 内联布局

```js
const { el, render } = ctx.ui;

render(root, el('div', { class: 'tb-pane tb-pane-pad' },
  el('div', { class: 'tb-section-title' }, 'Settings'),
  el('div', { class: 'tb-row' },
    el('span', { class: 'tb-row-label' }, 'Enabled'),
    el('span', { class: 'tb-dot tb-dot-ok' }),
  ),
  // 布局用内联 style —— 不依赖构建扫描，一定生效
  el('div', { style: 'display:flex;gap:6px;margin-top:8px;' },
    el('button', { class: 'tb-btn tb-btn-primary' }, 'Save'),
  ),
));
```

**规则**：

1. **颜色一律走令牌**，绝不写死颜色 —— 写死就不跟随主题了
2. **布局用内联 `style`** —— 不依赖构建扫描，一定生效
3. **观感用 `.tb-*` 类** —— 常驻 CSS，一定存在

---

## 可用的类（节选，按用途）

### 容器

| 类 | 用途 |
|---|---|
| `.tb-pane` / `.tb-pane-pad` | 一块面板 / 带内边距的面板 |
| `.tb-card` / `.tb-card-head` / `.tb-card-body` / `.tb-card-foot` | 卡片四件套 |
| `.tb-section-title` | 小节标题 |
| `.tb-divider` | 分隔线 |
| `.tb-empty` | 空状态 |
| `.tb-screen` / `.tb-screen-title` / `.tb-screen-count` | 整屏标题区 |

### 列表与行

| 类 | 用途 |
|---|---|
| `.tb-list` | 可滚动的列表容器 |
| `.tb-row` / `.tb-row-label` / `.tb-row-actions` | 一行：内容 + 右侧动作 |
| `.tb-table` | 表格 |

### 控件

| 类 | 用途 |
|---|---|
| `.tb-btn` + `.tb-btn-primary` / `.tb-btn-ghost` / `.tb-btn-danger` / `.tb-btn-sm` | 按钮 |
| `.tb-icon-btn` / `.tb-icon-btn-danger` | 方形图标按钮 |
| `.tb-input` / `.tb-input-inline` / `.tb-textarea` / `.tb-select` | 输入类 |
| `.tb-field` / `.tb-label` | 表单字段 + 标签 |

### 状态与文字

| 类 | 用途 |
|---|---|
| `.tb-dot` + `.tb-dot-ok` / `.tb-dot-warn` / `.tb-dot-bad` | 状态点 |
| `.tb-badge` + `.tb-badge-ok` / `.tb-badge-warn` / `.tb-badge-bad` | 徽章 |
| `.tb-t-ok` / `.tb-t-warn` / `.tb-t-bad` / `.tb-t-brand` / `.tb-t-muted` / `.tb-t-dim` | 文字颜色 |
| `.tb-hint` | 次要说明文字 |
| `.tb-mono` | 等宽 |
| `.tb-kbd` | 键帽 |

### 导航与外壳

`.tb-tabs` / `.tb-tab`、`.tb-toolbar`、`.tb-nav` / `.tb-nav-group` / `.tb-nav-item`、
`.tb-sidebar` / `.tb-shell` / `.tb-content`、`.tb-toasts` / `.tb-toast`、`.tb-overlay`

---

## 令牌

**一律用 `var(--color-*)`。** 常用的：

| 令牌 | 用途 |
|---|---|
| `--color-canvas` | 最底层的背景 |
| `--color-card` | 卡片/面板表面 |
| `--color-ink` | 正文 |
| `--color-ink-muted` / `--color-ink-subtle` | 次要 / 更弱 |
| `--color-brand` / `--color-brand-hover` | 主色 |
| `--color-line` | **区域分隔线**（很轻） |
| `--color-line-strong` | 更明确的分隔 |
| `--color-input` | **控件轮廓**（比 line 明确） |
| `--color-danger` / `--color-success` / `--color-warn` | 语义色 |

> **`--color-line` 和 `--color-input` 是分开的，这不是冗余。**
> 分隔线要尽量退场，控件轮廓要让人看出「这是个输入框」—— 两个相反的诉求。
> 用错会让界面要么全是黑框、要么输入框看不见。

---

## 组件工厂：比手写类名更好

```js
const { el } = ctx.ui;
el('button', { variant: 'default', size: 'sm' }, 'Go');
el('card', {}, el('card-header', {}, el('card-title', {}, 'T')));
```

**tag 名 = `.tb-*` 类去掉 `tb-` 前缀** —— 只有一份词汇表，工厂不可能和 CSS 漂移。

**为什么优先用它**：

- 返回**真 DOM 节点**，不需要框架
- 发出的类**基于令牌** → 自动跟随主题
- 自动跟随**你自己在 `contributes.theme` 里定义的主色** —— 插件零代码
- 事件处理器由宿主挂载并交给 `ctx` 的 disposer 释放，**不会泄漏监听器**
- 有状态的组件（Dialog 等）宿主已经把 portal 指到你的容器，
  所以**弹层不会逃出你的主题作用域**

**什么时候手写类名**：需要工厂没覆盖的组合时。手写完全没问题 ——
`class: 'tb-btn tb-btn-primary'` 和 `el('button', { variant: 'primary' })`
最终是同一个东西。

### 想知道有哪些 tag？问工厂，别翻源码

```js
const tags = ctx.ui.components();   // → ['accordion', 'alert', 'button', 'card', …]（已排序）
```

返回宿主这一刻真正装上的组件名，也就是 `el(tag, …)` 接受的那一套。
**用它而不是照抄文档里的清单** —— 文档给的是节选，这个方法给的是实况。
拼错的 tag 不会静默失败：`el('cardd', …)` 会在调用处抛「unknown tag」。

---

## `native()` 什么时候用

`el('form')` 拿到的是上游的 Form **组件**（一个校验包装），
它的 submit 事件**不是原生事件**，`ev.preventDefault` 不存在。

需要**真原生元素**时用 `native`：

```js
native('form', { onSubmit: (ev) => { ev.preventDefault(); /* … */ } }, …)
```

**判据**：你要的是浏览器原生行为（表单提交、`FormData`、原生校验）→ 用 `native`。

---

## ⚠️ 组件工厂只在主窗口 —— 插件窗口里**没有** `ctx.ui`

**这是最容易踩空的一处不对称。** 你按本页搭好的界面搬进独立窗口
（`mountWindow(bridge)`）会拿到 `undefined is not a function`，因为
**`bridge` 上根本没有 `ui`** —— 组件工厂、站内 toast、overlay 都不在。

| 你用的 | 主窗口视图 | 插件窗口 | 换成什么 |
|---|---|---|---|
| `ctx.ui.el` / `render` / `native` / `node` | ✅ | ❌ | `.tb-*` 类 + 内联 `style`（或自己注入 `<style>`） |
| `ctx.ui.notify`（toast） | ✅ | ❌ | 自己在界面里画一行状态 |
| `ctx.ui.notifyOS` | ✅ | ❌ | `bridge.request('notify', 'send', { title, body })`（需 `rpc:notify`） |
| `ctx.ui.mountOverlay` | ✅ | ❌ | 不需要 —— 整个窗口都是你的 |

**为什么组件工厂不镜像**：它的观感**全部来自 Tailwind 工具类**，而插件窗口的样式表
**故意不含工具类**（只有令牌 + `.tb-*`）。镜像它等于给每个插件窗口加回 ~122 KB utilities，
或再维护一套裁剪版组件 —— 不值。

**但 `notifyOS` 是另一回事**：OS 通知与 DOM / CSS 毫无关系，它只是被放进了 `ui`
命名空间然后跟着整块被跳过了。替代写法见 [bridge.md](bridge.md) §4。

**结论**：**插件窗口里的富 UI 用 `.tb-*` + 令牌 + 内联布局搭** —— 也就是本页前面
「三件套」那套写法，只是没有工厂可用。好消息是那个窗口整块 DOM 都是你的，
想彻底自绘就注入自己的 `<style>`。

> 完整的 `ctx` / `bridge` 差异矩阵（含 `windows` / `registerView` / `focusView` /
> `onDrop` 的 `info` 差异 / `log` 落点）在 [bridge.md](bridge.md)，那是唯一权威清单。

---

## 插件自己的主题

```json
"theme": {
  "light": { "--color-brand": "#7c3aed" },
  "dark":  { "--color-brand": "#a78bfa" }
}
```

宿主把它作用在**你视图的子树**上（`[data-plugin="<id>"]`）。

- 你**不用写任何代码**来「跟随主题」
- 用组件工厂搭的界面**自动**带上你的主色
- **手写的弹层要自己传 `portalTo`**，否则它 teleport 到 `document.body`，
  出了你的子树 → 「按钮是紫的、弹窗是蓝的」

---

## 主窗口里**不要**注入全局样式

**症状**：装了你的插件之后，宿主自己的按钮尺寸、字体、外边距全变了。

**原因**：插件入口顶层 `import './style.css'`，而那个 CSS 里有针对
`html, body, button, input` 或 `* { box-sizing: … }` 的重置样式。
**你的入口是被宿主主窗口通过 Blob import 加载的** —— 那份 CSS 会作用于**整个主窗口**，
不只是你的视图。

**规矩**：

| 你在哪 | 能做什么 |
|---|---|
| **主窗口视图**（`ctx.registerView`） | 只用 `.tb-*` 类 + `var(--color-*)`。**禁止**任何全局选择器 |
| **独立窗口**（`mountWindow`） | **随便写** —— 那个窗口整块 DOM 都是你的 |

所以样式要分两份：主窗口视图那份只写你自己的类名（带前缀），
完整的那份只在 `mountWindow` 里注入。

**为什么现在只能靠自觉**：外部插件是 Blob URL 单文件 ESM，宿主**没法**给它的样式
加作用域 —— 真正的隔离需要 **shadow DOM**（规划中的 L4）。
在那之前，**主窗口视图里请把选择器都写在自己的类名下**。

## 独立窗口里 `#app` 会挡住你的内容

**症状**：独立窗口一片空白，但审查元素发现节点都在 —— 只是排在**屏幕下方**。

**原因**：`index.html` 里有给**主窗口**用的 `<div id="app">`，而 `app.css` 给它
`height: 100%`。在插件窗口里没人用它，但它**占满整个视口** ——
你 `document.body.appendChild(...)` 的容器就落到它**下面**（Y = 100vh 开始）。

**宿主已经修了**：`pluginwin-host.js` 在调 `mountWindow` 之前会把这个节点移除。
**所以你现在直接 append 到 body 就是对的**，不需要写
`document.body.innerHTML = ''` 这种自保代码。

（如果你在旧版本上遇到，那一行就是解药；新版本上它只是多余。）

## 想要更多自由度？

**现在的路径**：`.tb-*` 常驻 CSS + 内联布局，外部插件拿得到全部观感。
外壳的产物是 170 KB CSS（`dist/assets/main-*.css`，一次实测；gzip 约 26 KB），
其中大部分是组件词汇表 —— **377 个组件导出**，而 `.tb-*` 那部分很小。

> **这个数字不该手抄。** 准确值问运行时：`ctx.ui.components().length`
> （返回已装上的 tag 名，见上文）。文档里这个数字由
> `tests/plugin-docs.test.mjs` 盯着，改了组件就必须同步 ——
> 它以前写的是 376，漂了一个也没人发现。

**自带的 CSS 目前是全局的** —— 裸 `<style>` 会污染整个应用。
要真正自由的方案需要先有 **shadow DOM 隔离**（规划中的 L4），
在那之前**别用裸 `<style>`**，用 `.tb-*` + 内联。

**不要**给插件加 Tailwind 白名单 —— 已评估并否决：构建发生在插件存在**之前**，
白名单只能是固定词汇表，覆盖不了组合空间（颜色 × 明度 × 属性 × 变体 × 断点），
漏掉的类名**静默失效**。论证见 `docs/UI.md`。
