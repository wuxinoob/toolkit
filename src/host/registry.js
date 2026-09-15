/**
 * Built-in plugin registry: id -> module source.
 * Static imports keep first-party plugins bundled with the app; external
 * plugins (app_data_dir/plugins/*) join via Blob-URL dynamic import.
 *
 * Every built-in plugin exercises a different part of the message plane, so
 * the scheme table is covered end to end by shipped code:
 *   notepad    storage (rpc) + broadcast (event-bus)
 *   eyecare    storage + overlay + timers
 *   procman    pty (pty-stream) + sidecar-free multi-process management
 *   streamlab  channel-json / channel-raw / stdio-line / in-process, side by side
 *   floatwin   multi-window + broadcast instead of polling
 */
import notepad from '../plugins/notepad.js';
import eyecare from '../plugins/eyecare.js';
import procman from '../plugins/procman.js';
import streamlab from '../plugins/streamlab.js';
import floatwin from '../plugins/floatwin.js';

const REGISTRY = new Map(
  [notepad, eyecare, procman, streamlab, floatwin].map((mod) => [mod.manifest.id, mod]),
);

export function resolveBuiltin(id) {
  return REGISTRY.get(id) || null;
}

export function builtinSources() {
  return [...REGISTRY.values()];
}
