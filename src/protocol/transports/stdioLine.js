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

export const stdioLineTransport = {
  descriptor: descriptor('stdio-line'),

  async open({ pluginId, ch, params = {}, onFrame, onEnd }) {
    const { exe, args = [], pollMs = 50, timeoutMs = 200 } = params;
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
    const finish = (env) => {
      if (ended) return;
      ended = true;
      stopped = true;
      if (timer) clearTimeout(timer);
      onEnd?.(env);
    };

    const tick = async () => {
      if (stopped) return;
      let delivered = false;
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
      // Re-poll IMMEDIATELY when a line arrived. The host's `recv` is condvar
      // driven and returns as soon as data exists, so delaying here would cap
      // throughput at 1/pollMs — about 20 lines/s at the 50ms default — however
      // fast the backend actually produces. The delay exists only for the idle
      // case, where it keeps us off the IPC bus.
      timer = setTimeout(tick, delivered ? 0 : pollMs);
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
