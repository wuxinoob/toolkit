/**
 * The channel receiver we own — behaviour, and the wire contract it must keep.
 *
 * The framework's `Channel` buffers a lost frame **forever**: `nextMessageIndex`
 * stops one short of the hole, every later frame is parked in a sparse array,
 * `onEnd` never fires, and memory grows. That is how a plugin panel went blank
 * while the app kept running. These tests pin the replacement's contract:
 *
 *   - same order guarantee while a hole is plausible (a real reorder),
 *   - bounded waiting when it is not (count / bytes / time),
 *   - a lost frame ends the stream LOUDLY, exactly once,
 *   - and the id still serialises the way `tauri::ipc` expects, which is the one
 *     thing that could silently break every stream at once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./browser-stubs-loader.mjs', import.meta.url);

const callbacks = new Map();
let seq = 0;
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
};
globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async () => {
      throw new Error('the receiver must not invoke anything');
    },
    transformCallback: (cb) => {
      const id = ++seq;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
};

const { Channel } = await import('../src/protocol/channel.js');

/** Deliver the way the Rust side does. Returns false if the callback is gone. */
function deliver(channel, message) {
  const cb = callbacks.get(channel.id);
  if (!cb) return false;
  cb(message);
  return true;
}

/** A channel plus the two things every test asserts on. */
function makeChannel(opts = {}) {
  const frames = [];
  const gaps = [];
  const channel = new Channel((m) => frames.push(m), { onGap: (why) => gaps.push(why), ...opts });
  return { channel, frames, gaps };
}

// ----------------------------------- tests ------------------------------------

test('frames are delivered in order, and an end frame releases the callback', () => {
  const { channel, frames, gaps } = makeChannel();

  assert.equal(deliver(channel, { index: 0, message: 'a' }), true);
  assert.equal(deliver(channel, { index: 1, message: 'b' }), true);
  assert.deepEqual(frames, ['a', 'b']);
  assert.equal(gaps.length, 0);

  assert.equal(deliver(channel, { end: true, index: 2 }), true);
  assert.deepEqual(frames, ['a', 'b'], 'an end frame is not a message');
  assert.equal(callbacks.has(channel.id), false, 'the callback must be released');
  assert.equal(deliver(channel, { index: 3, message: 'c' }), false, 'nothing arrives after end');
});

test('a real reorder is still repaired, not reported', () => {
  const { channel, frames, gaps } = makeChannel();

  // Frame 1 arrives before 0 — the fetch path can do this, which is why the
  // index exists at all. Within the window this must stay silent.
  deliver(channel, { index: 1, message: 'b' });
  assert.deepEqual(frames, [], 'nothing is delivered out of order');
  deliver(channel, { index: 0, message: 'a' });

  assert.deepEqual(frames, ['a', 'b'], 'the gap filled, both arrive in order');
  assert.equal(gaps.length, 0, 'a repaired reorder is not a failure');
});

test('a hole that is never filled ends the channel once, and nothing follows it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { channel, frames, gaps } = makeChannel({ gapMs: 2_000 });

  deliver(channel, { index: 0, message: 'a' });
  deliver(channel, { index: 2, message: 'c' }); // frame 1 is lost
  assert.equal(gaps.length, 0, 'a hole is given time before it is judged');

  t.mock.timers.tick(2_000);

  assert.equal(gaps.length, 1, `expected exactly one gap report, got ${JSON.stringify(gaps)}`);
  assert.match(gaps[0], /frame 1 never arrived/, 'the report must name the missing index');
  assert.deepEqual(frames, ['a'], 'the buffered frame is not delivered out of order');
  assert.equal(callbacks.has(channel.id), false, 'the callback must be released');

  // A late arrival must not resurrect a stream the caller already closed.
  assert.equal(deliver(channel, { index: 1, message: 'b' }), false);
  assert.deepEqual(frames, ['a']);
});

test('an unbounded backlog is refused instead of buffered forever', () => {
  // The framework's receiver has no cap at all: a single lost frame is enough
  // to accumulate every later frame for the life of the window (one renderer
  // reached 832 MB this way).
  const { channel, frames, gaps } = makeChannel();

  for (let i = 1; i <= 300; i++) deliver(channel, { index: i, message: i });

  assert.equal(gaps.length, 1, `expected one overflow report, got ${JSON.stringify(gaps)}`);
  assert.match(gaps[0], /overflow/, 'the report must say what happened');
  assert.match(gaps[0], /waiting for index 0/, 'and what it was waiting for');
  assert.deepEqual(frames, [], 'nothing is delivered while the hole is open');
  assert.equal(callbacks.has(channel.id), false);
});

test('the id serialises the way the IPC layer expects', async () => {
  const { channel } = makeChannel();

  // 1) Same prefix as the installed API. This is the assertion that catches an
  //    upstream change: our copy would keep producing `__CHANNEL__:` while Rust
  //    stopped accepting it, and EVERY stream would break at once.
  const { Channel: Upstream } = await import('@tauri-apps/api/core');
  const upstream = new Upstream();
  assert.equal(
    channel.toJSON().split(':')[0],
    upstream.toJSON().split(':')[0],
    'the prefix must match @tauri-apps/api',
  );

  // 2) The exact check `process-ipc-message-fn.js` performs: the method name is
  //    a plain string key, not a Symbol — `toJSON` alone would be ignored and
  //    the whole object would be serialised instead of the id.
  assert.equal('__TAURI_TO_IPC_KEY__' in channel, true, 'the serialiser looks for this key');
  const asArg = JSON.stringify({ onFrame: channel }, (_k, val) =>
    val && typeof val === 'object' && '__TAURI_TO_IPC_KEY__' in val
      ? val.__TAURI_TO_IPC_KEY__()
      : val,
  );
  assert.deepEqual(
    JSON.parse(asArg),
    { onFrame: `__CHANNEL__:${channel.id}` },
    'the command argument must arrive as the id string',
  );
});

test('a lost frame ends the STREAM, not just the receiver', async (t) => {
  // The receiver reporting a gap is only half of it: the caller has to be told
  // and the host has to be told to stop. Without this the stream stays in
  // `hub.streams` (so it cannot be re-opened) while the host keeps producing
  // into a callback that no longer exists.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  globalThis.window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'plugin_stream_open') return null;
    if (cmd === 'plugin_stream_close') return { stopped: true };
    throw new Error(`unexpected invoke: ${cmd}`);
  };

  const { hub } = await import('../src/protocol/hub.js');
  const Envelope = await import('../src/protocol/envelope.js');

  const ended = [];
  await hub.stream('p.gap', 'channel-json', {
    provider: 'ticker',
    ch: 'g1',
    onFrame: () => {},
    onEnd: (e) => ended.push(e),
  });

  const channel = calls.find((c) => c.cmd === 'plugin_stream_open').args.onFrame;
  const cb = callbacks.get(channel.id);
  assert.ok(cb, 'the open call must hand the host a live channel');

  cb({ index: 0, message: Envelope.data('g1', { n: 0 }) });
  cb({ index: 2, message: Envelope.data('g1', { n: 2 }) }); // 1 is lost
  assert.equal(ended.length, 0, 'a gap is not judged immediately');

  t.mock.timers.tick(2_000);

  assert.equal(ended.length, 1, 'the caller must get exactly one terminal frame');
  assert.equal(ended[0].kind, 'err');
  assert.equal(ended[0].code, 'transport', 'a lost frame is a transport failure, not a codec one');
  assert.match(ended[0].msg, /frame 1 never arrived/);
  assert.equal(hub.streams.has('p.gap/g1'), false, 'the channel must be re-openable');
  assert.ok(
    calls.some((c) => c.cmd === 'plugin_stream_close'),
    'the host must be told to stop producing',
  );
});
