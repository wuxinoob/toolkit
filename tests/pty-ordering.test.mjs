/**
 * pty frame ordering and ownership.
 *
 * The transport used to guess when the output was finished (a 120ms quiet period
 * after `exit`). This suite pins what replaced that guess — and, importantly, the
 * case that broke in the real app:
 *
 *   A design that waits for `read` to report EOF before asking for the exit
 *   status DEADLOCKS on Windows: ConPTY's reader stays parked after the child
 *   exits, so the read never returns and the status is never asked for. The app
 *   caught it — the marker text arrived, then no terminal frame ever did.
 *
 * The pty command surface is mocked at the invoke boundary; everything above it
 * (the hub, the transport, the envelope) is production code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ------------------------------ environment shims -----------------------------
const callbacks = new Map();
let cbSeq = 0;

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

// Not Windows: the ConPTY cursor-query watchdog is inert, so any timer we see is
// the drain. (`navigator` is a getter-only global in Node.)
Object.defineProperty(globalThis, 'navigator', {
  value: { platform: 'Linux x86_64' },
  configurable: true,
  writable: true,
});

globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => invokeImpl(cmd, args),
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
  createElement: () => ({
    style: {},
    addEventListener() {},
    appendChild(c) {
      return c;
    },
  }),
  head: { appendChild() {} },
  body: { appendChild() {}, style: {} },
  documentElement: { style: {} },
};
globalThis.requestAnimationFrame ||= (fn) => setTimeout(() => fn(0), 0);

// --------------------------- the pty command surface ---------------------------

const pty = {
  reads: [],
  pendingRead: null,
  exitResult: undefined,
  exitPending: null,
  kills: 0,
  registerFails: false,
  calls: [],
};

function resetPty() {
  pty.reads = [];
  pty.pendingRead = null;
  pty.exitResult = undefined;
  pty.exitPending = null;
  pty.kills = 0;
  pty.registerFails = false;
  pty.calls = [];
}

const bytes = (s) => new TextEncoder().encode(s).buffer;

function deliver(item) {
  if (pty.pendingRead) {
    const p = pty.pendingRead;
    pty.pendingRead = null;
    if (item.err) p.reject(item.err);
    else p.resolve(item.ok);
    return;
  }
  pty.reads.push(item);
}

const output = (s) => deliver({ ok: bytes(s) });
const endOfOutput = (how = 'eof') => deliver({ err: how === 'eof' ? 'EOF' : 'Unavailable pid' });

function setExit(code) {
  pty.exitResult = code;
  if (pty.exitPending) {
    const resolve = pty.exitPending;
    pty.exitPending = null;
    resolve(code);
  }
}

async function invokeImpl(cmd, args) {
  pty.calls.push({ cmd, args });
  switch (cmd) {
    case 'plugin:pty|spawn':
      return 7;
    case 'plugin:pty|read': {
      const next = pty.reads.shift();
      if (next) return next.err ? Promise.reject(next.err) : next.ok;
      // Parked forever — this is what ConPTY actually does after the child exits.
      return new Promise((resolve, reject) => {
        pty.pendingRead = { resolve, reject };
      });
    }
    case 'plugin:pty|exitstatus':
      if (pty.exitResult !== undefined) return pty.exitResult;
      return new Promise((resolve) => {
        pty.exitPending = resolve;
      });
    case 'plugin:pty|kill':
      pty.kills += 1;
      return null;
    case 'plugin:pty|write':
    case 'plugin:pty|resize':
      return null;
    case 'plugin_rpc': {
      const { msg } = args;
      if (msg.svc === 'stream' && msg.act === 'session_open' && pty.registerFails) {
        return Promise.reject('registration refused');
      }
      return { v: 1, kind: 'res', id: msg.id, p: { ok: true } };
    }
    default:
      throw new Error(`unexpected invoke: ${cmd}`);
  }
}

// dynamic imports AFTER shims are in place
const { MessageHub } = await import('../src/protocol/hub.js');

const tick = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

const openPty = (hub, ch, sink) =>
  hub.pty('t.plugin', ch, {
    program: 'cmd',
    onFrame: (f) => sink.frames.push(f),
    onEnd: (f) => {
      sink.ended = f;
    },
  });

/** Record every armed delay, but still honour it (the drain needs real time). */
function recordTimers() {
  const delays = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    delays.push(ms ?? 0);
    return real(fn, ms, ...rest);
  };
  return { delays, restore: () => { globalThis.setTimeout = real; } };
}

const sessionOpens = () =>
  pty.calls.filter((c) => c.cmd === 'plugin_rpc' && c.args?.msg?.act === 'session_open');

// ----------------------------------- tests ------------------------------------

test('a parked read does not stop the exit frame (the app regression)', async () => {
  // The child exits and the reader stays parked: no EOF ever arrives. The exit
  // frame must still come, or a consumer waits forever.
  resetPty();
  const sink = { frames: [], ended: null };
  const hub = new MessageHub();
  const timers = recordTimers();
  try {
    const opening = openPty(hub, 'p1', sink);
    await opening;
    output('marker');
    setExit(0);
    await tick();

    // bounded wait: the drain is 120ms, so this is a short test, not a hang
    const deadline = Date.now() + 2000;
    while (!sink.ended && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));

    assert.ok(sink.ended, 'the exit frame must arrive even though the read never ended');
    assert.equal(sink.ended.kind, 'exit');
    assert.equal(sink.ended.p, 0, 'with the real exit code');
    assert.equal(new TextDecoder().decode(sink.frames[0].p), 'marker', 'and the output came first');
    assert.ok(
      timers.delays.includes(120),
      `the drain must be the bounded 120ms wait, got ${JSON.stringify(timers.delays)}`,
    );
    assert.ok(
      // the only large delay is the rpc transport's own 45s request timeout
      timers.delays.every((d) => d === 45000 || d <= 1000),
      `the drain is bounded, got ${JSON.stringify(timers.delays)}`,
    );
  } finally {
    timers.restore();
  }
});

test('an end-of-output from the read loop needs no drain at all', async () => {
  resetPty();
  const sink = { frames: [], ended: null };
  const hub = new MessageHub();
  const timers = recordTimers();
  try {
    const opening = openPty(hub, 'p2', sink);
    output('a');
    endOfOutput();
    setExit(3);
    await opening;
    await tick();

    // The exit frame is already here after a few ticks. If the transport had to
    // fall back to the drain, it would still be waiting 120ms — so "the frame
    // exists now" IS the determinism claim. (The drain may have been armed and
    // then cancelled when the read loop ended first; that is fine.)
    assert.deepEqual(sink.frames.map((f) => f.kind), ['data', 'exit']);
    assert.equal(sink.ended.p, 3);
  } finally {
    timers.restore();
  }
});

test('every spelling of "output ended" ends the stream, not just EOF', async () => {
  const spellings = ['EOF', 'Input/output error', 'Unavailable pid'];
  for (const [i, spelling] of spellings.entries()) {
    resetPty();
    const sink = { frames: [], ended: null };
    const hub = new MessageHub();
    const opening = openPty(hub, `p3-${i}`, sink);
    setExit(0);
    await opening;
    deliver({ err: spelling });
    await tick();
    assert.equal(sink.ended?.kind, 'exit', `"${spelling}" must end the stream, not error`);
  }
});

test('the session is registered WITHOUT a pid', async () => {
  // What spawn returns is the plugin's session HANDLE, not an OS pid. Registering
  // it as one would make app exit `taskkill` an unrelated process number.
  resetPty();
  const hub = new MessageHub();
  await openPty(hub, 'p4', { frames: [], ended: null });
  const opens = sessionOpens();
  assert.equal(opens.length, 1);
  assert.deepEqual(
    opens[0].args.msg.p,
    { ch: 'p4', kind: 'pty' },
    'the host does not own this process, so it must not claim a pid',
  );
});

test('a failed session registration kills the child instead of leaking it', async () => {
  resetPty();
  pty.registerFails = true;
  const hub = new MessageHub();
  await assert.rejects(
    () => openPty(hub, 'p5', { frames: [], ended: null }),
    /registration failed/,
  );
  assert.equal(pty.kills, 1, 'and the child must not be left unowned');
});

test('close kills once and emits a single end frame', async () => {
  resetPty();
  const endedFrames = [];
  const hub = new MessageHub();
  const handle = await hub.pty('t.plugin', 'p6', {
    program: 'cmd',
    onFrame: () => {},
    onEnd: (f) => endedFrames.push(f),
  });

  await handle.close();
  await handle.close();

  assert.equal(pty.kills, 1, 'killed exactly once');
  assert.equal(endedFrames.length, 1);
  assert.equal(endedFrames[0].kind, 'end');
  assert.deepEqual(hub.openStreamKeys(), [], 'the hub record is released');
});

/**
 * The bell, at the only layer that can do anything about it.
 *
 * A user reported "the process manager sometimes beeps". Nothing in this app can
 * ring — no dependency opens an `AudioContext`, and `@xterm/xterm` fires
 * `onBell` with nothing subscribed — so the byte is consumed at the transport
 * and reported as a NUMBER instead (`consumeBell` in the pty transport). These
 * assertions are the contract that makes the number trustworthy: what is
 * delivered contains no BEL, what is counted is exactly what was removed, and a
 * chunk that was nothing but bells produces no frame at all.
 */
test('BEL is consumed and counted, never delivered', async () => {
  resetPty();
  const sink = { frames: [], ended: null };
  const hub = new MessageHub();
  const handle = await openPty(hub, 'p7', sink);

  const delivered = () =>
    sink.frames
      .filter((f) => f.kind === 'data')
      .map((f) => new TextDecoder().decode(f.p))
      .join('');

  output('before\x07\x07after');
  await tick();
  assert.equal(delivered(), 'beforeafter', 'the bytes around the bells still arrive');
  assert.equal(handle.bells(), 2, 'both bells are reported');

  // A chunk that is only bells says nothing and must not become an empty frame:
  // `{kind:'data', p: <0 bytes>}` downstream would be a frame that carries no
  // information and every consumer would have to special-case.
  const before = sink.frames.length;
  output('\x07');
  await tick();
  assert.equal(handle.bells(), 3);
  assert.equal(sink.frames.length, before, 'an all-bell chunk emits no frame');

  // ... and it must not wedge the stream either.
  output('still here');
  await tick();
  assert.equal(delivered(), 'beforeafterstill here');
});

/**
 * The other half of the same contract: zero is a real answer.
 *
 * "The count is zero while I can still hear it" is the diagnosis — it says the
 * sound never entered this stream, so it belongs to the child or to the OS sound
 * scheme, and no host-side switch could have silenced it. That reading is only
 * worth anything if a stream that saw no BEL really does report 0.
 */
test('a stream that saw no BEL reports zero', async () => {
  resetPty();
  const clean = await openPty(new MessageHub(), 'p8', { frames: [], ended: null });
  output('no bells here');
  await tick();
  assert.equal(clean.bells(), 0);
});
