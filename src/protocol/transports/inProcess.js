/**
 * `in-process` transport — the window-local bus.
 *
 * Carrier: none (a `Map` in this JS context). Codec: object (by reference).
 * This exists so a same-window subscriber pays nothing: no IPC, no
 * serialization, synchronous delivery. It is the cheapest scheme in the table
 * and the one that proves the abstraction is not just "IPC with extra steps".
 *
 * The Map itself lives in `host/events.js` (which `ctx.events` also uses), so
 * this transport and the plugin-facing event API are provably one mechanism.
 *
 * Scope caveat, declared in the descriptor: it is NOT cross-window. Anything
 * that must reach another window uses `event-bus`.
 */

import { descriptor } from '../registry.js';
import { events, resetEvents } from '../../host/events.js';

export const inProcessTransport = {
  descriptor: descriptor('in-process'),

  async publish({ topic, payload = null }) {
    return { topic, delivered: events.emit(topic, payload) };
  },

  async subscribe({ topic, onEvent }) {
    return { unsubscribe: events.on(topic, onEvent) };
  },
};

/** Test seam: drop every window-local listener. */
export function _resetInProcess() {
  resetEvents();
}
