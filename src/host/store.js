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
  /** DOM element reserved for plugin overlay content (eyecare break screen). */
  overlayEl: null,
  /** Scheme table snapshot, filled at boot for the diagnostics view. */
  schemes: [],
  settings: {
    summonShortcut: 'Ctrl+Alt+T',
    /**
     * Per-hotkey user state, keyed `<pluginId>:<action>`.
     *
     * A plugin's `contributes.hotkeys` entry is a REQUEST, not a registration:
     * it says "this action would like a shortcut" and nothing more. Nothing
     * reaches the OS until the user turns it on here — a plugin must not be able
     * to take a global shortcut just by shipping.
     *
     *   { 'builtin.eyecare:pause': { key: 'ctrl+alt+p', enabled: false } }
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
  const { summonShortcut, hotkeys } = store.settings;
  localStorage.setItem('toolbox.settings', JSON.stringify({ summonShortcut, hotkeys }));
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
