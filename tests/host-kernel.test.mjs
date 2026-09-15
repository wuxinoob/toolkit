/**
 * Host kernel unit tests (node --test, no Tauri runtime).
 *
 * A window/localStorage shim is installed BEFORE importing host modules, and
 * `invoke` is routed to a controllable mock, so the real kernel code runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

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
    transformCallback: (cb) => cb,
    unregisterCallback: () => {},
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
};

// dynamic imports AFTER shims are in place
const { events, resetEvents } = await import('../src/host/events.js');
const { logger } = await import('../src/core/logger.js');
const { buildCtx } = await import('../src/host/ctx.js');
const {
  loadPlugin,
  activate,
  deactivate,
  enabledIds,
  saveEnabled,
  registerWithHost,
  adoptNewPlugin,
} = await import('../src/host/lifecycle.js');
const { store } = await import('../src/host/store.js');
const { hub } = await import('../src/protocol/hub.js');
const { descriptors } = await import('../src/protocol/registry.js');

const disposerStub = { track() {} };

// --------------------------------- event bus ----------------------------------

test('events: on/emit/once/off', () => {
  resetEvents();
  let got = null;
  const off = events.on('t:ping', (p) => (got = p));
  events.emit('t:ping', 99);
  assert.equal(got, 99);

  let hits = 0;
  events.once('t:once', () => hits++);
  events.emit('t:once');
  events.emit('t:once');
  assert.equal(hits, 1, 'once must fire exactly one time');

  off();
  events.emit('t:ping', 0);
  assert.equal(got, 99, 'unsubscribed listener must not fire');
  assert.equal(events.count('t:ping'), 0);
});

// ---------------------------------- logger ------------------------------------

test('logger: ring capacity, filters, subscribe', () => {
  logger.clear();
  for (let i = 0; i < 900; i++) logger.debug('cap', `m${i}`);
  assert.ok(logger.dump().length <= 800, 'ring buffer must be capped');
  assert.equal(logger.dump({ level: 'error' }).length, 0);

  logger.error('cap', 'boom');
  assert.equal(logger.dump({ level: 'error' }).length, 1);
  assert.equal(logger.dump({ category: 'cap', limit: 5 }).length, 5);

  let seen = null;
  const unsub = logger.subscribe((e) => (seen = e));
  logger.info('sub', 'hello');
  assert.equal(seen?.message, 'hello');
  unsub();
  logger.info('sub', 'not seen');
  assert.equal(seen?.message, 'hello', 'unsubscribed sink must not fire');
  logger.clear();
});

// --------------------------- ctx permission gate -------------------------------

test('ctx: unpermitted rpc is rejected before reaching invoke', async () => {
  const before = invokeCalls.length;
  const ctx = buildCtx({ manifest: { id: 't.noperm', permissions: [] } }, disposerStub);
  await assert.rejects(() => ctx.storage.get('x'), /missing permission/);
  await assert.rejects(() => ctx.rpc('host', 'info', {}), /missing permission/);
  await assert.rejects(() => ctx.sidecar('c', { exe: 'x' }), /missing permission/);
  await assert.rejects(() => ctx.pty('c', { program: 'x' }), /missing permission/);
  await assert.rejects(() => ctx.windows.exists('floatwin'), /missing permission/);
  assert.equal(invokeCalls.length, before, 'no invoke may be issued for unpermitted calls');
});

test('ctx: storage routes a req envelope through plugin_rpc', async () => {
  invokeCalls.length = 0;
  invokeImpl = async (cmd, { msg }) =>
    msg.p?.key === 'k' ? { v: 1, kind: 'res', id: msg.id, p: { stored: msg.p.key } } : { v: 1, kind: 'res', id: msg.id, p: true };

  const ctx = buildCtx({ manifest: { id: 't.perm', permissions: ['rpc:storage'] } }, disposerStub);
  const out = await ctx.storage.get('k');
  assert.deepEqual(out, { stored: 'k' });

  const last = invokeCalls.at(-1);
  assert.equal(last.cmd, 'plugin_rpc');
  assert.equal(last.args.pluginId, 't.perm');
  // the uplink is the unified envelope, not an ad-hoc {service, action} shape
  assert.equal(last.args.msg.kind, 'req');
  assert.equal(last.args.msg.svc, 'storage');
  assert.equal(last.args.msg.act, 'get');
  assert.deepEqual(last.args.msg.p, { key: 'k' });
  assert.ok(Number.isInteger(last.args.msg.id), 'every req needs a correlation id');
});

test('ctx: broadcast goes through the bus service', async () => {
  invokeCalls.length = 0;
  invokeImpl = async (cmd, { msg }) => ({ v: 1, kind: 'res', id: msg.id, p: { delivered: true } });

  const ctx = buildCtx({ manifest: { id: 't.bus', permissions: ['rpc:bus'] } }, disposerStub);
  await ctx.bus.publish('some.topic', { n: 1 });
  const msg = invokeCalls.at(-1).args.msg;
  assert.equal(msg.svc, 'bus');
  assert.equal(msg.act, 'publish');
  assert.deepEqual(msg.p, { topic: 'some.topic', payload: { n: 1 } });
});

// ---------------------------------- lifecycle ----------------------------------

test('lifecycle: load/activate/deactivate with full view cleanup', async () => {
  ls.clear();
  resetEvents();
  store.plugins.length = 0;
  store.views.length = 0;
  invokeCalls.length = 0;
  invokeImpl = async (cmd) => (cmd === 'plugin_register' ? null : null);

  let deactivated = false;
  const plugin = await loadPlugin({
    manifest: {
      id: 'fake.a',
      name: 'Fake',
      permissions: ['rpc:storage'],
      contributes: { views: [{ id: 'v', title: 'V' }] },
    },
    activate: (ctx) => {
      ctx.registerView('v', () => {});
    },
    deactivate: () => (deactivated = true),
  });

  await activate(plugin, { silent: true });
  assert.equal(store.plugins.find((p) => p.manifest.id === 'fake.a')?.status, 'active');
  assert.ok(store.views.some((v) => v.viewId === 'fake.a/v'));
  assert.equal(plugin.manifest.builtin, true);

  await deactivate(plugin, { silent: true });
  assert.equal(deactivated, true);
  assert.equal(store.views.some((v) => v.viewId === 'fake.a/v'), false, 'views must be removed');
  assert.equal(store.plugins.find((p) => p.manifest.id === 'fake.a')?.status, 'inactive');
});

test('lifecycle: loading a plugin declares its permissions to the native host', async () => {
  invokeCalls.length = 0;
  invokeImpl = async () => null;
  await registerWithHost({ id: 'decl.plugin', permissions: ['rpc:storage', 'win:manage'] });
  const call = invokeCalls.at(-1);
  assert.equal(call.cmd, 'plugin_register');
  assert.equal(call.args.pluginId, 'decl.plugin');
  assert.deepEqual(call.args.permissions, ['rpc:storage', 'win:manage']);

  await assert.rejects(() => registerWithHost({}), /manifest.id is required/);
});

test('lifecycle: a newly discovered plugin defaults to enabled, a disable sticks', async () => {
  ls.clear();
  // first sighting -> enabled (same rule for builtins and drop-ins)
  assert.equal(adoptNewPlugin('user.dropin'), true);
  assert.ok(JSON.parse(ls.get('toolbox.plugins.enabled')).includes('user.dropin'));
  assert.ok(JSON.parse(ls.get('toolbox.plugins.known')).includes('user.dropin'));

  // a deliberate disable is honoured on the next discovery
  saveEnabled([]);
  assert.equal(adoptNewPlugin('user.dropin'), false, 'an explicit disable must stick');

  // and a brand-new plugin is still adopted enabled
  assert.equal(adoptNewPlugin('user.another'), true);
});

test('lifecycle: invalid module shape is rejected', async () => {
  await assert.rejects(() => loadPlugin({ activate() {} }), /invalid plugin module/);
});

test('lifecycle: first run enables every builtin by default', () => {
  ls.clear();
  const set = enabledIds(['x.a', 'x.b']);
  assert.deepEqual([...set].sort(), ['x.a', 'x.b']);
  assert.deepEqual(JSON.parse(ls.get('toolbox.plugins.enabled')).sort(), ['x.a', 'x.b']);
  // a later builtin defaults to enabled; an explicit disable sticks
  saveEnabled([]);
  assert.deepEqual([...enabledIds(['x.a', 'x.b'])], []);
  assert.deepEqual([...enabledIds(['x.a', 'x.b', 'x.c'])], ['x.c']);
});

// ------------------------------- scheme plumbing -------------------------------

test('hub: every declared scheme is implemented and the table is inspectable', () => {
  const ids = hub.transports();
  for (const d of descriptors()) {
    assert.ok(ids.includes(d.id), `scheme \`${d.id}\` declared but not implemented`);
  }
  const rows = hub.schemes();
  assert.equal(rows.length, descriptors().length);
  assert.ok(rows.every((r) => r.id && r.label && r.direction && r.note));
  // the helpers resolve to the documented schemes
  assert.equal(hub.schemeFor('request').id, 'rpc');
  assert.equal(hub.schemeFor('sidecar').id, 'stdio-line');
  assert.equal(hub.schemeFor('pty').id, 'pty-stream');
  assert.equal(hub.schemeFor('broadcast').id, 'event-bus');
  assert.equal(hub.schemeFor('local').id, 'in-process');
});

test('hub: a plugin deactivation drops its subscriptions', async () => {
  resetEvents();
  let hits = 0;
  await hub.local('drop.me', 'topic', () => hits++);
  hub.publish('drop.me', 'topic', null, { scheme: 'in-process' });
  assert.equal(hits, 1);
  hub.dropSubscriptions('drop.me');
  hub.publish('drop.me', 'topic', null, { scheme: 'in-process' });
  assert.equal(hits, 1, 'no delivery after dropSubscriptions');
});
