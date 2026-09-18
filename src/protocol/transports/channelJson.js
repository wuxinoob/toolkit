/**
 * `channel-json` transport — structured push streams.
 *
 * Carrier: Tauri `Channel<Envelope>`. Codec: json-envelope. The host keeps
 * sending after the open call returns, so the open promise only covers SETUP;
 * everything after that arrives as a frame, and the stream always ends with a
 * terminal frame (`end` / `exit` / `err`).
 */

import { invoke, Channel } from '@tauri-apps/api/core';
import * as Envelope from '../envelope.js';
import { Code } from '../codes.js';
import { descriptor } from '../registry.js';
import { ProtocolError, guard } from '../errors.js';

export const channelJsonTransport = {
  descriptor: descriptor('channel-json'),

  /**
   * Open a stream. `onFrame` receives validated envelopes; `onEnd` fires once
   * on any terminal frame so callers do not each re-implement that check.
   * Returns `{ ch, close }`.
   */
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
        env = typeof raw === 'string' ? Envelope.validate(JSON.parse(raw)) : Envelope.validate(raw);
      } catch (e) {
        finish(Envelope.streamErr(ch, Code.CODEC, String(e?.message ?? e)));
        return;
      }
      onFrame?.(env);
      if (Envelope.endsStream(env)) finish(env);
    };

    await guard(
      invoke('plugin_stream_open', {
        pluginId,
        provider,
        ch,
        params,
        onFrame: channel,
      }),
      `stream ${provider}/${ch}`,
    );

    return {
      ch,
      provider,
      async close() {
        await guard(invoke('plugin_stream_close', { pluginId, ch }), `close ${ch}`).catch((e) => {
          // The producer may already have finished; that is not an error.
          if (e.code !== Code.TRANSPORT) throw e;
        });
        finish(Envelope.end(ch));
      },
    };
  },
};

export { ProtocolError };
