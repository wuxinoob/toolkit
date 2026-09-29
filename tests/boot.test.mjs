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
const { store, sortPluginList } = await import('../src/host/store.js');
const { builtinSources } = await import('../src/host/registry.js');
const { deactivate } = await import('../src/host/lifecycle.js');
const { Origin, loadedIds, originOf, pluginModule, reconcilePlugins, reloadPlugin } = await import(
  '../src/host/plugins.js'
);
const { descriptors } = await import('../src/protocol/registry.js');
const { hub } = await import('../src/protocol/hub.js');
const { selftestCases } = await import('../src/core/selftest.js');

/**
 * Run ONE in-app selftest case by id and report it the way `runSelftest` does.
 *
 * The suite's own doc says its pure-JS parts run under `node --test`; this is
 * what makes that true for the cases that only look at `store`. Without it the
 * app-side checks have no test at all, and the ones that assert a PROPERTY
 * (rather than a fixed list) can rot into "always passes" without anyone seeing.
 */
async function runSelftestCase(id) {
  const entry = selftestCases.find(([key]) => key === id);
  assert.ok(entry, `no such selftest case: ${id}`);
  try {
    return { ok: true, detail: (await entry[1]()) || 'ok' };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

/**
 * Full host reset between tests.
 *
 * Clearing `store` is not enough: a plugin module caches its activation state
 * (`_ctx`), so a second boot would no-op and the test would assert against a
 * stale status. Deactivating also releases the plugin's timers and streams,
 * which would otherwise keep this process alive and hang the test runner.
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
  // Deliberately not an exact count: how many built-ins ship is the registry's
  // decision (see src/host/registry.js), and pinning it here meant this test
  // failed for a change that was correct. What must hold is that the registry is
  // not empty — otherwise the loop below proves nothing.
  assert.ok(sources.length > 0, 'the registry must ship at least one built-in plugin');
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
  // Derived from the registry, so this asserts the property that matters —
  // "every view a shipped built-in declares got registered" — and does not need
  // editing when the set of built-ins changes. The literal that used to be here
  // outlived three of the plugins it named.
  const declared = builtinSources().flatMap((m) =>
    (m.manifest.contributes?.views ?? []).map((v) => `${m.manifest.id}/${v.id}`),
  );
  assert.ok(declared.length > 0, 'the registry should declare at least one view');

  const ids = store.views.map((v) => v.viewId).sort();
  for (const expected of declared) {
    assert.ok(ids.includes(expected), `view ${expected} missing (have ${ids.join(', ')})`);
  }
  // every registered view carries what the shell needs to render a nav item
  for (const v of store.views) {
    assert.ok(v.title && v.icon && v.pluginId && typeof v.render === 'function', `bad view ${v.viewId}`);
  }
});

test('boot: the scheme table is published for the diagnostics view', async () => {
  // derived from the registry, not a literal: adding a scheme must not fail this
  assert.equal(store.schemes.length, descriptors().length);
  assert.deepEqual(
    store.schemes.map((s) => s.id),
    hub.transports(),
    'the published table must match the transport registry',
  );
});

test('boot: every plugin declares its permissions to the native host', async () => {
  const expectedIds = builtinSources().map((m) => m.manifest.id).sort();
  const registrations = invokeCalls.filter((c) => c.cmd === 'plugin_register');
  assert.equal(registrations.length, expectedIds.length, 'one registration per built-in plugin');
  for (const r of registrations) {
    assert.ok(r.args.pluginId, 'registration must carry a plugin id');
    assert.ok(Array.isArray(r.args.permissions), `${r.args.pluginId}: permissions must be an array`);
  }
  const ids = registrations.map((r) => r.args.pluginId).sort();
  assert.deepEqual(ids, expectedIds);
});

test('boot: a plugin that throws on activate is contained, not fatal', async () => {
  // The blast radius of one bad plugin must be exactly one bad plugin: boot
  // still completes and the others still come up.
  //
  // The victim has to be a built-in that reads storage DURING activate, so the
  // injected error lands inside `activate()` rather than after it — procman
  // seeds its default profiles there.
  const VICTIM = 'builtin.procman';
  await resetHost();

  invokeImpl = async (cmd, args) => {
    if (cmd === 'plugin_register') return null;
    if (cmd === 'plugin_scan') return [];
    if (cmd === 'plugin:event|listen') return 1;
    if (cmd.startsWith('plugin:global-shortcut')) return null;
    if (cmd === 'plugin_rpc') {
      const { msg } = args;
      // make storage reads explode for one plugin only
      if (args.pluginId === VICTIM) {
        return { v: 1, kind: 'err', id: msg.id, code: 'storage/get', msg: 'simulated failure' };
      }
      return { v: 1, kind: 'res', id: msg.id, p: msg.act === 'get' ? null : true };
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  };

  await boot();

  assert.equal(store.booted, true, 'boot must still complete');
  const failed = store.plugins.find((p) => p.manifest.id === VICTIM);
  assert.equal(failed.status, 'error', 'the failing plugin must be marked as an error');
  assert.ok(failed.error, 'the error must be recorded, not swallowed');
  const others = store.plugins.filter((p) => p.manifest.id !== VICTIM);
  assert.ok(others.length > 0, 'there must be another plugin, or "contained" proves nothing');
  assert.ok(
    others.every((p) => p.status === 'active'),
    `other plugins must be unaffected: ${others.map((p) => `${p.manifest.id}=${p.status}`).join(', ')}`,
  );
  assert.ok(
    !store.views.some((v) => v.pluginId === VICTIM),
    'a failed plugin must not leave a view behind',
  );
});

/* ---------------------------------------------------------------------------
 * Display order, and staying put
 * ------------------------------------------------------------------------- */

/** `[isExternal, name]` — the comparable key both lists are ordered by. */
const rowKey = (p) => [p.manifest.builtin ? 0 : 1, p.manifest.name];
const viewKey = (v) => [v.builtin ? 0 : 1, v.title];
const byKey = (a, b) => a[0] - b[0] || a[1].localeCompare(b[1], undefined, { sensitivity: 'base' });

test('the plugin list is ordered built-ins first, then alphabetically', async () => {
  // The lenient gateway goes in BEFORE the reset: resetting deactivates the
  // previous test's plugins, and that teardown fires `unlisten` — which the
  // strict stub the previous test installs would reject as unhandled.
  installGateway();
  await resetHost();
  await boot();

  const rows = store.plugins.map(rowKey);
  assert.deepEqual(
    rows,
    [...rows].sort(byKey),
    `plugin rows out of order: ${store.plugins.map((p) => p.manifest.name).join(' | ')}`,
  );

  const views = store.views.map(viewKey);
  assert.deepEqual(
    views,
    [...views].sort(byKey),
    `views out of order: ${store.views.map((v) => v.title).join(' | ')}`,
  );

  // The rule really is "built-ins first", not merely alphabetical. A plugin
  // whose name sorts before every built-in must still come LAST, because it is
  // external — this is the assertion that fails if the builtin axis is dropped.
  store.plugins.push({
    manifest: { id: 'aaa.demo', name: 'AAA Demo', builtin: false },
    status: 'inactive',
    error: null,
  });
  sortPluginList();
  const names = store.plugins.map((p) => p.manifest.name);
  assert.equal(names[names.length - 1], 'AAA Demo', 'an external plugin sorts after the built-ins');
  assert.ok(names.length > 1, 'and there were built-ins for it to sort after');
});

test('deactivate: disabling a plugin leaves the user where they were', async () => {
  installGateway();
  await resetHost();
  await boot();

  // The MODULE, not the store row — `deactivate` reads `plugin._ctx`, which only
  // the module has. (SettingsView resolves it the same way.)
  const victim = builtinSources()[0];
  assert.ok(victim._ctx, 'the victim must be active, or deactivate returns early and this proves nothing');

  // The shell's own pages are NOT in `store.views` — `__settings` is a synthetic
  // id — so "is the active view still in store.views" is false for them, and the
  // old check threw the user onto the first plugin's page every time they
  // toggled ANY plugin off while reading Settings.
  store.activeViewId = '__settings';
  await deactivate(victim, { silent: true });
  assert.equal(
    store.activeViewId,
    '__settings',
    'disabling a plugin must not navigate away from Settings',
  );
});

test('deactivate: the user IS moved off a page that belonged to the disabled plugin', async () => {
  installGateway();
  await resetHost();
  await boot();

  const victim = builtinSources()[0];
  assert.ok(victim._ctx, 'the victim must be active, or deactivate returns early and this proves nothing');
  const own = store.views.find((v) => v.pluginId === victim.manifest.id);
  assert.ok(own, 'the victim must own a view, or this test proves nothing');

  store.activeViewId = own.viewId;
  await deactivate(victim, { silent: true });
  assert.notEqual(store.activeViewId, own.viewId, 'a page that no longer exists must not stay active');
  assert.ok(store.activeViewId, 'and the shell lands somewhere real rather than nowhere');
  assert.ok(
    store.views.some((v) => v.viewId === store.activeViewId),
    'the fallback must be a view that actually exists',
  );
});

// ------------------- t13: what "a missing view" is allowed to mean -------------------

test('t13: a built-in the user DISABLED is not a failure — it is named as skipped', async () => {
  installGateway();
  await resetHost();
  await boot();

  // Turn one built-in off the way the Settings toggle does. Its views go away,
  // and that is correct behaviour, not a defect. This is the exact shape that
  // produced `view missing: builtin.streamlab/streamlab` and a 14/15 report for
  // a user who had simply switched a plugin off.
  const victim = builtinSources().find((m) => (m.manifest.contributes?.views ?? []).length > 0);
  assert.ok(victim, 'need a built-in that declares a view, or this test proves nothing');
  await deactivate(victim, { silent: true });

  const r = await runSelftestCase('t13-registry-views');
  assert.ok(r.ok, `t13 must tolerate a plugin the user turned off, got: ${r.detail}`);
  assert.match(r.detail, /skipped/, 'the disabled plugin must be NAMED, not silently dropped');
  assert.ok(
    r.detail.includes(victim.manifest.id),
    `the skip list must name ${victim.manifest.id}, got: ${r.detail}`,
  );
});

test('t13: an ACTIVE built-in with a missing view is still a failure', async () => {
  installGateway();
  await resetHost();
  await boot();

  // The same shape as the test above, except the plugin is still active — so now
  // the missing view IS a defect. Without this, "tolerate a disabled plugin"
  // could have been implemented as "stop checking" and nothing would notice.
  const victim = builtinSources().find((m) => (m.manifest.contributes?.views ?? []).length > 0);
  assert.ok(victim, 'need a built-in that declares a view');
  const at = store.views.findIndex((v) => v.pluginId === victim.manifest.id);
  assert.ok(at >= 0, 'the victim must have a registered view for this to remove');
  store.views.splice(at, 1);

  const r = await runSelftestCase('t13-registry-views');
  assert.equal(r.ok, false, "removing a live plugin's view must still fail t13");
  assert.match(r.detail, /view missing/, `expected a "view missing" failure, got: ${r.detail}`);
});

// ---------------------- the catalogue's built-in half ----------------------

test('catalogue: a built-in reports its origin, and resolves to its module', async () => {
  installGateway();
  await resetHost();
  await boot();

  const victim = builtinSources()[0];
  const id = victim.manifest.id;
  assert.equal(originOf(id), Origin.BUILTIN);
  assert.equal(pluginModule(id), victim, 'the catalogue holds the very module the registry ships');
  // The row and the catalogue must not disagree about which kind a plugin is.
  const row = store.plugins.find((p) => p.manifest.id === id);
  assert.equal(row.manifest.builtin, true, 'the row says built-in too');
});

test('catalogue: reloadPlugin restarts a built-in, and keeps the module instance', async () => {
  installGateway();
  await resetHost();
  await boot();

  const victim = builtinSources()[0];
  const id = victim.manifest.id;
  assert.ok(victim._ctx, 'the victim must be active, or "restarted" would be vacuous');

  const out = await reloadPlugin(id, { silent: true });

  // A built-in cannot be re-imported — it is in the bundle — so the honest
  // reload is stop-then-start, on the SAME module. This is the asymmetry the
  // Settings button labels "Restart" instead of "Reload".
  assert.equal(out.origin, Origin.BUILTIN);
  assert.equal(pluginModule(id), victim, 'the same module instance, not a new one');
  assert.ok(victim._ctx, 'and it is running again');
  assert.equal(store.plugins.find((p) => p.manifest.id === id)?.status, 'active');
});

test('reconciling the plugins DIRECTORY must not unload the built-ins', async () => {
  installGateway();
  await resetHost();
  await boot();

  // Rescan means "rescan {appData}/plugins". A built-in has no folder there, so
  // "not on disk" says nothing about it — and the removal pass is driven by
  // exactly that question. Without the origin guard in `reconcileExternals`, the
  // first click of Rescan would unload every built-in and revoke its native
  // grant, which would look like the whole app falling apart.
  const before = builtinSources().map((m) => m.manifest.id);

  invokeCalls.length = 0;
  const { external } = await reconcilePlugins({ silent: true, sources: [Origin.EXTERNAL] });

  assert.deepEqual(external.removed, [], 'nothing built-in may be removed by a directory rescan');
  for (const id of before) {
    assert.ok(loadedIds().includes(id), `${id} must still be in the catalogue`);
    assert.ok(pluginModule(id), `${id} must still resolve`);
  }
  const revoked = invokeCalls.filter(
    (c) => c.cmd === 'plugin_rpc' && c.args?.msg?.svc === 'host' && c.args.msg.act === 'unregister',
  );
  assert.deepEqual(revoked, [], 'and no built-in may lose its native grant');
});
