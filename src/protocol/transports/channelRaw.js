/**
 * `channel-raw` transport — binary push streams.
 *
 * Carrier: Tauri `Channel<InvokeResponseBody>`. Codec: raw-binary (1 kind byte
 * + payload). Identical shape to `channel-json` from the caller's point of
 * view — the difference is entirely in framing, which is the point: a consumer
 * written against the envelope interface does not care which one it got.
 */

import { invoke } from '@tauri-apps/api/core';
import { Channel } from '../channel.js';
import * as Envelope from '../envelope.js';
import { Code } from '../codes.js';
import { rawToEnvelope, toBytes } from '../codec.js';
import { descriptor } from '../registry.js';
import { guard } from '../errors.js';
import { withTimeout, DEFAULT_TIMEOUT_MS } from './rpc.js';

export const channelRawTransport = {
  descriptor: descriptor('channel-raw'),

  async open({ pluginId, provider, ch, params = null, onFrame, onEnd, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    let settled = false;
    const finish = (env) => {
      if (settled) return;
      settled = true;
      onEnd?.(env);
    };

    // `onGap`: a frame the host lost can never be re-sent, so a hole in the
    // index sequence is not something to wait out — see `channel.js`. Ending the
    // stream is the recoverable outcome: the caller sees a `transport` error and
    // can open it again, where the framework's own receiver would buffer
    // forever and report nothing.
    const channel = new Channel(undefined, {
      onGap: (why) => {
        // Stop the producer too: it would otherwise keep sending frames to a
        // callback nobody is listening to.
        void invoke('plugin_stream_close', { pluginId, ch }).catch(() => {});
        finish(Envelope.streamErr(ch, Code.TRANSPORT, why));
      },
    });

    channel.onmessage = (raw) => {
      let env;
      try {
        env = rawToEnvelope(toBytes(raw), ch);
      } catch (e) {
        finish(Envelope.streamErr(ch, Code.CODEC, String(e?.message ?? e)));
        return;
      }
      onFrame?.(env);
      if (Envelope.endsStream(env)) finish(env);
    };

    // Bounded like `rpc` — see the note in channelJson.js.
    await withTimeout(
      guard(
        invoke('plugin_stream_open_raw', {
          pluginId,
          provider,
          ch,
          params,
          onFrame: channel,
        }),
        `raw stream ${provider}/${ch}`,
      ),
      timeoutMs,
      `open raw ${provider}/${ch}`,
    );

    return {
      ch,
      provider,
      async close() {
        await withTimeout(
          guard(invoke('plugin_stream_close', { pluginId, ch }), `close ${ch}`).catch((e) => {
            if (e.code !== Code.TRANSPORT) throw e;
          }),
          timeoutMs,
          `close ${ch}`,
        );
        finish(Envelope.end(ch));
      },
    };
  },
};
