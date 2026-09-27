/**
 * The window-scoped SDK (`bridge`) — its BEHAVIOUR, not just its surface.
 *
 * `tests/sdk-parity.test.mjs` proves which namespaces exist on both SDKs. That
 * is necessary and not sufficient: `bridge.dispose()` existed and had the right
 * shape while doing the wrong thing. It released subscriptions and timers but
 * not STREAMS, so a plugin window that opened a pty or a sidecar and then closed
 * left the helper process running with nothing left alive that could ever close
 * it. Same name, same signature, wrong behaviour.
 *
 * So this file drives the real `makeBridge` against the real protocol hub with
 * only `invoke` shimmed, and asserts what actually happens.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

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
const { makeBridge, deliverWindowDrop } = await import('../src/host/pluginwin-host.js');
const { hub } = await import('../src/protocol/hub.js');

/** A host that accepts everything the bridge might open. */
function openGateway() {
  invokeCalls.length = 0;
  invokeImpl = async (cmd, { msg } = {}) => {
    if (cmd === 'plugin_stream_open' || cmd === 'plugin_stream_open_raw') return null;
    if (cmd === 'plugin_stream_close') return null;
    return { v: 1, kind: 'res', id: msg?.id ?? 1, p: {} };
  };
}

/** Drop any stream a previous test left behind, so keys cannot collide. */
async function closeAllStreams() {
  for (const key of [...hub.streams.keys()]) {
    const at = key.indexOf('/');
    await hub.close(key.slice(0, at), key.slice(at + 1));
  }
}

const STREAM_PERMS = { permissions: ['rpc:stream'] };

// ----------------------------------- tests ------------------------------------

test('dispose() releases every stream the window opened', async () => {
  openGateway();
  await closeAllStreams();

  const bridge = makeBridge('p.win', 'plugin-p', STREAM_PERMS);
  await bridge.stream('ticker', 'a', {});
  await bridge.stream('ticker', 'b', {});
  assert.ok(hub.streams.has('p.win/a'), 'the first stream should be live');
  assert.ok(hub.streams.has('p.win/b'), 'the second stream should be live');

  invokeCalls.length = 0;
  await bridge.dispose();

  assert.equal(
    hub.streams.has('p.win/a'),
    false,
    'a closed window must not leave its stream behind — this is the pty/sidecar leak',
  );
  assert.equal(hub.streams.has('p.win/b'), false, '…nor its second one');
  const closes = invokeCalls.filter((c) => c.cmd === 'plugin_stream_close');
  assert.equal(closes.length, 2, `both streams must be closed at the host, saw ${closes.length}`);
});

test('dispose() is idempotent and does not throw on an already-closed stream', async () => {
  openGateway();
  await closeAllStreams();

  const bridge = makeBridge('p.win2', 'plugin-p', STREAM_PERMS);
  await bridge.stream('ticker', 'a', {});
  await bridge.closeStream('a');

  await bridge.dispose(); // the stream is already gone; this must not throw
  await bridge.dispose(); // and running twice must not either
  assert.equal(hub.streams.size, 0);
});

test('closeStream only ever touches streams this window opened', async () => {
  openGateway();
  await closeAllStreams();

  const bridge = makeBridge('p.own', 'plugin-p', STREAM_PERMS);
  await bridge.stream('ticker', 'mine', {});

  invokeCalls.length = 0;
  assert.equal(await bridge.closeStream('mine'), true, 'its own stream closes');
  assert.equal(hub.streams.has('p.own/mine'), false, 'and it is gone from the hub');

  invokeCalls.length = 0;
  assert.equal(await bridge.closeStream('not-mine'), false, 'an unknown ch is a no-op, not an error');
  assert.deepEqual(invokeCalls, [], 'and it must not reach the host at all');
});

test('a stream another window owns is untouched by this one', async () => {
  openGateway();
  await closeAllStreams();

  const other = makeBridge('p.other', 'plugin-q', STREAM_PERMS);
  const mine = makeBridge('p.mine', 'plugin-p', STREAM_PERMS);
  await other.stream('ticker', 'theirs', {});
  await mine.stream('ticker', 'theirs', {}); // same ch name, different plugin

  invokeCalls.length = 0;
  await mine.dispose();

  assert.equal(hub.streams.has('p.mine/theirs'), false, 'mine is released');
  assert.equal(hub.streams.has('p.other/theirs'), true, "the other window's stream must survive");
  await other.dispose();
});

test('files.* is gated by rpc:dialog, exactly like ctx.files', async () => {
  openGateway();
  const noPerm = makeBridge('p.nodialog', 'plugin-p', { permissions: [] });
  await assert.rejects(
    () => noPerm.files.pick(),
    /missing permission "rpc:dialog"/,
    'a window without rpc:dialog must fail fast, not silently resolve []',
  );
  await assert.rejects(() => noPerm.files.save(), /missing permission "rpc:dialog"/);
  await assert.rejects(() => noPerm.files.message('hi'), /missing permission "rpc:dialog"/);

  const withPerm = makeBridge('p.dialog', 'plugin-p', { permissions: ['rpc:dialog'] });
  invokeImpl = async (cmd, args) => {
    invokeCalls.push({ cmd, args });
    return { paths: ['C:/x.txt'] };
  };
  assert.deepEqual(await withPerm.files.pick({ multiple: true }), ['C:/x.txt']);

  const call = invokeCalls.at(-1);
  assert.equal(call.cmd, 'plugin_dialog');
  assert.equal(call.args.pluginId, 'p.dialog', 'the host must know which plugin asked');
  assert.equal(call.args.action, 'open');
  assert.equal(call.args.params.multiple, true);
});

test('files.pick resolves [] on cancel rather than null', async () => {
  openGateway();
  const bridge = makeBridge('p.cancel', 'plugin-p', { permissions: ['rpc:dialog'] });
  invokeImpl = async () => ({ paths: null });
  assert.deepEqual(await bridge.files.pick(), [], 'a cancelled pick is an empty list, not an error');

  invokeImpl = async () => ({ path: null });
  assert.equal(await bridge.files.save(), null, 'a cancelled save is null');
});

test('log.* prefixes the plugin id, like ctx.log', () => {
  const calls = [];
  const real = console.info;
  console.info = (...a) => calls.push(a);
  try {
    makeBridge('p.logger', 'plugin-p', {}).log.info('hello', 1);
  } finally {
    console.info = real;
  }
  assert.deepEqual(calls, [['[plugin:p.logger]', 'hello', 1]]);
});

// ------------------------------- onDrop (files) -------------------------------

test('onDrop receives the paths and the window label, and needs no permission', async () => {
  // A drop on a plugin window lands on the ONE plugin that owns the window, so
  // there is nothing to route and nothing to authorise — the same reasoning as
  // ctx.onDrop, which is why the permission list here is empty.
  const bridge = makeBridge('p.drop', 'plugin-mywindow', { permissions: [] });
  const seen = [];
  const off = await bridge.onDrop((paths, info) => seen.push([paths, info]));

  assert.equal(deliverWindowDrop(['C:/a.txt', 'C:/b.md'], { label: 'plugin-mywindow' }), 1);
  assert.deepEqual(seen, [
    [['C:/a.txt', 'C:/b.md'], { label: 'plugin-mywindow' }],
  ]);

  off();
  assert.equal(deliverWindowDrop(['C:/c.txt'], { label: 'plugin-mywindow' }), 0);
});

test('onDrop has the same shape as ctx.onDrop: a Promise of a cancel function', async () => {
  const bridge = makeBridge('p.drop2', 'plugin-p', {});
  const off = bridge.onDrop(() => {});
  assert.equal(typeof off.then, 'function', 'the return value must be awaitable, like ctx.onDrop');
  const unsubscribe = await off;
  assert.equal(typeof unsubscribe, 'function', 'and it must resolve to an unsubscribe function');
  unsubscribe(); // the set is per-window; do not leak this into the next test

  await assert.rejects(
    () => bridge.onDrop('not a function'),
    /onDrop\(fn\): fn must be a function/,
    'a bad argument should fail loudly rather than register nothing',
  );
});

test('one throwing drop handler does not stop the next one', async () => {
  const bridge = makeBridge('p.drop3', 'plugin-p', {});
  const seen = [];
  const offBad = await bridge.onDrop(() => {
    throw new Error('this plugin is broken');
  });
  const offGood = await bridge.onDrop((paths) => seen.push(paths));

  const errs = [];
  const real = console.error;
  console.error = (...a) => errs.push(a);
  try {
    assert.equal(deliverWindowDrop(['C:/x'], { label: 'plugin-p' }), 1, 'only the good handler counts');
  } finally {
    console.error = real;
    // The handler set is per-WINDOW, not per-bridge (one window, one realm, one
    // bridge), so a test that leaves a handler behind leaks it into the next
    // test. Release explicitly rather than relying on a later dispose().
    offBad();
    offGood();
  }
  assert.deepEqual(seen, [['C:/x']], 'the second handler must still run');
  assert.equal(errs.length, 1, 'and the failure must be reported, not swallowed');
});

test('dispose() clears the window\u2019s drop handlers, so a torn-down window is inert', async () => {
  const bridge = makeBridge('p.drop4', 'plugin-p', {});
  await bridge.onDrop(() => {
    throw new Error('a stale window must not run this');
  });
  await bridge.dispose();
  assert.equal(
    deliverWindowDrop(['C:/after-dispose'], { label: 'plugin-p' }),
    0,
    'a disposed window must not deliver drops',
  );
});
