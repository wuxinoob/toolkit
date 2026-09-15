/**
 * `rpc` transport — the uplink control plane.
 *
 * Carrier: Tauri `invoke`. Codec: json-envelope. Every plugin→host call in
 * the app funnels through here, so there is exactly one place that knows the
 * gateway command name, the correlation id counter and the res/err unwrapping.
 */

import { invoke } from '@tauri-apps/api/core';
import * as Envelope from '../envelope.js';
import { descriptor } from '../registry.js';
import { ProtocolError, guard } from '../errors.js';

export const rpcTransport = {
  descriptor: descriptor('rpc'),

  /**
   * One request/response round trip.
   * Resolves with the `res` payload; rejects with a ProtocolError built from
   * an `err` envelope. A protocol-level rejection from Rust (malformed
   * envelope, unknown service) surfaces as code `transport`.
   */
  async request({ pluginId, svc, act, params = null }) {
    const env = Envelope.req(Envelope.nextId(), svc, act, params);
    const reply = await guard(
      invoke('plugin_rpc', { pluginId, msg: env }),
      `${svc}/${act}`,
    );
    if (!reply || typeof reply !== 'object') {
      throw ProtocolError.protocol(`${svc}/${act}: host returned a non-envelope reply`);
    }
    if (reply.kind === Envelope.Kind.ERR) throw ProtocolError.fromEnvelope(reply);
    if (reply.kind !== Envelope.Kind.RES) {
      throw ProtocolError.protocol(`${svc}/${act}: expected a \`res\`, got \`${reply.kind}\``);
    }
    return reply.p ?? null;
  },
};
