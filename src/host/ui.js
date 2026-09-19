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

/** Descriptors carrying one of these tags get a portal target injected. */
const PORTALLED = new Set([
  'select-content',
  'dialog-content',
  'dropdown-menu-content',
  'popover-content',
  'tooltip-content',
]);

const kebab = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();

/** A Vue component export, as opposed to a helper like `buttonVariants`. */
const looksLikeComponent = (name, value) =>
  /^[A-Z]/.test(name) && value !== null && typeof value === 'object';

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
  for (const [path, load] of Object.entries(componentModules)) {
    const mod = await load();
    for (const [name, value] of Object.entries(mod)) {
      if (looksLikeComponent(name, value)) components.set(kebab(name), value);
    }
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
 * @param {string} tag   kebab-case component name, e.g. 'card-header'
 * @param {object} [props]
 * @param {any} [children] string | number | descriptor | array of those
 */
export function el(tag, props = {}, children = undefined) {
  if (typeof tag !== 'string' || !tag) throw new Error('el(tag, props, children): tag is required');
  return { __uiEl: true, tag, props: props ?? {}, children };
}

const isDescriptor = (v) => v !== null && typeof v === 'object' && v.__uiEl === true;

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

  const Comp = components.get(node.tag);
  if (Comp) {
    // Slot function, so a component that renders its slot lazily still works
    // (and so a portalled child is only built when it actually opens).
    return h(Comp, node.props, () => toVNode(node.children));
  }

  // Not a component — fall through to a plain element, so a plugin can use
  // `div`, `span`, `code`, `pre`… without those being mistaken for components.
  // Restricted to dash-free lowercase names: every component tag with a dash
  // (card-header, select-item) is in the vocabulary, so a dashed miss is a typo
  // and should say so rather than silently render an unknown element.
  if (/^[a-z][a-z0-9]*$/.test(node.tag)) {
    // Children are resolved eagerly here: the slot-function form is a component
    // concept and a plain element would render it as nothing.
    return h(node.tag, node.props, toVNode(node.children));
  }

  // A silent no-op here would look like a layout bug. Naming the tag, and
  // listing what IS available, turns it into a one-line fix.
  throw new Error(`unknown component "${node.tag}". Available: ${uiKitVocabulary().join(', ')}`);
}

/**
 * Create the per-plugin factory.
 *
 * @param {object} opts
 * @param {(fn: Function) => void} [opts.track] register a cleanup with the disposer
 */
export function createUiKit({ track } = {}) {
  /** Every mounted Vue app, so deactivate can unmount them all. */
  const apps = new Set();

  function build(tree, container) {
    if (!uiKitReady()) {
      throw new Error('ui kit not loaded — the host must await loadUiKit() before activating plugins');
    }
    const scoped = container ? injectPortalTarget(tree, container) : tree;
    const host = document.createElement('div');
    const app = createApp({ render: () => toVNode(scoped) });
    app.mount(host);
    apps.add(app);
    return { app, host, node: host.firstElementChild };
  }

  const kit = {
    /** The vocabulary, so a plugin can discover what it may use. */
    components: () => uiKitVocabulary(),
    el,

    /** Mount a descriptor tree into a container (the plugin's view element). */
    render: (container, tree) => {
      if (!container || typeof container.appendChild !== 'function') {
        throw new Error('render(container, tree): container must be a DOM element');
      }
      const { host, node } = build(tree, container);
      container.append(...host.childNodes);
      return node;
    },

    /** Replace a container's contents with a tree. */
    replace: (container, tree) => {
      if (!container || typeof container.replaceChildren !== 'function') {
        throw new Error('replace(container, tree): container must be a DOM element');
      }
      const { host, node } = build(tree, container);
      container.replaceChildren(...host.childNodes);
      return node;
    },

    /**
     * Build a detached element. No container is known, so a portalled child
     * cannot be theme-scoped — it falls back to `document.body`. Prefer
     * `render()` when the plugin has a view element; use this only for content
     * that is handed to something else (a toast body, a window payload).
     */
    node: (tree) => build(tree, null).node,

    /** Unmount everything this plugin built. */
    destroy: () => {
      for (const app of apps) {
        try {
          app.unmount();
        } catch {
          /* already gone */
        }
      }
      apps.clear();
    },
  };

  track?.(() => kit.destroy());
  return kit;
}
