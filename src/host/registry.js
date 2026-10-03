/**
 * Built-in plugin registry: id -> module source.
 * Static imports keep first-party plugins bundled with the app; external
 * plugins (app_data_dir/plugins/*) join via Blob-URL dynamic import.
 *
 * ## Kept deliberately small
 *
 * A built-in is code the user cannot uninstall and that every boot pays for, so
 * it has to earn its place by covering part of the message plane that nothing
 * else covers:
 *
 *   procman    pty (pty-stream) + sidecar-free multi-process management
 *   streamlab  channel-json / channel-raw / stdio-line / in-process, side by side
 *
 * That is now the whole list. `notepad`, `eyecare` and `floatwin` used to be
 * here too — three working demos, but demos: a notepad, a break-timer overlay
 * and a floating widget are not parts of the message plane, and each one cost
 * every boot. A plugin a user wants is a plugin a user can install; the place
 * to learn the framework from is `tests/fixtures/plugins/`.
 *
 * So the rule for adding one: **it must exercise a scheme that nothing else in
 * this table exercises.** "It is a nice feature" is not a reason — that is what
 * the plugins directory is for.
 */
import procman from '../plugins/procman.js';
import streamlab from '../plugins/streamlab.js';

const REGISTRY = new Map(
  [procman, streamlab].map((mod) => [mod.manifest.id, mod]),
);

export function resolveBuiltin(id) {
  return REGISTRY.get(id) || null;
}

export function builtinSources() {
  return [...REGISTRY.values()];
}
