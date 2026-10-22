/**
 * `stdio-line` pacing — the last unbounded producer in the app.
 *
 * One line costs one `invoke`, and every invoke is a main-thread message; the
 * window's queue holds 10 000 of them. The drain loop used to re-poll at 0 ms
 * whenever a line arrived, so a backend that prints faster than the IPC can
 * answer (a build tool, `tail -f`, anything logging per iteration) turned into
 * an invoke storm — and the first visible symptom was that every control in the
 * app stopped responding, with no error on the JS side.
 *
 * Two properties are pinned here, both of them behavioural:
 *
 *   1. A chatty backend is THROTTLED, and says so once (the warning is the
 *      deterministic signal: no budget, no warning).
 *   2. `pollMs: 0` cannot become a 0 ms IDLE loop. That case has no data at
 *      all, so it was a busy loop that produced nothing.
 *
 * Real timers, not mock ones, on purpose: `setTimeout(0)` in Node is ~1 ms, so
 * the old behaviour is measurable (~1000 polls/s) instead of an infinite
 * synchronous spin that would hang the runner.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./browser-stubs-loader.mjs', import.meta.url);

const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
  clear: () => ls.clear(),
};

/** Set by each test: what `proc/recv` should answer. */
let recvReply = () => ({ line: 'tick' });
let recvCalls = 0;

globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => {
      if (cmd !== 'plugin_rpc') throw new Error(`unexpected invoke: ${cmd}`);
      const { msg } = args;
      const base = { v: 1, kind: 'res', id: msg.id };
      if (msg.act === 'recv') {
        recvCalls += 1;
        return { ...base, p: recvReply() };
      }
      if (msg.act === 'spawn') return { ...base, p: { pid: 4242 } };
      if (msg.act === 'kill') return { ...base, p: true };
      throw new Error(`unexpected action: ${msg.act}`);
    },
    transformCallback: (cb) => cb,
    unregisterCallback: () => {},
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
};

const { hub } = await import('../src/protocol/hub.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function muteWarnings(t) {
  const seen = [];
  const real = console.warn;
  console.warn = (...args) => seen.push(args.join(' '));
  t.after(() => {
    console.warn = real;
  });
  return seen;
}

test('a chatty backend is throttled, and the throttle is reported once', async (t) => {
  const warns = muteWarnings(t);
  recvCalls = 0;
  recvReply = () => ({ line: 'a line from a very talkative helper' });

  // Freeze the clock. The budget is a COUNT inside a 1 s window, and how fast
  // that count grows depends on the platform's timer resolution — 12 ms per
  // `setTimeout(0)` on this machine, 4 ms in a webview. Asserting against a real
  // window would make this a stopwatch test that passes or fails with the host
  // machine. With time standing still the window never rolls, so the 121st poll
  // MUST trip the budget however fast the loop happens to run.
  const realNow = Date.now;
  const T0 = realNow();
  Date.now = () => T0;
  t.after(() => {
    Date.now = realNow;
  });

  const handle = await hub.sidecar('p.talk', 'chatty', { exe: 'x.exe', pollMs: 50 });
  t.after(() => handle.close());

  // Wait for the trip rather than sleeping a fixed time: the property is "it
  // trips", not "it trips in exactly N milliseconds".
  const deadline = realNow() + 6_000;
  while (!warns.length && realNow() < deadline) await sleep(20);

  assert.equal(warns.length, 1, `expected one throttle warning, got ${JSON.stringify(warns)}`);
  assert.match(warns[0], /drain throttled to 120\/s/, 'the warning must name the rate');
  assert.match(warns[0], /chatty/, 'and the channel');

  // It trips AT the budget, not long after: 121 polls, plus whatever the wait
  // loop overshot by.
  assert.ok(
    recvCalls >= 115 && recvCalls <= 160,
    `the budget is 120/s, so the trip should land near poll 120 — got ${recvCalls}`,
  );

  // And it backs OFF rather than stopping: `pollMs` (50) from here on.
  const before = recvCalls;
  await sleep(220);
  const after = recvCalls - before;
  assert.ok(after >= 2 && after <= 8, `after the trip the loop must pace at pollMs, got ${after} in 220ms`);
});

test('the poll interval is clamped, so pollMs: 0 cannot mean "no pacing"', async () => {
  // Not behavioural, and deliberately so: on a platform whose `setTimeout(0)`
  // floor is 12 ms, an unclamped 0 and a clamped 10 look the same from the
  // outside. The clamp is a policy, so the policy is what gets asserted.
  const { clampPoll } = await import('../src/protocol/transports/stdioLine.js');

  assert.equal(clampPoll(0), 10, '0 is a busy loop; the floor is 10 ms');
  assert.equal(clampPoll(-100), 10, 'a negative interval is the same mistake');
  assert.equal(clampPoll(undefined), 50, 'absent keeps the documented default');
  assert.equal(clampPoll(Number.NaN), 50, 'a non-number must not become 0');
  assert.equal(clampPoll(1e9), 5_000, 'and the ceiling holds');
  assert.equal(clampPoll(60), 60, 'a sane value is untouched');
});
