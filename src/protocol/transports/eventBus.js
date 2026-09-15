/**
 * `event-bus` transport — the cross-window broadcast.
 *
 * Carrier: Tauri events. Codec: json-envelope. Publishing goes through the
 * gateway (`bus/publish`) so the host does the fan-out to every window;
 * subscribing is a single `listen` on one event name, filtered by topic.
 *
 * This is what replaces per-feature polling: the floating widget and any
 * external plugin window subscribe with the same call as a main-window plugin,
 * and the message arrives as an ordinary `evt` envelope.
 */

import { listen } from '@tauri-apps/api/event';
import * as Envelope from '../envelope.js';
import { descriptor } from '../registry.js';
import { ProtocolError, guard } from '../errors.js';
import { rpcTransport } from './rpc.js';

export const eventBusTransport = {
  descriptor: descriptor('event-bus'),

  /** Publish to every window. Fire-and-forget: resolves when the host fanned out. */
  async publish({ pluginId, topic, payload = null }) {
    return rpcTransport.request({
      pluginId,
      svc: 'bus',
      act: 'publish',
      params: { topic, payload },
    });
  },

  /**
   * Subscribe. `topic` may be a string (exact) or a RegExp. Returns
   * `{ unsubscribe }`; the host bus never delivers to a window that is gone,
   * so no cleanup beyond unsubscribe is needed.
   */
  async subscribe({ topic, onEvent }) {
    const matches =
      topic instanceof RegExp
        ? (t) => topic.test(t)
        : topic == null
          ? () => true
          : (t) => t === topic;

    const unlisten = await listen(Envelope.BROADCAST_EVENT, (event) => {
      const env = event?.payload;
      if (!env || env.kind !== Envelope.Kind.EVT) return;
      if (!matches(env.topic ?? '')) return;
      try {
        Envelope.validate(env);
      } catch (e) {
        throw ProtocolError.protocol(`bad broadcast envelope: ${e?.message ?? e}`);
      }
      onEvent(env);
    });

    return { unsubscribe: () => unlisten() };
  },
};

export { guard };
