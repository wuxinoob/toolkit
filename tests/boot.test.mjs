/**
 * Boot smoke test — runs the REAL boot path (host kernel + every built-in
 * plugin) under Node with a Tauri shim, so a JS-side boot failure is caught
 * deterministically instead of only being visible in a webview console.
 *
 * This is the layer the unit tests do not reach: `protocol.test.mjs` proves the
 * schemes, `host-kernel.test.mjs` proves the kernel, and this proves that the
 * kernel + the shipped plugins actually come up together.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// CSS imports and browser-only packages are a bundler concern; stub them
// before anything is loaded.
register('./browser-stubs-loader.mjs', import.meta.url);

// ------------------------------ environment shims -----------------------------
const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
  clear: () => ls.clear(),
};

const invokeCalls = [];
let invokeImpl = async (cmd) => {
  throw new Error(`unexpected invoke: ${cmd}`);
};

globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => {
      invokeCalls.push({ cmd, args });
      return invokeImpl(cmd, args);
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

// Enough DOM for the code that touches it during activate() (a log panel that
// is not mounted yet, and timers). View *render* functions are not called here.
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
globalThis.cancelAnimationFrame ||= (id) => clearTimeout(id);

// dynamic imports AFTER shims are in place
const { boot } = await import('../src/host/boot.js');
const { store } = await import('../src/host/store.js');
const { builtinSources } = await import('../src/host/registry.js');
const { deactivate } = await import('../src/host/lifecycle.js');
const { descriptors } = await import('../src/protocol/registry.js');
const { hub } = await import('../src/protocol/hub.js');

/**
 * Full host reset between tests.
 *
 * Clearing `store` is not enough: a plugin module caches its activation state
 * (`_ctx`), so a second boot would no-op and the test would assert against a
 * stale status. Deactivating also releases plugin timers (eyecare's 45-minute
 * interval, floatwin's status poll) which would otherwise keep this process
 * alive and hang the test runner.
 */
async function resetHost() {
  for (const mod of builtinSources()) {
    await deactivate(mod, { silent: true });
  }
  ls.clear();
  store.plugins.length = 0;
  store.views.length = 0;
  store.activeViewId = null;
}

after(async () => {
  // Teardown must not depend on whichever stub the last test installed: a
  // strict stub turns an unlisten during teardown into an unhandled rejection.
  installGateway();
  await resetHost();
});

/**
 * A gateway that behaves like the native one for the calls boot makes:
 * registrations, storage reads, and everything else answered with a `res`.
 */
function installGateway() {
  invokeImpl = async (cmd, args) => {
    if (cmd === 'plugin_register') return null;
    if (cmd === 'plugin_scan') return [];
    if (cmd === 'plugin:event|listen') return 1;
    if (cmd === 'plugin:event|unlisten') return null;
    if (cmd === 'global-shortcut' || cmd.startsWith('plugin:global-shortcut')) return null;
    if (cmd === 'plugin_rpc') {
      const { msg } = args;
      const p =
        msg.act === 'get' ? null : msg.act === 'keys' ? [] : msg.act === 'sessions' ? [] : true;
      return { v: 1, kind: 'res', id: msg.id, p };
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  };
}

// ----------------------------------- tests ------------------------------------

test('boot: every built-in plugin activates with no errors', async () => {
  await resetHost();
  installGateway();

  await boot();

  assert.equal(store.booted, true, 'boot must mark the store booted');

  const sources = builtinSources();
  assert.equal(sources.length, 5, 'five built-in plugins expected');
  for (const mod of sources) {
    const row = store.plugins.find((p) => p.manifest.id === mod.manifest.id);
    assert.ok(row, `plugin ${mod.manifest.id} never registered`);
    assert.equal(
      row.status,
      'active',
      `plugin ${mod.manifest.id} is ${row.status}${row.error ? ` — ${row.error}` : ''}`,
    );
  }
});

test('boot: the expected views are registered, one per declared view', async () => {
  const ids = store.views.map((v) => v.viewId).sort();
  for (const expected of [
    'builtin.eyecare/eyecare',
    'builtin.floatwin/floatwin',
    'builtin.notepad/notepad',
    'builtin.procman/procman',
    'builtin.streamlab/streamlab',
  ]) {
    assert.ok(ids.includes(expected), `view ${expected} missing (have ${ids.join(', ')})`);
  }
  // every registered view carries what the shell needs to render a nav item
  for (const v of store.views) {
    assert.ok(v.title && v.icon && v.pluginId && typeof v.render === 'function', `bad view ${v.viewId}`);
  }
});

test('boot: the scheme table is published for the diagnostics view', async () => {
  assert.equal(store.schemes.length, descriptors().length);
  assert.equal(store.schemes.length, 7);
  assert.deepEqual(
    store.schemes.map((s) => s.id),
    hub.transports(),
    'the published table must match the transport registry',
  );
});

test('boot: every plugin declares its permissions to the native host', async () => {
  const registrations = invokeCalls.filter((c) => c.cmd === 'plugin_register');
  assert.equal(registrations.length, 5, 'one registration per built-in plugin');
  for (const r of registrations) {
    assert.ok(r.args.pluginId, 'registration must carry a plugin id');
    assert.ok(Array.isArray(r.args.permissions), `${r.args.pluginId}: permissions must be an array`);
  }
  const ids = registrations.map((r) => r.args.pluginId).sort();
  assert.deepEqual(ids, [
    'builtin.eyecare',
    'builtin.floatwin',
    'builtin.notepad',
    'builtin.procman',
    'builtin.streamlab',
  ]);
});

test('boot: a plugin that throws on activate is contained, not fatal', async () => {
  // The blast radius of one bad plugin must be exactly one bad plugin: boot
  // still completes and the others still come up.
  await resetHost();

  invokeImpl = async (cmd, args) => {
    if (cmd === 'plugin_register') return null;
    if (cmd === 'plugin_scan') return [];
    if (cmd === 'plugin:event|listen') return 1;
    if (cmd.startsWith('plugin:global-shortcut')) return null;
    if (cmd === 'plugin_rpc') {
      const { msg } = args;
      // make storage reads explode for one plugin only
      if (args.pluginId === 'builtin.eyecare') {
        return { v: 1, kind: 'err', id: msg.id, code: 'storage/get', msg: 'simulated failure' };
      }
      return { v: 1, kind: 'res', id: msg.id, p: msg.act === 'get' ? null : true };
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  };

  await boot();

  assert.equal(store.booted, true, 'boot must still complete');
  const eyecare = store.plugins.find((p) => p.manifest.id === 'builtin.eyecare');
  assert.equal(eyecare.status, 'error', 'the failing plugin must be marked as an error');
  assert.ok(eyecare.error, 'the error must be recorded, not swallowed');
  const others = store.plugins.filter((p) => p.manifest.id !== 'builtin.eyecare');
  assert.ok(
    others.every((p) => p.status === 'active'),
    `other plugins must be unaffected: ${others.map((p) => `${p.manifest.id}=${p.status}`).join(', ')}`,
  );
  assert.ok(
    !store.views.some((v) => v.pluginId === 'builtin.eyecare'),
    'a failed plugin must not leave a view behind',
  );
});
