/**
 * The wire contract, in one place.
 *
 * External plugins are loaded from a Blob URL as a single-file ESM, so they
 * cannot `import` the protocol barrel. The host therefore hands the contract
 * over — as `ctx.protocol` in the main window and `bridge.protocol` in a plugin
 * window. Both call this function, so the two surfaces cannot drift apart.
 *
 * Keep this list small and stable: it is the part of the protocol that plugins
 * are allowed to depend on directly.
 */

import * as Envelope from './envelope.js';
import { Code, ALL_CODES } from './codes.js';

/**
 * Host API version — the shape of `ctx` / `bridge`, NOT the wire format.
 *
 * Two version numbers, because they move independently:
 *   - `Envelope.PROTOCOL_VERSION` — the envelope shape on the wire.
 *   - `HOST_API` — the JavaScript surface a plugin codes against.
 *
 * Bump this whenever a plugin-visible shape changes incompatibly. A plugin
 * declares the version it was built for in its manifest (`"api": 2`), and the
 * host records a mismatch on the plugin row so the boot trace says why a plugin
 * misbehaves instead of leaving a cryptic runtime error.
 *
 * History:
 *   1 — `ctx.events.on` was synchronous, `ctx.bus.subscribe` asynchronous.
 *   2 — every subscribe/publish is async on every scheme (P1-1 unification);
 *       a plugin built for 1 that calls `off()` directly will fail.
 */
export const HOST_API = 2;

export function protocolContract() {
  return Object.freeze({
    api: HOST_API,
    version: Envelope.PROTOCOL_VERSION,
    broadcastEvent: Envelope.BROADCAST_EVENT,
    Kind: Envelope.Kind,
    req: Envelope.req,
    res: Envelope.res,
    err: Envelope.err,
    evt: Envelope.evt,
    data: Envelope.data,
    end: Envelope.end,
    exit: Envelope.exit,
    validate: Envelope.validate,
    isTerminal: Envelope.isTerminal,
    endsStream: Envelope.endsStream,
    /**
     * The error vocabulary, so a plugin writes `protocol.Code.DENIED` rather
     * than the literal `'denied'` — and can see the whole set it may receive.
     */
    Code,
    codes: ALL_CODES,
    nextId: Envelope.nextId,
  });
}
