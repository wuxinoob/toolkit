/**
 * The plugin catalogue: the bookkeeping shared by both kinds of plugin, and the
 * digest-driven half that only an external plugin can have.
 *
 * A rescan used to only DISCOVER: new plugins loaded, changed ones were skipped
 * (so dropping new bytes in did nothing until a restart), removed ones stayed
 * loaded, and a plugin that failed to load was never retried because its row
 * already existed.
 *
 * These drive the real `reconcilePlugins`, the real `loadPlugin` and the real
 * lifecycle. Only the Tauri boundary is mocked. `URL.createObjectURL` is
 * redirected to a `data:` URL so Node can actually import the plugin source.
 *
 * Two notes on names:
 *
 *   - This file was `external-reconcile.test.mjs`. It was renamed because the
 *     reconcile is no longer an external-only idea: `plugins.js` owns the loaded
 *     set for BOTH sources, and this is the spec for that.
 *   - The assertions below are unchanged, and the local helper still spells the
 *     call the old way, so the diff shows "same assertions, new loader" rather
 *     than a rewrite. The built-in half of the catalogue is pinned in
 *     `boot.test.mjs`, which already has a boot-compatible gateway.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// `lifecycle.js` now pulls in the component factory (host/ui.js -> Vue SFCs +
// `import.meta.glob`), none of which Node can resolve. The stub loader fakes the
// rendering but keeps every tag name real, so the kernel tests still exercise
// the actual activation path.
register('./browser-stubs-loader.mjs', import.meta.url);


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
const { Origin, originOf, pluginModule, reconcilePlugins, reloadPlugin } = await import(
  '../src/host/plugins.js'
);
const { store } = await import('../src/host/store.js');
const { saveEnabled, saveKnown } = await import('../src/host/lifecycle.js');

/**
 * The external half of a reconcile — what most of this file is about.
 *
 * Kept under the old name so the assertions below read exactly as they did when
 * this drove `scanExternalPlugins` directly. The only rename is
 * `getExternal(id)` → `pluginModule(id)`; everything else is the same call
 * through the new catalogue.
 */
const scanExternalPlugins = async (opts = {}) =>
  (await reconcilePlugins({ silent: true, ...opts, sources: [Origin.EXTERNAL] })).external;

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
  const first = pluginModule('a.demo');
  assert.ok(first, 'the plugin was loaded');
  assert.equal(row('a.demo')?.status, 'active');

  // 2. unchanged: the same digest must leave it entirely alone
  const readsBefore = reads();
  const registersBefore = invokeCalls.filter((c) => c.cmd === 'plugin_register').length;
  r = await scanExternalPlugins({ silent: true });
  assert.deepEqual(r.unchanged, ['a.demo']);
  assert.deepEqual(r.added, []);
  assert.equal(pluginModule('a.demo'), first, 'the module instance is untouched');
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
  assert.notEqual(pluginModule('a.demo'), first, 'a fresh module instance was imported');
  assert.equal(row('a.demo')?.status, 'active');

  // 4. removed: unload, drop the row, revoke the native grant
  scanList = [];
  r = await scanExternalPlugins({ silent: true });
  assert.deepEqual(r.removed, ['a.demo']);
  assert.equal(pluginModule('a.demo'), null);
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

// ------------------------- the catalogue's shared half -------------------------

test('catalogue: an external plugin reports its origin, and resolves to its module', async () => {
  reset();
  scanList = [entry('cat.demo', 'c1', SOURCE('cat.demo'))];
  await scanExternalPlugins({ silent: true });

  assert.equal(originOf('cat.demo'), Origin.EXTERNAL);
  assert.equal(pluginModule('cat.demo')?.manifest.id, 'cat.demo');
  // The row and the catalogue must not be able to disagree about which kind a
  // plugin is — the row drives sorting, the catalogue drives behaviour.
  assert.equal(row('cat.demo').manifest.builtin, false, 'the row says external too');
});

test('catalogue: reloadPlugin re-imports an external plugin with unchanged bytes', async () => {
  reset();

  // This is the capability the digest path deliberately does NOT have: a rescan
  // skips bytes it has already seen, so before reloadPlugin there was no way to
  // make a plugin start over without editing its file.
  scanList = [entry('r.demo', 'same', SOURCE('r.demo'))];
  await scanExternalPlugins({ silent: true });
  const first = pluginModule('r.demo');

  const readsBefore = reads();
  const rescan = await scanExternalPlugins({ silent: true });
  assert.deepEqual(rescan.unchanged, ['r.demo']);
  assert.equal(reads(), readsBefore, 'a rescan still skips unchanged bytes');

  const out = await reloadPlugin('r.demo', { silent: true });
  assert.equal(out.origin, Origin.EXTERNAL);
  assert.equal(reads(), readsBefore + 1, 'the reload re-read the entry file');
  assert.equal(row('r.demo')?.status, 'active');

  // Deliberately NOT asserted: "a fresh module instance". The first test in this
  // file CAN assert it, because there the bytes changed and so did the stub's
  // data URL. Here the bytes are identical, and Node caches a module by its
  // specifier — so this environment hands back the same instance. Production
  // does not: a real `createObjectURL` is unique per call, which is exactly why
  // the loader can revoke it immediately afterwards. The env-independent
  // difference between Rescan and Reload is the extra read, and that is what is
  // pinned above.
  void first;
});

test('catalogue: reloadPlugin respects a disabled plugin instead of switching it on', async () => {
  reset();
  saveKnown(['r2.demo']);
  saveEnabled([]);

  scanList = [entry('r2.demo', 'd1', SOURCE('r2.demo'))];
  await scanExternalPlugins({ silent: true });
  assert.equal(row('r2.demo')?.status, 'inactive');

  await reloadPlugin('r2.demo', { silent: true });
  assert.ok(pluginModule('r2.demo'), 'the reload loads it');
  assert.equal(row('r2.demo')?.status, 'inactive', 'but must not enable it');
});

test('catalogue: reloadPlugin refuses an id nothing knows about', async () => {
  reset();
  await assert.rejects(() => reloadPlugin('nobody.demo'), /not loaded/);
});
