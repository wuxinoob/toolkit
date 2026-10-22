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
import { DEFAULT_TIMEOUT_MS } from './rpc.js';

function withTimeout(promise, ms, what) {
  if (!ms || ms <= 0) return promise;
  let timer = null;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(ProtocolError.timeout(what, ms)), ms);
    }),
  ]);
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
    let raw;
    try {
      raw = await withTimeout(
        invoke('plugin_rpc_raw', { pluginId, msg: env }),
        timeoutMs,
        what,
      );
    } catch (e) {
      if (e instanceof ProtocolError) throw e;
      // A host rejection carries the same `{code, msg}` pair an `err` envelope
      // would, so the caller sees one error type regardless of the gateway.
      if (e && typeof e === 'object' && typeof e.code === 'string') {
        throw new ProtocolError(e.code, e.msg ?? e.code);
      }
      throw ProtocolError.transport(`${what} failed: ${e?.message ?? e}`, e);
    }
    if (!(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw)) {
      // A string here means the host answered JSON — which is what a build
      // without `plugin_rpc_raw` would do (an unknown command rejects, but a
      // mis-wired gateway could resolve with an envelope). Say so precisely
      // instead of handing the caller `NaN` bytes.
      throw ProtocolError.protocol(
        `${what}: expected binary from the raw gateway, got ${typeof raw}`,
      );
    }
    return toBytes(raw);
  },
};
