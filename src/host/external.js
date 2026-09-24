import { invoke } from '@tauri-apps/api/core';

import {
  loadPlugin,
  activate,
  deactivate,
  adoptNewPlugin,
  setPluginState,
} from './lifecycle.js';
import { store, sortPluginList } from './store.js';
import { hub } from '../protocol/hub.js';

/** Host identity: the only caller allowed to revoke a plugin registration. */
const HOST_ID = '__host__';

/**
 * External plugin loading and reconciliation.
 *   Rust scans {appData}/plugins/*  ->  entry JS source  ->  Blob URL
 *   ->  dynamic import  ->  normal lifecycle (registration, views, settings).
 *
 * Adding a new plugin requires ZERO host code changes: drop a folder with
 * plugin.json + a single-file bundled ESM entry, then Rescan.
 *
 * A rescan RECONCILES rather than only discovering. Dropping new bytes in used
 * to do nothing until the app restarted, and a plugin deleted from disk stayed
 * loaded forever:
 *
 *   added      new folder on disk   -> load + activate
 *   changed    digest differs       -> deactivate, reload, activate
 *   unchanged  digest matches       -> left alone (no churn, no re-toast)
 *   removed    folder gone          -> deactivate + unload + drop its row
 *   failed     could not load       -> recorded, retried once it changes
 *
 * The digest comes from the native scan, so a rescan costs one IPC call plus a
 * read per plugin that actually changed.
 *
 * Limitation (by design): the entry must be a single ESM file — bare/relative
 * imports cannot resolve from a Blob URL. Bundle dependencies with esbuild.
 */

/** pluginId -> loaded plugin module, so Settings can enable/disable live. */
const loaded = new Map();

/** pluginId -> digest of the content currently loaded. */
const loadedDigest = new Map();

/**
 * pluginId -> digest of the content whose load FAILED.
 *
 * Retrying the same bytes on every rescan would only repeat the same error, so
 * a failure is remembered until the content changes — which is exactly when a
 * retry can plausibly succeed.
 */
const failedDigest = new Map();

/** Get a loaded (builtin-independent) plugin module by id, or null. */
export function getExternal(id) {
  return loaded.get(id) || null;
}

/**
 * Revoke a removed plugin's native grant.
 *
 * Without this the permission registry keeps it forever, so a plugin that was
 * uninstalled from disk would still be authorised to call the host.
 */
async function revokeNativeGrant(id) {
  try {
    await hub.request(HOST_ID, 'host', 'unregister', { plugin: id });
  } catch (e) {
    console.error(`[external] could not revoke the grant for ${id}`, e);
  }
}

function dropPluginRow(id) {
  const i = store.plugins.findIndex((p) => p.manifest.id === id);
  if (i >= 0) store.plugins.splice(i, 1);
  sortPluginList();
}

/** Import a plugin's entry through a Blob URL, then release the URL. */
async function importEntry(item) {
  const code = await invoke('plugin_read_entry', {
    dir: item.dir,
    entryFile: item.entry_file,
  });
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
    // plugin.json is authoritative for the declarative fields (id, permissions,
    // contributes) — see mergeManifest in lifecycle.js.
    return await loadPlugin(url, { declarative: item.manifest });
  } finally {
    // The module graph is fetched during import, so the URL is dead weight
    // afterwards — without this, every reload would leak one.
    URL.revokeObjectURL(url);
  }
}

function rememberFailure(item, e) {
  failedDigest.set(item.id, item.digest);
  console.error(`[external] load failed for ${item.id}`, e);
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
 * Reconcile the loaded set with what is on disk.
 *
 * Returns a summary rather than the raw scan, so the caller can report what
 * actually happened instead of "N plugin(s) found" — which was the same number
 * whether the rescan changed anything or not.
 */
export async function scanExternalPlugins({ silent = true } = {}) {
  const summary = {
    found: 0,
    added: [],
    reloaded: [],
    unchanged: [],
    removed: [],
    failed: [],
  };

  let list = [];
  try {
    list = await invoke('plugin_scan');
  } catch (e) {
    console.error('[external] scan failed', e);
    return summary;
  }
  summary.found = list.length;
  const onDisk = new Set(list.map((p) => p.id));

  // --- removed: known here, but no longer on disk ---
  // Includes plugins whose load previously failed: their error row should go
  // when the folder does.
  for (const id of [...new Set([...loaded.keys(), ...failedDigest.keys()])]) {
    if (onDisk.has(id)) continue;
    const plugin = loaded.get(id);
    if (plugin) await deactivate(plugin, { silent: true });
    loaded.delete(id);
    loadedDigest.delete(id);
    failedDigest.delete(id);
    await revokeNativeGrant(id);
    dropPluginRow(id);
    summary.removed.push(id);
  }

  // --- added / changed / unchanged / failed ---
  for (const item of list) {
    const isLoaded = loaded.has(item.id);

    if (isLoaded && loadedDigest.get(item.id) === item.digest) {
      summary.unchanged.push(item.id);
      continue;
    }
    if (!isLoaded && failedDigest.get(item.id) === item.digest) {
      summary.failed.push(item.id); // the same bytes that failed before
      continue;
    }

    try {
      if (isLoaded) {
        // Stop the old instance first: it may hold hotkeys, streams and views,
        // and the new manifest may declare a different set.
        await deactivate(loaded.get(item.id), { silent: true });
        loaded.delete(item.id);
        loadedDigest.delete(item.id);
        dropPluginRow(item.id); // so the new manifest is what shows up
      }
      const plugin = await importEntry(item);
      loaded.set(item.id, plugin);
      loadedDigest.set(item.id, item.digest);
      failedDigest.delete(item.id);
      // A reload keeps the persisted enable state, so dropping new bytes into a
      // deliberately disabled plugin does not switch it back on.
      if (adoptNewPlugin(item.id)) await activate(plugin, { silent });
      (isLoaded ? summary.reloaded : summary.added).push(item.id);
    } catch (e) {
      summary.failed.push(item.id);
      rememberFailure(item, e);
    }
  }

  if (!store.activeViewId && store.views.length) {
    store.activeViewId = store.views[0].viewId;
  }
  return summary;
}
