/**
 * `ctx.windows.create` validates its options.
 *
 * The point of this file: window options were the one surface in the host with
 * no allow-list — they went straight into `new WebviewWindow(label, options)`.
 * Everything else here is fail-closed (service actions, capabilities, the
 * component vocabulary), so this is the exception worth pinning.
 *
 * The validation runs BEFORE the async window lookup, so it can be tested with
 * no Tauri at all: the rejection happens before anything touches the native API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

// A window/localStorage shim, installed before any host module is imported —
// ctx.js reads localStorage at import time.
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
const ctx = buildCtx({ manifest: { id: 'test.winopts', permissions: ['win:manage'] } }, disposer);

/** The rejection message, or null if it resolved (it should not). */
async function reason(promise) {
  try {
    await promise;
    return null;
  } catch (e) {
    return e.message;
  }
}

test('windows.create: the app\'s own entry page is allowed', async () => {
  // These are the shapes the two built-in windowed plugins actually pass. They
  // must get PAST validation; where they fail afterwards (no Tauri in Node) is
  // not what this test is about, so the assertion is only that the failure is
  // not a validation one.
  for (const url of ['index.html?mode=floatwin', 'index.html?mode=pluginwin&plugin=x', 'index.html']) {
    const msg = await reason(ctx.windows.create('probe-a', { url, width: 200, height: 200 }));
    assert.ok(
      msg === null || !msg.includes('must be the app'),
      `"${url}" should pass validation, got: ${msg}`,
    );
  }
});

test('windows.create: an arbitrary URL is rejected', async () => {
  for (const url of ['https://example.com', 'http://127.0.0.1/x', 'file:///etc/passwd', 'index.htmlx']) {
    const msg = await reason(ctx.windows.create('probe-b', { url }));
    assert.ok(
      msg && msg.includes('must be the app'),
      `"${url}" should have been rejected, got: ${msg}`,
    );
  }
});

test('windows.create: an unknown option is rejected', async () => {
  // `url` is the dangerous one, but the rule is an allow-list: anything not
  // named is refused rather than forwarded and hoped about.
  const msg = await reason(ctx.windows.create('probe-c', { someFutureOption: true }));
  assert.ok(msg && msg.includes('not allowed'), `expected a rejection, got: ${msg}`);
  assert.ok(msg.includes('someFutureOption'), 'the message should name the offending option');
});

test('windows.create: the documented options still pass', async () => {
  // Everything floatwin and calc pass today, plus the neighbours a plugin might
  // reasonably want. A regression here would break both built-ins.
  const ok = {
    url: 'index.html?mode=floatwin',
    title: 'x',
    width: 300,
    height: 400,
    x: 10,
    y: 10,
    center: true,
    transparent: true,
    decorations: false,
    shadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    closable: true,
    focus: true,
    visible: true,
  };
  const msg = await reason(ctx.windows.create('probe-d', ok));
  assert.ok(msg === null || !msg.includes('not allowed'), `a documented option was refused: ${msg}`);
});

test('windows.create: the allow-list covers every option the built-ins pass', () => {
  // The allow-list is only safe if it does not silently break the windows that
  // already exist. Reading the real call sites beats a hand-written list: the
  // hand-written one drifts the moment someone adds an option to a plugin.
  const WINDOW_OPTIONS = new Set([
    'url', 'title', 'width', 'height', 'x', 'y', 'center', 'transparent',
    'decorations', 'shadow', 'alwaysOnTop', 'skipTaskbar', 'resizable',
    'maximizable', 'minimizable', 'closable', 'focus', 'visible',
  ]);

  const files = ['src/plugins/floatwin.js', 'examples/calc-plugin/main.js'];
  const problems = [];
  let seen = 0;
  for (const file of files) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const call = src.match(/ctx\.windows\.create\([^,]+,\s*\{([\s\S]*?)\n\s*\}\)/);
    if (!call) {
      problems.push(`${file}: no ctx.windows.create(...) call found — did the shape change?`);
      continue;
    }
    const keys = [...call[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:/gm)].map((m) => m[1]);
    seen += keys.length;
    for (const k of keys) {
      if (!WINDOW_OPTIONS.has(k)) problems.push(`${file}: passes "${k}", which the allow-list refuses`);
    }
  }
  assert.ok(seen >= 10, `only ${seen} options extracted — the extractor is not working`);
  assert.deepEqual(problems, [], `the allow-list would break a built-in window://n  ${problems.join('\n  ')}`);
});

test('startup: the hidden-window handshake is intact on all three sides', () => {
  // Three files have to agree or the app misbehaves in a way that is easy to
  // ship and hard to notice:
  //
  //   tauri.conf.json  visible:false  — no unpainted frame is ever shown
  //   src/main.js      show()         — the frontend reveals it after first paint
  //   src-tauri/lib.rs show()         — the backstop if the frontend never does
  //
  // Drop the config and the white flash returns (worst on a FIRST run, where
  // WebView2 has no caches). Drop either show() and the window never appears at
  // all — the app looks like it failed to start.
  const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const main = conf.app.windows.find((w) => w.title === 'Toolbox');
  assert.ok(main, 'no main window in tauri.conf.json');
  assert.equal(main.visible, false, 'the main window must start hidden, or the white flash comes back');

  const mainJs = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.ok(
    /getCurrentWindow\(\)[\s\S]{0,120}?\.show\(\)/.test(mainJs),
    'src/main.js must reveal the window — nothing else does',
  );

  const libRs = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.ok(libRs.includes('is_visible'), 'lib.rs must have the backstop that shows a window the frontend never revealed');

  // And the frontend is only ALLOWED to show it because the capability says so.
  const cap = JSON.parse(
    readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'),
  );
  assert.ok(
    cap.permissions.includes('core:window:allow-show'),
    'the main-window capability must allow `show`',
  );
});
