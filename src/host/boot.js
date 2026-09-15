import { getCurrentWindow } from '@tauri-apps/api/window';
import { register, unregisterAll, isRegistered } from '@tauri-apps/plugin-global-shortcut';

import { store, saveSettings, toast } from './store.js';
import { bootPlugins } from './lifecycle.js';
import { builtinSources } from './registry.js';
import { scanExternalPlugins } from './external.js';
import { installDebug } from './debug.js';
import { logger } from '../core/logger.js';
import { runSelftest } from '../core/selftest.js';
import { hub } from '../protocol/hub.js';

/** Global hotkey that summons (shows + focuses) the main window. */
export async function applySummonShortcut() {
  const shortcut = store.settings.summonShortcut;
  try {
    await unregisterAll();
    if (shortcut) {
      if (await isRegistered(shortcut)) return;
      await register(shortcut, (event) => {
        if (event.state !== 'Pressed') return;
        const win = getCurrentWindow();
        win.show();
        win.setFocus();
      });
    }
  } catch (e) {
    toast(`Hotkey "${shortcut}" failed: ${e}`, 'error');
    console.error('[boot] summon shortcut failed', e);
  }
}

/**
 * Closed-loop diagnostics: persist a line to {app_data_dir}/debug.log through
 * the gateway. Best-effort by design — the gateway is independent of plugin
 * boot, so even a failed boot can explain itself on disk instead of only in a
 * webview console nobody is watching.
 */
async function report(line) {
  try {
    await hub.request('__host__', 'host', 'write_debug_log', { content: line });
  } catch (e) {
    console.error('[boot] could not write debug.log', e);
  }
}

export async function boot() {
  await report(`--- boot ${new Date().toISOString()} ---`);
  try {
    installDebug(); // window.__toolbox before plugins attach their own handles

    // The scheme table is a static contract; snapshot it for the diagnostics view.
    store.schemes = hub.schemes();
    await report(`message plane: ${hub.transports().join(', ')}`);

    // First enabled plugin's first view becomes the initial screen.
    await bootPlugins(builtinSources());
    await scanExternalPlugins(); // drop-in plugins from {appData}/plugins/*
    await applySummonShortcut();

    store.booted = true;
    const line = `boot ok: ${store.plugins.length} plugins, ${store.views.length} views, active=${store.activeViewId}`;
    logger.info('boot', line);
    await report(line);
    for (const p of store.plugins) {
      await report(`  plugin ${p.manifest.id}: ${p.status}${p.error ? ` — ${p.error}` : ''}`);
    }
    // `import.meta.env` is injected by Vite; the optional chain keeps this
    // module importable outside a bundler (node --test boot smoke test).
    if (import.meta.env?.DEV) await runStartupSelftest();
  } catch (e) {
    // A boot failure must leave a trace outside the webview.
    logger.error('boot', `boot failed: ${e}`);
    await report(`BOOT FAILED: ${e?.stack ?? e}`);
    throw e;
  }
}

/**
 * Run the in-app conformance suite and persist the report through the gateway
 * to {app_data_dir}/debug.log — readable from outside the webview without any
 * manual clicking.
 */
async function runStartupSelftest() {
  try {
    const result = await runSelftest();
    await report(result.lines.join('\n'));
    console.info(`[selftest] ${result.pass}/${result.total} passed (see app data debug.log)`);
  } catch (e) {
    logger.error('selftest', `startup selftest pipeline failed: ${e}`);
    await report(`SELFTEST PIPELINE FAILED: ${e?.stack ?? e}`);
  }
}

export { saveSettings };
