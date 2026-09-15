/**
 * Window-local event bus — the `in-process` scheme's implementation.
 *
 * A `Map` in this JS context: synchronous delivery, no IPC, no serialization.
 * Scope is ONE window, which is exactly its declared capability — anything
 * that must cross a window boundary goes through `hub.publish` (event-bus
 * scheme) instead.
 *
 * The protocol layer imports this module rather than keeping a second copy,
 * so the scheme table and `ctx.events` are provably the same mechanism.
 */

const listeners = new Map(); // topic -> Set<fn>

export const events = {
  on(topic, fn) {
    if (!listeners.has(topic)) listeners.set(topic, new Set());
    listeners.get(topic).add(fn);
    return () => events.off(topic, fn);
  },

  once(topic, fn) {
    const off = events.on(topic, (payload) => {
      off();
      fn(payload);
    });
    return off;
  },

  off(topic, fn) {
    listeners.get(topic)?.delete(fn);
  },

  emit(topic, payload) {
    const set = listeners.get(topic);
    if (!set) return 0;
    let delivered = 0;
    for (const fn of [...set]) {
      try {
        fn(payload);
        delivered += 1;
      } catch (e) {
        console.error(`[bus] listener error for "${topic}"`, e);
      }
    }
    return delivered;
  },

  /** Diagnostics: how many listeners a topic currently has. */
  count(topic) {
    return listeners.get(topic)?.size ?? 0;
  },
};

/** Test seam. */
export function resetEvents() {
  listeners.clear();
}
