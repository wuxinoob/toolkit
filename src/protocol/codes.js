/**
 * The closed set of error codes — the JS mirror of `src-tauri/src/protocol/codes.rs`.
 *
 * An `err` envelope carries one of these, so a caller can branch on `code`
 * instead of pattern-matching messages. Before this existed the host used
 * `{svc}/{act}` for service failures (e.g. `storage/get`), which told a caller
 * nothing about the KIND of failure, and everything else was an unclassified
 * string — which is how the pty transport ended up matching a dependency's
 * wording (`"EOF"`, `"Unavailable pid"`).
 *
 * `tests/codes.test.mjs` parses both files and fails if the two lists drift, so
 * this is a mirror rather than a second source of truth.
 *
 * A plugin's OWN backend may define its own codes on top of these (the calc
 * example answers `div_by_zero`); this set is the HOST's vocabulary.
 */

export const Code = Object.freeze({
  /** The caller lacks a permission its manifest declares it needs. */
  DENIED: 'denied',

  /** No service by that name. */
  UNKNOWN_SERVICE: 'unknown_service',
  /** The service exists but has no such action. */
  UNKNOWN_ACTION: 'unknown_action',
  /** A required parameter is missing or malformed. */
  BAD_PARAMS: 'bad_params',
  /** The addressed thing does not exist (key, window, session, process). */
  NOT_FOUND: 'not_found',
  /** The request contradicts current state (duplicate id, already open). */
  CONFLICT: 'conflict',

  /** The scheme, provider or codec cannot do what was asked. */
  UNSUPPORTED: 'unsupported',

  /** A filesystem or OS operation failed. */
  IO: 'io',
  /** A child process could not be started. */
  SPAWN_FAILED: 'spawn_failed',
  /** The caller stopped waiting. Never means the host was cancelled. */
  TIMEOUT: 'timeout',

  /** The IPC layer itself failed. */
  TRANSPORT: 'transport',
  /** A malformed envelope, or a violation of the contract. */
  PROTOCOL: 'protocol',
  /** A frame could not be decoded. */
  CODEC: 'codec',

  /** An unexpected host-side failure. */
  INTERNAL: 'internal',
});

/** Every code, in the same order as the Rust `ALL`. */
export const ALL_CODES = Object.freeze(Object.values(Code));

export const isKnownCode = (code) => ALL_CODES.includes(code);
