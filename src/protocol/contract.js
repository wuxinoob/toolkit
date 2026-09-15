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

export function protocolContract() {
  return Object.freeze({
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
    nextId: Envelope.nextId,
  });
}
