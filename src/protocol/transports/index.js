/**
 * The transport table — one entry per scheme, keyed by descriptor id.
 *
 * This is the ONLY place a scheme id is bound to an implementation. Everything
 * above it (hub, ctx, plugins) resolves by id, so swapping an experiment in or
 * out is a one-line change here and nothing else moves.
 */

import { descriptors } from '../registry.js';
import { ProtocolError } from '../errors.js';
import { rpcTransport } from './rpc.js';
import { channelJsonTransport } from './channelJson.js';
import { channelRawTransport } from './channelRaw.js';
import { eventBusTransport } from './eventBus.js';
import { stdioLineTransport } from './stdioLine.js';
import { ptyStreamTransport } from './pty.js';
import { inProcessTransport } from './inProcess.js';

const IMPLS = [
  rpcTransport,
  channelJsonTransport,
  channelRawTransport,
  eventBusTransport,
  stdioLineTransport,
  ptyStreamTransport,
  inProcessTransport,
];

const TABLE = new Map(IMPLS.map((t) => [t.descriptor.id, t]));

/** Every scheme must have an implementation — a missing one is a build bug. */
function assertComplete() {
  const missing = descriptors()
    .map((d) => d.id)
    .filter((id) => !TABLE.has(id));
  if (missing.length) {
    throw ProtocolError.protocol(`transport(s) declared but not implemented: ${missing.join(', ')}`);
  }
}

export function transportTable() {
  return TABLE;
}

export function transport(id) {
  const t = TABLE.get(id);
  if (!t) {
    throw ProtocolError.protocol(
      `no implementation for transport \`${id}\` (have: ${[...TABLE.keys()].join(', ')})`,
    );
  }
  return t;
}

export function transportIds() {
  return [...TABLE.keys()];
}

assertComplete();

export {
  rpcTransport,
  channelJsonTransport,
  channelRawTransport,
  eventBusTransport,
  stdioLineTransport,
  ptyStreamTransport,
  inProcessTransport,
};
