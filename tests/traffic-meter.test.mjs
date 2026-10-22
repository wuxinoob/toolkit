/**
 * The traffic meter — "which channel was flooding?".
 *
 * Why this needs a behavioural test rather than a note: the app has twice gone
 * dead with no error on the JS side (a standby resume, and a full window message
 * queue → `PostMessageW` `ERROR_NOT_ENOUGH_QUOTA` 0x80070718, after which every
 * IPC call is dropped silently). The only question that matters at that moment
 * is which channel was producing so fast, and the only tool there was
 * `traceRpc` — which writes one gateway call PER FRAME, i.e. a diagnostic that
 * amplifies the flood.
 *
 * A meter that stops counting looks exactly like a quiet app, so the assertions
 * are on real frames going through the real hub: if the wrap point is removed,
 * these go red.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./browser-stubs-loader.mjs', import.meta.url);

// ------------------------------ environment shims -----------------------------
const callbacks = new Map();
let cbSeq = 0;
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
      const id = ++cbSeq;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
};

// dynamic imports AFTER the shims are in place
const Envelope = await import('../src/protocol/envelope.js');
const { hub } = await import('../src/protocol/hub.js');

const T0 = Date.parse('2026-10-22T09:00:00Z');
const WINDOW_MS = 5_000;

/** Drive a `Channel` the way the Rust side does: `{index, message}`. */
function deliver(channel, message, index) {
  const cb = callbacks.get(channel.id);
  assert.ok(cb, `no callback registered for channel ${channel.id}`);
  cb({ index, message });
}

/** A host that accepts one stream open, and records the Channel it was given. */
function openGateway() {
  invokeCalls.length = 0;
  const captured = { current: null };
  invokeImpl = async (cmd, args) => {
    if (cmd === 'plugin_stream_open' || cmd === 'plugin_stream_open_raw') {
      captured.current = args;
      return null;
    }
    if (cmd === 'plugin_stream_close') return { stopped: true };
    throw new Error(`unexpected invoke: ${cmd}`);
  };
  return captured;
}

function muteWarnings(t) {
  const seen = [];
  const real = console.warn;
  console.warn = (...args) => seen.push(args.join(' '));
  t.after(() => {
    console.warn = real;
  });
  return seen;
}

// ----------------------------------- tests ------------------------------------

test('a sustained flood warns once, naming the channel and the rate', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const warns = muteWarnings(t);
  const captured = openGateway();

  const frames = [];
  await hub.stream('p.flood', 'channel-json', {
    provider: 'ticker',
    ch: 'hot',
    onFrame: (f) => frames.push(f),
  });

  // 700 frames inside one window = 137/s, over the 120/s budget. That is the
  // shape of the real incident: a terminal or a chatty child, sustained.
  for (let i = 0; i < 700; i++) deliver(captured.current.onFrame, Envelope.data('hot', { n: i }), i);
  assert.equal(warns.length, 0, 'a window that has not closed yet cannot be judged');

  // The window closes on the next frame — that is when the rate exists.
  t.mock.timers.setTime(T0 + WINDOW_MS + 100);
  deliver(captured.current.onFrame, Envelope.data('hot', { n: 700 }), 700);

  assert.equal(frames.length, 701, 'the meter must never swallow a frame');
  assert.equal(warns.length, 1, `expected exactly one warning, got ${JSON.stringify(warns)}`);
  assert.match(warns[0], /channel-json p\.flood\/hot/, 'the warning must name the channel');
  assert.match(warns[0], /frames\/s/);

  const top = hub.trafficReport()[0];
  assert.ok(top, 'the report must contain the flooding channel');
  assert.match(top.key, /p\.flood\/hot/);
  assert.ok(top.framesPerSec > 120, `the rate must be recorded, got ${top.framesPerSec}`);
});

test('a quiet channel stays out of the report, and same-window events are not metered', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const warns = muteWarnings(t);
  const captured = openGateway();

  await hub.stream('p.quiet', 'channel-json', {
    provider: 'ticker',
    ch: 'cold',
    onFrame: () => {},
  });
  deliver(captured.current.onFrame, Envelope.data('cold', { n: 0 }), 0);
  t.mock.timers.setTime(T0 + WINDOW_MS + 100);
  // Roll the window without adding traffic: one frame in 5.1 s = 0.2/s.
  hub.trafficReport();

  const keys = hub.trafficReport().map((x) => x.key);
  assert.equal(
    keys.some((k) => k.includes('cold')),
    false,
    `a channel under 1 frame/s is not news, got ${JSON.stringify(keys)}`,
  );
  assert.equal(warns.length, 0, 'nothing to warn about');

  // `in-process` never leaves the window: metering it would report a plugin's
  // own event loop as if it were queue pressure.
  const got = [];
  hub.local('p.local', 'busy.topic', (p) => got.push(p));
  for (let i = 0; i < 50; i++) hub.publish('p.local', 'busy.topic', i, { scheme: 'in-process' });
  assert.equal(got.length, 50, 'same-window delivery still works');
  assert.equal(
    hub.trafficReport().some((x) => x.key.includes('busy.topic')),
    false,
    'in-process events cost no IPC and must not be counted',
  );
});

test('a frame without a payload does not break the counter', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  muteWarnings(t);
  const captured = openGateway();

  let seen = 0;
  await hub.stream('p.bare', 'channel-json', {
    provider: 'ticker',
    ch: 'bare',
    onFrame: () => {
      seen += 1;
    },
  });
  // `end` carries no payload at all — the meter must count it, not throw.
  deliver(captured.current.onFrame, Envelope.end('bare'), 0);
  assert.equal(seen, 1);
  assert.ok(
    hub.trafficReport().some((x) => x.key.includes('bare')),
    'a payload-less frame is still a frame',
  );
});
