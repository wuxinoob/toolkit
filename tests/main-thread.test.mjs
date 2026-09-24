/**
 * No command may run on the main thread.
 *
 * ## Why this is a test and not a comment
 *
 * Tauri runs a `#[tauri::command]` **without** the `async` keyword on the main
 * thread — the same thread that pumps window messages for every webview in the
 * process. The docs are explicit:
 *
 *   "Async commands are executed on a separate async task using
 *    `async_runtime::spawn`. Commands without the *async* keyword are executed
 *    on the main thread unless defined with `#[tauri::command(async)]`."
 *
 * A blocked main thread cannot drag, resize or repaint a window, and it takes
 * every OTHER window down with it, because the thread is shared. So the symptom
 * of getting this wrong is never "a command blocked" — it is "the whole UI is
 * laggy", which is indistinguishable from a dozen other causes. That is exactly
 * the kind of rule a machine has to hold, because a human reading the code sees
 * `fn plugin_rpc(...)` and has no reason to think about threads.
 *
 * It really happened: `plugin_rpc` — the gateway EVERY plugin call goes through
 * — was a plain `fn`, and the services behind it do blocking file I/O
 * (`storage/*` reads and rewrites the store, `host/write_debug_log` opens and
 * appends a file per line, `bus/publish` posts to every window). The main
 * window felt stuck, and the plugin windows felt stuck too, because there was
 * one thread doing all of it.
 *
 * ## The second half: `async` alone is not enough
 *
 * `async` moves the work off the main thread, which is the fix for the UI. But
 * the work is *blocking*, and a blocking call inside an async task parks a
 * runtime WORKER — and there are only as many of those as there are CPU cores.
 * A burst of storage calls would then stall every other async task in the app.
 * So the I/O-bearing commands also route through the blocking pool, and that is
 * asserted separately below.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SRC = fileURLToPath(new URL('../src-tauri/src/', import.meta.url));

/** Every `.rs` file under `src-tauri/src`, recursively. */
function rustFiles(dir = SRC) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...rustFiles(full));
    else if (entry.endsWith('.rs')) out.push(full);
  }
  return out;
}

/**
 * Command declarations in one source file.
 *
 * Matches the attribute and the `fn` it decorates, allowing `pub`, an `async`
 * keyword, and the `#[tauri::command(async)]` form.
 */
function commandsIn(src) {
  const out = [];
  const re = /#\[tauri::command(?:\(([^)]*)\))?\]\s*(?:pub\s+)?(async\s+)?fn\s+([a-z0-9_]+)/g;
  let m;
  while ((m = re.exec(src))) {
    out.push({ name: m[3], async: Boolean(m[2]) || /\basync\b/.test(m[1] ?? '') });
  }
  return out;
}

test('every tauri command is async, so none of them runs on the main thread', () => {
  const offenders = [];
  let total = 0;

  for (const file of rustFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const cmd of commandsIn(src)) {
      total += 1;
      if (!cmd.async) offenders.push(`${file.slice(SRC.length)}: ${cmd.name}`);
    }
  }

  // A guard on the guard: if the regex stops matching (the attribute is written
  // differently, the files moved), this test would pass by finding nothing.
  assert.ok(total >= 8, `expected to find the command surface, found ${total}`);
  assert.deepEqual(
    offenders,
    [],
    `these commands run on the main thread and will stall every window: ${offenders.join(', ')}`,
  );
});

test('the gateway keeps its blocking work off the async workers too', () => {
  // `async` alone frees the main thread but parks a runtime worker for the
  // duration of the file I/O, and there is one worker per core. The blocking
  // pool is the right home, and it is the difference between "queues" and
  // "starves everything else".
  const lib = readFileSync(join(SRC, 'lib.rs'), 'utf8');
  const start = lib.indexOf('async fn plugin_rpc');
  assert.ok(start > 0, 'plugin_rpc should be an async fn');

  const body = lib.slice(start, lib.indexOf('\n}\n', start));
  assert.match(
    body,
    /spawn_blocking/,
    'the service table does blocking I/O; it must not run on an async worker',
  );
  // And the permission gate must still be OUTSIDE the closure, so a denied call
  // is rejected without ever reaching the blocking pool.
  const gate = body.indexOf('is_allowed');
  const spawn = body.indexOf('spawn_blocking');
  assert.ok(gate > 0 && gate < spawn, 'the permission gate runs before the blocking hop');
});

test('the scan, lookup and entry-read commands go through the blocking pool', () => {
  // These three are the file I/O in the app: `plugin_scan` walks the plugins
  // directory and reads each plugin's manifest AND its entire entry file (the
  // digest needs the bytes), `plugin_info` walks it reading manifests only, and
  // `plugin_read_entry` reads one entry. The scan runs at boot and every time a
  // plugin window opens; on the main thread that is a frozen window at the exact
  // moment the user is waiting for one.
  const src = readFileSync(join(SRC, 'services', 'external.rs'), 'utf8');
  for (const name of ['plugin_scan', 'plugin_info', 'plugin_read_entry']) {
    const start = src.indexOf(`async fn ${name}`);
    assert.ok(start > 0, `${name} should be an async fn`);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    assert.match(body, /spawn_blocking/, `${name} must use the blocking pool`);
  }
});
