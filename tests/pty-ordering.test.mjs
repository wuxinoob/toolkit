/**
 * pty frame ordering.
 *
 * The transport used to guess when the output was finished: the `tauri-pty`
 * wrapper's read loop ends on an `EOF` error and then silently returns, while
 * the exit status arrives on a separate promise — so the exit frame was held
 * back by a 120ms quiet period with a 1.5s cap. A short command's echo could
 * still be lost, and a chatty one could delay the exit.
 *
 * Driving the plugin's commands directly makes "the output ended" a fact
 * (`read` fails with EOF), so the exit frame is emitted only once BOTH facts are
 * known. These tests pin that ordering, including the race where the process
 * exits before the buffer has been drained.
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

// Not Windows: the ConPTY cursor-query watchdog is inert, so any timer we see
// must be the ordering heuristic this change removed. (`navigator` is a
// getter-only global in Node, so it has to be redefined rather than assigned.)
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
    querySelector: () => null,
    querySelectorAll: () => [],
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

/** Queue a chunk of output, or hand it to the read loop if it is parked. */
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
/** The end of output: `EOF`, or the lookup failure the plugin reports instead. */
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
      return { v: 1, kind: 'res', id: msg.id, p: true };
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

// ----------------------------------- tests ------------------------------------

test('exit waits for the output, even when the process exits first', async () => {
  resetPty();
  const sink = { frames: [], ended: null };
  const hub = new MessageHub();

  const opening = openPty(hub, 'p1', sink);
  setExit(0); // the process is gone before any output has been read
  await opening;

  output('hello');
  await tick();
  assert.deepEqual(
    sink.frames.map((f) => f.kind),
    ['data'],
    'a known exit code is not enough — the output must be drained first',
  );
  assert.equal(sink.ended, null);
  assert.equal(
    pty.calls.filter((c) => c.cmd === 'plugin:pty|exitstatus').length,
    0,
    'and the exit status is not even asked for while output may still come',
  );

  endOfOutput();
  await tick();
  assert.deepEqual(sink.frames.map((f) => f.kind), ['data', 'exit']);
  assert.equal(sink.ended.kind, 'exit');
  assert.equal(sink.ended.p, 0, 'the real exit code is reported');
  assert.equal(new TextDecoder().decode(sink.frames[0].p), 'hello', 'the data came first');
});

test('exit waits for the exit status when the output ends first', async () => {
  resetPty();
  const sink = { frames: [], ended: null };
  const hub = new MessageHub();

  const opening = openPty(hub, 'p2', sink);
  output('a');
  endOfOutput();
  await opening;
  await tick();

  assert.deepEqual(
    sink.frames.map((f) => f.kind),
    ['data'],
    'output ended, but the process has not been reaped yet',
  );

  setExit(3);
  await tick();
  assert.deepEqual(sink.frames.map((f) => f.kind), ['data', 'exit']);
  assert.equal(sink.ended.p, 3);
});

test('every spelling of "output ended" ends the stream, not just EOF', async () => {
  // The underlying read differs by platform and by timing, so the same fact
  // arrives under three names: EOF (Windows, 0 bytes), EIO (Unix reports the
  // end of a pty stream as an error), and a lost session lookup when
  // `exitstatus` got there first.
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
    assert.equal(sink.frames.at(-1).kind, 'exit');
  }
});

test('a failed session registration kills the child instead of leaking it', async () => {
  resetPty();
  pty.registerFails = true;
  const hub = new MessageHub();

  await assert.rejects(
    () => openPty(hub, 'p4', { frames: [], ended: null }),
    /registration failed/,
    'the open must fail loudly',
  );
  assert.equal(pty.kills, 1, 'and the child must not be left unowned');
});

test('close kills once and emits a single end frame', async () => {
  resetPty();
  const sink = { frames: [], ended: null };
  const endedFrames = [];
  const hub = new MessageHub();
  const handle = await hub.pty('t.plugin', 'p5', {
    program: 'cmd',
    onFrame: (f) => sink.frames.push(f),
    onEnd: (f) => endedFrames.push(f),
  });

  await handle.close();
  await handle.close(); // idempotent

  assert.equal(pty.kills, 1, 'killed exactly once');
  assert.equal(endedFrames.length, 1);
  assert.equal(endedFrames[0].kind, 'end');
  assert.deepEqual(hub.openStreamKeys(), [], 'the hub record is released');
});

test('ordering uses no drain timers', async () => {
  resetPty();
  const delays = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    delays.push(ms ?? 0);
    return real(fn, 0, ...rest);
  };
  try {
    const sink = { frames: [], ended: null };
    const hub = new MessageHub();
    const opening = openPty(hub, 'p6', sink);
    setExit(0);
    output('x');
    endOfOutput();
    await opening;
    await tick();

    assert.equal(sink.ended?.kind, 'exit');
    // The rpc transport arms its 45s request timeout; the old heuristic used
    // 120ms and up to 1500ms, so this range cleanly isolates it.
    assert.deepEqual(
      delays.filter((d) => d <= 1500),
      [],
      'the old 120ms/1.5s quiet-period heuristic must be gone',
    );
  } finally {
    globalThis.setTimeout = real;
  }
});
