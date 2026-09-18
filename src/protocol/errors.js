/**
 * One error type for every wire.
 *
 * Whether a failure arrives as an `err` envelope (control call), a mid-stream
 * `err` frame, or a raw-binary error frame, the caller sees a `ProtocolError`
 * with a machine-readable `code`. That is what keeps error handling uniform
 * across transports instead of every call site inventing its own shape.
 */
import { Code } from './codes.js';

export class ProtocolError extends Error {
  constructor(code, message, envelope = null) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code || 'error';
    this.envelope = envelope;
  }

  /** Build from a host `err` envelope. */
  static fromEnvelope(env) {
    return new ProtocolError(env?.code || 'error', env?.msg || 'host reported an error', env);
  }

  /** A transport-level break (IPC rejected, channel closed, codec mismatch). */
  static transport(message, cause) {
    const e = new ProtocolError(Code.TRANSPORT, message);
    e.cause = cause;
    return e;
  }

  /** A protocol-level break (malformed envelope, unknown kind). */
  static protocol(message) {
    return new ProtocolError(Code.PROTOCOL, message);
  }

  /**
   * The caller stopped waiting.
   *
   * Deliberately worded to avoid the impression that this cancelled anything:
   * the request is already with the host and a synchronous service cannot be
   * interrupted, so the work may still complete and its reply is discarded.
   */
  static timeout(what, ms) {
    return new ProtocolError(
      Code.TIMEOUT,
      `${what} did not answer within ${ms}ms — the caller stopped waiting; ` +
        'the host may still be working (synchronous services cannot be cancelled)',
    );
  }
}

/** Wrap a Tauri `invoke` rejection in the unified error type. */
export async function guard(promise, what) {
  try {
    return await promise;
  } catch (e) {
    if (e instanceof ProtocolError) throw e;
    throw ProtocolError.transport(`${what} failed: ${e?.message ?? e}`, e);
  }
}
