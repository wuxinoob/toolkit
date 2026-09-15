/**
 * `rpc` transport — the uplink control plane.
 *
 * Carrier: Tauri `invoke`. Codec: json-envelope. Every plugin→host call in
 * the app funnels through here, so there is exactly one place that knows the
 * gateway command name, the correlation id counter, the timeout policy and the
 * res/err unwrapping.
 *
 * Timeouts are enforced HERE, not in the envelope: the gateway is synchronous,
 * so the host cannot be told to abandon a call, and a `deadline` field would
 * imply a guarantee the host cannot make. What this buys is that a wedged
 * service cannot hang a caller forever.
 */

import { invoke } from '@tauri-apps/api/core';
import * as Envelope from '../envelope.js';
import { descriptor } from '../registry.js';
import { ProtocolError, guard } from '../errors.js';

/**
 * Default ceiling on a control call. Generous on purpose: the slowest
 * legitimate calls are `proc/recv` (the host caps it at 30s) and `proc/kill_all`
 * on a full process table. Pass `timeoutMs: 0` to wait indefinitely.
 */
export const DEFAULT_TIMEOUT_MS = 45_000;

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

export const rpcTransport = {
  descriptor: descriptor('rpc'),

  /**
   * One request/response round trip.
   * Resolves with the `res` payload; rejects with a ProtocolError built from
   * an `err` envelope. A protocol-level rejection from Rust (malformed
   * envelope, unknown service or action) surfaces as code `transport`.
   */
  async request({ pluginId, svc, act, params = null, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const env = Envelope.req(Envelope.nextId(), svc, act, params);
    const what = `${svc}/${act}`;
    const reply = await withTimeout(
      guard(invoke('plugin_rpc', { pluginId, msg: env }), what),
      timeoutMs,
      what,
    );
    if (!reply || typeof reply !== 'object') {
      throw ProtocolError.protocol(`${what}: host returned a non-envelope reply`);
    }
    if (reply.kind === Envelope.Kind.ERR) throw ProtocolError.fromEnvelope(reply);
    if (reply.kind !== Envelope.Kind.RES) {
      throw ProtocolError.protocol(`${what}: expected a \`res\`, got \`${reply.kind}\``);
    }
    return reply.p ?? null;
  },
};
