/**
 * Public surface of the message protocol.
 *
 * Import from here, not from the individual modules: this barrel is the
 * contract the host kernel and plugins are written against.
 */

export {
  PROTOCOL_VERSION,
  BROADCAST_EVENT,
  Kind,
  req,
  res,
  err,
  evt,
  data,
  end,
  exit,
  streamErr,
  validate,
  describe,
  isTerminal,
  isUplink,
  isDownlink,
  nextId,
} from './envelope.js';

export {
  CodecId,
  codecs,
  codec,
  jsonEnvelope,
  lineJson,
  rawBinary,
  object as objectCodec,
  encodeRaw,
  decodeRaw,
  kindByte,
  byteKind,
  payloadBytes,
  bytesToText,
  encodeCode,
  decodeCode,
  rawToEnvelope,
} from './codec.js';

export { ProtocolError, guard } from './errors.js';

export {
  TransportKind,
  Capability,
  DESCRIPTORS,
  descriptors,
  descriptor,
  assertSupports,
  describeSchemes,
} from './registry.js';

export { transportTable, transport, transportIds } from './transports/index.js';

export { MessageHub, hub } from './hub.js';
