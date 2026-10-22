/**
 * `stdio-line` transport — the sidecar data plane.
 *
 * Carrier: the sidecar's stdio, reached through the `proc` service. Codec:
 * line-json (one envelope per line). The native pipe is request/response at
 * the host boundary, so this transport is a pull adapter that presents the
 * same push interface as the channel transports:
 *
 *   open()  -> spawn the helper, then poll its stdout and emit envelopes
 *   send()  -> encode one envelope as a line and write it
 *
 * A sidecar line that is not a valid envelope is surfaced as a `data` frame
 * carrying the raw text, so a plain-text backend still works.
 */

import * as Envelope from '../envelope.js';
import { Code } from '../codes.js';
import { lineJson } from '../codec.js';
import { descriptor } from '../registry.js';
import { ProtocolError } from '../errors.js';
import { rpcTransport } from './rpc.js';

/**
 * Poll pacing.
 *
 * `recv` is condvar driven: it returns as soon as a line exists, so the loop
 * re-polls at 0 ms while there is a backlog. That is right for latency and
 * wrong for the host: **one line costs one `invoke`**, each invoke is a
 * main-thread message, and the window's queue holds 10 000 of them. A backend
 * that prints faster than the IPC can answer (a build tool, `tail -f`, anything
 * that logs per iteration) therefore turns into an invoke storm, and the first
 * visible symptom is that every control in the app stops responding.
 *
 * So the drain has a **budget**, and past it the loop waits `pollMs` instead of
 * 0. Nothing is lost by that: the host already bounds its own queue (4 MiB) and
 * reports what it had to drop, which the caller sees as `dropped` on the next
 * line. This is a transport for CONTROL plane traffic — a sidecar that needs to
 * stream data should use a pty or a raw stream, not line-json.
 *
 * The ceiling of the old loop was not infinite: a webview clamps nested timers
 * to 4 ms, so it was about **250 polls/s per sidecar**. That is still 250
 * invokes a second, and each one holds a blocking-pool thread for the whole
 * `recv` timeout (150–400 ms in the plugins shipped here) — the cost is the
 * threads, not just the messages.
 *
 * The floor matters too: `pollMs: 0` used to mean a 0 ms idle loop, which is a
 * busy loop with no data at all. 10 ms is 100 polls/s — still generous, and
 * bounded.
 */
const POLL_DEFAULT_MS = 50;
const POLL_MIN_MS = 10;
const POLL_MAX_MS = 5_000;

/** Polls per second before the loop stops re-polling immediately. */
const DRAIN_PER_SECOND = 120;

/**
 * Exported because it is the ONE part of this file that cannot be observed from
 * outside on every platform: with a 12 ms timer floor (this machine) or a 4 ms
 * clamp (a webview), `pollMs: 0` and `pollMs: 10` look identical from the
 * outside — both are paced by the platform. The policy still has to be pinned,
 * so the test asserts the number directly.
 */
export function clampPoll(v) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : POLL_DEFAULT_MS;
  return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.round(n)));
}

export const stdioLineTransport = {
  descriptor: descriptor('stdio-line'),

  async open({ pluginId, ch, params = {}, onFrame, onEnd }) {
    const { exe, args = [], timeoutMs = 200 } = params;
    const pollMs = clampPoll(params.pollMs);
    if (!exe) throw ProtocolError.protocol('stdio-line requires params.exe (a binary in the plugin folder)');

    await rpcTransport.request({
      pluginId,
      svc: 'proc',
      act: 'spawn',
      params: { key: ch, exe, args },
    });

    let stopped = false;
    let ended = false;
    let closing = null;
    let timer = null;

    // Sliding one-second budget. Every poll counts, not just the productive
    // ones: a fast `pollMs` is its own flood when nothing is arriving.
    let windowStart = Date.now();
    let pollsInWindow = 0;
    let warnedThrottle = false;
    const withinBudget = () => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        pollsInWindow = 0;
      }
      pollsInWindow += 1;
      return pollsInWindow <= DRAIN_PER_SECOND;
    };
    const finish = (env) => {
      if (ended) return;
      ended = true;
      stopped = true;
      if (timer) clearTimeout(timer);
      onEnd?.(env);
    };

    const tick = async () => {
      if (stopped) return;
      const fast = withinBudget();
      // `delivered` means "there is more waiting, drain it NOW". An EMPTY line
      // is still a frame, but it is not evidence of a backlog: a backend that
      // prints blank lines would otherwise drive a 0ms loop, and a 0ms loop in
      // the main window freezes every control in the app without burning a
      // visible amount of CPU per turn. So it is delivered, and then we wait.
      let delivered = false;
      let nonEmpty = false;
      try {
        const r = await rpcTransport.request({
          pluginId,
          svc: 'proc',
          act: 'recv',
          params: { key: ch, timeoutMs },
        });
        if (stopped) return;
        if (r && typeof r.line === 'string') {
          delivered = true;
          nonEmpty = r.line.length > 0;
          if (r.dropped) {
            // The host dropped old output to stay inside its queue cap. Say so:
            // a silent gap is worse than a noisy one.
            console.warn(
              `[stdio-line:${ch}] host dropped ${r.dropped} line(s) — consumer too slow`,
            );
          }
          let env;
          try {
            env = lineJson.decode(r.line);
          } catch {
            env = Envelope.data(ch, r.line); // plain-text backend: wrap it
          }
          onFrame?.(env);
          // The "does this end the stream" rule is shared, not local: a reply
          // (res/err carrying an id) travels the same channel and must not end it.
          if (Envelope.endsStream(env)) return finish(env);
        } else if (r && r.exited) {
          const env = Envelope.exit(ch, r.code);
          onFrame?.(env);
          return finish(env);
        }
      } catch (e) {
        if (stopped) return;
        // A host-level failure ends the stream with a proper terminal frame.
        const env = Envelope.streamErr(ch, e.code ?? Code.TRANSPORT, String(e.message ?? e));
        onFrame?.(env);
        return finish(env);
      }
      // Re-poll IMMEDIATELY when a non-empty line arrived. The host's `recv` is
      // condvar driven and returns as soon as data exists, so delaying here
      // would cap throughput at 1/pollMs — about 20 lines/s at the 50ms default
      // — however fast the backend actually produces. The delay exists for the
      // idle case (and for empty lines, see above), where it keeps us off the
      // IPC bus.
      if (!fast && delivered && nonEmpty && !warnedThrottle) {
        // Say it once. A throttle that nobody reports looks exactly like a
        // backend that got slower, and the fix (use a pty, or stop logging per
        // iteration) is not guessable from the outside.
        warnedThrottle = true;
        console.warn(
          `[stdio-line:${ch}] drain throttled to ${DRAIN_PER_SECOND}/s — this transport is ` +
            `control plane; a sidecar that streams data needs a pty or a raw stream`,
        );
      }
      timer = setTimeout(tick, delivered && nonEmpty && fast ? 0 : pollMs);
    };
    timer = setTimeout(tick, 0);

    return {
      ch,
      provider: 'sidecar',
      async send(env) {
        Envelope.validate(env);
        return rpcTransport.request({
          pluginId,
          svc: 'proc',
          act: 'send',
          params: { key: ch, line: lineJson.encode(env) },
        });
      },
      close() {
        if (closing) return closing;
        stopped = true;
        if (timer) clearTimeout(timer);
        closing = rpcTransport
          .request({ pluginId, svc: 'proc', act: 'kill', params: { key: ch } })
          .catch(() => {})
          .then(() => {
            finish(Envelope.end(ch));
          });
        return closing;
      },
    };
  },
};
