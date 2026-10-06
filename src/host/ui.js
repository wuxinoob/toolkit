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
 * Components that render their popup through a Teleport.
 *
 * A Teleport with no target goes to `document.body` — which is OUTSIDE the
 * plugin's `[data-plugin]` scope, so a plugin's dropdown opens themed by the
 * SHELL ("the trigger is purple, the popup is blue"). `injectPortalTarget`
 * points these at the container the plugin rendered into instead.
 *
 * The names are reka-ui's: the `*-content` part is the portalled one.
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
    console.warn(`[ui] ${failed.length}/${entries.length} component module(s) failed to load:\n  ${failed.join('\n  ')}`);
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

/**
 * The two form vocabularies, and the translation between them.
 *
 * A plugin writes a form the way it writes HTML — `value`, `checked`,
 * `oninput` — but the components only speak Vue: `defaultValue` /
 * `modelValue` / `onUpdate:modelValue`. This is the seam. `tag -> the native
 * key a plugin is likely to write`; the rest is mechanical (see below).
 *
 * Exported so `tests/ui-form-props.test.mjs` can drive the WHOLE table rather
 * than a hand-copied list of tags that goes stale the moment one is added.
 */
export const FORM_PROP_RULES = Object.freeze({
  input: 'value',
  textarea: 'value',
  'number-field': 'value',
  select: 'value',
  slider: 'value',
  'radio-group': 'value',
  'toggle-group': 'value',
  'tags-input': 'value',
  checkbox: 'checked',
  switch: 'checked',
});

/** The native spellings of "the value changed", in the order we prefer them. */
const NATIVE_CHANGE_EVENTS = ['oninput', 'onInput', 'onchange', 'onChange'];

/**
 * Controls that render a real `<input>` / `<textarea>`.
 *
 * For these the native listener is attached to the element itself, so it fires
 * with the REAL event — `preventDefault`, `selectionStart`, `e.target.files`
 * and all. Bridging those onto `onUpdate:modelValue` would replace a real event
 * with `{ target: { value } }` and call the plugin twice per keystroke. So: text
 * controls keep their native handler; everything else (a reka root renders a
 * button or a div, where no native `input`/`change` ever arrives) gets bridged.
 */
const NATIVE_EVENT_TAGS = new Set(['input', 'textarea', 'number-field']);

/**
 * Translate a plugin's native-style props into what the component actually
 * declares. Returns `props` untouched for tags that are not form controls.
 *
 * ## Why the native key is DELETED, not merely shadowed
 *
 * `value` is a real DOM property of `<input>`, and `Input.vue` does not declare
 * it — so Vue passes it through as a fallthrough attr onto the root element.
 * Every time the component re-renders (its internal `v-model` proxy changes on
 * each keystroke) that attr is written back to the DOM, wiping what the user
 * just typed.
 *
 * Measured in the dev probe (`ui-probe.html`, real components, headless Edge):
 * with `value` left in place the box read `""` 5ms after a keystroke while the
 * plugin's own state was already `"a"`. The DATA was right and only the DISPLAY
 * rolled back — which is exactly what makes this bug read as "the plugin can't
 * receive input" when it is really receiving everything. Deleting the key after
 * translating it is the fix; `tests/ui-form-props.test.mjs` pins it.
 *
 * ## What is deliberately NOT translated
 *
 * - `el('input', { type: 'checkbox' | 'radio' })` asks for the NATIVE control
 *   (see `nativeEl`): its `value`/`checked` are real attributes, so nothing is
 *   touched. Use `el('checkbox')` / `el('switch')` for the components.
 * - `value` on `checkbox`/`switch` is a LEGITIMATE reka prop (the value
 *   submitted with a form), so only `checked` is translated there.
 */
export function normalizeFormProps(tag, props) {
  const nativeKey = FORM_PROP_RULES[tag];
  if (!nativeKey) return props;
  if (tag === 'input' && (props.type === 'checkbox' || props.type === 'radio')) return props;

  const out = { ...props };
  const native = out[nativeKey];
  if (native !== undefined) {
    if (out.defaultValue === undefined) out.defaultValue = native;
    if (out.modelValue === undefined) out.modelValue = native;
    delete out[nativeKey];
  }

  const bridged = out['onUpdate:modelValue'];
  if (typeof bridged !== 'function' && !NATIVE_EVENT_TAGS.has(tag)) {
    const orig = NATIVE_CHANGE_EVENTS.map((k) => out[k]).find((h) => typeof h === 'function');
    if (orig) {
      // `checked` as well as `value`: the same bridge serves the boolean
      // controls, and a handler that reads the wrong one would silently
      // compute `undefined`.
      out['onUpdate:modelValue'] = (val) => orig({ target: { value: val, checked: val } });
    }
  }
  // One delivery, not two: a non-text control has no native event worth
  // keeping (its root is a button/div), and leaving the native handler on the
  // vnode would also leak it into the DOM as a stray attribute.
  if (!NATIVE_EVENT_TAGS.has(tag)) {
    for (const k of NATIVE_CHANGE_EVENTS) delete out[k];
  }
  return out;
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
      const props = normalizeFormProps(node.tag, node.props);
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
   * One app per container, and the app is REUSED across renders.
   *
   * The first version unmounted and rebuilt the app on every `render()`, then
   * moved the fresh nodes in with `replaceChildren`. That is what made a plugin
   * that redraws on each keystroke lose the caret: every render threw the
   * `<input>` away and made a new one. Keeping the app (and therefore the DOM
   * nodes) alive and patching the tree in place is the whole point — see
   * `set()` for the one subtlety that made this non-obvious.
   */
  const apps = new Map();
  /** Detached trees from `node()`; no container to key on. */
  const detached = new Set();

  /**
   * Release the apps whose container has left the document.
   *
   * `ViewHost` hands a plugin a NEW element every time the user switches views
   * (it is `:key`ed on `viewId` on purpose — see ViewHost.vue: a stale
   * reference must not write into another plugin's container). Reusing apps
   * makes that discarded element cost something: its app stays mounted, with
   * its component instances, watchers and portal targets, until the plugin
   * deactivates. This sweep is the release.
   *
   * Only containers we have SEEN connected are eligible. A plugin may
   * `render()` into an element it has not attached yet and attach it later;
   * such an element is never pruned out from under it.
   */
  function pruneDisconnected() {
    for (const [container, entry] of apps) {
      if (!entry.connected || container.isConnected) continue;
      unmount(entry.app);
      apps.delete(container);
    }
  }

  function mount(tree, container) {
    if (!uiKitReady()) {
      throw new Error('ui kit not loaded — the host must await loadUiKit() before activating plugins');
    }
    /**
     * The tree this app currently shows.
     *
     * A closure variable rather than a `ref`, deliberately: see `set()`.
     */
    let current = tree;

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
    const app = createApp({
      render: () => wrap(toVNode(container ? injectPortalTarget(current, container) : current)),
    });
    app.mount(host);
    return {
      app,
      host,
      node: host.firstElementChild,
      /**
       * Swap the tree and patch — **synchronously**.
       *
       * `render()` has always been synchronous and plugins depend on that:
       * `procman` renders and then reads its own container on the next line
       * (`renderProfiles(root); renderDetail();` → `document.querySelector('.pm-term-area')`).
       * A `shallowRef` would defer the patch to the next microtask and those
       * call sites would see an empty container.
       *
       * So the update goes through the component instance's effect runner,
       * which is the same function the scheduler would have called. That runner
       * is technically internal API: if a future Vue drops it, `set()` returns
       * false and `render()` falls back to the old unmount + rebuild, which is
       * always correct — just slower, and it loses focus again.
       */
      set(next) {
        current = next;
        const update = app._instance?.update;
        if (typeof update !== 'function') return false;
        update();
        return true;
      },
    };
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
      pruneDisconnected();
      const entry = apps.get(container);
      // The common case: patch the existing tree. Same nodes, same focus,
      // same caret, same scroll, same component state.
      if (entry) {
        entry.connected = entry.connected || container.isConnected;
        if (entry.set(tree)) return container.firstElementChild;
      }
      if (entry) unmount(entry.app);
      const fresh = mount(tree, container);
      fresh.connected = container.isConnected;
      container.replaceChildren(...fresh.host.childNodes);
      apps.set(container, fresh);
      return container.firstElementChild;
    },

    /**
     * Build a detached element. No container is known, so a portalled child
     * cannot be theme-scoped — it falls back to `document.body`. Prefer
     * `render()` when the plugin has a view element; use this only for content
     * that is handed to something else (an overlay, a window payload).
     */
    node: (tree) => {
      const entry = mount(tree, null);
      detached.add(entry.app);
      return entry.node;
    },

    /** Unmount everything this plugin built. */
    destroy: () => {
      for (const entry of apps.values()) unmount(entry.app);
      for (const app of detached) unmount(app);
      apps.clear();
      detached.clear();
    },
  };

  track?.(() => kit.destroy());
  return kit;
}
