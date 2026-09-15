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
    ...JSON.parse(localStorage.getItem('toolbox.settings') || '{}'),
  },
});

export function saveSettings() {
  const { summonShortcut } = store.settings;
  localStorage.setItem('toolbox.settings', JSON.stringify({ summonShortcut }));
}

let toastSeq = 0;
export function toast(message, type = 'info', timeout = 3500) {
  const id = ++toastSeq;
  store.toasts.push({ id, message, type });
  setTimeout(() => {
    const i = store.toasts.findIndex((t) => t.id === id);
    if (i >= 0) store.toasts.splice(i, 1);
  }, timeout);
}
