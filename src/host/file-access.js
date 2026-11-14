import { toBytes } from '../protocol/codec.js';
import { Code } from '../protocol/codes.js';
import { ProtocolError } from '../protocol/errors.js';
import { DEFAULT_TIMEOUT_MS, withTimeout } from '../protocol/transports/rpc.js';
import { binaryReply, invokeBinary, writeChunk } from '../protocol/transports/rpcRaw.js';

export function fileAccess(pluginId, disposer) {
  const closers = new Set();
  disposer.track(() => Promise.all([...closers].map((close) => close())));

  return async (write, options = {}) => {
    if (disposer.closed) throw new ProtocolError(Code.NOT_FOUND, 'plugin scope is closed');
    const { title, directory, defaultPath, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    const id = crypto.randomUUID();
    const address = { pluginId, id };
    const control = (action, wait = timeoutMs) => invokeBinary('plugin_fs_control', { ...address, action }, {
      what: `fs/${action.kind}`, timeoutMs: wait,
    });
    let closed = false;
    let closing;
    function close() {
      closed = true;
      return closing ??= control({ kind: 'close' }).then((result) => {
        closers.delete(close);
        return result;
      }).catch((error) => {
        closing = undefined;
        throw error;
      });
    }
    // A pending dialog is also a native reservation. Invalidate it immediately
    // on disposal even when the user has not dismissed the dialog yet.
    closers.add(close);
    let info;
    try {
      info = await control({ kind: 'open', write, title, directory, defaultPath }, 0);
    } catch (error) {
      if (error.code === Code.TRANSPORT) void close().catch(() => {});
      else closers.delete(close);
      throw error;
    }
    if (!info) {
      closers.delete(close);
      return null;
    }
    if (closed || disposer.closed) {
      // A close sent before the reservation reached Rust may have missed it.
      await control({ kind: 'close' });
      throw new ProtocolError(Code.NOT_FOUND, 'plugin scope closed during file open');
    }

    const { path, size, maxChunkBytes } = info;
    let busy = false;
    async function run(action, start) {
      if (closed || disposer.closed) throw new ProtocolError(Code.NOT_FOUND, 'file reference is closed');
      if (busy) throw new ProtocolError(Code.CONFLICT, 'await the previous file operation');
      busy = true;
      // Keep the slot while native work is running even if the caller times out.
      const pending = start().finally(() => { busy = false; });
      return withTimeout(pending, timeoutMs, `fs/${action}`);
    }
    function validate(offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > maxChunkBytes) {
        throw new ProtocolError(Code.BAD_PARAMS, `invalid file offset or chunk length (maximum ${maxChunkBytes} bytes)`);
      }
    }

    if (write) return Object.freeze({
      path, maxChunkBytes, close,
      async write(offset, input) {
        if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) {
          throw new ProtocolError(Code.BAD_PARAMS, 'file write requires a byte buffer');
        }
        const bytes = toBytes(input);
        validate(offset, bytes.byteLength);
        return run('write', () => writeChunk('plugin_fs_write', pluginId, id, offset, bytes));
      },
      commit: () => run('commit', () => control({ kind: 'commit' }, 0)),
    });
    return Object.freeze({
      path, size, maxChunkBytes, close,
      stat: () => run('stat', () => control({ kind: 'stat' }, 0)),
      async readAt(offset, length = maxChunkBytes) {
        validate(offset, length);
        return run('read', async () => binaryReply(await invokeBinary('plugin_fs_read', {
          ...address, offset, length,
        }, { timeoutMs: 0 }), 'fs/read', length));
      },
    });
  };
}
