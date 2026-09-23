import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { register, unregisterAll, isRegistered } from '@tauri-apps/plugin-global-shortcut';

import { store, saveSettings, toast } from './store.js';
import { bootPlugins } from './lifecycle.js';
import { builtinSources } from './registry.js';
import { scanExternalPlugins } from './external.js';
import { installDebug } from './debug.js';
import { logger } from '../core/logger.js';
import { runSelftest } from '../core/selftest.js';
import { hub, setTraceSink } from '../protocol/hub.js';
import { events } from './events.js';
import { loadUiKit } from './ui.js';

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

/**
 * Drop sessions a previous frontend left behind.
 *
 * A page reload replaces this JS context while the host process keeps running —
 * in dev that is every HMR update. The previous incarnation's sessions stay
 * registered, and they hold real OS processes, so they leak: reload a few times
 * and the in-app selftest starts reporting failures that are not failures
 * (its own `selftest-pty` is already open, so t10 and t11 go red).
 *
 * Exit and Ctrl+C both drain sessions; a reload passes through neither, so the
 * new frontend says so itself. Outside the app (tests, a plain browser) there is
 * no host to talk to, and that is not an error worth reporting.
 */
async function reapOrphanSessions() {
  try {
    const n = await invoke('plugin_reap_orphans');
    if (n > 0) await report(`reaped ${n} session(s) left by a previous frontend`);
  } catch {
    // No host (browser, node --test) — nothing to reap.
  }
}

/**
 * Route OS file drops to the plugin view the user dropped them on.
 *
 * `onDragDropEvent` is CORE (`@tauri-apps/api/webview`) — no plugin needed. The
 * host listens ONCE and republishes on the window-local bus, so a plugin does
 * not have to touch a Tauri API (it cannot import one) and does not have to
 * care which window it is in.
 *
 * **Only the ACTIVE view receives it.** A drop lands on what the user is
 * looking at; broadcasting to every plugin would let one silently harvest paths
 * meant for another. That routing is what lets `ctx.onDrop` need no permission.
 *
 * Deliberately not awaited by `boot()`: a window that cannot report drops is
 * still a usable window, and this must never be the reason startup fails.
 */
async function watchDrops() {
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event?.payload;
      if (payload?.type !== 'drop') return;
      const viewId = store.activeViewId;
      if (!viewId) return;
      // `host:drop` — the topic `ctx.onDrop` subscribes to. See ctx.js.
      events.emit('host:drop', { paths: payload.paths ?? [], viewId });
    });
    await report('file drops: watching');
  } catch (e) {
    // No host (browser, node --test) or a platform without the event. Not fatal.
    logger.warn('boot', `file drop watch unavailable: ${e}`);
  }
}

export async function boot() {
  // A startup budget. Without one, "startup feels slow" is unanswerable — the
  // window now appears as soon as the shell has painted (see main.js), so every
  // millisecond between that and the plugin list showing up is visible to the
  // user as an empty sidebar.
  const t0 = performance.now();
  const marks = [];
  const mark = (label) => {
    marks.push(`${label} ${Math.round(performance.now() - t0)}`);
  };

  await report(`--- boot ${new Date().toISOString()} ---`);
  try {
    installDebug(); // window.__toolbox before plugins attach their own handles
    mark('debug');

    // Trace lines belong in the debug log, not just the console — the whole
    // point is that they survive the webview and can be read after the fact.
    // Installed before anything else can call the gateway.
    setTraceSink((line) => {
      void report(`  ${line}`);
    });

    // Before anything opens a session of its own.
    await reapOrphanSessions();
    mark('reap');

    // The component factory loads all 376 components. `activate()` awaits it too,
    // but whoever gets there FIRST pays for it — which used to be whichever
    // plugin happened to be first, making the per-plugin timings a lie
    // (`builtin.notepad 2163ms` was really the UI kit, not notepad).
    //
    // Loading it here gives it its own mark, so `plugin load (ms)` means what it
    // says.
    await loadUiKit();
    mark('uikit');

    // The scheme table is a static contract; snapshot it for the diagnostics view.
    store.schemes = hub.schemes();
    await report(`message plane: ${hub.transports().join(', ')}`);
    mark('schemes');

    // First enabled plugin's first view becomes the initial screen.
    const pluginTimings = await bootPlugins(builtinSources());
    mark('builtins');

    await scanExternalPlugins(); // drop-in plugins from {appData}/plugins/*
    mark('external');

    await applySummonShortcut();
    mark('hotkey');

    // Not awaited: see watchDrops.
    watchDrops();

    // Reported BEFORE the per-plugin lines and the selftest: those are
    // diagnostics, and their cost must not be attributed to the plugin list
    // the user is waiting for.
    await report(`boot timing (ms): ${marks.join(' | ')}`);
    await report(
      `  plugin load (ms): ${pluginTimings
        .map((t) => `${t.id} ${t.ms}${t.failed ? ' FAILED' : ''}`)
        .join(' | ')}`,
    );

    store.booted = true;
    const line = `boot ok: ${store.plugins.length} plugins, ${store.views.length} views, active=${store.activeViewId}`;
    logger.info('boot', line);
    await report(line);
    for (const p of store.plugins) {
      const note = p.note ? ` [${p.note}]` : '';
      await report(`  plugin ${p.manifest.id}: ${p.status}${p.error ? ` — ${p.error}` : ''}${note}`);
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
