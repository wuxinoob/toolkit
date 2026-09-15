/**
 * In-app conformance suite — the closed-loop verification for the message
 * plane. Runs INSIDE the app (and its pure-JS parts also run under
 * `node --test`), and the dev boot sequence persists the report to
 * {app_data_dir}/debug.log so verification is readable without clicking.
 *
 * It is also callable anytime: `await window.__toolbox.selftest()`.
 *
 * The point of this suite is that every check is expressed against the
 * ENVELOPE and the SCHEME TABLE — not against a specific transport. Add a
 * scheme and the same assertions apply to it.
 */

import { events } from '../host/events.js';
import { logger } from './logger.js';
import { hub } from '../protocol/hub.js';
import * as Envelope from '../protocol/envelope.js';
import { lineJson, rawBinary, decodeRaw, decodeCode, jsonEnvelope } from '../protocol/codec.js';
import { descriptors, assertSupports, Capability } from '../protocol/registry.js';
import { transportIds } from '../protocol/transports/index.js';
import { buildCtx } from '../host/ctx.js';
import { store } from '../host/store.js';

const HOST = '__host__';
const disposerStub = { track() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(id, fn) {
  const started = Date.now();
  try {
    const detail = (await fn()) || 'ok';
    return { id, ok: true, detail, ms: Date.now() - started };
  } catch (e) {
    return { id, ok: false, detail: String(e?.message || e), ms: Date.now() - started };
  }
}

const tests = [
  [
    't01-envelope-contract',
    async () => {
      Envelope.validate(Envelope.req(1, 'storage', 'get', { key: 'k' }));
      Envelope.validate(Envelope.data('c', 'x'));
      Envelope.validate(Envelope.evt('t', null));
      // omitted fields must not appear on the wire
      const wire = JSON.parse(jsonEnvelope.encode(Envelope.end('c')));
      if ('svc' in wire || 'id' in wire || 'topic' in wire) {
        throw new Error(`optional fields leaked: ${JSON.stringify(wire)}`);
      }
      const bad = [
        { v: 1, kind: 'req', svc: 's', act: 'a' }, // no id
        { v: 1, kind: 'data' }, // no ch
        { v: 1, kind: 'evt' }, // no topic
        { v: 99, kind: 'end', ch: 'c' }, // bad version
      ];
      for (const env of bad) {
        let threw = false;
        try {
          Envelope.validate(env);
        } catch {
          threw = true;
        }
        if (!threw) throw new Error(`validator accepted a malformed envelope: ${JSON.stringify(env)}`);
      }
      return 'shape rules enforced on both directions';
    },
  ],
  [
    't02-codec-roundtrip',
    async () => {
      const env = Envelope.req(7, 'proc', 'send', { key: 'k', line: 'hi' });
      if (jsonEnvelope.decode(jsonEnvelope.encode(env)).id !== 7) throw new Error('json-envelope roundtrip');
      if (lineJson.decode(lineJson.encode(env)).svc !== 'proc') throw new Error('line-json roundtrip');

      const framed = rawBinary;
      if (!framed.binary) throw new Error('raw-binary must declare itself binary');
      const encoded = rawBinary ? null : null;
      const bytes = new Uint8Array([1, 104, 105]); // data + "hi"
      const frame = decodeRaw(bytes);
      if (frame.kind !== Envelope.Kind.DATA) throw new Error('raw decode kind');
      if (new TextDecoder().decode(frame.payload) !== 'hi') throw new Error('raw decode payload');
      if (decodeCode(new Uint8Array([2, 1, 0, 0])) !== 258) throw new Error('raw exit code LE');
      if (decodeRaw(new Uint8Array([9, 1])) !== null) throw new Error('unknown kind byte must be rejected');
      void encoded;
      return 'json-envelope / line-json / raw-binary verified';
    },
  ],
  [
    't03-scheme-table',
    async () => {
      const declared = descriptors().map((d) => d.id);
      const implemented = transportIds();
      const missing = declared.filter((id) => !implemented.includes(id));
      if (missing.length) throw new Error(`declared but not implemented: ${missing.join(', ')}`);
      // capability negotiation must reject impossible requests at setup time
      let threw = false;
      try {
        assertSupports('in-process', Capability.CROSS_WINDOW);
      } catch {
        threw = true;
      }
      if (!threw) throw new Error('in-process must not claim crossWindow');
      assertSupports('event-bus', Capability.CROSS_WINDOW);
      return `${implemented.length} schemes: ${implemented.join(', ')}`;
    },
  ],
  [
    't04-gateway-permission-denied',
    async () => {
      // An unregistered plugin id must be refused by the NATIVE gate, not just
      // by the JS one — this is the property the old design did not have.
      try {
        await hub.request('not.registered', 'storage', 'get', { key: 'x' });
        throw new Error('gateway allowed an unregistered plugin');
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (!/not registered|denied/i.test(msg)) throw e;
        return `denied natively: ${msg.slice(0, 80)}`;
      }
    },
  ],
  [
    't05-storage-roundtrip',
    async () => {
      await hub.request(HOST, 'storage', 'set', { key: 'selftest', value: { n: 7391, arr: [1, 2] } });
      const back = await hub.request(HOST, 'storage', 'get', { key: 'selftest' });
      if (back?.n !== 7391 || back?.arr?.length !== 2) throw new Error(`mismatch: ${JSON.stringify(back)}`);
      await hub.request(HOST, 'storage', 'remove', { key: 'selftest' });
      const gone = await hub.request(HOST, 'storage', 'get', { key: 'selftest' });
      if (gone !== null) throw new Error(`expected null after remove, got ${JSON.stringify(gone)}`);
      return 'set/get/remove through the gateway verified';
    },
  ],
  [
    't06-host-info',
    async () => {
      const info = await hub.request(HOST, 'host', 'info', {});
      if (!info?.dataDir) throw new Error('host.info returned no dataDir');
      return `dataDir=${info.dataDir} liveSessions=${info.liveSessions}`;
    },
  ],
  [
    't07-stream-json',
    async () => {
      const frames = [];
      let ended = null;
      await hub.stream(HOST, 'channel-json', {
        provider: 'ticker',
        ch: 'selftest-json',
        params: { intervalMs: 1, count: 3 },
        onFrame: (f) => frames.push(f),
        onEnd: (f) => (ended = f),
      });
      const deadline = Date.now() + 5000;
      while (!ended && Date.now() < deadline) await sleep(20);
      const data = frames.filter((f) => f.kind === Envelope.Kind.DATA);
      if (data.length !== 3) throw new Error(`expected 3 data frames, got ${data.length}`);
      if (data[0].p?.n !== 0 || data[2].p?.n !== 2) throw new Error(`bad payloads: ${JSON.stringify(data)}`);
      if (ended?.kind !== Envelope.Kind.END) throw new Error(`expected end frame, got ${ended?.kind}`);
      return 'json-envelope stream: 3 data + end, ordered';
    },
  ],
  [
    't08-stream-raw',
    async () => {
      const frames = [];
      let ended = null;
      await hub.stream(HOST, 'channel-raw', {
        provider: 'ticker',
        ch: 'selftest-raw',
        params: { intervalMs: 1, count: 2 },
        onFrame: (f) => frames.push(f),
        onEnd: (f) => (ended = f),
      });
      const deadline = Date.now() + 5000;
      while (!ended && Date.now() < deadline) await sleep(20);
      const data = frames.filter((f) => f.kind === Envelope.Kind.DATA);
      if (data.length !== 2) throw new Error(`expected 2 data frames, got ${data.length}`);
      // same producer, binary wire: the payload is 8 LE bytes, not an object
      const bytes = data[0].p;
      if (!(bytes instanceof Uint8Array)) throw new Error(`raw payload must be bytes, got ${typeof bytes}`);
      if (bytes.byteLength !== 8) throw new Error(`expected 8-byte counter, got ${bytes.byteLength}`);
      if (decodeCode(bytes) !== 0) throw new Error(`expected counter 0, got ${decodeCode(bytes)}`);
      if (ended?.kind !== Envelope.Kind.END) throw new Error(`expected end frame, got ${ended?.kind}`);
      return 'raw-binary stream: 8-byte LE frames + end, same producer';
    },
  ],
  [
    't09-broadcast-fanout',
    async () => {
      // The broadcast goes out through Rust and comes back to this window, so a
      // successful round trip proves the cross-window path works.
      let got = null;
      const off = await hub.subscribe(HOST, 'selftest.topic', (env) => (got = env));
      try {
        await hub.publish(HOST, 'selftest.topic', { n: 5 });
        const deadline = Date.now() + 3000;
        while (!got && Date.now() < deadline) await sleep(20);
        if (!got) throw new Error('broadcast never arrived');
        if (got.p?.n !== 5) throw new Error(`bad payload: ${JSON.stringify(got.p)}`);
        return 'evt envelope fanned out through the host and back';
      } finally {
        off();
      }
    },
  ],
  [
    't10-pty-session-tracked',
    async () => {
      const platform = globalThis.navigator?.platform ?? '';
      if (!/win/i.test(platform)) return `SKIPPED (platform "${platform || 'unknown'}")`;
      const chunks = [];
      let ended = null;
      await hub.pty(HOST, 'selftest-pty', {
        program: 'cmd.exe',
        args: ['/c', 'echo', 'toolbox-pty-marker-7391'],
        onFrame: (f) => chunks.push(f),
        onEnd: (f) => (ended = f),
      });
      const deadline = Date.now() + 8000;
      while (!ended && Date.now() < deadline) await sleep(50);
      const text = chunks
        .filter((f) => f.kind === Envelope.Kind.DATA)
        .map((f) => new TextDecoder().decode(f.p))
        .join('');
      if (!text.includes('toolbox-pty-marker-7391')) {
        throw new Error(`marker missing; got ${JSON.stringify(text.slice(0, 120))} ended=${ended?.kind}`);
      }
      if (ended?.kind !== Envelope.Kind.EXIT) throw new Error(`expected exit frame, got ${ended?.kind}`);
      if (ended.p !== 0) throw new Error(`expected exit code 0, got ${ended.p}`);
      return `pty stream verified (exit ${ended.p}, ${text.length} chars)`;
    },
  ],
  [
    't11-session-registry',
    async () => {
      const list = await hub.sessions(HOST);
      if (!Array.isArray(list)) throw new Error('host.sessions must return an array');
      // After t10 the pty has exited, so nothing of ours should be left behind.
      const leaked = list.filter((s) => s.ch === 'selftest-pty');
      if (leaked.length) throw new Error(`session leaked: ${JSON.stringify(leaked)}`);
      return `unified registry reports ${list.length} live session(s)`;
    },
  ],
  [
    't12-ctx-permission-gate',
    async () => {
      const ctx = buildCtx({ manifest: { id: 'selftest.noperm', permissions: [] } }, disposerStub);
      let threw = false;
      try {
        await ctx.storage.get('x');
      } catch (e) {
        threw = /missing permission/.test(String(e));
      }
      if (!threw) throw new Error('JS gate did not reject an unpermitted call');
      return 'ctx gate fails fast with a readable message';
    },
  ],
  [
    't13-registry-views',
    async () => {
      if (!store.booted) throw new Error('store.booted is false (suite ran too early?)');
      const ids = store.views.map((v) => v.viewId);
      for (const expected of ['builtin.notepad/notepad', 'builtin.procman/procman', 'builtin.streamlab/streamlab']) {
        if (!ids.includes(expected)) throw new Error(`view missing: ${expected} (have: ${ids.join(', ')})`);
      }
      return `views registered: ${ids.length}`;
    },
  ],
  [
    't14-in-process-scheme',
    async () => {
      let got = null;
      const off = events.on('selftest:local', (p) => (got = p));
      const r = await hub.publish(HOST, 'selftest:local', 42, { scheme: 'in-process' });
      off();
      if (got !== 42) throw new Error('in-process delivery failed');
      if (r?.delivered !== 1) throw new Error(`expected 1 delivery, got ${JSON.stringify(r)}`);
      return 'window-local scheme delivers synchronously, zero IPC';
    },
  ],
  [
    't15-sidecar-roundtrip',
    async () => {
      // The `stdio-line` scheme end to end against a REAL native helper.
      // Requires a plugin that ships one: the bundled example is
      // examples/calc-plugin, deployed as `calc.demo`. When it is not
      // installed this reports SKIPPED rather than passing quietly, so the
      // difference between "not exercised" and "verified" stays visible.
      const known = (await hub.request(HOST, 'host', 'plugins'))?.plugins ?? [];
      if (!known.includes('calc.demo')) {
        return 'SKIPPED (calc.demo not installed — see examples/calc-plugin)';
      }

      const ch = 'selftest-calc';
      const frames = [];
      let ended = null;
      const handle = await hub.sidecar('calc.demo', ch, {
        exe: 'calc.exe',
        pollMs: 20,
        timeoutMs: 200,
        onFrame: (f) => frames.push(f),
        onEnd: (f) => (ended = f),
      });
      try {
        await handle.send(Envelope.req(1, 'calc', 'eval', { op: 'mul', a: 6, b: 7 }));
        const deadline = Date.now() + 5000;
        while (!frames.some((f) => f.kind === Envelope.Kind.RES) && Date.now() < deadline) {
          await sleep(20);
        }
        const res = frames.find((f) => f.kind === Envelope.Kind.RES);
        if (!res) throw new Error(`no res frame (saw ${frames.map((f) => f.kind).join(',') || 'none'})`);
        if (res.p?.result !== 42) throw new Error(`expected 42, got ${JSON.stringify(res.p)}`);

        // and a protocol error comes back on the same envelope, as an err
        await handle.send(Envelope.req(2, 'calc', 'eval', { op: 'div', a: 1, b: 0 }));
        const deadline2 = Date.now() + 5000;
        while (!frames.some((f) => f.kind === Envelope.Kind.ERR) && Date.now() < deadline2) {
          await sleep(20);
        }
        const err = frames.find((f) => f.kind === Envelope.Kind.ERR);
        if (!err) throw new Error('no err frame for div by zero');
        if (err.code !== 'div_by_zero') throw new Error(`unexpected err code ${err.code}`);
        return 'sidecar round trip: 6×7=42 and div_by_zero, over line-json envelopes';
      } finally {
        await handle.close();
        void ended;
      }
    },
  ],
];

/** Run the full suite. Returns {total, pass, fail, lines, results}. */
export async function runSelftest() {
  const results = [];
  for (const [id, fn] of tests) {
    const r = await check(id, fn);
    results.push(r);
    logger[r.ok ? 'info' : 'error']('selftest', `${r.ok ? 'PASS' : 'FAIL'} ${id} (${r.ms}ms): ${r.detail}`);
  }
  const pass = results.filter((r) => r.ok).length;
  const lines = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.id} (${r.ms}ms): ${r.detail}`);
  lines.unshift(`--- toolbox selftest ${new Date().toISOString()} : ${pass}/${results.length} passed ---`);
  return { total: results.length, pass, fail: results.length - pass, lines, results };
}

export const selftestCases = tests;
