# gallery.demo — every component `ctx.ui` offers

A drop-in plugin that renders the whole component vocabulary in the main window.
Copy this folder into the app's plugins directory and click **Rescan**.

```
%APPDATA%\com.tan18.toolbox\plugins\gallery.demo\
```

## What it demonstrates

| | |
|---|---|
| **`permissions: []`** | The component factory is **not** gated. It builds DOM and touches nothing native, so a plugin can render a full interface with zero capabilities. The permission list says what a plugin can *do*, not how much it can *show*. |
| **No imports** | This is a Blob-URL single-file ESM. It cannot `import` anything — every component below arrives through `ctx.ui`, the same way `ctx.protocol` delivers the wire contract. |
| **The whole vocabulary** | The badge list at the bottom is generated from `ctx.ui.components()`, so it always matches what is actually installed. |

## The API in one screen

```js
const { el, render } = ctx.ui;

ctx.registerView('gallery', (root) => {
  render(root, el('card', {}, [
    el('card-header', {}, el('card-title', {}, 'Hello')),
    el('card-content', {}, el('button', { variant: 'default' }, 'Save')),
  ]));
});
```

- **`el(tag, props, children)`** returns a *description*, not a node. Children may
  be an array, a single value, or variadic.
- **`render(container, tree)`** mounts the tree, **replacing** what was there —
  so redrawing a list is just calling it again.
- **`native(tag, props, children)`** asks for a plain HTML element even when the
  tag is also a component name. Needed for `<select>`, because
  `el('select')` is shadcn's Select (a button plus a popover) and `FormData`
  would not see it.
- **`components()`** returns the vocabulary, so a plugin can discover what it may
  use instead of guessing.
- Tag names are the component names in kebab-case: `CardHeader` → `card-header`,
  `NumberFieldIncrement` → `number-field-increment`. An unknown tag **throws**,
  naming the tag and listing what is available.

## What is not here

A few registry components need a controller or real data to be meaningful, and
this plugin renders the simplest working form of each rather than a full demo:

- `chart` — needs a series and axis config (`@unovis/vue`, ~123 KB, lazily loaded)
- `carousel` — needs `embla-carousel-vue`
- `form` / `field` — needs `vee-validate` + `zod`
- `sidebar` — expects to own the window's layout
- `resizable`, `scroll-area` — rendered, but their whole point is interaction

They are all installed and available through `ctx.ui`; they simply need more
setup than a one-line gallery entry.

## One thing that looks broken and is not

`native-select` renders a **real `<select>`**, and its open dropdown is drawn by
the operating system *outside the document* — opening it adds **zero nodes to the
DOM** (measured: 1614 → 1614). No CSS can reach it, so it cannot be themed. That
is a platform limit, not a gap in the styling.

Its **closed** state is fully styled (border, radius, custom chevron), because
that part *is* an element.

Use it only when something reads the form back with `FormData` — reka-ui's
`Select` is a button plus a popover, so `FormData` never sees it. When you just
want a dropdown that follows the theme, use `select`, whose popup is a real DOM
element and therefore fully themeable.

## Sizing note

Pulling the full registry means Tailwind emits the classes for **all** of them,
whether or not a plugin uses them: the stylesheet went from ~28 KB to ~164 KB raw
(6 KB → 26 KB gzipped). The JavaScript is code-split per component, so only what a
view actually renders is fetched. If the CSS weight matters more than the
breadth, `scripts/shadcn-pull.mjs` takes an explicit component list — pulling a
narrower set is one command.
