/**
 * Message-plane conformance suite (node --test, no Tauri runtime).
 *
 * The point of this file is that EVERY scheme is asserted against the same
 * things: it produces the same envelope shapes, it terminates on a terminal
 * frame, and a failure arrives as a ProtocolError. That is what makes the
 * schemes comparable and swappable rather than a pile of one-off mechanisms.
 *
 * Tauri is shimmed at the `__TAURI_INTERNALS__` boundary, so the code under
 * test is the real production code, including the real `@tauri-apps/api`
 * Channel implementation and the real `tauri-pty` client.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ------------------------------ environment shims -----------------------------
const callbacks = new Map();
let cbSeq = 0;
const invokeCalls = [];
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
  // the event plugin keeps its own registry on the window object
  __TAURI_EVENT_PLUGIN_INTERNALS__: {
    unregisterListener: () => {},
  },
};

// dynamic imports AFTER shims are in place
const Envelope = await import('../src/protocol/envelope.js');
const { lineJson, decodeRaw, decodeCode, jsonEnvelope } = await import('../src/protocol/codec.js');
const { descriptors, assertSupports, Capability, describeSchemes } = await import('../src/protocol/registry.js');
const { transport, transportIds } = await import('../src/protocol/transports/index.js');
const { hub } = await import('../src/protocol/hub.js');
const { ProtocolError } = await import('../src/protocol/errors.js');
const { events } = await import('../src/host/events.js');

// --------------------------------- helpers ------------------------------------
const resEnv = (p) => ({ v: 1, kind: 'res', id: 1, p });
const errEnv = (code, msg) => ({ v: 1, kind: 'err', id: 1, code, msg });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`timeout (${ms}ms) waiting for ${what}`);
}

/** Drive a `Channel` the way the Rust side does: `{index, message}`. */
function deliverFrame(channel, message, index = 0) {
  const cb = callbacks.get(channel.id);
  assert.ok(cb, `no callback registered for channel ${channel.id}`);
  cb({ index, message });
}

// ---------------------------------- envelope ----------------------------------

test('envelope: constructors emit the documented shape and omit empty fields', () => {
  assert.deepEqual(Envelope.req(7, 'storage', 'get', { key: 'k' }), {
    v: 1,
    kind: 'req',
    id: 7,
    svc: 'storage',
    act: 'get',
    p: { key: 'k' },
  });
  assert.deepEqual(Envelope.data('c', { n: 1 }), { v: 1, kind: 'data', ch: 'c', p: { n: 1 } });
  assert.deepEqual(Envelope.exit('c', 3), { v: 1, kind: 'exit', ch: 'c', p: 3 });
  // nothing optional leaks on the wire
  assert.equal(JSON.stringify(Envelope.end('c')), '{"v":1,"kind":"end","ch":"c"}');
});

test('envelope: validate enforces per-kind requirements (mirrors the Rust rules)', () => {
  Envelope.validate(Envelope.req(1, 's', 'a'));
  Envelope.validate(Envelope.data('c'));
  Envelope.validate(Envelope.evt('t'));
  Envelope.validate(Envelope.streamErr('c', 'io', 'boom')); // no id needed mid-stream

  const rejects = [
    { v: 1, kind: 'req', svc: 's', act: 'a' },
    { v: 1, kind: 'req', id: 1, act: 'a' },
    { v: 1, kind: 'data' },
    { v: 1, kind: 'evt' },
    { v: 1, kind: 'end', ch: '' },
    { v: 99, kind: 'end', ch: 'c' },
    { v: 1, kind: 'nope' },
  ];
  for (const env of rejects) {
    assert.throws(() => Envelope.validate(env), `must reject ${JSON.stringify(env)}`);
  }
});

// ----------------------------------- codecs -----------------------------------

test('codecs: json-envelope / line-json round trip, raw-binary frames decode', () => {
  const env = Envelope.req(3, 'proc', 'send', { key: 'k', line: 'hi' });
  assert.deepEqual(jsonEnvelope.decode(jsonEnvelope.encode(env)), env);
  assert.deepEqual(lineJson.decode(lineJson.encode(env)), env);
  // a CRLF producer must not leak `\r` into the payload
  assert.deepEqual(lineJson.decode(`${JSON.stringify(env)}\r\n`), env);

  const bytes = new Uint8Array([0x01, 104, 105]);
  const frame = decodeRaw(bytes);
  assert.equal(frame.kind, 'data');
  assert.equal(new TextDecoder().decode(frame.payload), 'hi');
  assert.equal(decodeRaw(new Uint8Array([0x09, 1])), null, 'unknown kind byte rejected');
  assert.equal(decodeRaw(new Uint8Array(0)), null, 'empty buffer has no kind byte');
  assert.equal(decodeCode(new Uint8Array([2, 1, 0, 0])), 258, 'exit codes are LE i32');
});

// ------------------------------ registry / negotiation -------------------------

test('registry: every declared scheme has an implementation, and capabilities are enforced', () => {
  const declared = descriptors().map((d) => d.id);
  for (const id of declared) {
    assert.ok(transportIds().includes(id), `scheme \`${id}\` declared but not implemented`);
  }
  // Setup-time negotiation, not a runtime surprise.
  assert.throws(() => assertSupports('in-process', Capability.CROSS_WINDOW), /cannot crossWindow/);
  assert.doesNotThrow(() => assertSupports('event-bus', Capability.CROSS_WINDOW));
  assert.throws(() => transport('does-not-exist'), /no implementation/);

  const rows = describeSchemes();
  assert.ok(rows.every((r) => r.id && r.label && r.direction));
});

// ---------------------------------- rpc scheme ---------------------------------

test('rpc: unwraps a res envelope and turns an err envelope into a ProtocolError', async () => {
  invokeImpl = async (cmd, args) => {
    assert.equal(cmd, 'plugin_rpc');
    assert.equal(args.pluginId, 'p.rpc');
    // the uplink really is a `req` envelope
    assert.equal(args.msg.kind, 'req');
    assert.equal(args.msg.svc, 'storage');
    assert.equal(args.msg.act, 'get');
    return args.msg.p?.key === 'boom' ? errEnv('denied', 'no permission') : resEnv({ ok: true });
  };

  assert.deepEqual(await hub.request('p.rpc', 'storage', 'get', { key: 'k' }), { ok: true });

  await assert.rejects(
    () => hub.request('p.rpc', 'storage', 'get', { key: 'boom' }),
    (e) => {
      assert.ok(e instanceof ProtocolError);
      assert.equal(e.code, 'denied');
      assert.match(e.message, /no permission/);
      return true;
    },
  );
});

test('rpc: a non-envelope reply is a protocol error, not a silent undefined', async () => {
  invokeImpl = async () => 'not an envelope';
  await assert.rejects(() => hub.request('p.rpc', 'host', 'info'), /non-envelope reply/);
});

test('rpc: a wedged service times out instead of hanging the caller', async () => {
  invokeImpl = () => new Promise(() => {}); // never settles
  await assert.rejects(
    () => hub.request('p.slow', 'host', 'info', null, { timeoutMs: 40 }),
    (e) => {
      assert.equal(e.code, 'timeout');
      // the message must not imply the host was cancelled
      assert.match(e.message, /stopped waiting/);
      assert.match(e.message, /cannot be cancelled/);
      return true;
    },
  );
});

test('rpc: timeoutMs 0 opts out and waits indefinitely', async () => {
  invokeImpl = async (cmd, { msg }) => ({ v: 1, kind: 'res', id: msg.id, p: { ok: true } });
  assert.deepEqual(await hub.request('p.nowait', 'host', 'info', null, { timeoutMs: 0 }), { ok: true });
});

test('rpc: a fast call is unaffected by the default timeout', async () => {
  invokeImpl = async (cmd, { msg }) => ({ v: 1, kind: 'res', id: msg.id, p: 1 });
  assert.equal(await hub.request('p.fast', 'host', 'info'), 1);
});

test('hub: once delivers exactly one event, then detaches', async () => {
  const got = [];
  const off = await hub.once('p.once', 'topic', (x) => got.push(x), { scheme: 'in-process' });
  await hub.publish('p.once', 'topic', { n: 1 }, { scheme: 'in-process' });
  await hub.publish('p.once', 'topic', { n: 2 }, { scheme: 'in-process' });
  assert.deepEqual(got, [{ n: 1 }], 'exactly one delivery');
  off(); // idempotent
});

test('hub: schema composes the native surface with the local scheme table', async () => {
  invokeImpl = async (cmd, { msg }) => ({
    v: 1,
    kind: 'res',
    id: msg.id,
    p: { protocol: 1, services: { storage: ['get'] }, providers: ['ticker'] },
  });
  const schema = await hub.schema('p.schema');
  assert.equal(schema.protocol, 1, 'native half');
  assert.deepEqual(schema.services.storage, ['get'], 'native half');
  assert.equal(schema.schemes.length, 7, 'local half: the scheme table');
  assert.equal(schema.transports.length, 7, 'local half: transport ids');
});

test('rpc: a wedged service times out instead of hanging the caller', async () => {
  invokeImpl = () => new Promise(() => {}); // never settles
  await assert.rejects(
    () => hub.request('p.slow', 'host', 'info', null, { timeoutMs: 40 }),
    (e) => {
      assert.equal(e.code, 'timeout');
      // the message must not imply the host was cancelled
      assert.match(e.message, /stopped waiting/);
      assert.match(e.message, /cannot be cancelled/);
      return true;
    },
  );
});

test('rpc: timeoutMs 0 opts out and waits indefinitely', async () => {
  invokeImpl = async (cmd, { msg }) => ({ v: 1, kind: 'res', id: msg.id, p: { ok: true } });
  assert.deepEqual(await hub.request('p.nowait', 'host', 'info', null, { timeoutMs: 0 }), { ok: true });
});

test('rpc: a fast call is unaffected by the default timeout', async () => {
  invokeImpl = async (cmd, { msg }) => ({ v: 1, kind: 'res', id: msg.id, p: 1 });
  assert.equal(await hub.request('p.fast', 'host', 'info'), 1);
});

test('hub: once delivers exactly one event, then detaches', async () => {
  const got = [];
  const off = await hub.once('p.once', 'topic', (x) => got.push(x), { scheme: 'in-process' });
  await hub.publish('p.once', 'topic', { n: 1 }, { scheme: 'in-process' });
  await hub.publish('p.once', 'topic', { n: 2 }, { scheme: 'in-process' });
  assert.deepEqual(got, [{ n: 1 }], 'exactly one delivery');
  off(); // idempotent
});

test('hub: schema composes the native surface with the local scheme table', async () => {
  invokeImpl = async (cmd, { msg }) => ({
    v: 1,
    kind: 'res',
    id: msg.id,
    p: { protocol: 1, services: { storage: ['get'] }, providers: ['ticker'] },
  });
  const schema = await hub.schema('p.schema');
  assert.equal(schema.protocol, 1, 'native half');
  assert.deepEqual(schema.services.storage, ['get'], 'native half');
  assert.equal(schema.schemes.length, 7, 'local half: the scheme table');
  assert.equal(schema.transports.length, 7, 'local half: transport ids');
});

// ------------------------------ channel-json scheme ----------------------------

test('channel-json: frames arrive as envelopes and a terminal frame ends the stream', async () => {
  let captured = null;
  invokeImpl = async (cmd, args) => {
    if (cmd === 'plugin_stream_open') {
      captured = args;
      return null;
    }
    if (cmd === 'plugin_stream_close') return { stopped: true };
    throw new Error(`unexpected ${cmd}`);
  };

  const frames = [];
  let ended = null;
  await hub.stream('p.json', 'channel-json', {
    provider: 'ticker',
    ch: 'c1',
    params: { count: 2 },
    onFrame: (f) => frames.push(f),
    onEnd: (f) => (ended = f),
  });

  assert.equal(captured.provider, 'ticker');
  assert.equal(captured.ch, 'c1');
  assert.ok(captured.onFrame, 'the Channel must be passed to the command');

  deliverFrame(captured.onFrame, Envelope.data('c1', { n: 0 }), 0);
  deliverFrame(captured.onFrame, Envelope.data('c1', { n: 1 }), 1);
  deliverFrame(captured.onFrame, Envelope.end('c1'), 2);

  assert.equal(frames.length, 3);
  assert.equal(frames[0].p.n, 0);
  assert.equal(frames[2].kind, 'end');
  assert.equal(ended?.kind, 'end', 'onEnd must fire on the terminal frame');
  assert.deepEqual(hub.openStreamKeys(), [], 'a terminal frame must release the stream');
});

test('channel-json: a malformed frame terminates with a stream err instead of throwing', async () => {
  let captured = null;
  invokeImpl = async (cmd, args) => {
    captured = args;
    return null;
  };
  const frames = [];
  let ended = null;
  await hub.stream('p.json2', 'channel-json', {
    provider: 'ticker',
    ch: 'c2',
    onFrame: (f) => frames.push(f),
    onEnd: (f) => (ended = f),
  });

  callbacks.get(captured.onFrame.id)({ index: 0, message: { v: 1, kind: 'data' } }); // no ch
  assert.equal(ended?.kind, 'err');
  assert.equal(ended.code, 'codec');
});

// ------------------------------- channel-raw scheme ----------------------------

test('channel-raw: the same producer over the binary wire yields the same envelope shapes', async () => {
  let captured = null;
  invokeImpl = async (cmd, args) => {
    if (cmd === 'plugin_stream_open_raw') {
      captured = args;
      return null;
    }
    if (cmd === 'plugin_stream_close') return { stopped: true };
    throw new Error(`unexpected ${cmd}`);
  };

  const frames = [];
  let ended = null;
  await hub.stream('p.raw', 'channel-raw', {
    provider: 'ticker',
    ch: 'r1',
    onFrame: (f) => frames.push(f),
    onEnd: (f) => (ended = f),
  });

  // 1 kind byte + 8 LE bytes, exactly what Sink::data produces for a counter
  const counter = (n) => {
    const out = new Uint8Array(9);
    out[0] = 0x01;
    new DataView(out.buffer).setBigInt64(1, BigInt(n), true);
    return out;
  };
  deliverFrame(captured.onFrame, counter(0).buffer, 0);
  deliverFrame(captured.onFrame, counter(1).buffer, 1);
  deliverFrame(captured.onFrame, new Uint8Array([0x02]).buffer, 2); // end

  assert.equal(frames.length, 3);
  assert.equal(frames[0].kind, 'data');
  assert.ok(frames[0].p instanceof Uint8Array, 'raw payload must stay bytes');
  assert.equal(decodeCode(frames[0].p), 0);
  assert.equal(decodeCode(frames[1].p), 1);
  assert.equal(frames[2].kind, 'end');
  assert.equal(ended?.kind, 'end');
});

// ------------------------------- event-bus scheme ------------------------------

test('event-bus: publish goes through the gateway and subscribe receives the evt envelope', async () => {
  let publishArgs = null;
  let handlerId = null;
  invokeImpl = async (cmd, args) => {
    if (cmd === 'plugin_rpc') {
      publishArgs = args;
      return resEnv({ topic: 'lab.ping', delivered: true });
    }
    if (cmd === 'plugin:event|listen') {
      handlerId = args.handler;
      return 1;
    }
    if (cmd === 'plugin:event|unlisten') return null;
    throw new Error(`unexpected ${cmd}`);
  };

  const got = [];
  const off = await hub.subscribe('p.bus', 'lab.ping', (env) => got.push(env));

  const ack = await hub.publish('p.bus', 'lab.ping', { n: 5 });
  assert.equal(ack.delivered, true);
  assert.equal(publishArgs.msg.svc, 'bus');
  assert.equal(publishArgs.msg.act, 'publish');
  assert.deepEqual(publishArgs.msg.p, { topic: 'lab.ping', payload: { n: 5 } });

  // the host fans the envelope out; every window's listener sees the same shape
  const evt = Envelope.evt('lab.ping', { n: 5 });
  callbacks.get(handlerId)({ event: Envelope.BROADCAST_EVENT, id: 1, payload: evt });
  assert.equal(got.length, 1);
  assert.equal(got[0].topic, 'lab.ping');
  assert.equal(got[0].p.n, 5);

  // a different topic must be filtered out, not delivered
  callbacks.get(handlerId)({ event: Envelope.BROADCAST_EVENT, id: 2, payload: Envelope.evt('other', {}) });
  assert.equal(got.length, 1, 'topic filter must apply');
  await off();
});

// ------------------------------ stdio-line scheme ------------------------------

test('stdio-line: sidecar lines decode as envelopes and exit ends the stream', async () => {
  const sent = [];
  let recvCount = 0;
  invokeImpl = async (cmd, args) => {
    assert.equal(cmd, 'plugin_rpc');
    const { act, p } = args.msg;
    if (act === 'spawn') return resEnv({ pid: 99, reused: false });
    if (act === 'send') {
      sent.push(p.line);
      return resEnv(true);
    }
    if (act === 'recv') {
      recvCount += 1;
      if (recvCount === 1) return resEnv({ line: lineJson.encode(Envelope.data('sc', { n: 1 })) });
      if (recvCount === 2) return resEnv({ line: 'plain text, not an envelope' });
      return resEnv({ exited: true, code: 0 });
    }
    if (act === 'kill') return resEnv(true);
    throw new Error(`unexpected proc action ${act}`);
  };

  const frames = [];
  let ended = null;
  const handle = await hub.sidecar('p.stdio', 'sc', {
    exe: 'helper.exe',
    args: ['--serve'],
    pollMs: 1,
    onFrame: (f) => frames.push(f),
    onEnd: (f) => (ended = f),
  });

  await waitFor(() => ended, 3000, 'the sidecar stream to end');
  assert.equal(frames[0].kind, 'data');
  assert.equal(frames[0].p.n, 1);
  // a plain-text backend is surfaced as a data frame, not dropped
  assert.equal(frames[1].kind, 'data');
  assert.equal(frames[1].p, 'plain text, not an envelope');
  assert.equal(frames.at(-1).kind, 'exit');
  assert.equal(frames.at(-1).p, 0);
  assert.equal(ended.kind, 'exit');

  // and the uplink really is one envelope per line
  await handle.send(Envelope.req(1, 'demo', 'add', { a: 1, b: 2 }));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].endsWith('\n'), 'line-json frames must be newline terminated');
  assert.equal(JSON.parse(sent[0]).svc, 'demo');
});

// ------------------------------- pty scheme ------------------------------------

test('pty-stream: subprocess bytes become data frames and the exit code an exit frame', async () => {
  let sessionOpened = null;
  invokeImpl = async (cmd, args) => {
    if (cmd === 'plugin:pty|spawn') return 4242;
    if (cmd === 'plugin:pty|read') {
      if (!globalThis.__ptyRead) {
        globalThis.__ptyRead = true;
        return new TextEncoder().encode('marker-7391').buffer;
      }
      throw 'EOF';
    }
    if (cmd === 'plugin:pty|exitstatus') return 0;
    if (cmd === 'plugin:pty|kill') return null;
    if (cmd === 'plugin:pty|resize' || cmd === 'plugin:pty|write') return null;
    if (cmd === 'plugin_rpc') {
      if (args.msg.act === 'session_open') {
        sessionOpened = args.msg.p;
        return resEnv(true);
      }
      return resEnv(true);
    }
    throw new Error(`unexpected ${cmd}`);
  };

  const frames = [];
  let ended = null;
  const handle = await hub.pty('p.pty', 'pt1', {
    program: 'cmd.exe',
    args: ['/c', 'echo', 'marker-7391'],
    onFrame: (f) => frames.push(f),
    onEnd: (f) => (ended = f),
  });

  assert.equal(handle.pid, 4242, 'the async pid must be resolved before returning');
  // the pid is registered with the unified session registry, which is what
  // makes shutdown reap pty children instead of orphaning them
  assert.equal(sessionOpened.kind, 'pty');
  assert.equal(sessionOpened.pid, 4242);

  await waitFor(() => ended, 3000, 'the pty exit frame');
  const data = frames.filter((f) => f.kind === 'data');
  assert.equal(new TextDecoder().decode(data[0].p), 'marker-7391');
  assert.equal(ended.kind, 'exit');
  assert.equal(ended.p, 0);
  delete globalThis.__ptyRead;
});

// ----------------------------- in-process scheme -------------------------------

test('in-process: delivery is synchronous and stays inside this window', async () => {
  const got = [];
  const off = await hub.subscribe('p.local', 'local.topic', (p) => got.push(p), { scheme: 'in-process' });
  const r = await hub.publish('p.local', 'local.topic', { n: 1 }, { scheme: 'in-process' });
  // synchronous: no await needed between emit and observation
  assert.deepEqual(got, [{ n: 1 }]);
  assert.equal(r.delivered, 1);
  off();
  events.emit('local.topic', { n: 2 });
  assert.equal(got.length, 1, 'unsubscribe must detach');
});

// -------------------------------- hub behaviour --------------------------------

test('hub: duplicate channel ids are refused and close() releases the stream', async () => {
  invokeImpl = async (cmd) => {
    if (cmd === 'plugin_stream_open') return null;
    if (cmd === 'plugin_stream_close') return { stopped: true };
    throw new Error(`unexpected ${cmd}`);
  };

  const mk = () => ({
    provider: 'ticker',
    ch: 'dup',
    onFrame: () => {},
  });
  await hub.stream('p.dup', 'channel-json', mk());
  await assert.rejects(() => hub.stream('p.dup', 'channel-json', mk()), /already open/);
  assert.deepEqual(hub.openStreamKeys(), ['p.dup/dup']);
  assert.equal(await hub.close('p.dup', 'dup'), true);
  assert.deepEqual(hub.openStreamKeys(), []);
  assert.equal(await hub.close('p.dup', 'dup'), false, 'closing twice is a no-op');
});

test('hub: asking for a capability a scheme does not declare fails at setup', async () => {
  // `rpc` is request/response only — it declares no push capability.
  await assert.rejects(
    () => hub.stream('p.cap', 'rpc', { provider: 'x', ch: 'y' }),
    /cannot push/,
  );
});
