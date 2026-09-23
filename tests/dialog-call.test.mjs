/**
 * Does a plugin's `ctx.files.*` call actually REACH the host?
 *
 * The rest of `file-access.test.mjs` checks shapes by reading source, which
 * cannot tell a correct `invoke('plugin_dialog', {…})` from a typo'd command
 * name or a wrong argument. This file closes that gap the same way
 * `boot.test.mjs` does: shim `window.__TAURI_INTERNALS__.invoke` and record the
 * calls.
 *
 * Deliberately NOT a stub of `@tauri-apps/api/core` — see the note in
 * `browser-stubs-loader.mjs`. Keeping the real module in play is what makes the
 * recorder see anything at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

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

// What the fake host answers, per command.
let replies = {};
const calls = [];

globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      if (Object.prototype.hasOwnProperty.call(replies, cmd)) return replies[cmd];
      throw new Error(`unexpected invoke: ${cmd}`);
    },
    transformCallback: (cb) => {
      void cb;
      return 1;
    },
    unregisterCallback: () => {},
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main', windowLabel: 'main' },
    },
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
};

// Enough DOM for module evaluation. The view render functions are never called
// here — this file is about the CALL, not the UI.
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({
    style: {},
    className: '',
    textContent: '',
    innerHTML: '',
    addEventListener() {},
    appendChild(c) {
      return c;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  }),
  head: { appendChild() {} },
  body: { appendChild() {}, style: {} },
  documentElement: { style: {}, setAttribute() {}, removeAttribute() {} },
};
globalThis.requestAnimationFrame ||= (fn) => setTimeout(() => fn(0), 0);
globalThis.cancelAnimationFrame ||= (id) => clearTimeout(id);

register('./browser-stubs-loader.mjs', import.meta.url);
const { buildCtx } = await import('../src/host/ctx.js');

const disposer = { track() {}, dispose() {} };

/** A ctx with `rpc:dialog` declared. */
function makeCtx(id = 'test.dialog', permissions = ['rpc:dialog']) {
  return buildCtx({ manifest: { id, permissions } }, disposer);
}

/** Run `body` with a fresh call log and canned replies. */
async function withHost(replyTable, body) {
  calls.length = 0;
  replies = replyTable;
  try {
    return await body();
  } finally {
    replies = {};
  }
}

test('ctx.files.pick() reaches plugin_dialog with the right shape', async () => {
  const ctx = makeCtx();
  const paths = await withHost({ plugin_dialog: { paths: ['C:/a.txt'], cancelled: false } }, () =>
    ctx.files.pick({ multiple: true, title: 'Pick' }),
  );

  assert.equal(calls.length, 1, 'exactly one host call');
  assert.equal(calls[0].cmd, 'plugin_dialog');
  assert.equal(calls[0].args.pluginId, 'test.dialog');
  assert.equal(calls[0].args.action, 'open');
  assert.equal(calls[0].args.params.multiple, true);
  assert.equal(calls[0].args.params.title, 'Pick');
  assert.deepEqual(paths, ['C:/a.txt'], 'the host answer is what the plugin gets');
});

test('ctx.files.pick() normalises a cancel to an empty array', async () => {
  const ctx = makeCtx();
  const paths = await withHost({ plugin_dialog: { paths: [], cancelled: true } }, () =>
    ctx.files.pick(),
  );
  assert.deepEqual(paths, [], 'a cancel must not surface as null/undefined');
});

test('ctx.files.save() returns the path, and null on cancel', async () => {
  const ctx = makeCtx();
  const saved = await withHost({ plugin_dialog: { path: 'C:/out.txt', cancelled: false } }, () =>
    ctx.files.save({ defaultPath: 'out.txt' }),
  );
  assert.equal(saved, 'C:/out.txt');
  assert.equal(calls[0].args.action, 'save');
  assert.equal(calls[0].args.params.defaultPath, 'out.txt');

  const cancelled = await withHost({ plugin_dialog: { path: null, cancelled: true } }, () =>
    ctx.files.save(),
  );
  assert.equal(cancelled, null);
});

test('ctx.files.message() carries the text and title', async () => {
  const ctx = makeCtx();
  await withHost({ plugin_dialog: { shown: true } }, () =>
    ctx.files.message('hello', { title: 'T' }),
  );
  assert.equal(calls[0].args.action, 'message');
  assert.equal(calls[0].args.params.message, 'hello');
  assert.equal(calls[0].args.params.title, 'T');
});

test('a plugin WITHOUT rpc:dialog is stopped before the host is called', async () => {
  // The JS gate is the fast one; the Rust gate is the authoritative one. This
  // pins the fast one: an undeclared plugin must not even emit the call, so a
  // mis-declared plugin fails loudly and locally rather than being denied
  // later and looking like a host bug.
  const ctx = makeCtx('test.nodialog', []);
  await withHost({ plugin_dialog: { paths: [] } }, async () => {
    await assert.rejects(() => ctx.files.pick(), /rpc:dialog/);
  });
  assert.deepEqual(calls, [], 'no host call should have been made');
});

test('a host-side failure surfaces to the plugin, not swallowed', async () => {
  const ctx = makeCtx();
  await withHost({}, async () => {
    // No canned reply → the shim throws `unexpected invoke`.
    await assert.rejects(() => ctx.files.pick(), /unexpected invoke/);
  });
});
