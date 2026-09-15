/**
 * Codecs: how an envelope is framed on a given wire — the JS mirror of
 * `protocol::codec`.
 *
 * Codecs are pure and transport-agnostic: they never open a socket and never
 * know which service is on the other end. That is what lets one producer feed
 * several wire formats without the producer changing.
 *
 *   json-envelope  one JSON object per message      invoke gateway, Channel<Envelope>
 *   line-json      one JSON object per \n line      sidecar stdio pipes
 *   raw-binary     1 kind byte + payload            Channel<InvokeResponseBody>, PTY bytes
 */

import { Kind, validate } from './envelope.js';

export const CodecId = Object.freeze({
  JSON_ENVELOPE: 'json-envelope',
  LINE_JSON: 'line-json',
  RAW_BINARY: 'raw-binary',
  OBJECT: 'object',
});

/** One JSON object per message. */
export const jsonEnvelope = {
  id: CodecId.JSON_ENVELOPE,
  binary: false,
  encode(env) {
    return JSON.stringify(env);
  },
  decode(text) {
    const env = typeof text === 'string' ? JSON.parse(text) : text;
    return validate(env);
  },
};

/** Newline-delimited JSON — the sidecar pipe format. */
export const lineJson = {
  id: CodecId.LINE_JSON,
  binary: false,
  encode(env) {
    return `${JSON.stringify(env)}\n`;
  },
  decode(line) {
    if (typeof line !== 'string') return validate(line);
    return validate(JSON.parse(line.replace(/[\r\n]+$/, '')));
  },
};

/** 1-byte kind prefix + raw payload. */
export const rawBinary = {
  id: CodecId.RAW_BINARY,
  binary: true,
};

const KIND_BYTE = { [Kind.DATA]: 0x01, [Kind.END]: 0x02, [Kind.EXIT]: 0x03, [Kind.ERR]: 0x04 };
const BYTE_KIND = { 0x01: Kind.DATA, 0x02: Kind.END, 0x03: Kind.EXIT, 0x04: Kind.ERR };

export function kindByte(kind) {
  const b = KIND_BYTE[kind];
  if (b === undefined) throw new Error(`kind \`${kind}\` cannot travel raw`);
  return b;
}

export function byteKind(byte) {
  return BYTE_KIND[byte];
}

/** Encode one raw frame. */
export function encodeRaw(kind, payload = new Uint8Array(0)) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload ?? 0);
  const out = new Uint8Array(bytes.length + 1);
  out[0] = kindByte(kind);
  out.set(bytes, 1);
  return out;
}

/** Split one raw frame; null on empty input or an unknown kind byte. */
export function decodeRaw(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf ?? 0);
  if (bytes.length < 1) return null;
  const kind = byteKind(bytes[0]);
  if (!kind) return null;
  return { kind, payload: bytes.subarray(1) };
}

const i64View = new DataView(new ArrayBuffer(8));

/** Project a JSON payload down to raw bytes — the mirror of `payload_bytes`. */
export function payloadBytes(p) {
  if (p === null || p === undefined) return new Uint8Array(0);
  if (typeof p === 'string') return new TextEncoder().encode(p);
  if (typeof p === 'number') {
    i64View.setBigInt64(0, BigInt(Math.trunc(p)), true);
    return new Uint8Array(i64View.buffer.slice(0));
  }
  if (typeof p === 'boolean') return new Uint8Array([p ? 1 : 0]);
  if (p instanceof Uint8Array) return p;
  return new TextEncoder().encode(JSON.stringify(p));
}

export function bytesToText(payload) {
  return new TextDecoder().decode(payload ?? new Uint8Array(0));
}

export function encodeCode(code) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, code | 0, true);
  return out;
}

export function decodeCode(payload) {
  if (!payload || payload.length < 4) return null;
  return new DataView(payload.buffer, payload.byteOffset, 4).getInt32(0, true);
}

/**
 * Decode one raw frame into an envelope, so a raw consumer sees exactly the
 * same object shape as a JSON consumer. `code`/`msg` ride as `code|msg` on the
 * error frame (mirrors `Sink::send` on the Rust side).
 */
export function rawToEnvelope(buf, ch) {
  const frame = decodeRaw(buf);
  if (!frame) throw new Error('raw frame: unknown or missing kind byte');
  const { kind, payload } = frame;
  if (kind === Kind.DATA) return { v: 1, kind, ch, p: payload };
  if (kind === Kind.END) return { v: 1, kind, ch };
  if (kind === Kind.EXIT) return { v: 1, kind, ch, p: decodeCode(payload) ?? -1 };
  const [code, ...rest] = bytesToText(payload).split('|');
  return { v: 1, kind: Kind.ERR, ch, code, msg: rest.join('|') };
}

/** The window-local codec: values are passed by reference, nothing is serialized. */
export const object = {
  id: CodecId.OBJECT,
  binary: false,
  encode: (v) => v,
  decode: (v) => v,
};

export const codecs = new Map(
  [jsonEnvelope, lineJson, rawBinary, object].map((c) => [c.id, c]),
);

export function codec(id) {
  const c = codecs.get(id);
  if (!c) throw new Error(`unknown codec \`${id}\` (known: ${[...codecs.keys()].join(', ')})`);
  return c;
}
