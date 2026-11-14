/**
 * `rpc-raw` transport — a one-shot binary read.
 *
 * Carrier: Tauri `invoke`. Codec: raw-binary, but only in ONE direction: the
 * request is an ordinary `req` envelope (JSON — `svc`/`act`/`params` are small),
 * and the reply is the bytes themselves, delivered as an `ArrayBuffer`.
 *
 * ## Why this is not a stream
 *
 * A capture, a clipboard bitmap, a file's contents — these are "one question,
 * one answer". Expressing them as a `channel-raw` stream would mean open, emit
 * one frame, end: a stream that exists only to be finished. The stream shape is
 * for producers that keep talking; the request/response shape is for the rest,
 * and the two differ only in the reply's codec, not in the call site.
 *
 * ## Failures arrive as rejections
 *
 * The response channel carries bytes, so there is no room for an `err` envelope
 * (that is the one asymmetry with `rpc`, and it is stated in `docs/PROTOCOL.md`).
 * The host rejects with `{ code, msg }`, which is turned into the same
 * `ProtocolError` every other scheme produces — the caller branches on `code`
 * and never learns which gateway answered.
 *
 * ## Timeouts
 *
 * Same policy as `rpc`, for the same reason: the host is synchronous, so the
 * caller can only stop waiting. A big capture is slower than a control call, so
 * the ceiling is per-call (`opts.timeoutMs`) rather than a new global default.
 */

import { invoke } from '@tauri-apps/api/core';
import * as Envelope from '../envelope.js';
import { toBytes } from '../codec.js';
import { descriptor } from '../registry.js';
import { ProtocolError } from '../errors.js';
import { DEFAULT_TIMEOUT_MS, withTimeout } from './rpc.js';

export async function invokeBinary(command, args, { what = command, timeoutMs = DEFAULT_TIMEOUT_MS, headers } = {}) {
  try {
    return await withTimeout(invoke(command, args, headers ? { headers } : undefined), timeoutMs, what);
  } catch (e) {
    if (e instanceof ProtocolError) throw e;
    if (e && typeof e === 'object' && typeof e.code === 'string') {
      throw new ProtocolError(e.code, e.msg ?? e.code);
    }
    throw ProtocolError.transport(`${what} failed: ${e?.message ?? e}`, e);
  }
}

export function writeChunk(command, pluginId, id, offset, bytes) {
  return invokeBinary(command, bytes, {
    timeoutMs: 0,
    headers: { 'x-toolkit-plugin': pluginId, 'x-toolkit-transfer': id, 'x-toolkit-offset': String(offset) },
  });
}

const MAX_FALLBACK_REPLY_BYTES = 8 * 1024 * 1024;

export function binaryReply(raw, what, maxBytes = Infinity) {
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
    if (raw.byteLength <= maxBytes) return toBytes(raw);
  } else if (Array.isArray(raw) && raw.length <= Math.min(maxBytes, MAX_FALLBACK_REPLY_BYTES)) {
    // Tauri may deliver a raw response via a number array on postMessage.
    // Check each element before Uint8Array can silently coerce it.
    for (const value of raw) {
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw ProtocolError.protocol(`${what}: invalid byte in IPC fallback array`);
      }
    }
    return Uint8Array.from(raw);
  }
  throw ProtocolError.protocol(`${what}: expected binary from the raw gateway within the reply limit`);
}

export const rpcRawTransport = {
  descriptor: descriptor('rpc-raw'),

  /**
   * One request/response round trip whose reply is bytes.
   * Resolves with a `Uint8Array` (a view over the received `ArrayBuffer`).
   */
  async request({ pluginId, svc, act, params = null, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const env = Envelope.req(Envelope.nextId(), svc, act, params);
    const what = `${svc}/${act}`;
    const raw = await invokeBinary('plugin_rpc_raw', { pluginId, msg: env }, { timeoutMs, what });
    return binaryReply(raw, what);
  },
};
