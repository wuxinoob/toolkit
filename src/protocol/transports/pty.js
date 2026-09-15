/**
 * `pty-stream` transport — command-line subprocesses.
 *
 * Carrier: a pseudo-terminal (tauri-plugin-pty). Codec: raw-binary. This is
 * the transport that wraps a THIRD-PARTY mechanism behind the unified
 * interface: callers get the same `open/send/close` + envelope frames as every
 * other scheme, while the pty specifics (async pid resolution, ConPTY quirks,
 * resize) stay confined to this file.
 *
 * Four details worth knowing, all isolated here on purpose:
 *
 *  1. Handlers are registered BEFORE any `await`. The backend starts pushing
 *     as soon as the spawn invoke resolves, so a handler attached after an
 *     awaited step can miss the first chunk — a real data-loss race, not a
 *     theoretical one.
 *  2. `pid` is resolved asynchronously by the backend, so spawn polls briefly
 *     and reports a real failure instead of a session stuck in "starting".
 *  3. ConPTY is opened with INHERIT_CURSOR, so it emits a cursor-position
 *     request (ESC[6n) at startup and blocks the child until answered. xterm.js
 *     answers by itself; a headless consumer never does, which deadlocks
 *     short-lived commands. The watchdog below answers once, but only if the
 *     consumer has not already written (i.e. xterm already replied).
 *  4. The backend reports the exit independently of its read loop, so the exit
 *     can arrive before the last output chunk. The exit frame is therefore
 *     held back until the data stream goes quiet (bounded), so a consumer that
 *     treats `exit` as terminal never loses trailing output.
 *
 * The spawned pid is registered in the host's unified session registry, so
 * `kill_all()` on app exit reaps pty children too — previously they were
 * orphaned because only sidecars were tracked.
 */

import * as Envelope from '../envelope.js';
import { descriptor } from '../registry.js';
import { ProtocolError } from '../errors.js';
import { rpcTransport } from './rpc.js';

const DSR = [0x1b, 0x5b, 0x36, 0x6e]; // ESC [ 6 n
const CPR = '\x1b[1;1R';
/** Quiet period after the process exits before the exit frame is emitted. */
const DRAIN_MS = 120;
/** Hard cap on that delay, so a still-chatty stream cannot hold the exit back. */
const DRAIN_MAX_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toU8(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  return new Uint8Array(chunk ?? 0);
}

function hasDsr(u8) {
  for (let i = 0; i + DSR.length <= u8.length; i++) {
    if (u8[i] === 0x1b && u8[i + 1] === 0x5b && u8[i + 2] === 0x36 && u8[i + 3] === 0x6e) return true;
  }
  return false;
}

export const ptyStreamTransport = {
  descriptor: descriptor('pty-stream'),

  async open({ pluginId, ch, params = {}, onFrame, onEnd }) {
    // Explicit dist path: `tauri-pty` ships no `main`/`exports` field, so a
    // bare specifier only resolves inside a bundler. Naming the entry keeps the
    // transport testable under `node --test` with the same code path.
    const { spawn } = await import('tauri-pty/dist/index.es.js');

    const pty = spawn(params.program, params.args ?? [], {
      cwd: params.cwd,
      cols: params.cols ?? 80,
      rows: params.rows ?? 24,
    });

    let cprHandled = false;
    let dsrSeen = false;
    let dsrTimer = null;
    const isWindows = /win/i.test(globalThis.navigator?.platform ?? '');

    /** Single emit point: applies the ConPTY watchdog, then forwards. */
    const emit = (env) => {
      if (isWindows && !dsrSeen && env.kind === Envelope.Kind.DATA && hasDsr(toU8(env.p))) {
        dsrSeen = true;
        dsrTimer = setTimeout(() => {
          if (!cprHandled) {
            try {
              pty.write(CPR);
            } catch {
              /* session already gone */
            }
          }
        }, 250);
      }
      onFrame?.(env);
    };

    // Register FIRST — see note 1 at the top of this file.
    //
    // Note 4: the backend reports the exit independently of its read loop, so
    // the exit can arrive BEFORE the last output chunk. A consumer that treats
    // `exit` as terminal (which is the contract) would then lose trailing
    // output — observed in the field as a short command's echo going missing.
    // So the exit frame is held back until the data stream goes quiet, with a
    // hard cap so a noisy stream can never delay it indefinitely.
    let lastDataAt = Date.now();
    let exitTimer = null;

    const d1 = pty.onData((chunk) => {
      lastDataAt = Date.now();
      emit(Envelope.data(ch, toU8(chunk)));
    });

    const d2 = pty.onExit(({ exitCode }) => {
      const exitedAt = Date.now();
      const settle = () => {
        const waited = Date.now() - exitedAt;
        const quiet = Date.now() - lastDataAt;
        if (quiet >= DRAIN_MS || waited >= DRAIN_MAX_MS) {
          const env = Envelope.exit(ch, exitCode);
          emit(env);
          onEnd?.(env);
          rpcTransport
            .request({ pluginId, svc: 'stream', act: 'session_close', params: { ch } })
            .catch(() => {});
          return;
        }
        exitTimer = setTimeout(settle, Math.min(DRAIN_MS, DRAIN_MAX_MS - waited));
      };
      settle();
    });

    let initErr = null;
    pty._init?.catch?.((e) => {
      initErr = e;
    });
    for (let i = 0; i < 100 && pty.pid == null && !initErr; i++) await sleep(20);
    if (pty.pid == null) {
      d1?.dispose?.();
      d2?.dispose?.();
      throw ProtocolError.transport(
        `pty spawn failed: ${initErr ? `invoke error: ${initErr}` : 'pid unresolved after 2s'}`,
      );
    }

    // Register with the unified registry so app exit reaps this child.
    await rpcTransport
      .request({
        pluginId,
        svc: 'stream',
        act: 'session_open',
        params: { ch, kind: 'pty', pid: pty.pid },
      })
      .catch(() => {
        /* registry unavailable: the pty still works, just not tracked */
      });

    return {
      ch,
      provider: 'pty',
      pid: pty.pid,
      cols: pty.cols,
      rows: pty.rows,
      write(data) {
        cprHandled = true;
        pty.write(data);
      },
      resize(cols, rows) {
        pty.resize(cols, rows);
      },
      clear() {
        pty.clear();
      },
      async close() {
        cprHandled = true;
        if (dsrTimer) clearTimeout(dsrTimer);
        if (exitTimer) clearTimeout(exitTimer);
        try {
          pty.kill();
        } finally {
          d1?.dispose?.();
          d2?.dispose?.();
        }
        await rpcTransport
          .request({ pluginId, svc: 'stream', act: 'session_close', params: { ch } })
          .catch(() => {});
      },
    };
  },
};
