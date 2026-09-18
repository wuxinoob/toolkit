import test from 'node:test';
import assert from 'node:assert/strict';

import { MessageHub } from '../src/protocol/hub.js';
import { rpcTransport } from '../src/protocol/transports/rpc.js';
import * as Envelope from '../src/protocol/envelope.js';

/**
 * Record every delay the transport arms, and never actually wait.
 *
 * Asserting on the armed delay is deterministic; asserting on elapsed wall time
 * would be a flaky timing test.
 */
function captureTimers() {
  const delays = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    delays.push(ms ?? 0);
    return real(fn, 0, ...rest);
  };
  return { delays, restore: () => { globalThis.setTimeout = real; } };
}

test('a delivered line re-polls immediately instead of waiting pollMs', async () => {
  // The host's recv is condvar driven and returns as soon as data exists, so
  // waiting pollMs after every line capped throughput at 1/pollMs (~20 lines/s
  // at the 50ms default) however fast the backend produced.
  const original = rpcTransport.request;
  const lines = [Envelope.data('w', 'a'), Envelope.data('w', 'b'), Envelope.data('w', 'c'), Envelope.end('w')];
  let i = 0;
  rpcTransport.request = async ({ act }) =>
    act === 'recv' ? (i < lines.length ? { line: JSON.stringify(lines[i++]) } : { timeout: true }) : {};

  const timers = captureTimers();
  try {
    const hub = new MessageHub();
    const frames = [];
    let resolveEnded;
    const ended = new Promise((r) => { resolveEnded = r; });
    await hub.sidecar('poll-test', 'w', {
      exe: 'stub',
      pollMs: 50,
      onFrame: (f) => frames.push(f),
      onEnd: resolveEnded,
    });
    await ended;
    assert.equal(frames.length, 4, 'all four frames delivered');

    const reArms = timers.delays.slice(1); // [0] is the initial arm
    assert.ok(reArms.length >= 3, `expected at least 3 re-arms, got ${reArms.length}`);
    assert.deepEqual(
      reArms.slice(0, 3),
      [0, 0, 0],
      `a delivered line must re-poll immediately, got ${reArms.slice(0, 3)}`,
    );
  } finally {
    rpcTransport.request = original;
    timers.restore();
  }
});

test('an idle poll waits pollMs, so a silent backend is not a busy loop', async () => {
  const original = rpcTransport.request;
  rpcTransport.request = async ({ act }) => (act === 'recv' ? { timeout: true } : {});

  const timers = captureTimers();
  let handle;
  try {
    const hub = new MessageHub();
    handle = await hub.sidecar('poll-idle', 'w', { exe: 'stub', pollMs: 50, onEnd: () => {} });
    // the first tick is a macrotask; wait (bounded) for it to arm the next one
    const deadline = Date.now() + 2000;
    while (timers.delays.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    const reArms = timers.delays.slice(1); // [0] is the initial arm
    assert.ok(reArms.length >= 1, 'expected at least one idle re-arm');
    assert.equal(reArms[0], 50, 'an idle poll must back off by pollMs');
  } finally {
    await handle?.close();
    rpcTransport.request = original;
    timers.restore();
  }
});
