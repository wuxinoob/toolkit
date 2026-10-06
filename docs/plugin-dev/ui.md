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

### 表单控件：两种写法，同一套语义

组件的 prop 是 Vue 的（`defaultValue` / `modelValue` / `onUpdate:modelValue`），
但你也可以照 HTML 写，工厂会翻译：

```js
el('input',    { value: name, onInput: (e) => { name = e.target.value; } });
el('checkbox', { checked: on, onchange: (e) => { on = e.target.checked; } });
```

| 组件 | 你写的（原生） | 翻译成 | 事件怎么送到你手上 |
|---|---|---|---|
| `input` `textarea` `number-field` | `value` | `defaultValue` + `modelValue` | 监听器就在真 `<input>` 上，收到的是**真事件** |
| `checkbox` `switch` | `checked` | `defaultValue` + `modelValue` | 桥成 `onUpdate:modelValue`（这两个的原生事件根本不会触发） |
| `select` `slider` `radio-group` `toggle-group` `tags-input` | `value` | 同上 | 同上 |

**三条要知道的**：

1. **它是受控的**：框里的值 = 你这次渲染写进去的值。处理完事件要**改状态并重渲染**，
   否则外观不会跟着变（`checkbox` / `switch` 上尤其明显，看起来"点不动"）。
2. **原生键会被消费掉**，不会落到 DOM 上。这不是洁癖：`value` 落到真实 `<input>` 上，
   每次重渲染都会把上一次渲染的值写回去 —— 症状是**输入字符回退**，
   而插件状态其实一直是**对的**（数据没错，只是显示回滚了）。
   规则与守卫见 `tests/ui-form-props.test.mjs`。
3. **`switch` / `checkbox` 自己的 `value` 不是原生写法**，那是"随表单提交的值"，
   别拿它当输入值传。要**真原生元素**（`FormData`、原生校验）用 `native('input', …)`；
   `el('input', { type: 'checkbox' })` 也走原生，不做翻译。

### `render()` 是**就地更新**，可以放心在按键里重渲染整页

`render(container, tree)` 把新描述树 patch 到原地：同一个 `<input>` 节点会被**复用**，
所以焦点、光标、中文合成态、滚动位置、组件内部状态（下拉是否展开、终端实例）都保留，
组件实例不会重建。

```js
el('input', {
  value: q,
  onInput: (e) => { q = e.target.value; render(root, view()); },  // 整树重渲染，安全
});
```

两条随之而来的规矩：

1. **列表要带 `key`。** 没有 key 时 Vue 按位置复用节点：删掉中间一行，下面那行会
   "继承"上一行的 DOM（用户在里面打的字、展开的下拉都跟着挪过去）。给一个稳定 id 就行：
   `el('input', { key: row.id, value: row.text, onInput: … })`。
2. **`defaultValue` 只是初始值。** 用户改过之后，再传新的 `defaultValue` 不会刷新它。
   要"值跟着我的状态走"就写 `value`（原生写法）或 `modelValue` —— 两者每次渲染都会同步。

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

## ⚠️ 插件窗口里**什么样式都没有** —— 没有 `ctx.ui`，也没有 `.tb-*`

**这是最容易踩空的一处不对称**，而且是两层的：

1. **`bridge` 上没有 `ui`** —— 组件工厂、站内 toast、overlay 都不在，调它会拿到
   `undefined is not a function`；
2. **那个窗口不引任何样式表** —— `pluginwin.html` 页面**零 CSS**，所以
   **令牌、`.tb-*`、Tailwind 工具类、reset 全都没有**。整个 document 的样式都是你的责任。

| 你用的 | 主窗口视图 | 插件窗口 | 换成什么 |
|---|---|---|---|
| `ctx.ui.el` / `render` / `native` / `node` | ✅ | ❌ | 自己写 DOM + 自己的 `<style>` |
| `.tb-*` 类 + `var(--color-*)` 令牌 | ✅ | ❌ | 自己的类名 + 自己的变量 |
| `ctx.ui.notify`（toast） | ✅ | ❌ | 自己在界面里画一行状态 |
| `ctx.ui.notifyOS` | ✅ | ❌ | `bridge.request('notify', 'send', { title, body })`（需 `rpc:notify`） |
| `ctx.ui.mountOverlay` | ✅ | ❌ | 不需要 —— 整个窗口都是你的 |

**自己动手时别忘的三件事**（它们的缺席是静默的）：

```css
* { box-sizing: border-box; }            /* 否则 width:100% + padding 溢出 */
html, body { margin: 0; }                /* 否则恢复浏览器那 8px */
:focus-visible { outline: 2px solid …; } /* 否则键盘用户看不见焦点 */
```

**唯一保留下来的一处**是 `color-scheme`（内联主题脚本设的一个属性），它决定
**操作系统画的那部分**（滚动条、`<select>` 下拉、日期选择器）跟随主题 —— 那些东西
CSS 碰不到。**你自己的正文配色仍然要自己写。**

### 但你不必手写两套配色：`contributes.theme` 仍然属于你

窗口零 CSS，**但你声明的主题变量照旧会被注入** —— 那是**你自己的声明**，不是宿主的样式：

```json
// plugin.json
"contributes": {
  "theme": { "light": { "--pill-bg": "#fff" }, "dark": { "--pill-bg": "#23262e" } }
}
```

宿主把它写成 `:root[data-theme='dark'] [data-plugin='<你的 id>']{…}`，而这个选择器
**也匹配 `<html>`** —— 整个窗口都是你这个插件的域。所以在自己的 `<style>` 里直接：

```css
.pill { background: var(--pill-bg); }
```

**这就是零 CSS 窗口里拿到「跟随明暗主题的变量」的正路** —— 不用自己监听主题变化，
也不用写两份配色；`data-theme` 由内联主题脚本在首帧前设好。

**为什么组件工厂不镜像**：它的观感**全部来自 Tailwind 工具类**，而插件窗口连样式表都没有。
镜像它等于给每个插件窗口加回 ~122 KB utilities，或再维护一套裁剪版组件 —— 不值。
（历史上那个窗口引过一份 19 KB 的 `plugin.css`：令牌 + `.tb-*` + preflight。
它被删掉是因为**它的 preflight 落在无层**，反过来压过与它同船交付的 `.tb-*`；
而且仓库里两个真实的插件窗口都自带 reset 与配色，没人需要它。）

**`notifyOS` 是另一回事**：OS 通知与 DOM / CSS 毫无关系，它只是被放进了 `ui`
命名空间然后跟着整块被跳过了。替代写法见 [bridge.md](bridge.md) §4。

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
