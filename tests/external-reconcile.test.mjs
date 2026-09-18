/**
 * Reconciliation tests for the external plugin loader.
 *
 * A rescan used to only DISCOVER: new plugins loaded, changed ones were skipped
 * (so dropping new bytes in did nothing until a restart), removed ones stayed
 * loaded, and a plugin that failed to load was never retried because its row
 * already existed.
 *
 * These drive the real `scanExternalPlugins`, the real `loadPlugin` and the real
 * lifecycle. Only the Tauri boundary is mocked. `URL.createObjectURL` is
 * redirected to a `data:` URL so Node can actually import the plugin source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ------------------------------ environment shims -----------------------------
const callbacks = new Map();
let cbSeq = 0;
const invokeCalls = [];
let scanList = [];
const entrySources = new Map();
let invokeImpl = async (cmd) => {
  throw new Error(`unexpected invoke: ${cmd}`);
};

globalThis.localStorage = {
  store: new Map(),
  getItem(k) {
    return this.store.has(k) ? this.store.get(k) : null;
  },
  setItem(k, v) {
    this.store.set(k, String(v));
  },
  removeItem(k) {
    this.store.delete(k);
  },
  clear() {
    this.store.clear();
  },
};

globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => {
      invokeCalls.push({ cmd, args });
      return invokeImpl(cmd, args);
    },
    transformCallback: (cb) => {
      const id = ++cbSeq;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main', windowLabel: 'main' },
    },
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
};

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
  documentElement: { style: {} },
};
globalThis.requestAnimationFrame ||= (fn) => setTimeout(() => fn(0), 0);

// Blob URLs cannot be imported by Node, so hand out data: URLs instead — the
// real loader path (Blob -> createObjectURL -> dynamic import) still runs.
globalThis.Blob = class Blob {
  constructor(parts, opts = {}) {
    this.parts = parts;
    this.type = opts.type;
  }
};
globalThis.URL.createObjectURL = (blob) =>
  `data:text/javascript;base64,${Buffer.from(blob.parts.join(''), 'utf8').toString('base64')}`;
globalThis.URL.revokeObjectURL = () => {};

// dynamic imports AFTER shims are in place
const { scanExternalPlugins, getExternal } = await import('../src/host/external.js');
const { store } = await import('../src/host/store.js');
const { saveEnabled, saveKnown } = await import('../src/host/lifecycle.js');

// --------------------------------- helpers ------------------------------------

function installGateway() {
  invokeImpl = async (cmd, args) => {
    if (cmd === 'plugin_scan') return scanList;
    if (cmd === 'plugin_read_entry') {
      const src = entrySources.get(args.dir);
      if (src === undefined) throw new Error(`no entry source for ${args.dir}`);
      return src;
    }
    if (cmd === 'plugin_register') return null;
    if (cmd === 'plugin:event|listen') return 1;
    if (cmd === 'plugin:event|unlisten') return null;
    if (cmd.startsWith('plugin:global-shortcut')) return null;
    if (cmd === 'plugin_rpc') {
      const { msg } = args;
      return { v: 1, kind: 'res', id: msg.id, p: { ok: true } };
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  };
}

const SOURCE = (id) => `export const manifest = {
  id: '${id}', name: '${id}', api: 2, permissions: [],
  contributes: { views: [] },
};
export function activate() {}
export function deactivate() {}
export default { manifest, activate, deactivate };
`;

function entry(id, digest, source) {
  const dir = `/plugins/${id}`;
  entrySources.set(dir, source);
  return {
    id,
    dir,
    entry_file: 'main.js',
    manifest: { id, name: id, version: '1.0.0', api: 2, permissions: [], contributes: { views: [] } },
    digest,
  };
}

function reset() {
  installGateway();
  localStorage.clear();
  store.plugins.length = 0;
  store.views.length = 0;
  store.activeViewId = null;
  invokeCalls.length = 0;
}

const row = (id) => store.plugins.find((p) => p.manifest.id === id);
const reads = () => invokeCalls.filter((c) => c.cmd === 'plugin_read_entry').length;

// ----------------------------------- tests ------------------------------------

test('a rescan reconciles: added, unchanged, reloaded, removed', async () => {
  reset();

  // 1. added
  scanList = [entry('a.demo', 'd1', SOURCE('a.demo'))];
  let r = await scanExternalPlugins({ silent: true });
  assert.deepEqual(r.added, ['a.demo']);
  assert.equal(r.found, 1);
  const first = getExternal('a.demo');
  assert.ok(first, 'the plugin was loaded');
  assert.equal(row('a.demo')?.status, 'active');

  // 2. unchanged: the same digest must leave it entirely alone
  const readsBefore = reads();
  const registersBefore = invokeCalls.filter((c) => c.cmd === 'plugin_register').length;
  r = await scanExternalPlugins({ silent: true });
  assert.deepEqual(r.unchanged, ['a.demo']);
  assert.deepEqual(r.added, []);
  assert.equal(getExternal('a.demo'), first, 'the module instance is untouched');
  assert.equal(reads(), readsBefore, 'an unchanged rescan must not re-read the entry');
  assert.equal(
    invokeCalls.filter((c) => c.cmd === 'plugin_register').length,
    registersBefore,
    'nor re-register it',
  );

  // 3. changed: new bytes -> deactivate the old, import the new
  scanList = [entry('a.demo', 'd2', `${SOURCE('a.demo')}// changed`)];
  r = await scanExternalPlugins({ silent: true });
  assert.deepEqual(r.reloaded, ['a.demo']);
  assert.notEqual(getExternal('a.demo'), first, 'a fresh module instance was imported');
  assert.equal(row('a.demo')?.status, 'active');

  // 4. removed: unload, drop the row, revoke the native grant
  scanList = [];
  r = await scanExternalPlugins({ silent: true });
  assert.deepEqual(r.removed, ['a.demo']);
  assert.equal(getExternal('a.demo'), null);
  assert.equal(row('a.demo'), undefined, 'the row is gone');
  const revoked = invokeCalls.filter(
    (c) => c.cmd === 'plugin_rpc' && c.args?.msg?.svc === 'host' && c.args.msg.act === 'unregister',
  );
  assert.equal(revoked.length, 1, 'the native grant is revoked exactly once');
  assert.equal(revoked[0].args.msg.p.plugin, 'a.demo');
});

test('a failed load is remembered until the content changes', async () => {
  reset();

  scanList = [entry('bad.demo', 'b1', 'throw new Error("nope");')];
  let r = await scanExternalPlugins({ silent: true });
  assert.deepEqual(r.failed, ['bad.demo']);
  assert.equal(row('bad.demo')?.status, 'error');
  assert.equal(reads(), 1);

  // the same bytes are not retried — that would only repeat the same error
  r = await scanExternalPlugins({ silent: true });
  assert.deepEqual(r.failed, ['bad.demo']);
  assert.equal(reads(), 1, 'an unchanged failure must not be retried');

  // fixed content is retried, and now succeeds
  scanList = [entry('bad.demo', 'b2', SOURCE('bad.demo'))];
  r = await scanExternalPlugins({ silent: true });
  assert.deepEqual(r.added, ['bad.demo']);
  assert.equal(row('bad.demo')?.status, 'active');
});

test('a reload does not switch a deliberately disabled plugin back on', async () => {
  reset();
  // known (so it is not "newly discovered") but explicitly disabled
  saveKnown(['off.demo']);
  saveEnabled([]);

  scanList = [entry('off.demo', 'd1', SOURCE('off.demo'))];
  let r = await scanExternalPlugins({ silent: true });
  assert.deepEqual(r.added, ['off.demo']);
  assert.equal(row('off.demo')?.status, 'inactive', 'a disabled plugin is loaded but not activated');

  scanList = [entry('off.demo', 'd2', `${SOURCE('off.demo')}// v2`)];
  r = await scanExternalPlugins({ silent: true });
  assert.deepEqual(r.reloaded, ['off.demo']);
  assert.equal(
    row('off.demo')?.status,
    'inactive',
    'dropping new bytes in must not enable it',
  );
});

test('a plugin removed from disk while failed also loses its row', async () => {
  reset();

  scanList = [entry('gone.demo', 'g1', 'throw new Error("nope");')];
  await scanExternalPlugins({ silent: true });
  assert.equal(row('gone.demo')?.status, 'error');

  scanList = [];
  const r = await scanExternalPlugins({ silent: true });
  assert.deepEqual(r.removed, ['gone.demo']);
  assert.equal(row('gone.demo'), undefined, 'the error row goes with the folder');
});
