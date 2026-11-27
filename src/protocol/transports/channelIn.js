/**
 * `channel-in` transport — an UPLINK stream: the plugin pushes frames to a
 * host-side sink.
 *
 * Every other scheme moves data host -> plugin. This one is the other direction,
 * and its carrier is a deliberate compromise:
 *
 *   Tauri's `Channel` is one-directional. The JS side has no `send` at all —
 *   only a receive callback — so the framework offers no push carrier for
 *   plugin -> host. The uplink is therefore carried by **batched `invoke`**:
 *   one round trip per batch of frames instead of one per frame.
 *
 * That is what makes it worth having: the old way to feed a backend was
 * `proc/send` once per line, so a 1000-frame burst cost 1000 round trips. Here
 * it costs one per `sendBatch`, and the host validates every frame and hands it
 * to a named sink, so the plugin does not need to know how the host consumes it.
 *
 * The handle keeps the same shape as every other stream (send / close), so a
 * caller does not learn a second model — `send` is simply a batch of one.
 */

import * as Envelope from '../envelope.js';
import { descriptor } from '../registry.js';
import { ProtocolError } from '../errors.js';
import { rpcTransport, DEFAULT_TIMEOUT_MS, withTimeout } from './rpc.js';

/** Mirrors `MAX_FRAMES_PER_BATCH` in services/uplink.rs. */
export const MAX_FRAMES_PER_BATCH = 256;
export const MAX_BATCH_BYTES = 1 << 20;

export const channelInTransport = {
  descriptor: descriptor('channel-in'),

  async open({ pluginId, ch, params = {}, onEnd }) {
    const { sink, params: sinkParams = null } = params;
    if (!sink) {
      throw ProtocolError.protocol('channel-in requires params.sink (the host-side consumer)');
    }

    await rpcTransport.request({
      pluginId,
      svc: 'stream',
      act: 'open_in',
      params: { ch, sink, params: sinkParams },
    });

    let closed = false;
    let closing = null;
    let writing = false;

    const handle = {
      ch,
      provider: 'plugin',
      sink,

      /**
       * Send one frame. Same shape as every other transport's `send`; it is
       * flushed immediately so a caller never has to remember to.
       */
      async send(env) {
        return handle.sendBatch([env]);
      },

      /**
       * Send many frames in ONE round trip — the point of this scheme.
       * Rejects a batch larger than the host accepts rather than letting the
       * host reject it, so the error names the caller's own call.
       */
      async sendBatch(envs) {
        if (closed) throw ProtocolError.protocol(`uplink \`${ch}\` is closed`);
        if (writing) throw new ProtocolError('conflict', 'await the previous uplink batch before sending another');
        if (!Array.isArray(envs) || !envs.length) {
          throw ProtocolError.protocol('sendBatch requires a non-empty array of frames');
        }
        if (envs.length > MAX_FRAMES_PER_BATCH) {
          throw ProtocolError.protocol(
            `batch of ${envs.length} exceeds the ${MAX_FRAMES_PER_BATCH}-frame limit — split it`,
          );
        }
        let bytes = 0;
        for (const env of envs) {
          Envelope.validate(env);
          bytes += new TextEncoder().encode(JSON.stringify(env)).byteLength;
          if (bytes > MAX_BATCH_BYTES) throw new ProtocolError('bad_params', 'batch exceeds 1 MiB; split it');
        }
        writing = true;
        const operation = rpcTransport.request({
          pluginId,
          svc: 'stream',
          act: 'write_in',
          params: { ch, frames: envs },
          timeoutMs: 0,
        }).finally(() => { writing = false; });
        // Keep the slot until the native operation really finishes, including after caller timeout.
        return withTimeout(operation, DEFAULT_TIMEOUT_MS, `uplink/${ch}`);
      },

      /** Idempotent: a second call returns the first call's promise. */
      close() {
        if (closing) return closing;
        closed = true;
        closing = rpcTransport
          .request({ pluginId, svc: 'stream', act: 'close_in', params: { ch } })
          .catch(() => {})
          .then(() => {
            onEnd?.(Envelope.end(ch));
          });
        return closing;
      },
    };

    return handle;
  },
};
