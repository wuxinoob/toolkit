import { invoke } from '@tauri-apps/api/core';

import { loadPlugin, activate, adoptNewPlugin } from './lifecycle.js';
import { store } from './store.js';

/**
 * External plugin loading.
 *   Rust scans {appData}/plugins/*  ->  entry JS source  ->  Blob URL
 *   ->  dynamic import  ->  normal lifecycle (registration, views, settings).
 *
 * Adding a new plugin requires ZERO host code changes: drop a folder with
 * plugin.json + a single-file bundled ESM entry, then Rescan.
 *
 * Limitation (by design): the entry must be a single ESM file — bare/relative
 * imports cannot resolve from a Blob URL. Bundle dependencies with esbuild.
 */

/** pluginId -> loaded plugin module, so Settings can enable/disable live. */
const loaded = new Map();

/** Get a loaded (builtin-independent) plugin module by id, or null. */
export function getExternal(id) {
  return loaded.get(id) || null;
}

export async function scanExternalPlugins({ silent = true } = {}) {
  let list = [];
  try {
    list = await invoke('plugin_scan');
  } catch (e) {
    console.error('[external] scan failed', e);
    return [];
  }

  for (const item of list) {
    if (store.plugins.some((p) => p.manifest.id === item.id)) continue; // already loaded
    try {
      const code = await invoke('plugin_read_entry', {
        dir: item.dir,
        entryFile: item.entry_file,
      });
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      // plugin.json is authoritative for the declarative fields (id,
      // permissions, contributes) — see mergeManifest in lifecycle.js.
      const plugin = await loadPlugin(url, { declarative: item.manifest });
      loaded.set(plugin.manifest.id, plugin);
      // First sighting -> enabled (see adoptNewPlugin); a deliberate disable
      // from a previous run is honoured instead.
      if (adoptNewPlugin(plugin.manifest.id)) {
        await activate(plugin, { silent });
      }
    } catch (e) {
      console.error(`[external] load failed for ${item.id}`, e);
      store.plugins.push({
        manifest: {
          id: item.id,
          name: item.manifest?.name || item.id,
          version: item.manifest?.version || '?',
          builtin: false,
        },
        status: 'error',
        error: String(e),
      });
    }
  }

  if (!store.activeViewId && store.views.length) {
    store.activeViewId = store.views[0].viewId;
  }
  return list;
}
