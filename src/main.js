import { createApp } from 'vue';
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
//   ?mode=floatwin                     -> builtin FloatWin widget page
//   ?mode=pluginwin&plugin=<id>&label= -> generic EXTERNAL plugin window host
//                                         (Blob-imports the plugin entry and
//                                         calls its mountWindow(bridge))
const mode = new URLSearchParams(window.location.search).get('mode');

if (mode === 'floatwin') {
  import('./plugins/floatwin-widget.js').then((m) => m.mountWidget());
} else if (mode === 'pluginwin') {
  import('./host/pluginwin-host.js').then((m) => m.mountPluginWindow());
} else {
  const app = createApp(App);
  app.mount('#app');

  boot();
}
