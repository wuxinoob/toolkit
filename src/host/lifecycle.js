import { invoke } from '@tauri-apps/api/core';

import { buildCtx } from './ctx.js';
import { store, toast } from './store.js';
import { events } from './events.js';
import { hub } from '../protocol/hub.js';

/**
 * Plugin lifecycle kernel.
 *   discovered -> loaded -> activated -> deactivated -> (dispose)
 *
 * A Disposer collects every cleanup fn registered during activate (bus
 * listeners, streams, DOM nodes, timers via ctx-managed helpers), so
 * deactivate is always a full teardown with no leaks.
 */

class Disposer {
  constructor() {
    this.fns = [];
  }
  track(fn) {
    this.fns.push(fn);
  }
  run() {
    for (const fn of this.fns.reverse()) {
      try {
        fn();
      } catch (e) {
        console.error('[lifecycle] dispose error', e);
      }
    }
    this.fns = [];
  }
}

function setPluginState(id, status, error = null) {
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

export async function activate(plugin, { silent = false } = {}) {
  if (plugin._ctx) return; // already active
  try {
    const disposer = new Disposer();
    const ctx = buildCtx(plugin, disposer);
    plugin._disposer = disposer;
    plugin._ctx = ctx;
    await plugin.activate(ctx); // may be sync or async
    setPluginState(plugin.manifest.id, 'active');
    if (!silent) toast(`${plugin.manifest.name} enabled`, 'info', 2000);
  } catch (e) {
    plugin._ctx = null;
    plugin._disposer?.run();
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
    plugin._disposer?.run();
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
  // Register before anything can call: the host gate is fail-closed.
  await registerWithHost(plugin.manifest);
  if (!store.plugins.some((p) => p.manifest.id === plugin.manifest.id)) {
    store.plugins.push({ manifest: plugin.manifest, status: 'inactive', error: null });
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

export async function bootPlugins(builtinPlugins) {
  const enabled = enabledIds(builtinPlugins.map((p) => p.manifest?.id ?? p.id));
  for (const src of builtinPlugins) {
    try {
      const plugin = await loadPlugin(src);
      if (enabled.has(plugin.manifest.id)) {
        await activate(plugin, { silent: true });
      }
    } catch (e) {
      console.error('[lifecycle] failed to load builtin plugin', e);
    }
  }
  if (!store.activeViewId && store.views.length) store.activeViewId = store.views[0].viewId;
  events.emit('host:booted');
}
