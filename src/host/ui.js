/**
 * The component factory handed to plugins — `ctx.ui.el` / `ctx.ui.render`.
 *
 * ## Why a factory and not a stylesheet
 *
 * An external plugin is a Blob-URL single-file ESM: it cannot `import` anything,
 * so a Vue component library can never reach it. But the host already solved
 * exactly this problem once — `ctx.protocol` hands a plugin the thing it cannot
 * import. This is the same trick applied to components: the host imports them at
 * build time and hands the plugin a way to build them.
 *
 * The payoff over hand-written HTML + `.tb-*` classes is *behaviour*, not looks:
 * a real Select manages keyboard navigation and focus, a real Dialog traps focus
 * and restores it. Those are the parts a plugin author would otherwise skip.
 *
 * ## Why `el()` returns a description, not a node
 *
 * The obvious API — "build me a detached element I can append" — cannot express
 * slot-structured components. `Select` needs its trigger and its content as
 * *distinct* slots; appending child nodes into its root would put the dropdown
 * items inside the trigger button. So `el()` returns a plain descriptor (the
 * same idea as a React element) and `render()` mounts a whole tree at once:
 *
 *     ctx.registerView('notes', (root) => {
 *       const { el, render } = ctx.ui;
 *       render(root, el('card', {}, [
 *         el('card-header', {}, el('card-title', {}, 'Notes')),
 *         el('card-content', {}, el('button', { onClick: save }, 'Save')),
 *       ]));
 *     });
 *
 * ## Portal scoping — the one thing that needs care
 *
 * reka-ui portals (Select's dropdown, Dialog) teleport to `document.body` by
 * default. That is OUTSIDE the plugin's `[data-plugin]` subtree, so
 * `contributes.theme` would style a plugin's button but not its own dropdown —
 * "the button is purple, the menu is blue". `render()` therefore stamps a portal
 * target onto every portalled descriptor in the tree, pointing at the container
 * the plugin rendered into. See `injectPortalTarget`.
 *
 * ## Loading
 *
 * The components are `.vue`/`.ts` files, so they are pulled in through a Vite
 * `import.meta.glob` and loaded once by the lifecycle before any plugin
 * activates. That keeps `el()`/`render()` synchronous, which matters: a plugin
 * builds its DOM inside a synchronous render callback.
 */

import { createApp, h } from 'vue';

/** kebab-case tag -> Vue component. Filled by `loadUiKit()`. */
const components = new Map();

/**
 * Providers every mounted tree is wrapped in.
 *
 * The factory mounts each tree as its OWN Vue app (`createApp(...).mount(...)`),
 * and a new app does **not** inherit the shell's `provide()` tree. So a component
 * that injects a context — `Tooltip` does — fails with
 * `Injection Symbol(TooltipProviderContext) not found`, which says nothing about
 * what the plugin did wrong. Wrapping here means a plugin writes
 * `el('tooltip', …)` and it just works, the same way it does in the shell.
 *
 * Safe to wrap unconditionally: reka-ui's provider components render only their
 * slot, so there is no extra element in the DOM and no layout impact.
 */
const PORTALLED = new Set([
  'select-content',
  'dialog-content',
  'dialog-scroll-content',
  'tooltip-content',
  'popover-content',
  'hover-card-content',
  'dropdown-menu-content',
  'context-menu-content',
  'menubar-content',
  'menubar-sub-content',
  'drawer-content',
  'sheet-content',
  'alert-dialog-content',
  'combobox-list',
]);

/**
 * Providers every mounted tree is wrapped in.
 *
 * The factory mounts each tree as its OWN Vue app (`createApp(...).mount(...)`),
 * and a new app does **not** inherit the shell's `provide()` tree. So a component
 * that injects a context — `Tooltip` does — fails with
 * `Injection Symbol(TooltipProviderContext) not found`, which says nothing about
 * what the plugin did wrong. Wrapping here means a plugin writes
 * `el('tooltip', …)` and it just works, the same way it does in the shell.
 *
 * Safe to wrap unconditionally: reka-ui's provider components render only their
 * slot, so there is no extra element in the DOM and no layout impact.
 */
const ROOT_PROVIDERS = ['tooltip-provider'];

/**
 * The plain HTML elements a plugin may ask for.
 *
 * An allow-list, not a shape test. "Any dash-free lowercase name" would be
 * simpler but silently accepts `el('crad')` and renders an inert element that
 * looks like a missing component — the same silent-failure mode as a typo'd
 * `.tb-*` class. With a list, a miss is a thrown error naming the tag.
 *
 * Document-level elements are deliberately absent. `el('style', {}, '…')` from
 * a plugin in the MAIN window would be a global stylesheet injection, which is
 * exactly what the `contributes.theme` scoping exists to prevent; a plugin's own
 * window is the supported way to ship arbitrary CSS.
 */
const HTML_TAGS = new Set(
  (
    'a abbr address area article aside audio b bdi bdo blockquote br button canvas caption cite code col ' +
    'colgroup data datalist dd del details dfn div dl dt em embed fieldset figcaption figure footer form ' +
    'h1 h2 h3 h4 h5 h6 header hgroup hr i iframe img input ins kbd label legend li main map mark menu meter ' +
    'nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp search section ' +
    'select slot small source span strong sub summary sup table tbody td textarea tfoot th thead time tr track u ul var video wbr'
  ).split(' '),
);

const kebab = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();

/**
 * A Vue component export, as opposed to a helper like `buttonVariants`.
 *
 * "Starts with a capital and is an object" is not enough: `form/index.ts`
 * re-exports reka-ui's `FORM_ITEM_INJECTION_KEY`, which is an object and starts
 * with a capital, so it became the tag `form_item_injection_key` in the
 * vocabulary. PascalCase with no underscores excludes that class of constant.
 */
const looksLikeComponent = (name, value) =>
  /^[A-Z][A-Za-z0-9]*$/.test(name) && value !== null && typeof value === 'object';

/**
 * Load every installed component once.
 *
 * Called by the lifecycle before a plugin activates, so `el()` can stay
 * synchronous — a plugin builds its DOM inside a synchronous render callback,
 * and making that async to satisfy an import would be a bad trade.
 */
export async function loadUiKit() {
  if (components.size) return components;
  // Dynamic, and from a module that contains nothing but the `import.meta.glob`
  // call: Node has no such macro, so a static import here would break every test
  // that touches ctx.js. This function is only ever called from the app.
  const { componentModules } = await import('./uiComponents.js');

  // Loaded in PARALLEL, not one at a time.
  //
  // This used to be `for (… ) await load()`, which made the browser fetch every
  // module strictly sequentially — a ~377-deep waterfall. Measured at ~2.1s in
  // dev, and it lands on whichever plugin activates FIRST (`bootPlugins` awaits
  // each plugin in turn), so it looked like that plugin was slow.
  //
  // In parallel the browser pipelines the requests; the same work is bound by
  // the slowest module rather than by their sum.
  //
  // Failures are collected rather than thrown: one component that fails to load
  // must not take the whole vocabulary down, and a missing tag surfaces as
  // `el('tag')` throwing a clear "unknown tag" at the call site anyway.
  const entries = Object.entries(componentModules);
  const loaded = await Promise.allSettled(entries.map(([, load]) => load()));

  const failed = [];
  loaded.forEach((result, i) => {
    if (result.status === 'rejected') {
      failed.push(`${entries[i][0]}: ${result.reason?.message ?? result.reason}`);
      return;
    }
    for (const [name, value] of Object.entries(result.value)) {
      if (looksLikeComponent(name, value)) components.set(kebab(name), value);
    }
  });
  if (failed.length) {
    console.warn(`[ui] ${failed.length}/${entries.length} component module(s) failed to load://n  ${failed.join('\n  ')}`);
  }
  return components;
}

export function uiKitReady() {
  return components.size > 0;
}

/** The vocabulary, for diagnostics and for the audit test. */
export function uiKitVocabulary() {
  return [...components.keys()].sort();
}

/**
 * Describe an element. Returns a descriptor — pass it to `render()` or `node()`.
 *
 * Children may be given as an array, as a single value, or variadically:
 *
 *     el('div', {}, [a, b])      // explicit
 *     el('div', {}, a)           // single child
 *     el('div', {}, a, b)        // variadic
 *
 * The variadic form exists because the singular signature silently DROPPED
 * everything past the third argument, and that is an easy mistake to make when
 * the call looks exactly like Vue's `h`. A silently-dropped child renders as a
 * missing element, which reads as a layout bug rather than a call-site bug.
 *
 * @param {string} tag   kebab-case component name, e.g. 'card-header'
 * @param {object} [props]
 * @param {any} [children] string | number | descriptor | array of those
 */
export function el(tag, props = {}, children = undefined, ...rest) {
  if (typeof tag !== 'string' || !tag) throw new Error('el(tag, props, children): tag is required');
  return { __uiEl: true, tag, props: props ?? {}, children: rest.length ? [children, ...rest] : children };
}

const isDescriptor = (v) => v !== null && typeof v === 'object' && v.__uiEl === true;

/**
 * Describe a PLAIN HTML element, bypassing the component vocabulary.
 *
 * Needed because the vocabulary shadows HTML tag names. Most are harmless —
 * `input`, `button`, `label`, `table` all render the element you expect — but
 * `select` is not: `el('select', …)` is shadcn's Select (reka-ui, a button plus
 * a popover), so its `<option>` children render as loose text. A plugin that
 * needs a REAL `<select>` — typically because it is read back through
 * `FormData`, which only sees native controls — has no other way to say so.
 */
export function nativeEl(tag, props = {}, children = undefined, ...rest) {
  if (typeof tag !== 'string' || !tag) throw new Error('native(tag, props, children): tag is required');
  return {
    __uiEl: true,
    __uiNative: true,
    tag,
    props: props ?? {},
    children: rest.length ? [children, ...rest] : children,
  };
}

/**
 * Point portalled components at the container the plugin rendered into, so the
 * popup stays inside the plugin's `[data-plugin]` scope and keeps its theme.
 * Without this a plugin's dropdown silently falls back to the app's accent.
 */
function injectPortalTarget(node, target) {
  if (!isDescriptor(node)) return node;
  const props = { ...node.props };
  if (PORTALLED.has(node.tag) && props.portalTo === undefined) props.portalTo = target;
  const kids = node.children;
  return {
    ...node,
    props,
    children: Array.isArray(kids)
      ? kids.map((c) => injectPortalTarget(c, target))
      : injectPortalTarget(kids, target),
  };
}

/** Descriptor tree -> Vue VNode. Unknown tags fail loudly rather than rendering nothing. */
function toVNode(node) {
  if (Array.isArray(node)) return node.map((c) => toVNode(c));
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (node === null || node === undefined || node === false || node === true) return null;
  if (!isDescriptor(node)) return node; // an already-built VNode or DOM node

  // `native()` wins even when the tag is also a component name — that is the
  // whole point of it (see `nativeEl`).
  if (!node.__uiNative) {
    const Comp = components.get(node.tag);
    if (Comp) {
      const props = { ...node.props };
      if (node.tag === 'input' && props.value !== undefined) {
        if (props.defaultValue === undefined) props.defaultValue = props.value;
        if (props.modelValue === undefined) props.modelValue = props.value;
        if (!props['onUpdate:modelValue']) {
          const orig = props.oninput || props.onInput;
          if (typeof orig === 'function') {
            props['onUpdate:modelValue'] = (val) => orig({ target: { value: val } });
          }
        }
      }
      // Slot function, so a component that renders its slot lazily still works
      // (and so a portalled child is only built when it actually opens).
      return h(Comp, props, () => toVNode(node.children));
    }
  }

  // Not a component — a plain element, so a plugin can use `div`, `span`,
  // `code`, `pre`… without those being mistaken for components. Checked against
  // a real tag list rather than a shape, so a typo like `crad` is an error
  // instead of an inert element that reads as a missing component.
  if (HTML_TAGS.has(node.tag)) {
    // Children are resolved eagerly here: the slot-function form is a component
    // concept and a plain element would render it as nothing.
    return h(node.tag, node.props, toVNode(node.children));
  }

  // A silent no-op here would look like a layout bug. Naming the tag, and
  // listing what IS available, turns it into a one-line fix.
  throw new Error(
    `unknown tag "${node.tag}": not a component and not an HTML element. ` +
      `Components: ${uiKitVocabulary().join(', ')}`,
  );
}

/**
 * Create the per-plugin factory.
 *
 * @param {object} opts
 * @param {(fn: Function) => void} [opts.track] register a cleanup with the disposer
 */
export function createUiKit({ track } = {}) {
  /**
   * One app per container, so re-rendering a list does not leak.
   *
   * A plugin that redraws a list on every keystroke would otherwise create a
   * Vue app per keystroke, all of them alive and none of them reachable. Keying
   * by container means the previous app is unmounted by the next render.
   */
  const apps = new Map();
  /** Detached trees from `node()`; no container to key on. */
  const detached = new Set();

  function build(tree, container) {
    if (!uiKitReady()) {
      throw new Error('ui kit not loaded — the host must await loadUiKit() before activating plugins');
    }
    const scoped = container ? injectPortalTarget(tree, container) : tree;

    // A fresh app has its own provide tree, so anything the components inject
    // has to be provided here. See ROOT_PROVIDERS.
    const wrap = (node) => {
      let out = node;
      for (const tag of ROOT_PROVIDERS) {
        const Provider = components.get(tag);
        if (!Provider) continue;
        // Capture the CURRENT value. Writing `() => out` here reads the
        // variable, which the next line reassigns to the new VNode — so the
        // slot would return itself and Vue would recurse until the stack blew.
        const inner = out;
        out = h(Provider, {}, () => inner);
      }
      return out;
    };

    const host = document.createElement('div');
    const app = createApp({ render: () => wrap(toVNode(scoped)) });
    app.mount(host);
    return { app, host, node: host.firstElementChild };
  }

  const unmount = (app) => {
    try {
      app.unmount();
    } catch {
      /* already gone */
    }
  };

  const kit = {
    /** The vocabulary, so a plugin can discover what it may use. */
    components: () => uiKitVocabulary(),
    el,
    native: nativeEl,

    /**
     * Render a descriptor tree into a container, replacing what was there.
     *
     * Replace rather than append: "render X into Y" is what a plugin means when
     * it redraws, and it keeps one live app per container.
     */
    render: (container, tree) => {
      if (!container || typeof container.replaceChildren !== 'function') {
        throw new Error('render(container, tree): container must be a DOM element');
      }
      const prev = apps.get(container);
      if (prev) unmount(prev);
      const { app, host, node } = build(tree, container);
      container.replaceChildren(...host.childNodes);
      apps.set(container, app);
      return node;
    },

    /**
     * Build a detached element. No container is known, so a portalled child
     * cannot be theme-scoped — it falls back to `document.body`. Prefer
     * `render()` when the plugin has a view element; use this only for content
     * that is handed to something else (an overlay, a window payload).
     */
    node: (tree) => {
      const { app, node } = build(tree, null);
      detached.add(app);
      return node;
    },

    /** Unmount everything this plugin built. */
    destroy: () => {
      for (const app of apps.values()) unmount(app);
      for (const app of detached) unmount(app);
      apps.clear();
      detached.clear();
    },
  };

  track?.(() => kit.destroy());
  return kit;
}
