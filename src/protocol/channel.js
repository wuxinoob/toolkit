/**
 * The `Channel` receiver this app owns, instead of `@tauri-apps/api`'s.
 *
 * ## The problem it fixes
 *
 * A Tauri `Channel` numbers every frame and the JS side delivers them **in
 * order**: `core.js` keeps `nextMessageIndex` and a sparse `pendingMessages`
 * array, and only advances when the expected index arrives. The host, for its
 * part, can lose a frame and never say so:
 *
 *   - the fetch path ends in `.catch(console.error)` (`tauri/src/ipc/channel.rs`)
 *     — one dropped fetch, one hole, no error anywhere;
 *   - `insert_if` returns `None` when the webview is gone and the frame is
 *     simply skipped;
 *   - and a full window message queue (`ERROR_NOT_ENOUGH_QUOTA`) makes the
 *     `eval` that delivers the frame fail outright.
 *
 * One lost frame is therefore **permanent**: `nextMessageIndex` stops one short
 * of the hole, every later frame is buffered forever, `onEnd` never fires, and
 * `pendingMessages` grows without limit. The stream looks open and delivers
 * nothing — that is exactly how a plugin panel went blank while the app kept
 * running, and how one renderer reached 832 MB.
 *
 * ## What this does instead
 *
 * Same wire contract (the id from `transformCallback`, serialised as
 * `__CHANNEL__:<id>`), same ordering guarantee, but the reorder buffer is
 * **bounded** — frames, bytes, and time. When a hole cannot be filled within
 * those bounds the channel reports it once through `onGap` and stops, so the
 * stream ends with a `transport` error the caller can see and act on. A stream
 * that ended is recoverable; a stream that is silently buffering is not.
 *
 * Bounds are deliberately small: a gap that is not filled within a couple of
 * frames is not a reordering, it is a loss.
 */

/** The prefix `tauri::ipc::JavaScriptChannelId` accepts (see its Deserialize). */
const PREFIX = '__CHANNEL__:';

/**
 * The method name the IPC serialiser looks for (`process-ipc-message-fn.js`).
 *
 * Not a `Symbol`: the serialiser does `'__TAURI_TO_IPC_KEY__' in val`, so a
 * `toJSON` alone would be ignored and the whole object would be sent instead of
 * the id string.
 */
const SERIALIZE_TO_IPC = '__TAURI_TO_IPC_KEY__';

const LIMITS = {
  /** Frames held while waiting for a hole. Reordering is 1–2 frames in practice. */
  maxFrames: 256,
  /** Bytes held while waiting (raw frames only; JSON frames count as 0 bytes). */
  maxBytes: 2 << 20,
  /** How long a hole may stay open before the stream is declared broken. */
  gapMs: 2_000,
};

/** Payload size, for the byte budget. Objects have no cheap size → 0. */
function sizeOf(message) {
  if (message == null) return 0;
  if (typeof message === 'string') return message.length;
  if (typeof message.byteLength === 'number') return message.byteLength;
  return 0;
}

export class Channel {
  /**
   * @param {(message: any) => void} [onmessage]  Per-frame handler (the
   *   transports assign `.onmessage` afterwards; both forms work).
   * @param {{ onGap?: (reason: string) => void, maxFrames?: number,
   *           maxBytes?: number, gapMs?: number }} [opts]
   */
  constructor(onmessage, opts = {}) {
    this._message = typeof onmessage === 'function' ? onmessage : null;
    this._onGap = typeof opts.onGap === 'function' ? opts.onGap : null;
    this._maxFrames = opts.maxFrames ?? LIMITS.maxFrames;
    this._maxBytes = opts.maxBytes ?? LIMITS.maxBytes;
    this._gapMs = opts.gapMs ?? LIMITS.gapMs;

    this._next = 0;
    /** index -> message, for frames that arrived before their turn. */
    this._pending = new Map();
    this._pendingBytes = 0;
    this._gapTimer = null;
    this._endAt = null;
    this._dead = false;

    const internals = globalThis.window?.__TAURI_INTERNALS__;
    if (!internals?.transformCallback) {
      throw new Error('Channel needs the Tauri IPC bridge (window.__TAURI_INTERNALS__.transformCallback)');
    }
    this._internals = internals;
    this.id = internals.transformCallback((raw) => this._receive(raw));
  }

  get onmessage() {
    return this._message;
  }

  set onmessage(fn) {
    this._message = typeof fn === 'function' ? fn : null;
  }

  /** How the id reaches Rust: `invoke`'s serialiser calls this method. */
  [SERIALIZE_TO_IPC]() {
    return `${PREFIX}${this.id}`;
  }

  toJSON() {
    return `${PREFIX}${this.id}`;
  }

  toString() {
    return `${PREFIX}${this.id}`;
  }

  /** Stop receiving and release the callback. Idempotent. */
  close() {
    this._dead = true;
    this._pending.clear();
    this._pendingBytes = 0;
    this._clearGapTimer();
    this._release();
  }

  // ------------------------------- internals --------------------------------

  _deliver(message) {
    try {
      this._message?.(message);
    } catch (e) {
      // A consumer that throws must not take the channel down with it: the
      // frame is gone either way, and the rest of the stream is still valid.
      console.error('[channel] onmessage threw:', e);
    }
  }

  _receive(raw) {
    if (this._dead) return;
    if (!raw || typeof raw !== 'object') return;

    if (raw.end === true) {
      const at = raw.index;
      if (typeof at !== 'number' || at <= this._next) {
        this._finishQuietly();
      } else {
        // The host closed while frames are still in flight; release when the
        // last one arrives rather than leaking the callback.
        this._endAt = at;
      }
      return;
    }

    const { index, message } = raw;
    if (typeof index !== 'number') {
      // No ordering information: deliver it rather than buffer under
      // `undefined`, which would stall the channel on its first frame.
      this._deliver(message);
      return;
    }

    if (index < this._next) return; // duplicate or already-delivered: drop

    if (index === this._next) {
      this._deliver(message);
      this._next += 1;
      this._drain();
      this._checkEnd();
      return;
    }

    this._pending.set(index, message);
    this._pendingBytes += sizeOf(message);

    if (this._pending.size > this._maxFrames || this._pendingBytes > this._maxBytes) {
      this._fail(
        `reorder buffer overflow: ${this._pending.size} frame(s) / ` +
          `${this._pendingBytes} bytes waiting for index ${this._next}`,
      );
      return;
    }
    if (!this._gapTimer) {
      this._gapTimer = setTimeout(() => {
        this._gapTimer = null;
        this._fail(
          `frame ${this._next} never arrived (${this._gapMs}ms, ` +
            `${this._pending.size} frame(s) waiting)`,
        );
      }, this._gapMs);
    }
  }

  /** Deliver everything that is now in order. */
  _drain() {
    while (this._pending.has(this._next)) {
      const message = this._pending.get(this._next);
      this._pending.delete(this._next);
      this._pendingBytes -= sizeOf(message);
      this._deliver(message);
      this._next += 1;
    }
    if (this._pending.size === 0) this._clearGapTimer();
    this._checkEnd();
  }

  _checkEnd() {
    if (this._endAt !== null && this._next >= this._endAt) this._finishQuietly();
  }

  /** The host is done: stop listening, but do not report a failure. */
  _finishQuietly() {
    this._dead = true;
    this._pending.clear();
    this._pendingBytes = 0;
    this._clearGapTimer();
    this._release();
  }

  /**
   * The stream is broken. Reported once; after that the channel is inert, so a
   * later frame cannot re-open a stream the caller already closed.
   */
  _fail(reason) {
    if (this._dead) return;
    this._finishQuietly();
    if (this._onGap) {
      try {
        this._onGap(reason);
      } catch {
        /* an observer must not become a participant */
      }
    } else {
      // No handler: say it out loud rather than leaving a silent dead stream.
      console.warn(`[channel] ${reason}`);
    }
  }

  _clearGapTimer() {
    if (this._gapTimer) {
      clearTimeout(this._gapTimer);
      this._gapTimer = null;
    }
  }

  _release() {
    try {
      this._internals.unregisterCallback(this.id);
    } catch {
      /* already gone (window closing) */
    }
  }
}

export const CHANNEL_PREFIX = PREFIX;
export const SERIALIZE_TO_IPC_KEY = SERIALIZE_TO_IPC;
