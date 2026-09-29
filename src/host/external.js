/**
 * The DISK half of the plugin loader: finding external plugins, and getting one
 * plugin's code into the app.
 *
 * This module holds **no state**. "Which plugins are loaded, and where did each
 * come from" belongs to exactly one place — `host/plugins.js` — because it used
 * to be two (a map here for externals, `registry.js`'s REGISTRY for built-ins),
 * and every caller that wanted a plugin module had to remember both.
 *
 * What stays here is what only the disk path knows:
 *
 *   scanExternal()   ask the native scanner what is in {appData}/plugins
 *   importEntry()    read one entry file and import it through a Blob URL
 *   revokeGrant()    drop a removed plugin's native permission grant
 *
 * Loading is `loadPlugin` (lifecycle.js) either way. The one thing that makes an
 * external plugin different is that its bytes arrive over IPC and become a Blob
 * URL — so it can import nothing, which is why every capability it uses has to
 * be handed to it. See `examples/README.md`.
 */

import { invoke } from '@tauri-apps/api/core';

import { loadPlugin } from './lifecycle.js';
import { hub } from '../protocol/hub.js';

/** Host identity: the only caller allowed to revoke a plugin registration. */
const HOST_ID = '__host__';

/**
 * Everything the native scanner sees under {appData}/plugins.
 *
 * The digest is computed natively over the manifest **and** the entry file, so a
 * caller can tell "unchanged" from "changed" without reading the entry itself —
 * which is the point: an unchanged rescan costs one call, not one read per plugin.
 */
export async function scanExternal() {
  return invoke('plugin_scan');
}

/**
 * Import a plugin's entry through a Blob URL, then release the URL.
 *
 * `item.manifest` (plugin.json) is passed as `declarative` because it is
 * authoritative for the declarative fields — see `mergeManifest`.
 */
export async function importEntry(item) {
  const code = await invoke('plugin_read_entry', {
    dir: item.dir,
    entryFile: item.entry_file,
  });
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
    return await loadPlugin(url, { declarative: item.manifest });
  } finally {
    // The module graph is fetched during import, so the URL is dead weight
    // afterwards — without this, every reload would leak one.
    URL.revokeObjectURL(url);
  }
}

/**
 * Revoke a removed plugin's native grant.
 *
 * Without this the permission registry keeps it forever, so a plugin that was
 * uninstalled from disk would still be authorised to call the host.
 */
export async function revokeGrant(id) {
  try {
    await hub.request(HOST_ID, 'host', 'unregister', { plugin: id });
  } catch (e) {
    console.error(`[external] could not revoke the grant for ${id}`, e);
  }
}
