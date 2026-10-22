/**
 * `channel-json` transport — structured push streams.
 *
 * Carrier: Tauri `Channel<Envelope>`. Codec: json-envelope. The host keeps
 * sending after the open call returns, so the open promise only covers SETUP;
 * everything after that arrives as a frame, and the stream always ends with a
 * terminal frame (`end` / `exit` / `err`).
 */

import { invoke } from '@tauri-apps/api/core';
import { Channel } from '../channel.js';
import * as Envelope from '../envelope.js';
import { Code } from '../codes.js';
import { descriptor } from '../registry.js';
import { ProtocolError, guard } from '../errors.js';
import { withTimeout, DEFAULT_TIMEOUT_MS } from './rpc.js';

export const channelJsonTransport = {
  descriptor: descriptor('channel-json'),

  /**
   * Open a stream. `onFrame` receives validated envelopes; `onEnd` fires once
   * on any terminal frame so callers do not each re-implement that check.
   * Returns `{ ch, close }`.
   */
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
        env = typeof raw === 'string' ? Envelope.validate(JSON.parse(raw)) : Envelope.validate(raw);
      } catch (e) {
        finish(Envelope.streamErr(ch, Code.CODEC, String(e?.message ?? e)));
        return;
      }
      onFrame?.(env);
      if (Envelope.endsStream(env)) finish(env);
    };

    // Bounded, for the same reason `rpc` is: an `invoke` that never settles
    // must not leave `await ctx.stream(...)` pending forever. Setup is fast, so
    // this only ever fires when the bridge itself is wedged.
    await withTimeout(
      guard(
        invoke('plugin_stream_open', {
          pluginId,
          provider,
          ch,
          params,
          onFrame: channel,
        }),
        `stream ${provider}/${ch}`,
      ),
      timeoutMs,
      `open ${provider}/${ch}`,
    );

    return {
      ch,
      provider,
      async close() {
        await withTimeout(
          guard(invoke('plugin_stream_close', { pluginId, ch }), `close ${ch}`).catch((e) => {
            // The producer may already have finished; that is not an error.
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

export { ProtocolError };
