/**
 * The unified message envelope — the JS mirror of `protocol::envelope`.
 *
 * One shape for every direction:
 *   uplink    req                ->  res | err
 *   downlink  evt (broadcast)    ->  (fire and forget)
 *             data | end | exit | err   (stream frames)
 *
 * Fields are omitted rather than set to null, so the wire form matches what
 * Rust produces and a round-trip is byte-stable.
 */

export const PROTOCOL_VERSION = 1;

/** Event name every broadcast is delivered under (matches `BROADCAST_EVENT`). */
export const BROADCAST_EVENT = 'ump://evt';

export const Kind = Object.freeze({
  REQ: 'req',
  RES: 'res',
  ERR: 'err',
  EVT: 'evt',
  DATA: 'data',
  END: 'end',
  EXIT: 'exit',
});

const TERMINAL = new Set([Kind.END, Kind.EXIT, Kind.ERR]);

/** After a terminal frame the stream is deregistered. */
export const isTerminal = (kind) => TERMINAL.has(kind);

/** Initiated by the plugin side. */
export const isUplink = (kind) => kind === Kind.REQ;

/** Pushed by the host side. */
export const isDownlink = (kind) =>
  kind === Kind.EVT || kind === Kind.DATA || kind === Kind.END || kind === Kind.EXIT;

let seq = 0;
/** Monotonic correlation id for req/res. */
export function nextId() {
  seq += 1;
  return seq;
}

function base(kind) {
  return { v: PROTOCOL_VERSION, kind };
}

function withPayload(env, p) {
  if (p !== null && p !== undefined) env.p = p;
  return env;
}

export function req(id, svc, act, p = null) {
  const e = base(Kind.REQ);
  e.id = id;
  e.svc = svc;
  e.act = act;
  return withPayload(e, p);
}

export function res(id, p = null) {
  const e = base(Kind.RES);
  e.id = id;
  return withPayload(e, p);
}

export function err(id, code, msg) {
  const e = base(Kind.ERR);
  if (id !== null && id !== undefined) e.id = id;
  e.code = code;
  e.msg = msg;
  return e;
}

export function evt(topic, p = null) {
  const e = base(Kind.EVT);
  e.topic = topic;
  return withPayload(e, p);
}

export function data(ch, p = null) {
  const e = base(Kind.DATA);
  e.ch = ch;
  return withPayload(e, p);
}

export function end(ch) {
  const e = base(Kind.END);
  e.ch = ch;
  return e;
}

export function exit(ch, code) {
  const e = base(Kind.EXIT);
  e.ch = ch;
  e.p = code;
  return e;
}

/** Mid-stream failure: carries `ch` instead of `id`. */
export function streamErr(ch, code, msg) {
  const e = base(Kind.ERR);
  e.ch = ch;
  e.code = code;
  e.msg = msg;
  return e;
}

const empty = (v) => typeof v !== 'string' || v.length === 0;

/**
 * The one place the "which fields does which kind need" rules live — the JS
 * mirror of `Envelope::validate`. Used by the transports and the conformance
 * suite so both sides reject the same malformed shapes.
 */
export function validate(env) {
  if (!env || typeof env !== 'object') throw new Error('envelope must be an object');
  if (env.v !== PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version ${env.v} (expected ${PROTOCOL_VERSION})`);
  }
  switch (env.kind) {
    case Kind.REQ:
      if (env.id === undefined || env.id === null) throw new Error('req envelope requires `id`');
      if (empty(env.svc)) throw new Error('req envelope requires `svc`');
      if (empty(env.act)) throw new Error('req envelope requires `act`');
      break;
    case Kind.RES:
    case Kind.ERR:
      if ((env.id === undefined || env.id === null) && empty(env.ch)) {
        throw new Error(`${env.kind} envelope requires \`id\` or \`ch\``);
      }
      break;
    case Kind.DATA:
    case Kind.END:
    case Kind.EXIT:
      if (empty(env.ch)) throw new Error(`${env.kind} envelope requires \`ch\``);
      break;
    case Kind.EVT:
      if (empty(env.topic)) throw new Error('evt envelope requires `topic`');
      break;
    default:
      throw new Error(`unknown envelope kind \`${env.kind}\``);
  }
  return env;
}

/** Short label for logs and diagnostics. */
export function describe(env) {
  if (!env) return 'envelope(null)';
  const bits = [env.kind];
  if (env.id !== undefined) bits.push(`id=${env.id}`);
  if (env.ch) bits.push(`ch=${env.ch}`);
  if (env.svc) bits.push(`${env.svc}/${env.act}`);
  if (env.topic) bits.push(`topic=${env.topic}`);
  return bits.join(' ');
}
