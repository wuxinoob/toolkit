/**
 * Host kernel unit tests (node --test, no Tauri runtime).
 *
 * A window/localStorage shim is installed BEFORE importing host modules, and
 * `invoke` is routed to a controllable mock, so the real kernel code runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

// `lifecycle.js` now pulls in the component factory (host/ui.js -> Vue SFCs +
// `import.meta.glob`), none of which Node can resolve. The stub loader fakes the
// rendering but keeps every tag name real, so the kernel tests still exercise
// the actual activation path.
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
  setHotkey,
  Disposer,
} = await import('../src/host/lifecycle.js');
const { store, closeToTray, saveSettings } = await import('../src/host/store.js');
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
  await assert.rejects(() => ctx.paths(), /missing permission/);
  await assert.rejects(() => ctx.sidecar('c', { exe: 'x' }), /missing permission/);
  await assert.rejects(() => ctx.pty('c', { program: 'x' }), /missing permission/);
  // The permission gate fires BEFORE the label check, so any label does — this
  // one just has to be a plausible one.
  await assert.rejects(() => ctx.windows.exists('plugin-anything'), /missing permission/);
  assert.equal(invokeCalls.length, before, 'no invoke may be issued for unpermitted calls');
});

/**
 * `ctx.paths()` is a thin wrapper over `host/paths`, and its whole value is that
 * the HOST answers: a webview that computes its own idea of "where the plugins
 * folder is" would name a folder the scanner never reads, and would fail
 * silently. So the shape it forwards is pinned here, not just the fact that it
 * resolves.
 */
test('ctx: paths() routes host/paths through the gateway', async () => {
  invokeCalls.length = 0;
  invokeImpl = async (cmd, { msg }) => ({
    v: 1,
    kind: 'res',
    id: msg.id,
    p: {
      pluginDataDir: 'C:\\data\\plugin-data\\t.perm',
      pluginsDir: 'C:\\data\\plugins',
      platform: 'windows',
      sep: '\\',
    },
  });

  const ctx = buildCtx({ manifest: { id: 't.perm', permissions: ['rpc:host'] } }, disposerStub);
  const p = await ctx.paths();
  assert.equal(p.platform, 'windows');
  assert.equal(p.sep, '\\');

  const last = invokeCalls.at(-1);
  assert.equal(last.cmd, 'plugin_rpc');
  assert.equal(last.args.msg.svc, 'host');
  assert.equal(last.args.msg.act, 'paths');
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

test('ctx: events and bus have the same shape — only the default scheme differs', async () => {
  // this test drives the event-bus scheme, which calls plugin:event|listen,
  // so it needs its own gateway rather than whatever the previous test left
  invokeImpl = async (cmd, args) => {
    if (cmd === 'plugin:event|listen') return 1;
    if (cmd === 'plugin:event|unlisten') return null;
    if (cmd === 'plugin_rpc') return { v: 1, kind: 'res', id: args.msg.id, p: true };
    throw new Error(`unexpected invoke: ${cmd}`);
  };
  const ctx = buildCtx(
    { manifest: { id: 't.shapes', permissions: ['rpc:bus'] } },
    { track() {} },
  );
  // every subscribe-style call is async and resolves to an unsubscribe fn
  for (const call of [
    () => ctx.events.on('t.a', () => {}),
    () => ctx.events.once('t.b', () => {}),
    () => ctx.bus.subscribe('t.c', () => {}),
    () => ctx.subscribe('t.d', () => {}),
  ]) {
    const p = call();
    assert.ok(p instanceof Promise, 'subscribe must be async on every scheme');
    assert.equal(typeof (await p), 'function', 'must resolve to an unsubscribe fn');
  }
  // and every publish-style call is async too
  for (const call of [() => ctx.events.emit('t.e', 1), () => ctx.publish('t.f', 1)]) {
    assert.ok(call() instanceof Promise, 'publish must be async on every scheme');
  }
});

test('ctx: receiving is passive, publishing is the gated capability', async () => {
  invokeCalls.length = 0;
  // this test drives the event-bus scheme, which calls plugin:event|listen,
  // so it needs its own gateway rather than whatever the previous test left
  invokeImpl = async (cmd, args) => {
    if (cmd === 'plugin:event|listen') return 1;
    if (cmd === 'plugin:event|unlisten') return null;
    if (cmd === 'plugin_rpc') return { v: 1, kind: 'res', id: args.msg.id, p: { delivered: true } };
    throw new Error(`unexpected invoke: ${cmd}`);
  };
  // declared: rpc:storage only — no rpc:bus
  const ctx = buildCtx({ manifest: { id: 't.passive', permissions: ['rpc:storage'] } }, { track() {} });

  // subscribing costs nothing and is allowed
  const off = await ctx.bus.subscribe('some.topic', () => {});
  assert.equal(typeof off, 'function', 'a passive listener needs no permission');
  // publishing reaches other windows, so it is refused
  await assert.rejects(() => ctx.bus.publish('some.topic', {}), /missing permission "rpc:bus"/);
});

test('ctx: rpc accepts a per-call timeout', async () => {
  invokeCalls.length = 0;
  invokeImpl = async (cmd, { msg }) => ({ v: 1, kind: 'res', id: msg.id, p: true });
  const ctx = buildCtx({ manifest: { id: 't.to', permissions: ['rpc:host'] } }, { track() {} });
  assert.equal(await ctx.rpc('host', 'info', {}, { timeoutMs: 0 }), true);
  assert.equal(invokeCalls.at(-1).args.msg.svc, 'host');
});

test('ctx: the contract is handed over, not imported', () => {
  const ctx = buildCtx({ manifest: { id: 't.contract', permissions: [] } }, { track() {} });
  assert.equal(ctx.protocol.version, 1, 'wire protocol version');
  assert.equal(ctx.protocol.api, 3, 'host API version');
  assert.equal(typeof ctx.protocol.req, 'function');
  assert.equal(ctx.protocol.Kind.DATA, 'data');
  // and it is frozen, so a plugin cannot mutate the contract for everyone
  assert.throws(() => {
    ctx.protocol.version = 99;
  }, TypeError);
});

test('lifecycle: dispose awaits async cleanups, newest first, exactly once', async () => {
  // Previously run() called each cleanup synchronously and dropped the promise,
  // so an async cleanup became fire-and-forget: the resource could still
  // register itself after teardown, and a rejection became unhandled.
  const order = [];
  const d = new Disposer();
  d.track(() => order.push('first'));
  d.track(async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push('second');
  });
  d.track(() => order.push('third'));

  await d.run();
  assert.deepEqual(order, ['third', 'second', 'first'], 'reverse order, and the async one completed');

  await d.run(); // idempotent
  assert.deepEqual(order, ['third', 'second', 'first'], 'a second run must not repeat them');
});

test('lifecycle: a failing cleanup does not stop the rest', async () => {
  const seen = [];
  const d = new Disposer();
  d.track(() => seen.push('first'));
  d.track(async () => {
    throw new Error('boom');
  });
  d.track(() => seen.push('third'));
  await d.run();
  assert.deepEqual(seen, ['third', 'first'], 'the throw is contained, the rest still run');
});

test('lifecycle: deactivate does not resolve before an async cleanup finishes', async () => {
  ls.clear();
  resetEvents();
  store.plugins.length = 0;
  store.views.length = 0;
  invokeImpl = async () => null;

  let finished = false;
  const plugin = await loadPlugin({
    manifest: {
      id: 'async.cleanup',
      name: 'AsyncCleanup',
      permissions: [],
      contributes: { views: [{ id: 'v', title: 'V' }] },
    },
    activate: (ctx) => {
      ctx.registerView('v', () => {});
      ctx.cleanup(async () => {
        await new Promise((r) => setTimeout(r, 10));
        finished = true;
      });
    },
  });
  await activate(plugin, { silent: true });
  await deactivate(plugin, { silent: true });
  assert.ok(finished, 'deactivate must await the cleanup before it resolves');
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

test('lifecycle: declared hotkeys are registered by the host on the plugin\'s behalf', async () => {
  ls.clear();
  resetEvents();
  store.plugins.length = 0;
  store.views.length = 0;
  invokeCalls.length = 0;
  invokeImpl = async (cmd, { msg }) => ({ v: 1, kind: 'res', id: msg?.id ?? 1, p: true });

  const plugin = await loadPlugin({
    manifest: {
      id: 'hk.plugin',
      name: 'Hotkeyed',
      permissions: [],
      contributes: { views: [{ id: 'v', title: 'V' }], hotkeys: [{ key: 'ctrl+alt+shift+k', action: 'go' }] },
    },
    activate: (ctx) => ctx.registerView('v', () => {}),
  });
  await activate(plugin, { silent: true });

  // A declaration is a REQUEST, not a registration. It must be recorded (so
  // Settings has something to list) and must NOT reach the OS: a plugin able to
  // take a global shortcut just by shipping could shadow a shortcut the user
  // relies on in every other application, without them ever agreeing to it.
  const reg = invokeCalls.find((c) => c.args?.msg?.svc === 'hotkey' && c.args.msg.act === 'register');
  assert.equal(reg, undefined, 'a declared hotkey must NOT be registered until enabled');

  const entry = store.settings.hotkeys['hk.plugin:go'];
  assert.ok(entry, 'the declaration must be recorded so Settings can list it');
  assert.equal(entry.key, 'ctrl+alt+shift+k', 'seeded with the declared default');
  assert.equal(entry.enabled, false, 'and off by default');

  // Only when the user turns it on does it reach the OS.
  invokeCalls.length = 0;
  await setHotkey('hk.plugin', 'go', { enabled: true });
  const reg2 = invokeCalls.find((c) => c.args?.msg?.svc === 'hotkey' && c.args.msg.act === 'register');
  assert.ok(reg2, 'an enabled hotkey must be registered');
  // the host acts for the plugin, and says so explicitly
  assert.equal(reg2.args.pluginId, '__host__');
  assert.deepEqual(reg2.args.msg.p, { key: 'ctrl+alt+shift+k', action: 'go', owner: 'hk.plugin' });

  invokeCalls.length = 0;
  await deactivate(plugin, { silent: true });
  const rel = invokeCalls.find((c) => c.args?.msg?.svc === 'hotkey' && c.args.msg.act === 'unregister_all');
  assert.ok(rel, 'deactivate must release the hotkeys');
  assert.deepEqual(rel.args.msg.p, { owner: 'hk.plugin' });
});

test('lifecycle: turning a hotkey off releases it at the OS', async () => {
  ls.clear();
  resetEvents();
  store.plugins.length = 0;
  store.views.length = 0;
  invokeCalls.length = 0;
  invokeImpl = async (cmd, { msg }) => ({ v: 1, kind: 'res', id: msg?.id ?? 1, p: true });

  const plugin = await loadPlugin({
    manifest: {
      id: 'hk.off',
      name: 'Toggle',
      permissions: [],
      contributes: { views: [{ id: 'v', title: 'V' }], hotkeys: [{ key: 'ctrl+alt+k', action: 'go' }] },
    },
    activate: (ctx) => ctx.registerView('v', () => {}),
  });
  await activate(plugin, { silent: true });
  await setHotkey('hk.off', 'go', { enabled: true });

  invokeCalls.length = 0;
  await setHotkey('hk.off', 'go', { enabled: false });
  const rel = invokeCalls.find((c) => c.args?.msg?.svc === 'hotkey' && c.args.msg.act === 'unregister');
  assert.ok(rel, 'disabling must unregister, or the key stays taken');
  assert.equal(rel.args.msg.p.key, 'ctrl+alt+k');
  assert.equal(store.settings.hotkeys['hk.off:go'].enabled, false);
});

test('lifecycle: an ENABLED hotkey goes live BEFORE activate runs', async () => {
  // A plugin must be able to rely on its own hotkeys during activation, so the
  // host has to register them first. This was a real bug: registering after
  // activate() meant a plugin that checked its own hotkey saw none.
  //
  // Only an ENABLED one now — a bare declaration is inert.
  ls.clear();
  resetEvents();
  store.plugins.length = 0;
  store.views.length = 0;
  invokeCalls.length = 0;
  invokeImpl = async (cmd, { msg }) => ({ v: 1, kind: 'res', id: msg?.id ?? 1, p: true });

  // Pre-seed the user's choice: this hotkey is ON.
  store.settings.hotkeys['hk.order:go'] = { key: 'ctrl+alt+shift+o', enabled: true };

  const plugin = await loadPlugin({
    manifest: {
      id: 'hk.order',
      name: 'Ordered',
      permissions: ['rpc:storage'],
      contributes: { views: [{ id: 'v', title: 'V' }], hotkeys: [{ key: 'ctrl+alt+shift+o', action: 'go' }] },
    },
    activate: async (ctx) => {
      // a gateway call, so the invoke log shows where activate sat
      await ctx.storage.get('probe');
      ctx.registerView('v', () => {});
    },
  });
  await activate(plugin, { silent: true });

  const regIdx = invokeCalls.findIndex((c) => c.args?.msg?.svc === 'hotkey' && c.args.msg.act === 'register');
  const rpcIdx = invokeCalls.findIndex((c) => c.cmd === 'plugin_rpc' && c.args?.msg?.svc === 'storage');
  assert.ok(regIdx >= 0, 'hotkey was never registered');
  assert.ok(rpcIdx >= 0, 'activate never reached the gateway');
  assert.ok(
    regIdx < rpcIdx,
    `hotkeys must be registered before activate() runs (hotkey at ${regIdx}, activate at ${rpcIdx})`,
  );
});

test('lifecycle: a failing hotkey registration does not fail the activation', async () => {
  ls.clear();
  resetEvents();
  store.plugins.length = 0;
  store.views.length = 0;
  invokeImpl = async (cmd, { msg }) => {
    if (msg?.svc === 'hotkey') {
      return { v: 1, kind: 'err', id: msg.id, code: 'hotkey/register', msg: 'shortcut already taken' };
    }
    return { v: 1, kind: 'res', id: msg?.id ?? 1, p: true };
  };

  // Enabled, so the host actually tries — the point is that a failure there is
  // contained, not that it is skipped.
  store.settings.hotkeys['hk.conflict:go'] = { key: 'ctrl+alt+shift+c', enabled: true };

  const plugin = await loadPlugin({
    manifest: {
      id: 'hk.conflict',
      name: 'Conflict',
      permissions: [],
      contributes: { views: [{ id: 'v', title: 'V' }], hotkeys: [{ key: 'ctrl+alt+shift+k', action: 'go' }] },
    },
    activate: (ctx) => ctx.registerView('v', () => {}),
  });
  await activate(plugin, { silent: true });
  assert.equal(
    store.plugins.find((p) => p.manifest.id === 'hk.conflict')?.status,
    'active',
    'a taken shortcut must not stop the plugin from activating',
  );
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

test('lifecycle: a plugin built for another host API is flagged, not silently broken', async () => {
  // The host API shape changes independently of the wire protocol. A plugin
  // built against an older shape must be *diagnosable*: this is what turned a
  // real failure ("off is not a function") into a mystery.
  ls.clear();
  resetEvents();
  store.plugins.length = 0;
  store.views.length = 0;
  invokeImpl = async () => null;

  await loadPlugin({
    manifest: { id: 'old.api', name: 'Old', api: 1, permissions: [], contributes: { views: [{ id: 'v', title: 'V' }] } },
    activate: () => {},
  });
  const stale = store.plugins.find((p) => p.manifest.id === 'old.api');
  assert.match(stale.note, /built for host API 1/, 'the mismatch must be recorded');
  assert.match(stale.note, /provides 3/);
  assert.equal(stale.status, 'inactive', 'a mismatch is a warning, not a failure');

  await loadPlugin({
    manifest: { id: 'new.api', name: 'New', api: 3, permissions: [], contributes: { views: [{ id: 'v2', title: 'V' }] } },
    activate: () => {},
  });
  assert.equal(
    store.plugins.find((p) => p.manifest.id === 'new.api').note,
    null,
    'a current plugin carries no note',
  );
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

/* --------------------------- close to tray ---------------------------------- */

test('close-to-tray is on by default, and an explicit off wins', () => {
  // The app has a tray icon and the tray menu is the only real exit, so this is
  // not cosmetic: with it on and no tray, the app cannot be quit from its own UI
  // (which is why the Rust side treats a tray that will not build as fatal).
  //
  // The accessor exists rather than a direct read because `ctx.js` needs the same
  // answer, and because the settings object is spread over defaults at import
  // time — a stored `false` has to beat the default `true`.
  const original = store.settings.closeToTray;

  delete store.settings.closeToTray;
  assert.equal(closeToTray(), true, 'absent means on');

  store.settings.closeToTray = false;
  assert.equal(closeToTray(), false, 'an explicit off must win over the default');

  store.settings.closeToTray = true;
  assert.equal(closeToTray(), true);

  store.settings.closeToTray = original;
});

test('close-to-tray survives a save/reload round trip', () => {
  // `saveSettings` writes a hand-picked subset, so a new setting that is not
  // added there is silently not persisted — it works until the next launch.
  const original = store.settings.closeToTray;
  store.settings.closeToTray = false;
  saveSettings();
  const stored = JSON.parse(localStorage.getItem('toolbox.settings'));
  assert.equal(stored.closeToTray, false, 'saveSettings must carry closeToTray');
  store.settings.closeToTray = original;
});

/* --------------------------- host-only actions ------------------------------ */

test('the host service keeps its write actions host-only', () => {
  // `rpc:host` is granted to plugins, and everything on the `host` service used
  // to be a READ (`info`, `sessions`, `plugins`, `schema`) plus a log write. Two
  // actions are not: `unregister` drops another plugin's permissions, and
  // `stop_session` kills another plugin's process. A read grant quietly becoming
  // the power to do either is how a permission model rots, so both are gated on
  // the host identity — and both are checked here, because the guard is inside a
  // function that needs a live `AppHandle` and so cannot be reached from
  // `host-checks`.
  const rs = readFileSync(
    new URL('../src-tauri/src/services/storage.rs', import.meta.url),
    'utf8',
  );

  for (const action of ['stop_session', 'unregister']) {
    const at = rs.indexOf(`"${action}" =>`);
    assert.ok(at > 0, `${action} must exist in the host service`);
    const body = rs.slice(at, rs.indexOf('\n            }', at));
    assert.match(body, /HOST_IDENTITY/, `${action} must check the caller is the host`);
    assert.match(body, /code::DENIED/, `${action} must deny everyone else`);
  }

  // And the action is actually declared, or the gateway rejects it before the
  // guard is ever reached.
  assert.match(rs, /"stop_session",/, 'stop_session must be in host actions()');
});
