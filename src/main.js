import { createApp, nextTick } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { initTheme } from './host/theme.js';

// Navigation-relative marks include time spent loading this module's imports.
performance.mark('toolkit:entry');

function renderMisplacedWindow() {
  document.body.innerHTML =
    '<p style="font:13px/1.6 system-ui;padding:24px;max-width:52ch">' +
    'This page is the <b>main window</b> of Toolbox, and this is not the main window. ' +
    'A plugin window must load <code>pluginwin.html?plugin=&lt;id&gt;&amp;label=&lt;label&gt;</code> ' +
    '— see <code>docs/plugin-dev/api.md</code>.</p>';
}

async function main() {
  // Installed plugins may still use the old URL. Preserve their query parameters.
  if (new URLSearchParams(window.location.search).get('mode') === 'pluginwin') {
    location.replace(`pluginwin.html${window.location.search}`);
    return;
  }

  let win;
  try {
    win = getCurrentWindow();
  } catch {
    // Plain-browser development has no native window.
  }
  // Never start a second host (and its subprocesses) inside a plugin window.
  if (win && win.label !== 'main') {
    renderMisplacedWindow();
    return;
  }

  initTheme();
  const { default: App } = await import('./App.vue');
  performance.mark('toolkit:shell-imported');
  createApp(App).mount('#app');
  await nextTick();
  performance.mark('toolkit:mounted');

  // Hidden WebViews may suspend animation frames. Show once the DOM is ready,
  // before importing the host, plugins and their component library.
  if (win) {
    performance.mark('toolkit:show-requested');
    try {
      await win.show();
      performance.mark('toolkit:shown');
    } catch (e) {
      console.error('[shell] could not show the window', e);
    }
  }

  const { boot } = await import('./host/boot.js');
  performance.mark('toolkit:host-imported');
  await boot();
}

export const startup = main().catch((e) => {
  console.error('[shell] startup failed', e);
});
