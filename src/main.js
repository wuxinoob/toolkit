import { createApp } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
// One stylesheet for every window: the design tokens and the `.tb-*` primitives
// are global on purpose — external plugins (Blob-URL ESM) cannot import a
// component library, but they CAN use these classes.
import './assets/app.css';
import { boot } from './host/boot.js';
import { initTheme } from './host/theme.js';

// Before anything renders, in EVERY window: the theme is one attribute on <html>
// and a plugin window is as entitled to it as the main one. index.html sets it
// even earlier (inline, pre-paint) to avoid a flash; this is the authoritative
// read, and it also wires the OS listener and the cross-window one.
initTheme();

/**
 * Which window am I? — decided by the window's own LABEL.
 *
 * This used to be decided by a `?mode=` query parameter:
 *
 *   if (mode === 'pluginwin')  -> plugin-window host
 *   else                       -> boot the whole plugin host
 *
 * and that `else` was a loaded gun. A plugin window opened with a bare
 * `index.html`, or with a stale `?mode=floatwin`, or with any typo, fell into it
 * and booted a SECOND host inside a plugin window. The blast radius is not
 * cosmetic:
 *
 *   - `bootPlugins()` activates every built-in again, and `procman`
 *     AUTO-STARTS its profiles — a second set of real subprocesses. Its guard
 *     (`runningFor(p.id)`) reads per-window module state, so nothing dedupes
 *     them across windows.
 *   - `scanExternalPlugins()` loads and activates every drop-in plugin again, so
 *     its timers, sidecars and subscriptions exist twice.
 *   - `applySummonShortcut()` registers the summon hotkey a second time, and the
 *     plugin window's own `hotkey:summon` subscription calls
 *     `getCurrentWindow()` — so the summon key also raises the plugin window.
 *   - a second boot report and selftest land in `debug.log`.
 *   - the window renders the app SHELL instead of the plugin's UI, and the
 *     plugin's `mountWindow(bridge)` is never called — so the window is useless
 *     to the plugin that asked for it.
 *
 * The one truly dangerous step, `plugin_reap_orphans()` (it kills every live
 * session), was already blocked: it is `require_main`-gated and the window is
 * not `main`. Everything else went through.
 *
 * So the branch is now on IDENTITY, not on a parameter a caller can get wrong.
 * `main` is the label `tauri.conf.json`'s window gets by default, and it is the
 * same discriminator the Rust side uses (`require_main`), so the two agree by
 * construction. Every other window goes to the plugin-window host, which either
 * mounts the plugin or renders an inline error naming the missing query
 * parameter — so the worst case is a readable message IN the window rather than
 * a silent second application.
 */
function windowLabel() {
  try {
    return getCurrentWindow().label;
  } catch {
    return null; // no Tauri (plain browser, `node --test`)
  }
}

const label = windowLabel();
// Without Tauri there is no label to read, and no second host to collide with,
// so the query parameter is still the answer — that keeps a browser dev server
// rendering whichever page it was asked for.
const isPluginWindow =
  label === null
    ? new URLSearchParams(window.location.search).get('mode') === 'pluginwin'
    : label !== 'main';

if (isPluginWindow) {
  // `?mode=pluginwin&plugin=<id>&label=<label>` — the host page reads the rest.
  import('./host/pluginwin-host.js').then((m) => m.mountPluginWindow());
} else {
  // The shell is imported HERE, not at the top of the file, and the difference
  // is not tidiness. A static import is fetched, parsed and EVALUATED by every
  // window, and a plugin window never mounts the shell — but it was paying for
  // the whole graph anyway: measured on this repo, `App.vue` pulls in ~615 KB of
  // JS (the shell, ViewHost, SettingsView, the entire `components/ui/` set, the
  // toaster, the tooltips) plus 166 KB of CSS. That is the bulk of what a plugin
  // window costs to open, for code it will never run.
  //
  // A dynamic import keeps the module out of the graph a plugin window walks, so
  // the cost lands on the one window that actually needs it. (It is the same
  // reason `pluginwin-host.js` was already dynamic — this was just the half that
  // got missed.)
  const { default: App } = await import('./App.vue');
  const app = createApp(App);
  app.mount('#app');

  // The window is created hidden (`visible: false` in tauri.conf.json) so nobody
  // ever sees an unpainted frame. Reveal it once a frame has actually been
  // painted — showing right after `mount()` still races the compositor, because
  // mount() returns before the browser has drawn anything.
  //
  // This matters most on a FIRST run, where WebView2 has no GPU/shader/code
  // caches yet and takes seconds to come up; a warm profile hides the problem,
  // which is exactly why it is worth fixing rather than tolerating.
  //
  // A failure here must not be silent, and must not be fatal: the native side
  // shows the window anyway after a few seconds (see `lib.rs`), so a frontend
  // that never gets this far still leaves a usable window.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      getCurrentWindow()
        .show()
        .catch((e) => console.error('[shell] could not show the window', e));
    });
  });

  boot();
}
