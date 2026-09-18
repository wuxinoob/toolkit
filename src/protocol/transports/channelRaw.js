/**
 * `channel-raw` transport — binary push streams.
 *
 * Carrier: Tauri `Channel<InvokeResponseBody>`. Codec: raw-binary (1 kind byte
 * + payload). Identical shape to `channel-json` from the caller's point of
 * view — the difference is entirely in framing, which is the point: a consumer
 * written against the envelope interface does not care which one it got.
 */

import { invoke, Channel } from '@tauri-apps/api/core';
import * as Envelope from '../envelope.js';
import { rawToEnvelope } from '../codec.js';
import { descriptor } from '../registry.js';
import { guard } from '../errors.js';

/** Normalise whatever the IPC bridge hands us into bytes. */
function toBytes(raw) {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (typeof raw === 'string') return new TextEncoder().encode(raw);
  return new Uint8Array(raw ?? 0);
}

export const channelRawTransport = {
  descriptor: descriptor('channel-raw'),

  async open({ pluginId, provider, ch, params = null, onFrame, onEnd }) {
    const channel = new Channel();
    let settled = false;
    const finish = (env) => {
      if (settled) return;
      settled = true;
      onEnd?.(env);
    };

    channel.onmessage = (raw) => {
      let env;
      try {
        env = rawToEnvelope(toBytes(raw), ch);
      } catch (e) {
        finish(Envelope.streamErr(ch, 'codec', String(e?.message ?? e)));
        return;
      }
      onFrame?.(env);
      if (Envelope.endsStream(env)) finish(env);
    };

    await guard(
      invoke('plugin_stream_open_raw', {
        pluginId,
        provider,
        ch,
        params,
        onFrame: channel,
      }),
      `raw stream ${provider}/${ch}`,
    );

    return {
      ch,
      provider,
      async close() {
        await guard(invoke('plugin_stream_close', { pluginId, ch }), `close ${ch}`).catch((e) => {
          if (e.code !== 'transport') throw e;
        });
        finish(Envelope.end(ch));
      },
    };
  },
};
