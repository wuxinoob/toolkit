/**
 * `pty-stream` transport — command-line subprocesses.
 *
 * Carrier: a pseudo-terminal (tauri-plugin-pty). Codec: raw-binary. This is the
 * transport that wraps a THIRD-PARTY mechanism behind the unified interface:
 * callers get the same `open/send/close` + envelope frames as every other
 * scheme, while the pty specifics (ConPTY quirks, resize, ownership) stay
 * confined to this file.
 *
 * It drives the plugin's own commands rather than its `tauri-pty` JS wrapper,
 * because the wrapper hides what this transport needs: its read loop ends on an
 * `EOF` error and then simply `return`s — nobody is told — while the exit status
 * arrives on a separate promise.
 *
 * ## When the output is finished
 *
 * The exit frame must not be emitted before the last chunk has been delivered,
 * or a consumer that treats `exit` as terminal loses trailing output (observed
 * in the field as a short command's echo going missing).
 *
 * The obvious signal — `read` returning 0 bytes — is NOT reliable here. On
 * Windows, ConPTY's reader stays parked after the child exits instead of
 * reporting end-of-stream; the pseudoconsole only closes when the master is
 * dropped. So a design that waits for EOF before asking for the exit status
 * deadlocks: the read never returns, so the status is never asked for. (That is
 * not theory — it is how this transport failed the in-app suite: the marker text
 * arrived, then no terminal frame ever did.)
 *
 * What this does instead, in order of preference:
 *
 *   1. If the read loop ends on its own (EOF where the platform reports it, or
 *      the session disappearing), that is the end of output — exact, no waiting.
 *   2. Otherwise, once the process is gone, wait for the data stream to go QUIET
 *      (bounded). That is a heuristic, and it is labelled as one: the platform
 *      does not tell us, so the honest thing is a short bounded wait rather than
 *      a claim of determinism.
 *
 * ## The bell
 *
 * BEL (0x07) is consumed here and never reaches a consumer; `handle.bells()`
 * reports how many were consumed. Deciding this at the transport rather than in
 * one consumer is deliberate: "there is no bell in this app" is a fact about the
 * host, not a preference of any one plugin, and a wire that keeps a byte nobody
 * can act on is a byte that eventually gets echoed somewhere it CAN be heard.
 * See `consumeBell` for the full reasoning, including what it does NOT fix.
 *
 * ## Ownership
 *
 * The value `spawn` returns is the PLUGIN's session HANDLE, not an OS pid —
 * `tauri-plugin-pty` keys its sessions by a counter starting at 0. It is
 * therefore never handed to the session registry as a pid: doing so would make
 * app exit run `taskkill` against an unrelated process number. The host does not
 * own this process; the plugin does, and `plugin:pty|kill` is how it stops.
 */

import { invoke } from '@tauri-apps/api/core';

import * as Envelope from '../envelope.js';
import { descriptor } from '../registry.js';
import { ProtocolError } from '../errors.js';
import { Code } from '../codes.js';
import { rpcTransport } from './rpc.js';

const DSR = [0x1b, 0x5b, 0x36, 0x6e]; // ESC [ 6 n
const CPR = '\x1b[1;1R';
const BEL = 0x07;
/** Quiet period after the process exits before the exit frame is emitted. */
const DRAIN_MS = 120;
/** Hard cap on that wait, so a still-chatty stream cannot hold the exit back. */
const DRAIN_MAX_MS = 1000;

/**
 * Consume BEL (0x07) instead of forwarding it, and count what was consumed.
 *
 * The host has no bell. That is not a preference, it is a fact about this app:
 * nothing in the tree can turn a BEL into a sound — `@xterm/xterm` fires
 * `onBell` and nothing subscribes to it, and no dependency in the bundle opens
 * an `AudioContext` (see the "no bell" section in `docs/plugin-dev/debugging.md`
 * for the two commands that re-check it). So a byte that a real terminal would
 * ring is, here, dead weight that a consumer might later surface somewhere it
 * *can* be heard — a copy into a real console, a log file, a `pre` block.
 *
 * The information is not lost, it is converted: whatever wrote the BEL is
 * reported by `handle.bells()`. That is the number that answers "is the shell
 * ringing us, or is the sound coming from somewhere we never see" — a child can
 * also beep by calling the Win32 `Beep()` API, which never touches this stream.
 *
 * Returns the input array itself when there is nothing to remove. That is the
 * overwhelmingly common case and the reason this is not a `.filter()`: the
 * common path should not copy every chunk.
 */
function consumeBell(u8) {
  if (u8.indexOf(BEL) < 0) return { data: u8, bells: 0 };
  let bells = 0;
  for (let i = 0; i < u8.length; i += 1) if (u8[i] === BEL) bells += 1;
  const out = new Uint8Array(u8.length - bells);
  let w = 0;
  for (let i = 0; i < u8.length; i += 1) if (u8[i] !== BEL) out[w++] = u8[i];
  return { data: out, bells };
}

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

/**
 * Does this `read` failure mean the output has ended? Three spellings of one
 * fact, because the underlying read differs by platform:
 *
 *   `EOF`                  the master read returned 0 bytes
 *   `Input/output error`   reading a master whose slave has closed (Unix EIO —
 *                          POSIX reports end-of-stream as an error, not as 0)
 *   `Unavailable pid`      `exitstatus` already removed the plugin's session, so
 *                          the lookup failed instead; same moment, other path
 */
function isEndOfOutput(message) {
  return /EOF|Unavailable pid|Input\/output error/i.test(message);
}

export const ptyStreamTransport = {
  descriptor: descriptor('pty-stream'),

  async open({ pluginId, ch, params = {}, onFrame, onEnd }) {
    if (!params.program) {
      throw ProtocolError.protocol('pty-stream requires params.program');
    }

    const pid = await invoke('plugin:pty|spawn', {
      file: params.program,
      args: params.args ?? [],
      termName: 'Toolbox',
      cols: params.cols ?? 80,
      rows: params.rows ?? 24,
      cwd: params.cwd ?? null,
      // The Rust side takes a map; an unset env is an empty one, not a cleared
      // environment — the child inherits when nothing is passed.
      env: params.env ?? {},
      encoding: null,
      handleFlowControl: null,
      flowControlPause: null,
      flowControlResume: null,
    });
    if (pid == null) throw ProtocolError.transport('pty spawn returned no handle');

    // Take ownership BEFORE reading. If the host cannot register the session,
    // nobody would reap this child on exit — so kill it and fail loudly instead
    // of leaking a process the app can no longer see.
    //
    // NOTE: no `pid` here. What spawn returned is the plugin's session handle,
    // not an OS pid, and the registry would turn it into a `taskkill` target on
    // app exit. The host does not own this process — the plugin does.
    try {
      await rpcTransport.request({
        pluginId,
        svc: 'stream',
        act: 'session_open',
        params: { ch, kind: 'pty' },
      });
    } catch (e) {
      await invoke('plugin:pty|kill', { pid }).catch(() => {});
      throw ProtocolError.transport(
        `pty session registration failed, child killed: ${e?.message ?? e}`,
      );
    }

    let stopped = false;
    let ended = false;
    let closing = null;
    let outputEnded = false;
    let exitCode = null; // null until exitstatus resolves
    let sessionReleased = false;
    let lastDataAt = Date.now();
    let drainTimer = null;

    const releaseNativeSession = () => {
      if (sessionReleased) return;
      sessionReleased = true;
      rpcTransport
        .request({ pluginId, svc: 'stream', act: 'session_close', params: { ch } })
        .catch(() => {});
    };

    /** Single terminal point: exactly one terminal frame, then release. */
    const finish = (env) => {
      if (ended) return;
      ended = true;
      stopped = true;
      if (drainTimer) clearTimeout(drainTimer);
      if (dsrTimer) clearTimeout(dsrTimer);
      onFrame?.(env);
      onEnd?.(env);
      releaseNativeSession();
    };

    /**
     * Emit `exit` once both facts are known. A read loop that ended on its own
     * is enough by itself; otherwise the bounded drain decides.
     */
    const maybeExit = () => {
      if (ended || exitCode === null) return;
      if (outputEnded) return finish(Envelope.exit(ch, exitCode));
      const exitedAt = Date.now();
      const settle = () => {
        const quiet = Date.now() - lastDataAt;
        const waited = Date.now() - exitedAt;
        if (quiet >= DRAIN_MS || waited >= DRAIN_MAX_MS) {
          outputEnded = true;
          return finish(Envelope.exit(ch, exitCode));
        }
        drainTimer = setTimeout(settle, Math.min(DRAIN_MS, DRAIN_MAX_MS - waited));
      };
      settle();
    };

    // ConPTY DSR watchdog: the child blocks until the cursor query is answered.
    // xterm answers itself; a headless consumer does not.
    let cprHandled = false;
    let dsrSeen = false;
    let dsrTimer = null;
    let bellCount = 0;
    const isWindows = /win/i.test(globalThis.navigator?.platform ?? '');

    const emitData = (u8) => {
      if (stopped) return;
      lastDataAt = Date.now();
      // Asked of the bytes as they ARRIVED: the watchdog answers what the child
      // sent, and the BEL pass below only ever removes a byte the child cannot
      // have meant as part of the query.
      if (isWindows && !dsrSeen && hasDsr(u8)) {
        dsrSeen = true;
        dsrTimer = setTimeout(() => {
          if (!cprHandled) invoke('plugin:pty|write', { pid, data: CPR }).catch(() => {});
        }, 250);
      }
      const chunk = consumeBell(u8);
      bellCount += chunk.bells;
      // Nothing left to render (a chunk that was only bells) — an empty data
      // frame would be a frame that says nothing.
      if (chunk.data.length === 0) return;
      onFrame?.(Envelope.data(ch, chunk.data));
    };

    // ---- fact 1: the output stream (may never end; see the header) ----
    (async () => {
      for (;;) {
        let data;
        try {
          data = await invoke('plugin:pty|read', { pid });
        } catch (e) {
          if (stopped) return;
          const s = String(e);
          if (isEndOfOutput(s)) {
            outputEnded = true;
            maybeExit();
            return;
          }
          finish(Envelope.streamErr(ch, Code.TRANSPORT, `pty read failed: ${s}`));
          return;
        }
        if (stopped) return;
        emitData(toU8(data));
      }
    })();

    // ---- fact 2: the process — asked for immediately, and independently ----
    (async () => {
      try {
        const code = await invoke('plugin:pty|exitstatus', { pid });
        exitCode = typeof code === 'number' ? code : -1;
      } catch (e) {
        if (stopped) return;
        // The output is over one way or another, so the frame must be terminal
        // or the consumer waits forever. Report an unknown code, not success.
        console.warn(`[pty-stream:${ch}] exit status unavailable: ${e}`);
        exitCode = -1;
      }
      maybeExit();
    })();

    return {
      ch,
      provider: 'pty',
      pid,
      cols: params.cols ?? 80,
      rows: params.rows ?? 24,

      /**
       * How many BEL bytes this stream has consumed and NOT delivered.
       *
       * Read it when a user reports a beep: a rising count means the thing
       * making the noise is writing to the terminal, so the bytes are ours to
       * see (and to drop, which is what this does). A count that stays at zero
       * while the beep is still audible means the sound never entered this
       * stream — a child calling `Beep()` directly, or the console host on its
       * behalf. No app-side switch can silence that one; it belongs to the
       * program or to the OS sound scheme.
       */
      bells: () => bellCount,

      write(data) {
        cprHandled = true; // the consumer answered the cursor query itself
        return invoke('plugin:pty|write', { pid, data });
      },

      resize(cols, rows) {
        return invoke('plugin:pty|resize', { pid, cols, rows });
      },

      /**
       * Close the stream. Emits `end` (like the stdio transport does) rather
       * than `exit`: the consumer ended it, so there is no exit code to report.
       * Idempotent — a second call returns the first call's promise.
       */
      close() {
        if (closing) return closing;
        stopped = true;
        cprHandled = true;
        if (drainTimer) clearTimeout(drainTimer);
        if (dsrTimer) clearTimeout(dsrTimer);
        closing = invoke('plugin:pty|kill', { pid })
          .catch(() => {})
          .then(() => {
            finish(Envelope.end(ch));
          });
        return closing;
      },
    };
  },
};
