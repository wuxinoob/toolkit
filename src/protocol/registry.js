/**
 * Transport registry — the table that makes "many schemes" cheap.
 *
 * A scheme is the COMBINATION of two independent choices:
 *
 *   transport (how bytes move)  x  codec (how a message is framed)
 *   invoke | channel | event | stdio | pty | in-process
 *      x  json-envelope | line-json | raw-binary | object
 *
 * Adding an experiment means adding ONE descriptor (+ one small transport
 * module). Nothing in the host, the SDK or the plugins grows a branch — they
 * all resolve a scheme by id through this table.
 *
 * Capabilities are declared, not inferred, so a feature can state what it
 * needs and be told at SETUP time that a scheme cannot provide it.
 */

import { CodecId } from './codec.js';
import { ProtocolError } from './errors.js';

export const TransportKind = Object.freeze({
  INVOKE: 'invoke',
  CHANNEL: 'channel',
  EVENT: 'event',
  STDIO: 'stdio',
  PTY: 'pty',
  IN_PROCESS: 'in-process',
  /**
   * Batched `invoke`. Not a new carrier — it is how the UPLINK stream is moved,
   * because Tauri's `Channel` is one-directional (JS has no `send`), so the
   * framework offers no push carrier from plugin to host.
   */
  INVOKE_BATCH: 'invoke-batch',
});

export const Capability = Object.freeze({
  REQUEST_RESPONSE: 'requestResponse',
  PUSH: 'push',
  PULL: 'pull',
  BINARY: 'binary',
  ORDERED: 'ordered',
  CROSS_WINDOW: 'crossWindow',
  /** The plugin pushes TO the host (every other scheme pushes the other way). */
  UPLINK: 'uplink',
});

// NOTE: there is deliberately no `backpressure` capability. The channel codecs
// give ordered delivery, but nothing lets a consumer throttle a producer, so
// claiming it would be a declaration a caller cannot rely on — which is exactly
// what the capability table exists to prevent.

const NONE = Object.freeze({});

/**
 * Every scheme the host knows. `capabilities` is the contract; `note` is for
 * the diagnostics table (Settings → Message plane).
 */
export const DESCRIPTORS = Object.freeze([
  {
    id: 'rpc',
    label: 'invoke · json-envelope',
    transport: TransportKind.INVOKE,
    codec: CodecId.JSON_ENVELOPE,
    direction: 'up',
    capabilities: { [Capability.REQUEST_RESPONSE]: true, [Capability.ORDERED]: true },
    note: '控制面：网关单命令，req/res 一一对应',
  },
  {
    id: 'channel-json',
    label: 'channel · json-envelope',
    transport: TransportKind.CHANNEL,
    codec: CodecId.JSON_ENVELOPE,
    direction: 'down',
    capabilities: {
      [Capability.PUSH]: true,
      [Capability.ORDERED]: true,
      [Capability.CROSS_WINDOW]: true,
    },
    note: '结构化流：宿主主动推送 data/end/exit',
  },
  {
    id: 'channel-in',
    label: 'invoke (batched) · json-envelope',
    transport: TransportKind.INVOKE_BATCH,
    codec: CodecId.JSON_ENVELOPE,
    direction: 'up',
    capabilities: { [Capability.UPLINK]: true, [Capability.ORDERED]: true },
    note: '上行流：插件按批把帧推给宿主侧 sink；Tauri 的 Channel 单向，故用批量 invoke 承载',
  },
  {
    id: 'channel-raw',
    label: 'channel · raw-binary',
    transport: TransportKind.CHANNEL,
    codec: CodecId.RAW_BINARY,
    direction: 'down',
    capabilities: {
      [Capability.PUSH]: true,
      [Capability.BINARY]: true,
      [Capability.ORDERED]: true,
      [Capability.CROSS_WINDOW]: true,
    },
    note: '二进制流：1 字节 kind + payload，零 JSON 解析',
  },
  {
    id: 'event-bus',
    label: 'event · json-envelope',
    transport: TransportKind.EVENT,
    codec: CodecId.JSON_ENVELOPE,
    direction: 'down',
    capabilities: { [Capability.PUSH]: true, [Capability.CROSS_WINDOW]: true },
    note: '广播：一次发布，所有窗口的订阅者都收到（替代轮询）',
  },
  {
    id: 'stdio-line',
    label: 'stdio · line-json',
    transport: TransportKind.STDIO,
    codec: CodecId.LINE_JSON,
    direction: 'both',
    capabilities: {
      [Capability.REQUEST_RESPONSE]: true,
      [Capability.PUSH]: true,
      [Capability.PULL]: true,
      [Capability.ORDERED]: true,
    },
    note: 'sidecar 数据面：插件自带原生后端，行 JSON 双向',
  },
  {
    id: 'pty-stream',
    label: 'pty · raw-binary',
    transport: TransportKind.PTY,
    codec: CodecId.RAW_BINARY,
    direction: 'both',
    capabilities: {
      [Capability.PUSH]: true,
      [Capability.BINARY]: true,
      [Capability.ORDERED]: true,
      [Capability.REQUEST_RESPONSE]: true,
    },
    note: '命令行子进程：伪终端字节流，保留控制序列',
  },
  {
    id: 'in-process',
    label: 'in-process · object',
    transport: TransportKind.IN_PROCESS,
    codec: CodecId.OBJECT,
    direction: 'down',
    capabilities: { [Capability.PUSH]: true },
    note: '同窗口零 IPC：值按引用传递，只用于本窗口事件',
  },
]);

const BY_ID = new Map(DESCRIPTORS.map((d) => [d.id, d]));

export function descriptors() {
  return DESCRIPTORS;
}

export function descriptor(id) {
  const d = BY_ID.get(id);
  if (!d) {
    throw ProtocolError.protocol(
      `unknown transport \`${id}\` (known: ${DESCRIPTORS.map((d) => d.id).join(', ')})`,
    );
  }
  return d;
}

/**
 * Setup-time capability negotiation. Asking a scheme for something it did not
 * declare fails immediately with a precise message, instead of misbehaving
 * later on the wire.
 */
export function assertSupports(id, ...needed) {
  const d = descriptor(id);
  const caps = d.capabilities ?? NONE;
  const missing = needed.filter((c) => !caps[c]);
  if (missing.length) {
    throw ProtocolError.protocol(
      `transport \`${id}\` cannot ${missing.join(' + ')} (declared: ${
        Object.keys(caps).join(', ') || 'none'
      })`,
    );
  }
  return d;
}

/** Rows for the diagnostics table in Settings. */
export function describeSchemes() {
  return DESCRIPTORS.map((d) => ({
    id: d.id,
    label: d.label,
    transport: d.transport,
    codec: d.codec,
    direction: d.direction,
    capabilities: Object.keys(d.capabilities ?? {}).join(', '),
    note: d.note,
  }));
}
