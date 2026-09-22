import { invoke } from '@tauri-apps/api/core';

import { buildCtx } from './ctx.js';
import { store, toast } from './store.js';
import { events } from './events.js';
import { hub } from '../protocol/hub.js';
import { HOST_API } from '../protocol/contract.js';
import { applyPluginTheme, clearPluginTheme } from './pluginTheme.js';
import { loadUiKit } from './ui.js';

/** Host identity: used for calls the host makes on a plugin's behalf. */
const HOST_ID = '__host__';

/**
 * Plugin lifecycle kernel.
 *   discovered -> loaded -> activated -> deactivated -> (dispose)
 *
 * A Disposer collects every cleanup fn registered during activate (bus
 * listeners, streams, DOM nodes, timers via ctx-managed helpers), so
 * deactivate is always a full teardown with no leaks.
 */

export class Disposer {
  constructor() {
    this.fns = [];
    this.running = null;
  }

  track(fn) {
    this.fns.push(fn);
  }

  /**
   * Run every cleanup, newest first, and AWAIT the async ones.
   *
   * Awaiting matters: a cleanup that closes a stream or releases a sidecar has
   * to finish before the caller treats the plugin as gone, otherwise the
   * resource can still register itself after teardown. Previously the promises
   * were dropped, so async cleanups became fire-and-forget and their rejections
   * surfaced as unhandled rejections.
   *
   * Idempotent: a second call returns the first call's promise instead of
   * running everything twice.
   */
  run() {
    if (this.running) return this.running;
    const fns = this.fns.reverse();
    this.fns = [];
    this.running = (async () => {
      for (const fn of fns) {
        try {
          await fn();
        } catch (e) {
          console.error('[lifecycle] dispose error', e);
        }
      }
    })();
    return this.running;
  }
}

export function setPluginState(id, status, error = null) {
  const p = store.plugins.find((x) => x.manifest.id === id);
  if (p) {
    p.status = status;
    p.error = error;
  }
}

/**
 * Tell the native side what this plugin declared.
 *
 * This is what makes the Rust gate authoritative rather than advisory: an
 * unregistered plugin id is denied at the gateway (fail-closed), so the
 * permission model cannot be bypassed by skipping the JS `ctx`.
 */
export async function registerWithHost(manifest) {
  const pluginId = manifest?.id;
  if (!pluginId) throw new Error('manifest.id is required to register with the host');
  await invoke('plugin_register', {
    pluginId,
    permissions: manifest.permissions ?? [],
  });
}

/**
 * Register the plugin's declared global hotkeys, and release them on deactivate.
 *
 * The host acts on the plugin's behalf: a plugin may not import the shortcut
 * API, and the `contributes.hotkeys` entry IS the declaration, so no extra
 * permission is needed. A conflict is reported, never fatal — one taken
 * shortcut must not stop a plugin from activating.
 */
async function registerHotkeys(plugin, ctx) {
  const declared = plugin.manifest.contributes?.hotkeys ?? [];
  let ok = 0;
  for (const hk of declared) {
    if (!hk || !hk.key || !hk.action) continue;
    try {
      await hub.request(HOST_ID, 'hotkey', 'register', {
        key: hk.key,
        action: hk.action,
        owner: plugin.manifest.id,
      });
      ok += 1;
    } catch (e) {
      ctx.log.warn('hotkey "' + hk.key + '" not registered: ' + (e?.message ?? e));
    }
  }
  return ok;
}

async function releaseHotkeys(plugin) {
  try {
    await hub.request(HOST_ID, 'hotkey', 'unregister_all', { owner: plugin.manifest.id });
  } catch {
    /* nothing to release, or the host is going away */
  }
}

/**
 * Apply `contributes.theme`, and report what was dropped.
 *
 * Reporting matters more than it looks: the failure mode of a bad contribution
 * is that the plugin renders *normally*, so a typo'd token name or an unusable
 * value is invisible unless it is said out loud. It goes to the plugin's own log
 * (which lands in debug.log) rather than to a toast, because it is a
 * plugin-author problem, not something the user can act on.
 */
function applyThemeContribution(plugin, ctx) {
  const declared = plugin.manifest.contributes?.theme;
  if (!declared) return;
  try {
    const { applied, rejected } = applyPluginTheme(plugin.manifest.id, declared);
    if (applied) ctx.log.info(`theme: ${applied} token override(s) applied`);
    for (const why of rejected) ctx.log.warn(`theme: ignored — ${why}`);
  } catch (e) {
    // Never fatal: a plugin that cannot be themed should still run.
    ctx.log.warn('theme contribution rejected: ' + (e?.message ?? e));
  }
}

export async function activate(plugin, { silent = false } = {}) {
  if (plugin._ctx) return; // already active
  try {
    // The component factory is loaded ONCE, before any plugin activates, so a
    // plugin's `ctx.ui.el(...)` can stay synchronous — a plugin builds its DOM
    // inside a synchronous render callback.
    await loadUiKit();
    const disposer = new Disposer();
    const ctx = buildCtx(plugin, disposer);
    plugin._disposer = disposer;
    plugin._ctx = ctx;
    // Declared hotkeys go live BEFORE activate runs, so a plugin can rely on
    // them (and check them) during its own activation rather than racing it.
    await registerHotkeys(plugin, ctx);
    applyThemeContribution(plugin, ctx);
    await plugin.activate(ctx); // may be sync or async
    setPluginState(plugin.manifest.id, 'active');
    if (!silent) toast(`${plugin.manifest.name} enabled`, 'info', 2000);
  } catch (e) {
    plugin._ctx = null;
    await releaseHotkeys(plugin);
    await plugin._disposer?.run();
    plugin._disposer = null;
    setPluginState(plugin.manifest.id, 'error', String(e));
    toast(`${plugin.manifest.name} failed to activate: ${e}`, 'error');
    console.error(`[lifecycle] activate failed for ${plugin.manifest.id}`, e);
  }
}

export async function deactivate(plugin, { silent = false } = {}) {
  if (!plugin._ctx) return;
  try {
    if (typeof plugin.deactivate === 'function') await plugin.deactivate(plugin._ctx);
  } catch (e) {
    console.error(`[lifecycle] deactivate error for ${plugin.manifest.id}`, e);
  } finally {
    await releaseHotkeys(plugin);
    clearPluginTheme(plugin.manifest.id);
    await plugin._disposer?.run();
    plugin._disposer = null;
    plugin._ctx = null;
    hub.dropSubscriptions(plugin.manifest.id);
    store.views = store.views.filter((v) => v.pluginId !== plugin.manifest.id);
    if (store.activeViewId && !store.views.some((v) => v.viewId === store.activeViewId)) {
      store.activeViewId = store.views[0]?.viewId || null;
    }
    setPluginState(plugin.manifest.id, 'inactive');
    if (!silent) toast(`${plugin.manifest.name} disabled`, 'info', 2000);
  }
}

/**
 * Merge the declarative manifest (`plugin.json`, discovered by the native
 * scanner) over the one the module exports.
 *
 * An external plugin has two descriptions of itself: the file the host had to
 * read to find it at all, and the object its code exports. Only one can be
 * authoritative. `plugin.json` wins — it is the artifact a user inspects and
 * edits — while the in-code manifest supplies anything the file omits. The
 * audit in `tests/plugins.test.mjs` asserts the two agree, so drift is caught
 * at test time rather than as a mysterious "lacks permission" at runtime.
 */
function mergeManifest(fromCode, fromJson) {
  if (!fromJson) return fromCode;
  return {
    ...fromCode,
    ...fromJson,
    contributes: { ...(fromCode?.contributes ?? {}), ...(fromJson.contributes ?? {}) },
  };
}

/**
 * Load a builtin (already-imported module) or external (URL -> dynamic import)
 * plugin.
 *
 * `declarative` is the plugin.json manifest for a disk plugin; it takes
 * precedence over the module's own export (see `mergeManifest`).
 */
export async function loadPlugin(source, { declarative = null } = {}) {
  const mod = typeof source === 'string' ? await import(/* @vite-ignore */ source) : source;
  const plugin = mod.default || mod;
  if (!plugin.manifest?.id || typeof plugin.activate !== 'function') {
    throw new Error('invalid plugin module: requires manifest.id and activate()');
  }
  plugin.manifest = mergeManifest(plugin.manifest, declarative);
  plugin.manifest.builtin = typeof source !== 'string';

  // A plugin codes against the HOST API shape, which changes independently of
  // the wire protocol. Record a mismatch on the plugin row so the boot trace
  // says why a plugin misbehaves, instead of leaving a cryptic runtime error
  // (a plugin built for api 1 calling the now-async `ctx.events.on` gets
  // "off is not a function").
  const declaredApi = plugin.manifest.api;
  const apiNote =
    typeof declaredApi === 'number' && declaredApi !== HOST_API
      ? 'built for host API ' + declaredApi + ', this host provides ' + HOST_API + ' — re-deploy the plugin if it misbehaves'
      : null;
  if (apiNote) console.warn('[lifecycle] ' + plugin.manifest.id + ': ' + apiNote);
  // Register before anything can call: the host gate is fail-closed.
  await registerWithHost(plugin.manifest);
  if (!store.plugins.some((p) => p.manifest.id === plugin.manifest.id)) {
    store.plugins.push({ manifest: plugin.manifest, status: 'inactive', error: null, note: apiNote });
  }
  return plugin;
}

/** Enable/disable state persisted by plugin id. First run: enable everything. */
const ENABLED_KEY = 'toolbox.plugins.enabled';
const KNOWN_KEY = 'toolbox.plugins.known';

export function enabledIds(builtinIds = []) {
  const raw = localStorage.getItem(ENABLED_KEY);
  if (raw === null) {
    saveEnabled(builtinIds);
    saveKnown(builtinIds);
    return new Set(builtinIds);
  }
  const saved = JSON.parse(raw || '[]');
  const known = JSON.parse(localStorage.getItem(KNOWN_KEY) || 'null');
  // Upgrade path: a builtin shipped after the saved list was written is absent
  // from the known set -> default it to enabled. Deliberate disables stick
  // because the id is present in the known set from then on.
  const knownSet = new Set(Array.isArray(known) ? known : saved);
  const set = new Set(saved);
  for (const id of builtinIds) {
    if (!knownSet.has(id)) {
      set.add(id);
      knownSet.add(id);
    }
  }
  saveEnabled([...set]);
  saveKnown([...knownSet]);
  return set;
}

export function saveEnabled(ids) {
  localStorage.setItem(ENABLED_KEY, JSON.stringify(ids));
}

export function saveKnown(ids) {
  localStorage.setItem(KNOWN_KEY, JSON.stringify(ids));
}

/**
 * Enable state for a plugin seen for the first time.
 *
 * One rule for builtins and drop-ins alike: first sighting -> enabled, and the
 * id is recorded in the known set so a later explicit disable sticks. Copying a
 * folder into the plugins directory IS an act of intent, so a freshly dropped
 * plugin should come up on Rescan (which is what the docs promise) rather than
 * sitting inert until it is toggled by hand.
 */
export function adoptNewPlugin(id) {
  const known = new Set(JSON.parse(localStorage.getItem(KNOWN_KEY) || '[]'));
  const enabled = new Set(JSON.parse(localStorage.getItem(ENABLED_KEY) || '[]'));
  if (known.has(id)) return enabled.has(id);
  known.add(id);
  enabled.add(id);
  saveKnown([...known]);
  saveEnabled([...enabled]);
  return true;
}

/**
 * Load and activate every built-in plugin, in order.
 *
 * Returns one timing per plugin. The boot log's `builtins` mark says the phase
 * costs ~1.7s; this says WHICH plugin, which is the difference between a number
 * and a lead. It is also the first thing to read when a plugin author reports
 * "my plugin makes startup slow" — activation is sequential and awaited, so one
 * slow `activate()` delays every plugin after it.
 */
export async function bootPlugins(builtinPlugins) {
  const enabled = enabledIds(builtinPlugins.map((p) => p.manifest?.id ?? p.id));
  const timings = [];
  for (const src of builtinPlugins) {
    const id = src.manifest?.id ?? src.id;
    const t0 = performance.now();
    try {
      const plugin = await loadPlugin(src);
      if (enabled.has(plugin.manifest.id)) {
        await activate(plugin, { silent: true });
      }
      timings.push({ id, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      timings.push({ id, ms: Math.round(performance.now() - t0), failed: true });
      console.error('[lifecycle] failed to load builtin plugin', e);
    }
  }
  if (!store.activeViewId && store.views.length) store.activeViewId = store.views[0].viewId;
  events.emit('host:booted');
  return timings;
}
