import { createApp } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
// The MAIN window's stylesheet. A plugin window links `plugin.css` instead — see
// the note at the top of `assets/app.css` for why that split exists and what it
// saves.
import './assets/app.css';
import { boot } from './host/boot.js';
import { initTheme } from './host/theme.js';

// Before anything renders: the theme is one attribute on <html>. index.html sets
// it even earlier (inline, pre-paint) to avoid a flash; this is the authoritative
// read, and it also wires the OS listener and the cross-window one.
initTheme();

/**
 * This entry belongs to the MAIN window, and it says so.
 *
 * It used to be a SHARED entry that decided what to render from a `?mode=`
 * parameter, with an `else` arm that booted the whole plugin host — so a plugin
 * window opened with a bare `index.html`, or with a stale `?mode=floatwin`, or
 * with any typo, booted a SECOND host inside itself. The blast radius was not
 * cosmetic:
 *
 *   - `bootPlugins()` activates every built-in again, and `procman` AUTO-STARTS
 *     its profiles — a second set of real subprocesses, and `runningFor()` reads
 *     per-window module state so nothing dedupes them across windows.
 *   - `scanExternalPlugins()` activates every drop-in plugin a second time, so
 *     its timers, sidecars and subscriptions exist twice.
 *   - `applySummonShortcut()` registers the summon hotkey again, and the plugin
 *     window's own `hotkey:summon` subscription calls `getCurrentWindow()` — so
 *     the summon key also raises the plugin window.
 *   - a second boot report and selftest land in `debug.log`.
 *   - the window renders the app SHELL instead of the plugin's UI, and the
 *     plugin's `mountWindow(bridge)` is never called.
 *
 * (The one truly dangerous step, `plugin_reap_orphans()` — it kills every live
 * session — was already blocked by its `require_main` gate.)
 *
 * A plugin window now has its own PAGE: `pluginwin.html` → `src/pluginwin.js`.
 * It never loads this file at all, which is the real fix — and it is also what
 * made the stylesheet split possible, because a page picks its `<link>` before
 * any module runs. No JS branch could have kept the shell's CSS out of a plugin
 * window.
 *
 * This check is the belt to that brace: reachable only if something created a
 * window pointing at `index.html` by a path that bypasses `ctx.windows.create`
 * (a config entry, a future native command). `main` is the label
 * `tauri.conf.json`'s window gets by default, and the same discriminator the
 * Rust side uses (`require_main`), so the two agree by construction.
 */
function isMainWindow() {
  try {
    return getCurrentWindow().label === 'main';
  } catch {
    // No Tauri: a plain browser dev server. There is no second window to collide
    // with there, and the shell is the only thing worth rendering.
    return true;
  }
}

if (!isMainWindow()) {
  // Say so IN the window, rather than starting a second application.
  document.body.innerHTML =
    '<p style="font:13px/1.6 system-ui;padding:24px;max-width:52ch">' +
    'This page is the <b>main window</b> of Toolbox, and this is not the main window. ' +
    'A plugin window must load <code>pluginwin.html?plugin=&lt;id&gt;&amp;label=&lt;label&gt;</code> ' +
    '— see <code>docs/plugin-dev/api.md</code>.</p>';
} else {
  // The shell is imported HERE rather than at the top of the file, and the
  // difference is not tidiness: a static import is fetched, parsed and EVALUATED
  // by whichever window loads this module. It is dynamic so that the cost lands
  // only where the shell is actually mounted.
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
