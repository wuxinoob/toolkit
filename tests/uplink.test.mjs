/**
 * Uplink streams (`channel-in`).
 *
 * The gap this closes: every other scheme moves data host -> plugin, so a plugin
 * feeding a backend had to call `proc/send` once per line — a 1000-frame burst
 * cost 1000 round trips.
 *
 * The carrier is batched `invoke`, not a `Channel`, because Tauri's Channel is
 * one-directional (the JS side has no `send`). These tests pin the consequence
 * that matters: N frames cost ONE round trip, and the capability declaration is
 * honest (asking for the wrong capability fails at setup).
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
const calls = [];
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
      calls.push({ cmd, args });
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
  createElement: () => ({ style: {}, addEventListener() {}, appendChild(c) { return c; } }),
  head: { appendChild() {} },
  body: { appendChild() {}, style: {} },
  documentElement: { style: {} },
};
globalThis.requestAnimationFrame ||= (fn) => setTimeout(() => fn(0), 0);

// dynamic imports AFTER shims are in place
const { MessageHub } = await import('../src/protocol/hub.js');
const { buildCtx } = await import('../src/host/ctx.js');
const { descriptors, Capability } = await import('../src/protocol/registry.js');
const Envelope = await import('../src/protocol/envelope.js');

/** Answer the gateway; record what the uplink sent. */
function installGateway() {
  calls.length = 0;
  invokeImpl = async (cmd, args) => {
    if (cmd === 'plugin_rpc') {
      const { msg } = args;
      return { v: 1, kind: 'res', id: msg.id, p: { ok: true } };
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  };
}

const writeIns = () =>
  calls.filter((c) => c.cmd === 'plugin_rpc' && c.args?.msg?.act === 'write_in');

const frames = (n, ch = 'up') =>
  Array.from({ length: n }, (_, i) => Envelope.data(ch, { i }));

// ----------------------------------- tests ------------------------------------

test('N frames cost ONE round trip, not N', async () => {
  installGateway();
  const hub = new MessageHub();
  const handle = await hub.uplink('t.plugin', 'up', { sink: 'proc', params: { key: 'backend' } });

  await handle.sendBatch(frames(100));

  const writes = writeIns();
  assert.equal(writes.length, 1, `100 frames must be one call, got ${writes.length}`);
  assert.equal(writes[0].args.msg.p.frames.length, 100, 'all 100 frames in that one call');
  assert.equal(writes[0].args.msg.p.ch, 'up');
});

test('send() is the same shape as every other transport, and is one frame', async () => {
  installGateway();
  const hub = new MessageHub();
  const handle = await hub.uplink('t.plugin', 'up', { sink: 'proc' });

  await handle.send(Envelope.data('up', { only: true }));

  const writes = writeIns();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].args.msg.p.frames.length, 1);
});

test('a batch over the limit is refused by the caller, not the host', async () => {
  installGateway();
  const hub = new MessageHub();
  const handle = await hub.uplink('t.plugin', 'up', { sink: 'proc' });

  await assert.rejects(() => handle.sendBatch(frames(1000)), /exceeds the 256-frame limit/);
  assert.equal(writeIns().length, 0, 'nothing was sent');

  // and a frame that is not an envelope is caught before it leaves
  await assert.rejects(() => handle.sendBatch([{ kind: 'nope' }]), /v/);
  assert.equal(writeIns().length, 0);
});

test('an uplink needs a sink, and close is idempotent', async () => {
  installGateway();
  const hub = new MessageHub();

  await assert.rejects(() => hub.uplink('t.plugin', 'nosink', {}), /requires params.sink/);

  const handle = await hub.uplink('t.plugin', 'up', { sink: 'proc' });
  await handle.close();
  await handle.close();

  const closes = calls.filter((c) => c.cmd === 'plugin_rpc' && c.args?.msg?.act === 'close_in');
  assert.equal(closes.length, 1, 'closed exactly once');
  assert.deepEqual(hub.openStreamKeys(), [], 'the hub record is released');
});

test('the capability declaration is real: channel-in is uplink, not push', async () => {
  const d = descriptors().find((x) => x.id === 'channel-in');
  assert.ok(d, 'channel-in must be in the scheme table');
  assert.equal(d.direction, 'up');
  assert.equal(d.capabilities[Capability.UPLINK], true);
  assert.notEqual(d.capabilities[Capability.PUSH], true, 'it does not push TO the plugin');

  installGateway();
  const hub = new MessageHub();
  // `hub.stream` defaults to requiring PUSH, so this must fail at SETUP — which
  // is the whole point of declaring capabilities rather than inferring them.
  await assert.rejects(
    () => hub.stream('t.plugin', 'channel-in', { provider: 'plugin', ch: 'x' }),
    /cannot push/,
  );
});

test('ctx.uplink is gated by rpc:stream, like the rest of the data plane', async () => {
  installGateway();
  const ctx = buildCtx({ manifest: { id: 't.noperm', permissions: [] } }, { track() {} });
  await assert.rejects(() => ctx.uplink('up', { sink: 'proc' }), /missing permission "rpc:stream"/);

  const allowed = buildCtx(
    { manifest: { id: 't.perm', permissions: ['rpc:stream'] } },
    { track() {} },
  );
  const handle = await allowed.uplink('up', { sink: 'proc' });
  assert.equal(handle.sink, 'proc');
  assert.equal(typeof handle.sendBatch, 'function');
  await handle.close();
});
