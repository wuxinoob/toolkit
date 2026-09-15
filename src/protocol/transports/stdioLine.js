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
    let timer = null;
    const finish = (env) => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      onEnd?.(env);
    };

    const tick = async () => {
      if (stopped) return;
      try {
        const r = await rpcTransport.request({
          pluginId,
          svc: 'proc',
          act: 'recv',
          params: { key: ch, timeoutMs },
        });
        if (r && typeof r.line === 'string') {
          let env;
          try {
            env = lineJson.decode(r.line);
          } catch {
            env = Envelope.data(ch, r.line); // plain-text backend: wrap it
          }
          onFrame?.(env);
          if (Envelope.isTerminal(env.kind)) return finish(env);
        } else if (r && r.exited) {
          const env = Envelope.exit(ch, r.code);
          onFrame?.(env);
          return finish(env);
        }
      } catch (e) {
        // A host-level failure ends the stream with a proper terminal frame.
        const env = Envelope.streamErr(ch, e.code ?? 'transport', String(e.message ?? e));
        onFrame?.(env);
        return finish(env);
      }
      timer = setTimeout(tick, pollMs);
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
      async close() {
        stopped = true;
        if (timer) clearTimeout(timer);
        await rpcTransport
          .request({ pluginId, svc: 'proc', act: 'kill', params: { key: ch } })
          .catch(() => {});
        finish(Envelope.end(ch));
      },
    };
  },
};
