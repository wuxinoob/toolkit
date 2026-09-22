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

## 想要更多自由度？

**现在的路径**：`.tb-*` 常驻 CSS + 内联布局。产物 164K / **26KB gzip**
（`dist/assets/index-*.css`，实测）。其中大部分是拉进来的 376 个组件词汇表，
`.tb-*` 那部分很小。
且外部插件拿得到全部观感。

**自带的 CSS 目前是全局的** —— 裸 `<style>` 会污染整个应用。
要真正自由的方案需要先有 **shadow DOM 隔离**（规划中的 L4），
在那之前**别用裸 `<style>`**，用 `.tb-*` + 内联。

**不要**给插件加 Tailwind 白名单 —— 已评估并否决：构建发生在插件存在**之前**，
白名单只能是固定词汇表，覆盖不了组合空间（颜色 × 明度 × 属性 × 变体 × 断点），
漏掉的类名**静默失效**。论证见 `docs/UI.md`。
