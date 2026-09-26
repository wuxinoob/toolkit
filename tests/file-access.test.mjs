/**
 * The file-access surface a plugin gets: `ctx.files` (native dialogs) and
 * `ctx.onDrop` (OS file drops).
 *
 * Both exist because a Blob-URL plugin imports nothing — it cannot reach
 * `@tauri-apps/plugin-dialog`, and it cannot call `onDragDropEvent`. The host
 * does both on its behalf, which is also what lets the permission story stay
 * coherent: the grant is the USER's action (a dialog they saw, a drop they
 * aimed), not a declaration the plugin made.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

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

register('./browser-stubs-loader.mjs', import.meta.url);
const { buildCtx } = await import('../src/host/ctx.js');

const disposer = { track() {}, dispose() {} };
const ctx = buildCtx(
  { manifest: { id: 'test.files', permissions: ['rpc:dialog'] } },
  disposer,
);

async function reason(promise) {
  try {
    await promise;
    return null;
  } catch (e) {
    return e.message;
  }
}

test('ctx.files: the surface exists and is async', () => {
  assert.equal(typeof ctx.files.pick, 'function');
  assert.equal(typeof ctx.files.save, 'function');
  assert.equal(typeof ctx.files.message, 'function');
  assert.equal(typeof ctx.onDrop, 'function');
});

test('ctx.files: pick resolves to an empty array on cancel, not an error', async () => {
  // In Node there is no host, so the invoke rejects — but the CONTRACT under
  // test is the normalisation: `pick` must never hand back null/undefined for
  // "the user cancelled", because every caller would have to guard it.
  const source = readFileSync(new URL('../src/host/ctx.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /\.then\(\(r\) => r\?\.paths \?\? \[\]\)/,
    'pick must normalise a missing paths array to []',
  );
  assert.match(
    source,
    /\.then\(\(r\) => r\?\.path \?\? null\)/,
    'save must normalise to null',
  );
});

test('ctx.files: every dialog call is gated by rpc:dialog', async () => {
  const source = readFileSync(new URL('../src/host/ctx.js', import.meta.url), 'utf8');
  const dialogCalls = source.match(/invoke\('plugin_dialog'/g) ?? [];
  assert.equal(dialogCalls.length, 3, 'expected three dialog entry points');
  const gates = source.match(/'rpc:dialog'/g) ?? [];
  assert.ok(
    gates.length >= 3,
    `each dialog call needs the gate — found ${gates.length} for ${dialogCalls.length} calls`,
  );
});

test('ctx.onDrop: a plugin without the permission can still subscribe', () => {
  // No `rpc:dialog`, no `rpc:proc` — and subscribing is still allowed, because
  // receiving a drop the user aimed at your own view is observation, not a
  // capability. If this ever throws, the permission model drifted.
  const bare = buildCtx({ manifest: { id: 'test.bare', permissions: [] } }, disposer);
  const off = bare.onDrop(() => {});
  // It returns the subscription promise (like every other subscribe), which is
  // what the disposer tracks. Throwing here would mean the permission model drifted.
  assert.equal(typeof off?.then, 'function', 'onDrop should return a promise');
});

test('ctx.onDrop: a drop on the plugin\'s own view reaches the handler', async () => {
  // THE bug this test exists for.
  //
  // Wiring up inputs in `activate` and mounting the view later is the natural
  // order — every example plugin does `ctx.onDrop(...)` first and
  // `ctx.registerView(...)` after. `ctx.onDrop` used to snapshot the plugin's
  // view ids at SUBSCRIBE time, which at that moment is an EMPTY set, so the
  // ownership filter rejected every drop for the plugin's whole lifetime.
  //
  // Silently, too: a drop declined on purpose and one declined by this bug look
  // identical from outside. The log said "3 listener(s)" — it was counting the
  // wrappers that ran, not the plugins that acted — and the drop really had
  // arrived, so nothing looked wrong anywhere.
  //
  // The old version of this test asserted the IMPLEMENTATION by regex
  // (`mine.has(payload.viewId)`) and therefore passed for the entire time the
  // feature was broken. Behaviour, not shape.
  const { store } = await import('../src/host/store.js');
  const { events, DROP_TOPIC, resetEvents } = await import('../src/host/events.js');

  resetEvents();
  store.views.length = 0;

  const seen = [];
  const local = buildCtx(
    {
      manifest: {
        id: 'test.drop',
        permissions: [],
        contributes: { views: [{ id: 'v', slot: 'tool', title: 'V' }] },
      },
    },
    disposer,
  );

  const off = await local.onDrop((paths, info) => seen.push({ paths, info }));
  local.registerView('v', () => {}); // AFTER subscribing — the natural order

  const mine = 'test.drop/v';
  store.activeViewId = mine;
  events.emit(DROP_TOPIC, { paths: ['C:/a.txt'], viewId: mine });
  assert.equal(seen.length, 1, 'a drop on the plugin\'s own view must reach the handler');
  assert.deepEqual(seen[0].paths, ['C:/a.txt']);
  assert.equal(seen[0].info.viewId, mine);

  // …and a drop aimed at someone else's view is still refused. The routing rule
  // is the whole reason this needs no permission.
  store.views.push({ viewId: 'other.p/v', pluginId: 'other.p', title: 'O', icon: 'x', render() {} });
  events.emit(DROP_TOPIC, { paths: ['C:/b.txt'], viewId: 'other.p/v' });
  assert.equal(seen.length, 1, 'a drop on another plugin\'s view must NOT be delivered');

  off();
  resetEvents();
  store.views.length = 0;
});

test('ctx.onDrop: ownership is decided at delivery time, not at subscribe time', () => {
  // The one-line statement of the rule above, kept as a source guard so a future
  // edit cannot reintroduce the snapshot without noticing.
  const source = readFileSync(new URL('../src/host/ctx.js', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /const mine = new Set\(/,
    'onDrop must not capture the view set when it subscribes — a plugin registers its views later',
  );
  assert.match(
    source,
    /store\.views\.some\(\(v\) => v\.viewId === viewId && v\.pluginId === id\)/,
    'onDrop must resolve ownership per delivery',
  );
});

test('the host listens for drops once, in boot, on the shared topic', () => {
  const boot = readFileSync(new URL('../src/host/boot.js', import.meta.url), 'utf8');
  assert.match(boot, /onDragDropEvent/, 'boot must register the drop listener');
  assert.match(boot, /events\.emit\(DROP_TOPIC/, 'and republish on the window-local bus');
  assert.match(boot, /import \{ events, DROP_TOPIC \}/, 'the topic is imported, not re-spelled');

  // The topic used to be a literal in BOTH files — `boot.js` (emitter) and
  // `ctx.js` (subscriber) — which is one edit away from a silent break: a drop
  // that finds no listener leaves exactly the same trace as a drop that never
  // arrived, which is none. Now there is one constant, and neither file may
  // spell it out.
  const ctx = readFileSync(new URL('../src/host/ctx.js', import.meta.url), 'utf8');
  assert.match(ctx, /subscribeWith\('in-process', DROP_TOPIC/, 'the subscriber uses the same constant');
  for (const [name, src] of [['boot.js', boot], ['ctx.js', ctx]]) {
    assert.doesNotMatch(src, /'host:drop'/, `${name} must not spell the topic out`);
  }

  // And the failure is diagnosable: the watcher reports every drag phase, the
  // view the drop was routed to, and WHO owns that view. Without the owner,
  // "the drop arrived and every plugin declined it" reads exactly like "the drop
  // never arrived" — which is what made the bug above take two reports to find.
  assert.match(boot, /file drop: \$\{type\}/, 'every drag phase is reported');
  assert.match(boot, /no listener at all for/, 'a drop nobody heard says so');
  assert.match(boot, /\(plugin \$\{owner\}\)/, 'and the routed view names its owning plugin');

  // Not awaited: a window that cannot report drops is still usable.
  assert.match(boot, /^\s{4}watchDrops\(\);$/m, 'watchDrops must not be awaited');
});

test('the dialog plugin is registered for its Rust API, not its JS commands', () => {
  const cargo = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
  assert.match(cargo, /tauri-plugin-dialog/, 'the crate must be a dependency');

  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(lib, /tauri_plugin_dialog::init\(\)/, 'and must be registered');

  // Deliberately NOT in the capability files: a plugin cannot import the JS
  // package, and `__TAURI_INTERNALS__` reaching `plugin:dialog|*` is denied by
  // the ACL precisely because no capability grants it. Adding it here would
  // open a second, ungated path to the same dialogs.
  const cap = JSON.parse(
    readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'),
  );
  const dialogPerms = cap.permissions.filter((p) => String(p).startsWith('dialog:'));
  assert.deepEqual(dialogPerms, [], `dialog permissions must NOT be granted: ${dialogPerms}`);
});

test('the dialog command is async, because the gateway is sync', () => {
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  // `plugin_rpc` is a sync command → main thread → `blocking_pick_file` there
  // would deadlock waiting for a dialog that needs the main thread to pump.
  assert.match(
    lib,
    /async fn plugin_dialog\(/,
    'plugin_dialog must be async so blocking_* runs off the main thread',
  );
  assert.match(lib, /host::registry::is_allowed\(&plugin_id, "rpc:dialog"\)\?/);
});

/* ---------------------------------------------------------------------------
 * Bringing a plugin's own WINDOW to the front.
 *
 * Reported by the author of a plugin whose real UI lives in a separate window:
 * a hotkey bound to `ctx.focusView` switched a main-window view and left the
 * window where it was. `focusView` is about VIEWS; windows need `raise`.
 * ------------------------------------------------------------------------- */

test('windows.control: raise does unminimize -> show -> focus, in that order', () => {
  // Order is the whole point. On Windows, setFocus on a MINIMISED window does
  // not restore it, so a summon that only focuses does nothing visible while
  // every call returns Ok — a silent failure, which is why this is one op
  // instead of three the caller sequences.
  const src = readFileSync(new URL('../src/host/ctx.js', import.meta.url), 'utf8');
  // Fixed-length slice, not up to the first '}': the body contains arrow
  // function bodies () whose braces close long before the case does.
  const start = src.indexOf("case 'raise':");
  assert.ok(start > 0, 'no raise op found');
  const body = src.slice(start, start + 400);

  const un = body.indexOf('unminimize');
  const show = body.indexOf('win.show()');
  const focus = body.indexOf('setFocus');
  assert.ok(un >= 0 && show >= 0 && focus >= 0, 'raise must do all three');
  assert.ok(un < show && show < focus, 'and in the order unminimize, show, focus');
});

test('the main window is ALLOWED to unminimize', () => {
  // The method existed in Tauri but the capability did not grant it, so the
  // call would have been denied at the ACL — the kind of gap that only shows up
  // at runtime, on the one path nobody tests.
  const cap = JSON.parse(
    readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'),
  );
  assert.ok(
    cap.permissions.includes('core:window:allow-unminimize'),
    'the main window must be allowed to unminimize',
  );
  assert.ok(cap.permissions.includes('core:window:allow-is-minimized'));
});

test('the docs do not claim focusView can summon a window', () => {
  // The original recipe called focusView "the complete implementation of
  // summon-a-plugin". It is complete for VIEW-based plugins only, and that
  // wording sent a window-based plugin author down a dead end.
  const api = readFileSync(new URL('../docs/plugin-dev/api.md', import.meta.url), 'utf8');
  const recipes = readFileSync(new URL('../docs/plugin-dev/recipes.md', import.meta.url), 'utf8');

  assert.match(api, /不管窗口/, 'api.md must say focusView does not touch windows');
  assert.match(recipes, /窗口型/, 'recipes.md must cover the window-based shape');
  assert.match(recipes, /raise/, 'and name the op that works for it');
});

test('the docs do not show a label the host would reject', () => {
  // The window section's example used `'my-win'`, which the host now refuses
  // outright — so the doc was teaching a pattern that throws. The one remaining
  // occurrence is inside a block that SHOWS the rejection, which is the point
  // of that block, so the check is on the url form a reader would copy.
  const api = readFileSync(new URL('../docs/plugin-dev/api.md', import.meta.url), 'utf8');
  assert.doesNotMatch(
    api,
    /label=my-win/,
    'a copyable url must not carry a label the host rejects',
  );
  // And the op that makes a window actually come forward has to be documented.
  assert.match(api, /raise/, 'api.md must document the raise op');
  assert.match(api, /创建后能改的/, 'and list the runtime ops');
});