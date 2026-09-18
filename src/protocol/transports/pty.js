/**
 * `pty-stream` transport — command-line subprocesses.
 *
 * Carrier: a pseudo-terminal (tauri-plugin-pty). Codec: raw-binary. This is the
 * transport that wraps a THIRD-PARTY mechanism behind the unified interface:
 * callers get the same `open/send/close` + envelope frames as every other
 * scheme, while the pty specifics (ConPTY quirks, resize, pid ownership) stay
 * confined to this file.
 *
 * It drives the plugin's own commands rather than its `tauri-pty` JS wrapper,
 * because the wrapper hides the one signal this transport needs. Its read loop
 * ends on an `EOF` error and then simply `return`s — nobody is told — while the
 * exit status arrives on a separate promise. So "the output is finished" was
 * unobservable, and the exit frame had to be guessed with a quiet-period timer.
 * Reading the commands directly makes the end of output a fact:
 *
 *   spawn      -> pid
 *   read       -> bytes, or Err("EOF") once the child's output is drained
 *   exitstatus -> the exit code (and it removes the plugin's session)
 *
 * The exit frame is then emitted only when BOTH facts are known — output ended
 * AND the process is gone — so ordering is exact and no timers are involved.
 *
 * Two more details, both isolated here on purpose:
 *
 *  1. `exitstatus` removes the plugin's session the moment the child exits, so a
 *     `read` racing that removal fails with "Unavailable pid" instead of
 *     returning 0 bytes. Both mean the same thing here and are treated alike.
 *  2. ConPTY is opened with INHERIT_CURSOR, so it emits a cursor-position request
 *     (ESC[6n) at startup and blocks the child until answered. xterm.js answers
 *     by itself; a headless consumer never does, which deadlocks short-lived
 *     commands. The watchdog below answers once, but only if the consumer has not
 *     already written (i.e. xterm already replied).
 *
 * The pid is registered in the host's unified session registry BEFORE any
 * reading, so `kill_all()` on app exit reaps pty children too; if registration
 * fails the child is killed rather than left unowned.
 */

import { invoke } from '@tauri-apps/api/core';

import * as Envelope from '../envelope.js';
import { Code } from '../codes.js';
import { descriptor } from '../registry.js';
import { ProtocolError } from '../errors.js';
import { rpcTransport } from './rpc.js';

const DSR = [0x1b, 0x5b, 0x36, 0x6e]; // ESC [ 6 n
const CPR = '\x1b[1;1R';

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
 * fact, because the underlying read differs by platform and by timing:
 *
 *   `EOF`                  the master read returned 0 bytes (Windows ConPTY)
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
      env: {},
      encoding: null,
      handleFlowControl: null,
      flowControlPause: null,
      flowControlResume: null,
    });
    if (pid == null) throw ProtocolError.transport('pty spawn returned no pid');

    // Take ownership BEFORE reading. If the host cannot register the session,
    // nobody would reap this child on exit — so kill it and fail loudly instead
    // of leaking a process the app can no longer see.
    try {
      await rpcTransport.request({
        pluginId,
        svc: 'stream',
        act: 'session_open',
        params: { ch, kind: 'pty', pid },
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
      onFrame?.(env);
      onEnd?.(env);
      releaseNativeSession();
    };

    /**
     * The exit frame needs BOTH facts. `exitstatus` can resolve before the read
     * loop has drained the buffer, and EOF can arrive before the code is known —
     * whichever is last decides.
     */
    const maybeExit = () => {
      if (ended || !outputEnded || exitCode === null) return;
      finish(Envelope.exit(ch, exitCode));
    };

    // ConPTY DSR watchdog — see note 2 at the top of this file.
    let cprHandled = false;
    let dsrSeen = false;
    let dsrTimer = null;
    const isWindows = /win/i.test(globalThis.navigator?.platform ?? '');

    const emitData = (u8) => {
      if (stopped) return;
      if (isWindows && !dsrSeen && hasDsr(u8)) {
        dsrSeen = true;
        dsrTimer = setTimeout(() => {
          if (!cprHandled) invoke('plugin:pty|write', { pid, data: CPR }).catch(() => {});
        }, 250);
      }
      onFrame?.(Envelope.data(ch, u8));
    };

    /**
     * Drain the output, THEN ask for the exit status — in that order, on
     * purpose.
     *
     * `exitstatus` removes the plugin's session as soon as the child exits, so
     * asking for it while the buffer is still unread can make the next `read`
     * fail the lookup and silently drop a short command's output. By the time
     * the output has ended the child has certainly exited (the end of output
     * means the child's side closed), so asking afterwards returns promptly.
     */
    (async () => {
      for (;;) {
        let data;
        try {
          data = await invoke('plugin:pty|read', { pid });
        } catch (e) {
          if (stopped) return;
          const s = String(e);
          if (isEndOfOutput(s)) break;
          finish(Envelope.streamErr(ch, Code.TRANSPORT, `pty read failed: ${s}`));
          return;
        }
        if (stopped) return;
        emitData(toU8(data));
      }

      outputEnded = true;
      if (stopped) return;

      try {
        const code = await invoke('plugin:pty|exitstatus', { pid });
        exitCode = typeof code === 'number' ? code : -1;
      } catch (e) {
        if (stopped) return;
        // The output ended, so the frame must be terminal or the consumer waits
        // forever. Report an unknown code rather than inventing success.
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
