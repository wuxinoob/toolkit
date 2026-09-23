/**
 * Communication tracing.
 *
 * The feature exists because the gateway layer was invisible: the debug log only
 * carried lines a plugin wrote itself, so "did my call go out, and what came
 * back" had no answer. That is a large part of why the identity hole in
 * `docs/COMMS-AUDIT-2026-09-23.md` survived as long as it did.
 *
 * The property worth pinning is the FIRST COLUMN: the identity the caller
 * claimed. A `__host__` appearing in a plugin's call is the shape of the
 * forgery, and the trace is what makes it visible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

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

const { hub, setTraceSink } = await import('../src/protocol/hub.js');

/** Capture trace lines for one body, then restore. */
async function traced(body) {
  const lines = [];
  const restore = setTraceSink((l) => lines.push(l));
  hub.setTrace(true);
  try {
    await body();
  } finally {
    hub.setTrace(false);
    setTraceSink(restore);
  }
  return lines;
}

/** Every call rejects in Node (no host) — that is fine, and it IS the path we
 *  want to trace: a denial is the interesting half of the line. */
const swallow = (p) => p.catch(() => {});

test('trace: off by default, so nothing is logged unless asked', async () => {
  const lines = [];
  const restore = setTraceSink((l) => lines.push(l));
  hub.setTrace(false);
  await swallow(hub.request('p', 'storage', 'get', { key: 'k' }));
  setTraceSink(restore);
  assert.deepEqual(lines, [], 'tracing must be opt-in');
});

test('trace: prints the CLAIMED identity first — that is the point', async () => {
  const lines = await traced(() => swallow(hub.request('my.plugin', 'storage', 'get', { key: 'k' })));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^rpc\s+-> my\.plugin storage\/get \d+ms /);
});

test('trace: a forged __host__ is visible as such', async () => {
  // This is what the audit's escalation looks like in the log. Nothing here
  // PREVENTS the forgery — the fix is a token (see the audit). What this
  // guarantees is that you can SEE it.
  const lines = await traced(() => swallow(hub.request('__host__', 'proc', 'spawn', {})));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^rpc\s+-> __host__ proc\/spawn /);
});

test('trace: a failure is recorded, not just a success', async () => {
  const lines = await traced(() => swallow(hub.request('p', 'proc', 'spawn', {})));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /err: /, 'a rejection must produce a line — that is where denials show up');
});

test('trace: write_debug_log is exempt, or the sink would loop forever', async () => {
  // The sink writes BY calling this service. Tracing it would recurse until the
  // stack dies. One line in, zero lines out.
  const lines = await traced(() =>
    swallow(hub.request('__host__', 'host', 'write_debug_log', { content: 'x' })),
  );
  assert.deepEqual(lines, [], 'the trace sink must not be traced');
});

test('trace: setTrace remembers the choice, and reports its own state', () => {
  assert.equal(hub.setTrace(true), true);
  assert.equal(hub.tracing, true);
  assert.equal(localStorage.getItem('toolbox.traceRpc'), '1');
  assert.equal(hub.setTrace(false), false);
  assert.equal(hub.tracing, false);
  assert.equal(localStorage.getItem('toolbox.traceRpc'), '0');
});

test('trace: the sink is reachable as a METHOD', () => {
  // Not just the module export: under Vite, importing the module a second time
  // yields a DIFFERENT instance, so a test (or a devtools session) that reaches
  // for the export silently observes nothing. Cost an hour once.
  assert.equal(typeof hub.setTraceSink, 'function');
  const lines = [];
  const restore = hub.setTraceSink((l) => lines.push(l));
  assert.equal(typeof restore, 'function', 'and it returns the previous sink');
  hub.setTraceSink(restore);
});

/* ---------------------------------------------------------------------------
 * The message kinds the first version MISSED.
 *
 * The trace originally wrapped `request` only, so it showed `rpc` and nothing
 * else — which is a small fraction of what moves. These pin the rest.
 * ------------------------------------------------------------------------- */

test('trace: a publish is traced, with its scheme and payload preview', async () => {
  const lines = await traced(() => swallow(hub.publish('p', 'my.topic', { n: 1 })));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^pub\s+-> p event-bus "my\.topic"/);
  assert.match(lines[0], /\{"n":1\}/, 'the payload preview is the point of a debug trace');
});

test('trace: a subscribe is traced', async () => {
  const lines = await traced(() =>
    hub.subscribe('p', 'my.topic', () => {}, { scheme: 'in-process' }),
  );
  assert.ok(
    lines.some((l) => /^sub\s+<- p in-process "my\.topic"/.test(l)),
    `expected a sub line, got: ${JSON.stringify(lines)}`,
  );
});

test('trace: an ARRIVING event is traced — the receive side', async () => {
  // This is the half the rpc-only trace could never show: not "I subscribed",
  // but "a message actually arrived".
  const { events } = await import('../src/host/events.js');
  const seen = [];
  const lines = [];
  const restore = setTraceSink((l) => lines.push(l));
  hub.setTrace(true);
  try {
    await hub.subscribe('p', 'evt.topic', (payload) => seen.push(payload), {
      scheme: 'in-process',
    });
    lines.length = 0; // drop the `sub` line; we want the delivery
    events.emit('evt.topic', { hello: 'world' });
  } finally {
    hub.setTrace(false);
    setTraceSink(restore);
  }
  assert.equal(seen.length, 1, 'the subscriber must still be called');
  const arrivals = lines.filter((l) => /^evt\s+<- p in-process "evt\.topic"/.test(l));
  assert.equal(arrivals.length, 1, `expected exactly one arrival line, got: ${JSON.stringify(lines)}`);
  assert.match(arrivals[0], /hello/, 'with a payload preview');
});

test('trace: a stream open and its frames are traced', async () => {
  // Frames are the bulk of the traffic in this app — a pty pushes them
  // continuously — and the rpc-only trace showed none of them.
  const lines = [];
  const restore = setTraceSink((l) => lines.push(l));
  hub.setTrace(true);
  try {
    // `ticker` is a real provider: it emits frames without needing a host, so
    // this exercises the frame path in Node.
    const handle = await hub.stream('p', 'in-process', {
      provider: 'ticker',
      ch: 'ch1',
      params: { count: 2, intervalMs: 1 },
      onFrame: () => {},
    });
    await new Promise((r) => setTimeout(r, 60));
    await handle?.close?.().catch(() => {});
  } catch (e) {
    // A provider that needs a host will reject; the OPEN line still proves the
    // wrap point is reached, which is what this test is about.
    lines.push(`(provider rejected: ${e?.message ?? e})`);
  } finally {
    hub.setTrace(false);
    setTraceSink(restore);
  }

  assert.ok(
    lines.some((l) => /^open\s+-> p in-process ch=ch1/.test(l)),
    `expected an open line, got: ${JSON.stringify(lines)}`,
  );
  // Frames themselves need a real carrier: `in-process` has no `open()`, and
  // every scheme that does (channel-json/raw, stdio-line, pty-stream) needs the
  // Rust host. So the frame path is asserted in the app, not here — what this
  // pins is that the wrap point is reached, which is the part that was missing.
  //
  // The line shape is fixed by `trace('frame', ...)` and covered by the tests
  // that do not need a host; see the `tracedCallback` note in hub.js.
});

test('trace: tracing never breaks delivery', async () => {
  // A trace that throws inside a frame callback would kill the stream. The
  // callback wrapper swallows its own failures for exactly that reason.
  const seen = [];
  const restore = setTraceSink(() => {
    throw new Error('a broken sink must not propagate');
  });
  hub.setTrace(true);
  try {
    const { events } = await import('../src/host/events.js');
    await hub.subscribe('p', 'boom', (p) => seen.push(p), { scheme: 'in-process' });
    events.emit('boom', { ok: true });
  } finally {
    hub.setTrace(false);
    setTraceSink(restore);
  }
  assert.equal(seen.length, 1, 'the subscriber still ran despite the sink throwing');
});
