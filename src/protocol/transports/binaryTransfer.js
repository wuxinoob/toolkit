import { toBytes } from '../codec.js';
import { Code } from '../codes.js';
import { ProtocolError } from '../errors.js';
import { DEFAULT_TIMEOUT_MS, withTimeout } from './rpc.js';
import { binaryReply, invokeBinary, writeChunk } from './rpcRaw.js';

export async function openBinaryTransfer(pluginId, size, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ProtocolError(Code.BAD_PARAMS, 'binary transfer size must be a nonnegative integer');
  }

  const id = crypto.randomUUID();
  const control = (action, wait = timeoutMs) => invokeBinary(
    'plugin_binary_control', { pluginId, id, action }, { timeoutMs: wait, what: `binary/${action.kind}` },
  );
  const release = () => control({ kind: 'close' });
  const opening = control({ kind: 'open', size }, 0);
  let maxChunkBytes;
  try {
    ({ maxChunkBytes } = await withTimeout(opening, timeoutMs, 'binary/open'));
  } catch (error) {
    if (error.code === Code.TIMEOUT) {
      // The native open may still complete after the caller stopped waiting.
      void release().catch(() => {});
      void opening.then(release).catch(() => {});
    }
    throw error;
  }

  let busy = false;
  let closed = false;
  let closing;
  async function run(action, offset, length, send) {
    if (closed) throw new ProtocolError(Code.NOT_FOUND, 'binary transfer is closed');
    if (busy) throw new ProtocolError(Code.CONFLICT, 'await the previous binary chunk before sending another');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > maxChunkBytes) {
      throw new ProtocolError(Code.BAD_PARAMS, `invalid offset or chunk length (maximum ${maxChunkBytes} bytes)`);
    }
    busy = true;
    // A deadline only stops the caller waiting. Hold the slot until the
    // underlying invoke settles so repeated timeouts cannot queue more chunks.
    const pending = send().finally(() => {
      busy = false;
    });
    return withTimeout(pending, timeoutMs, `binary/${action}`);
  }

  return Object.freeze({
    id,
    maxChunkBytes,
    async write(offset, raw) {
      if (!(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw)) {
        throw new ProtocolError(Code.BAD_PARAMS, 'binary write requires a byte buffer');
      }
      const bytes = toBytes(raw);
      return run('write', offset, bytes.byteLength, () => writeChunk('plugin_binary_write', pluginId, id, offset, bytes));
    },
    read(offset, maxBytes = maxChunkBytes) {
      return run('read', offset, maxBytes, async () => binaryReply(
        await invokeBinary('plugin_binary_read', { pluginId, id, offset, maxBytes }, { timeoutMs: 0, what: 'binary/read' }),
        'binary/read', maxBytes,
      ));
    },
    close() {
      closed = true;
      return closing ??= release().catch((error) => {
        closing = undefined;
        throw error;
      });
    },
  });
}
