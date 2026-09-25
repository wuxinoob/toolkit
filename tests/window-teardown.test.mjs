/**
 * A plugin's windows belong to the host once they exist.
 *
 * Every other resource a plugin acquires is tracked for teardown — streams,
 * sidecars, ptys, subscriptions, hotkeys, views — and windows were the one that
 * was NOT. So disabling a plugin left its windows on screen with nobody able to
 * close them: the plugin's JS context is gone, and the tray only knows about
 * `main`. A plugin that closes its own windows in `deactivate()` still does; this
 * is the backstop for one that forgets, and it is what makes "disable" mean the
 * same thing for every resource.
 *
 * ## Why this shims the global rather than the API module
 *
 * `browser-stubs-loader.mjs` spells it out: the real `@tauri-apps/api` is a thin
 * wrapper over `window.__TAURI_INTERNALS__`, so shimming THAT keeps the layer
 * under test real. Stubbing the module would replace the very code being
 * checked.
 *
 * It is a separate file from `window-options.test.mjs` on purpose: that file's
 * tests rely on the absence of a host, so a shim installed there would change
 * what they mean.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Installed before any host module is imported — `ctx.js` reads localStorage at
// import time.
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) {
    return this._m.has(k) ? this._m.get(k) : null;
  },
  setItem(k, v) {
    this._m.set(k, String(v));
  },
  removeItem(k) {
    this._m.delete(k);
  },
  clear() {
    this._m.clear();
  },
};

const invokes = [];
let cbSeq = 0;
const callbacks = new Map();

/** No windows exist unless a test says so, so `create` takes the construct path. */
let existingWindows = [];

globalThis.window = globalThis.window || {};
globalThis.window.__TAURI_INTERNALS__ = {
  invoke: async (cmd, args) => {
    invokes.push({ cmd, args });
    if (cmd === 'plugin:window|get_all_windows') return existingWindows;
    return null;
  },
  transformCallback: (cb) => {
    const id = ++cbSeq;
    callbacks.set(id, cb);
    return id;
  },
  metadata: { currentWindow: { label: 'main' } },
};

register('./browser-stubs-loader.mjs', import.meta.url);
const { buildCtx } = await import('../src/host/ctx.js');

const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

const makeCtx = (id) => {
  const tracked = [];
  const disposer = { track: (fn) => tracked.push(fn), dispose() {} };
  return { tracked, ctx: buildCtx({ manifest: { id, permissions: ['win:manage'] } }, disposer) };
};

test('a window a plugin creates is handed to the disposer', async () => {
  const { tracked, ctx } = makeCtx('t.win');
  invokes.length = 0;

  // `buildCtx` already tracks things of its own (the UI kit's theme listener),
  // so this counts the DELTA: what the create adds.
  const before = tracked.length;

  // Deliberately not awaited: `create` resolves on a `tauri://created` event that
  // never fires without a real webview. The tracking happens before that, which
  // is the part under test.
  ctx.windows.create('plugin-t-win', { url: 'pluginwin.html?plugin=x' }).catch(() => {});
  await flush();

  const created = invokes.find((c) => c.cmd === 'plugin:webview|create_webview_window');
  assert.ok(created, `the window should have been created (saw ${invokes.map((c) => c.cmd)})`);
  assert.equal(tracked.length - before, 1, 'the created window must be tracked for teardown');

  // Running that disposer is exactly what `deactivate` does.
  invokes.length = 0;
  tracked[tracked.length - 1]();
  await flush();

  const closed = invokes.find((c) => c.cmd === 'plugin:window|close');
  assert.ok(closed, 'teardown must close the window');
  assert.equal(closed.args.label, 'plugin-t-win', 'and it must close the one it created');
});

test('an existing window is NOT tracked — it may belong to another plugin', async () => {
  const { tracked, ctx } = makeCtx('t.win2');
  invokes.length = 0;
  const before = tracked.length;

  // The label is already taken, so `create` reuses rather than constructs.
  existingWindows = ['plugin-t-shared'];
  try {
    const how = await ctx.windows.create('plugin-t-shared', { url: 'pluginwin.html?plugin=x' });
    assert.equal(how, 'exists', 'a taken label is reported, not recreated');
    assert.equal(
      tracked.length - before,
      0,
      'a window this call did not create must not be closed when this plugin goes away',
    );
  } finally {
    existingWindows = [];
  }
});
