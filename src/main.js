import { createApp } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
// One stylesheet for every window: the design tokens and the `.tb-*` primitives
// are global on purpose — external plugins (Blob-URL ESM) cannot import a
// component library, but they CAN use these classes.
import './assets/app.css';
import App from './App.vue';
import { boot } from './host/boot.js';
import { initTheme } from './host/theme.js';

// Before anything renders, in EVERY window: the theme is one attribute on <html>
// and a plugin window is as entitled to it as the main one. index.html sets it
// even earlier (inline, pre-paint) to avoid a flash; this is the authoritative
// read, and it also wires the OS listener and the cross-window one.
initTheme();

// Secondary windows reuse this entry with a ?mode= query: they must render
// their own page only and skip the whole plugin host — a second host would
// double-register global shortcuts, timers and startup selftests.
//   ?mode=pluginwin&plugin=<id>&label= -> generic EXTERNAL plugin window host
//                                         (Blob-imports the plugin entry and
//                                         calls its mountWindow(bridge))
//
// There used to be a second mode, `?mode=floatwin`, pointing at the built-in
// FloatWin widget page. It went with the plugin: a page only one plugin could
// use is that plugin's page, not a host feature. A plugin that wants a window
// supplies its own entry and reaches it through `pluginwin`.
const mode = new URLSearchParams(window.location.search).get('mode');

if (mode === 'pluginwin') {
  import('./host/pluginwin-host.js').then((m) => m.mountPluginWindow());
} else {
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
