/**
 * Host ring-buffer logger with categories.
 * Goals:
 *  - Debuggable: keeps the last N entries in memory, dumpable anytime via
 *    window.__toolbox.logs() — survives console scrolling.
 *  - Observable: subscribers (e.g. a log panel) get entries live.
 *  - Cheap: bounded memory, no IO on the hot path.
 */

const CAPACITY = 800;
const buffer = [];
const subscribers = new Set();
let seq = 0;

function push(category, level, message) {
  const entry = {
    seq: ++seq,
    t: new Date().toISOString().slice(11, 23), // HH:MM:SS.mmm
    category,
    level,
    message: typeof message === 'string' ? message : safeJson(message),
  };
  buffer.push(entry);
  if (buffer.length > CAPACITY) buffer.splice(0, buffer.length - CAPACITY);
  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      /* subscriber errors must never break logging */
    }
  }
  return entry;
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const logger = {
  debug: (category, msg) => push(category, 'debug', msg),
  info: (category, msg) => push(category, 'info', msg),
  warn: (category, msg) => push(category, 'warn', msg),
  error: (category, msg) => push(category, 'error', msg),

  /** Latest entries, newest last. Optional filters. */
  dump({ category, level, limit = 200 } = {}) {
    let out = buffer.filter(
      (e) => (!category || e.category === category) && (!level || e.level === level),
    );
    if (out.length > limit) out = out.slice(out.length - limit);
    return out;
  },

  clear() {
    buffer.length = 0;
  },

  subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  },

  /** One-line text dump for file persistence (selftest results etc). */
  toText(entries) {
    return entries.map((e) => `${e.t} [${e.level}] ${e.category}: ${e.message}`).join('\n');
  },
};
