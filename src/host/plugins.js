/**
 * Plugin catalogue — the one place that knows which plugins exist, where each
 * came from, and how to (re)load one.
 *
 * A plugin arrives from one of two places:
 *
 *   builtin   a module the bundle ships       (host/registry.js, static import)
 *   external  a folder in {appData}/plugins   (Blob URL → dynamic import)
 *
 * That difference is a **field**, not a code path. Before this module it was a
 * code path in three places: `bootPlugins` and `scanExternalPlugins` were two
 * entry points with two summary shapes, and "is it loaded" had two answers
 * (`registry.js`'s REGISTRY for built-ins, a map in `external.js` for the rest).
 * So every caller wrote the same branch twice:
 *
 *   const mod = resolveBuiltin(row.id) || getExternal(row.id);   // before
 *   const mod = pluginModule(row.id);                            // after
 *
 * `reconcilePlugins({ sources })` is now the only way a plugin gets loaded, and
 * `loaded` is the only answer to "what is loaded".
 *
 * ## What still differs, and must
 *
 * The differences are confined to the two passes below, and each one is a real
 * property of its source rather than an accident of history:
 *
 *   builtin   no digest — the bundle cannot change under us; never removed; a
 *             load failure is reported once per boot rather than remembered
 *   external  digest-driven — unchanged bytes are not re-read, changed bytes
 *             reload in place, a deleted folder loses its row AND its native
 *             grant, and a FAILED load is remembered until the bytes change
 *             (retrying identical bytes would only repeat the same error)
 *
 * Built-ins are re-`loadPlugin`ed on every pass on purpose: that call is what
 * re-registers their permissions, and the native gate is fail-closed, so a fresh
 * frontend context must register again before anything can call the host.
 *
 * `tests/plugins-catalogue.test.mjs` pins both halves — the shared bookkeeping
 * and the per-source differences.
 */

import {
  activate,
  adoptNewPlugin,
  deactivate,
  enabledIds,
  loadPlugin,
  setPluginState,
} from './lifecycle.js';
import { events } from './events.js';
import { importEntry, revokeGrant, scanExternal } from './external.js';
import { builtinSources, resolveBuiltin } from './registry.js';
import { store, sortPluginList } from './store.js';

/** Where a plugin came from. */
export const Origin = Object.freeze({
  BUILTIN: 'builtin',
  EXTERNAL: 'external',
});

const ALL_ORIGINS = Object.freeze([Origin.BUILTIN, Origin.EXTERNAL]);

/** id → { module, origin, item } — every plugin currently loaded. */
const loaded = new Map();

/** id → digest of the external bytes whose load FAILED. Externals only. */
const failedDigests = new Map();

/**
 * The module for a plugin id, or `null`.
 *
 * Falls back to the bundle registry, so a built-in resolves even before any
 * reconcile has run — the behaviour `resolveBuiltin(id) || getExternal(id)` had,
 * kept so a caller cannot get a different answer just by asking earlier.
 */
export function pluginModule(id) {
  return loaded.get(id)?.module ?? resolveBuiltin(id) ?? null;
}

/**
 * Which of the two places a plugin came from, or `null` if nothing knows it.
 *
 * Exported for tests and for the Settings row, which names the reload action
 * differently: an external plugin can be re-read from disk, a built-in cannot.
 */
export function originOf(id) {
  const rec = loaded.get(id);
  if (rec) return rec.origin;
  return resolveBuiltin(id) ? Origin.BUILTIN : null;
}

/** Every id in the catalogue. */
export function loadedIds() {
  return [...loaded.keys()];
}

/** Drop a plugin's row from the shell's list. */
function dropRow(id) {
  const i = store.plugins.findIndex((p) => p.manifest.id === id);
  if (i >= 0) store.plugins.splice(i, 1);
  sortPluginList();
}

/**
 * Load and activate the built-ins, in registry order.
 *
 * Behaviour is the old `bootPlugins` verbatim, including two details that look
 * incidental and are not: activation is `silent` (boot is not the user doing
 * something), and the whole loop is **awaited one plugin at a time** — which is
 * why one slow `activate()` delays every plugin after it, and why the boot log
 * prints a per-plugin timing.
 */
async function bootBuiltins(out) {
  const mods = builtinSources();
  const enabled = enabledIds(mods.map((m) => m.manifest?.id ?? m.id));

  for (const src of mods) {
    const id = src.manifest?.id ?? src.id;
    const t0 = performance.now();
    try {
      const plugin = await loadPlugin(src);
      loaded.set(id, { module: plugin, origin: Origin.BUILTIN, item: null });
      if (enabled.has(plugin.manifest.id)) {
        await activate(plugin, { silent: true });
      }
      out.timings.push({ id, ms: Math.round(performance.now() - t0) });
      out.loaded.push(id);
    } catch (e) {
      out.timings.push({ id, ms: Math.round(performance.now() - t0), failed: true });
      console.error('[plugins] failed to load builtin plugin', e);
    }
  }

  if (!store.activeViewId && store.views.length) store.activeViewId = store.views[0].viewId;
  events.emit('host:booted');
}

/**
 * A load that failed is remembered, not retried.
 *
 * Retrying the same bytes on the next rescan would only repeat the same error,
 * so the failure sticks until the content changes — which is exactly when a
 * retry can plausibly succeed.
 */
function rememberFailure(item, e) {
  failedDigests.set(item.id, item.digest);
  console.error(`[plugins] external load failed for ${item.id}`, e);
  if (store.plugins.some((p) => p.manifest.id === item.id)) {
    setPluginState(item.id, 'error', String(e));
  } else {
    store.plugins.push({
      manifest: {
        id: item.id,
        name: item.manifest?.name || item.id,
        version: item.manifest?.version || '?',
        builtin: false,
      },
      status: 'error',
      error: String(e),
      note: null,
    });
    sortPluginList();
  }
}

/**
 * Reconcile the loaded set with what is on {appData}/plugins.
 *
 * Returns what CHANGED rather than the raw scan: "N plugin(s) found" was the
 * same number whether the rescan did anything or not.
 */
async function reconcileExternals(out, silent) {
  let list = [];
  try {
    list = await scanExternal();
  } catch (e) {
    console.error('[plugins] scan failed', e);
    return;
  }
  out.found = list.length;
  const onDisk = new Set(list.map((p) => p.id));

  // --- removed: in the catalogue, but no longer on disk ---
  // Includes plugins whose load previously failed: their error row should go
  // when the folder does.
  for (const id of [...new Set([...loaded.keys(), ...failedDigests.keys()])]) {
    // Only the external half is reconciled here. A built-in has no folder, so
    // "not on disk" says nothing about it — without this guard, a built-in would
    // be unloaded (and its native grant revoked) on the first rescan.
    if (loaded.get(id)?.origin === Origin.BUILTIN) continue;
    if (onDisk.has(id)) continue;
    const rec = loaded.get(id);
    if (rec) await deactivate(rec.module, { silent: true });
    loaded.delete(id);
    failedDigests.delete(id);
    await revokeGrant(id);
    dropRow(id);
    out.removed.push(id);
  }

  // --- added / changed / unchanged / failed ---
  for (const item of list) {
    const rec = loaded.get(item.id);
    const isLoaded = Boolean(rec);

    if (isLoaded && rec.digest === item.digest) {
      out.unchanged.push(item.id);
      continue;
    }
    if (!isLoaded && failedDigests.get(item.id) === item.digest) {
      out.failed.push(item.id); // the same bytes that failed before
      continue;
    }

    try {
      if (isLoaded) {
        // Stop the old instance first: it may hold hotkeys, streams and views,
        // and the new manifest may declare a different set.
        await deactivate(rec.module, { silent: true });
        loaded.delete(item.id);
        dropRow(item.id); // so the new manifest is what shows up
      }
      const plugin = await importEntry(item);
      loaded.set(item.id, { module: plugin, origin: Origin.EXTERNAL, item, digest: item.digest });
      failedDigests.delete(item.id);
      // A reload keeps the persisted enable state, so dropping new bytes into a
      // deliberately disabled plugin does not switch it back on.
      if (adoptNewPlugin(item.id)) await activate(plugin, { silent });
      (isLoaded ? out.reloaded : out.added).push(item.id);
    } catch (e) {
      out.failed.push(item.id);
      rememberFailure(item, e);
    }
  }

  if (!store.activeViewId && store.views.length) store.activeViewId = store.views[0].viewId;
}

/**
 * Bring the catalogue in line with its sources.
 *
 * `sources` exists because the two callers want different things and both are
 * right: **boot** reconciles everything, while the Settings *Rescan* button means
 * "rescan the plugins directory" and must not touch the built-ins (which have no
 * directory). The default reconciles both.
 *
 * The summary is split by source rather than flattened, because the fields are
 * not the same thing: `added`/`reloaded`/`removed` are digest events that only an
 * external plugin can have, while a built-in has a load timing.
 */
export async function reconcilePlugins({ silent = true, sources = ALL_ORIGINS } = {}) {
  const summary = {
    builtin: { loaded: [], timings: [] },
    external: { found: 0, added: [], reloaded: [], unchanged: [], removed: [], failed: [] },
  };

  if (sources.includes(Origin.BUILTIN)) await bootBuiltins(summary.builtin);
  if (sources.includes(Origin.EXTERNAL)) await reconcileExternals(summary.external, silent);

  return summary;
}

/**
 * Force one plugin to load again, right now.
 *
 * **External** → re-read the entry and import it again, *whatever the digest
 * says*. That is the difference between this and Rescan: Rescan deliberately
 * skips unchanged bytes, so before this there was no way to make a plugin pick up
 * a change that does not alter its digest (a rebuilt file with the same content,
 * or a plugin whose state simply needs restarting).
 *
 * **Built-in** → there is nothing to re-read, because the module is in the
 * bundle. The honest reload is "stop it, start it again": in dev Vite has
 * already replaced the module by the time anyone clicks this, and in a packaged
 * app the bundle is immutable, so re-importing would be a lie.
 *
 * Either way the user's enable/disable choice is respected — a disabled plugin
 * stays disabled.
 */
export async function reloadPlugin(id, { silent = false } = {}) {
  const rec = loaded.get(id);
  const origin = rec?.origin ?? originOf(id);
  if (!origin) {
    throw new Error(`plugin \`${id}\` is not loaded — rescan first`);
  }

  if (origin === Origin.EXTERNAL) {
    const item = rec?.item;
    if (!item) throw new Error(`plugin \`${id}\` has no on-disk location to reload from`);
    await deactivate(rec.module, { silent: true });
    loaded.delete(id);
    dropRow(id);
    const plugin = await importEntry(item);
    loaded.set(id, { module: plugin, origin, item, digest: item.digest });
    if (adoptNewPlugin(id)) await activate(plugin, { silent });
    return { id, origin, restarted: true };
  }

  const module = rec?.module ?? resolveBuiltin(id);
  if (!module) throw new Error(`plugin \`${id}\` is not loaded — rescan first`);
  if (module._ctx) await deactivate(module, { silent: true });
  if (adoptNewPlugin(id)) await activate(module, { silent });
  return { id, origin, restarted: true };
}
