import { reactive } from 'vue';

/**
 * Host store — the single reactive source of truth for the shell.
 * The plugin host kernel and the Vue shell communicate only through this.
 */
export const store = reactive({
  booted: false,
  /** @type {Array<{manifest:object, status:string, error:string|null}>} */
  plugins: [],
  /** @type {Array<{viewId:string, pluginId:string, title:string, icon:string, render:Function}>} */
  views: [],
  activeViewId: null,
  /** @type {Array<{id:number, message:string, type:string}>} */
  toasts: [],
  /** DOM element reserved for plugin overlay content (a full-window takeover). */
  overlayEl: null,
  /** Scheme table snapshot, filled at boot for the diagnostics view. */
  schemes: [],
  settings: {
    summonShortcut: 'Ctrl+Alt+T',
    /**
     * Whether the main window's ✕ hides it instead of quitting.
     *
     * On by default: the app has a tray icon, and closing a window that lives in
     * the tray should put it away, not end the session. The tray's "退出" is the
     * real exit, and it is the ONLY one — so if the tray ever fails to appear,
     * this must be turned off or the app cannot be quit from its own UI. The Rust
     * side treats a tray that will not build as fatal for exactly that reason.
     */
    closeToTray: true,
    /**
     * Per-hotkey user state, keyed `<pluginId>:<action>`.
     *
     * A plugin's `contributes.hotkeys` entry is a REQUEST, not a registration:
     * it says "this action would like a shortcut" and nothing more. Nothing
     * reaches the OS until the user turns it on here — a plugin must not be able
     * to take a global shortcut just by shipping.
     *
     *   { 'demo.breaktimer:pause': { key: 'ctrl+alt+p', enabled: false } }
     *
     * `key` is the user's binding, seeded from the plugin's declared default
     * the first time the action is seen. So a rebind survives a plugin update
     * that changes its default, and a plugin's default never silently becomes
     * active.
     */
    hotkeys: {},
    ...JSON.parse(localStorage.getItem('toolbox.settings') || '{}'),
  },
});

export function saveSettings() {
  const { summonShortcut, hotkeys, closeToTray } = store.settings;
  localStorage.setItem('toolbox.settings', JSON.stringify({ summonShortcut, hotkeys, closeToTray }));
}

/**
 * Whether closing the main window should hide it rather than quit.
 *
 * A function, not a direct read, because `ctx.js` needs the same answer and the
 * two must not drift — and because the settings object is spread over defaults
 * at import time, so a stored `false` has to win over the default `true`.
 */
export function closeToTray() {
  return store.settings.closeToTray !== false;
}

/* ---------------------------------------------------------------------------
 * Display order
 *
 * Built-ins first, then external, then alphabetical within each group.
 *
 * Applied to the arrays the shell RENDERS FROM, not at render time, so every
 * consumer reads one sequence: the sidebar, the Settings table, and the "which
 * view do I fall back to when the current one disappears" choice. Sorting
 * independently in each of those is exactly how they end up disagreeing.
 *
 * The key is the display NAME, compared case-insensitively. It is the string
 * the user is actually reading; ordering by the raw id would produce a sequence
 * nobody can predict from the screen (`builtin.procman` before `calc.demo` is
 * not "alphabetical" to anyone looking at "Processes" and "Calculator").
 * ------------------------------------------------------------------------- */

/** `[isExternal, name]` — the comparable shape for both arrays. */
function orderKey(entry) {
  return [entry.builtin ? 0 : 1, String(entry.name ?? entry.title ?? '')];
}

function compareOrder(a, b) {
  const [ab, an] = orderKey(a);
  const [bb, bn] = orderKey(b);
  if (ab !== bb) return ab - bb;
  return an.localeCompare(bn, undefined, { sensitivity: 'base' });
}

/** Re-sort the plugin rows. Call after adding or removing one. */
export function sortPluginList() {
  const key = (p) => ({ builtin: p.manifest.builtin, name: p.manifest.name });
  store.plugins.sort((a, b) => compareOrder(key(a), key(b)));
}

/** Re-sort the view list. Call after adding or removing views. */
export function sortViewList() {
  store.views.sort(compareOrder);
}

let toastSeq = 0;

/**
 * Where `toast()` delivers to.
 *
 * The store is imported by tests that run under plain Node with no DOM, so it
 * must not drag a renderer in. Presentation belongs to the shell, so the shell
 * installs a sink (the shadcn/sonner toaster) and the default sink keeps a
 * queue in `store.toasts` — which is what a headless run can assert against.
 */
let toastSink = null;

/** Install the shell's renderer. Returns the previous sink, for tests. */
export function setToastSink(fn) {
  const prev = toastSink;
  toastSink = fn;
  return prev;
}

export function toast(message, type = 'info', timeout = 3500) {
  const entry = { id: ++toastSeq, message, type, timeout };
  if (toastSink) {
    toastSink(entry);
    return entry.id;
  }
  // Headless default: a self-expiring queue, so a plugin's notify() still has
  // an observable effect without a browser.
  store.toasts.push(entry);
  setTimeout(() => {
    const i = store.toasts.findIndex((t) => t.id === entry.id);
    if (i >= 0) store.toasts.splice(i, 1);
  }, timeout);
  return entry.id;
}
