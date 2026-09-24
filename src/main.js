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
 * Which window am I, and which page should I be?
 *
 * Three answers, and the FIRST one is a compatibility shim rather than a
 * feature:
 *
 *   1. `?mode=pluginwin`  — the LEGACY plugin-window URL. Redirect, do not boot.
 *   2. not the main window — a misconfigured window; say so, do not boot.
 *   3. the main window     — mount the shell and boot the host.
 *
 * ## Why the legacy URL still has to work
 *
 * A plugin window's URL used to be `index.html?mode=pluginwin&…`, and it was
 * documented that way. When the two windows became two pages, that shape was
 * replaced by `pluginwin.html?…` — and the old one was refused. That broke every
 * plugin already installed:
 *
 *   - a third-party plugin cannot be edited at all (`moment-notes` asks for the
 *     old URL in five places, and it is 686 KB of someone else's bundle),
 *   - and the copy in the plugins directory is a COPY, so fixing `examples/` does
 *     not fix what is installed.
 *
 * The symptom was not "the plugin is missing" — the plugin loaded, activated, and
 * appeared in Settings. Its WINDOWS never opened, because `create` refused the
 * URL, and every caller had a `catch` around it. That is the worst shape a
 * regression can take: nothing errors, and the feature is just absent.
 *
 * So the old shape keeps working, by being sent to the page that has always been
 * what it meant. `replace` rather than `href` so this is not a history entry —
 * the window has one URL and it is the right one. The query is carried over
 * verbatim: `plugin` and `label` are what the host page reads, and `mode` is
 * inert there.
 *
 * This costs a legacy window the shell's stylesheet once (it is linked by
 * `index.html`, before any module runs), which is exactly the 147 KB the split
 * removed. That is the price of not breaking what is already installed, and it
 * goes away when the plugin is updated.
 */
const isLegacyPluginWindow =
  new URLSearchParams(window.location.search).get('mode') === 'pluginwin';

function isMainWindow() {
  try {
    return getCurrentWindow().label === 'main';
  } catch {
    // No Tauri: a plain browser dev server. There is no second window to collide
    // with there, and the shell is the only thing worth rendering.
    return true;
  }
}

/**
 * Reachable only if something created a window pointing at `index.html` by a path
 * that bypasses `ctx.windows.create` (a config entry, a future native command).
 *
 * This used to be a branch on `?mode=`, with an `else` that booted the whole host
 * — so a plugin window opened with a bare `index.html`, or a stale
 * `?mode=floatwin`, booted a SECOND host inside itself: `procman` auto-started a
 * second set of real subprocesses, every drop-in plugin was activated twice, and
 * the summon hotkey was registered twice. (`plugin_reap_orphans()` — the one that
 * kills every live session — was already blocked by its `require_main` gate.)
 *
 * Now the plugin-window host lives on its own page, so this file cannot start it
 * at all. The label check is the belt to that brace: `main` is the label
 * `tauri.conf.json`'s window gets by default, and the same discriminator the Rust
 * side uses (`require_main`).
 */
function renderMisplacedWindow() {
  document.body.innerHTML =
    '<p style="font:13px/1.6 system-ui;padding:24px;max-width:52ch">' +
    'This page is the <b>main window</b> of Toolbox, and this is not the main window. ' +
    'A plugin window must load <code>pluginwin.html?plugin=&lt;id&gt;&amp;label=&lt;label&gt;</code> ' +
    '— see <code>docs/plugin-dev/api.md</code>.</p>';
}

async function main() {
  if (isLegacyPluginWindow) {
    location.replace(`pluginwin.html${window.location.search}`);
    return;
  }

  if (!isMainWindow()) {
    renderMisplacedWindow();
    return;
  }

  // The shell is imported HERE rather than at the top of the file, and the
  // difference is not tidiness: a static import is fetched, parsed and EVALUATED
  // by whichever window loads this module. It is dynamic so the cost lands only
  // where the shell is actually mounted.
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

main().catch((e) => {
  console.error('[shell] startup failed', e);
});
