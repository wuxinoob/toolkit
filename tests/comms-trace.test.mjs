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
  assert.match(lines[0], /^rpc -> my\.plugin storage\/get \d+ms /);
});

test('trace: a forged __host__ is visible as such', async () => {
  // This is what the audit's escalation looks like in the log. Nothing here
  // PREVENTS the forgery — the fix is a token (see the audit). What this
  // guarantees is that you can SEE it.
  const lines = await traced(() => swallow(hub.request('__host__', 'proc', 'spawn', {})));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^rpc -> __host__ proc\/spawn /);
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
