/**
 * `rpc-raw` — one request/response round trip whose answer is BYTES.
 *
 * The scheme exists so a screenshot does not have to travel as base64 inside a
 * JSON envelope: same gateway, same permission, same timeout policy, different
 * codec. What this file pins is the part that is easy to get wrong and
 * invisible when it is:
 *
 *   - the reply is normalised to a `Uint8Array` (ArrayBuffer / view / DataView),
 *   - a host REJECTION (the raw gateway cannot answer with an `err` envelope)
 *     becomes the same `ProtocolError` a JSON call would have produced,
 *   - a JSON answer arriving where bytes were promised is reported as a
 *     protocol break, not silently coerced to `NaN` bytes.
 *
 * The IPC layer is shimmed at `window.__TAURI_INTERNALS__`, not by mocking
 * `@tauri-apps/api/core` — the real wrapper stays in play, so this exercises the
 * same `invoke` the app uses. Same trick as `boot.test.mjs`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./browser-stubs-loader.mjs', import.meta.url);

const calls = [];
let impl = async () => {
  throw new Error('no invoke implementation installed');
};

globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return impl(cmd, args, options);
    },
  },
};

const { hub } = await import('../src/protocol/hub.js');
const { transport, transportIds } = await import('../src/protocol/transports/index.js');
const { descriptor, assertSupports, Capability } = await import('../src/protocol/registry.js');
const { Code } = await import('../src/protocol/codes.js');
const { createPluginSdk } = await import('../src/host/plugin-sdk.js');
const { Disposer } = await import('../src/host/disposer.js');

const bytesOf = (...n) => Uint8Array.from(n);

test('the scheme is declared, implemented, and can carry binary', () => {
  assert.ok(transportIds().includes('rpc-raw'), 'rpc-raw is not registered as a transport');
  const d = descriptor('rpc-raw');
  assert.equal(d.codec, 'raw-binary');
  assert.equal(d.direction, 'up');
  assert.equal(d.capabilities[Capability.BINARY], true);
  assert.equal(d.capabilities[Capability.REQUEST_RESPONSE], true);
  // Declared, checked at setup — a caller asking for something it cannot do
  // fails immediately instead of on the wire.
  assert.doesNotThrow(() => assertSupports('rpc-raw', Capability.BINARY));
});

test('one call sends a normal `req` envelope to the raw gateway', async () => {
  calls.length = 0;
  impl = async () => new ArrayBuffer(0);

  await hub.requestBytes('probe.demo', 'screen', 'capture', { monitor: 1 });

  assert.equal(calls.length, 1);
  const { cmd, args } = calls[0];
  assert.equal(cmd, 'plugin_rpc_raw');
  assert.equal(args.pluginId, 'probe.demo');
  assert.equal(args.msg.kind, 'req');
  assert.equal(args.msg.svc, 'screen');
  assert.equal(args.msg.act, 'capture');
  assert.deepEqual(args.msg.p, { monitor: 1 });
  assert.equal(typeof args.msg.id, 'number', 'a req needs a correlation id');
});

test('the reply is normalised to a Uint8Array, whatever the carrier handed us', async () => {
  const cases = [
    ['ArrayBuffer', new Uint8Array([1, 2, 3]).buffer],
    ['Uint8Array', bytesOf(1, 2, 3)],
    ['DataView', new DataView(new Uint8Array([0, 1, 2, 3]).buffer, 1, 3)],
    ['postMessage byte array', [1, 2, 3]],
  ];
  for (const [label, reply] of cases) {
    impl = async () => reply;
    const got = await hub.requestBytes('p', 'screen', 'capture');
    assert.ok(got instanceof Uint8Array, `${label}: expected a Uint8Array`);
    assert.deepEqual([...got], [1, 2, 3], `${label}: wrong bytes`);
  }
});

test('raw replies reject invalid values in a postMessage array', async () => {
  impl = async () => [137, 256, -1, '80'];
  await assert.rejects(() => hub.requestBytes('p', 'screen', 'capture'), { code: Code.PROTOCOL });
});

test('binary SDK sends raw request bodies and reads a payload larger than 1 MiB in chunks', async () => {
  const maxChunkBytes = 256 * 1024;
  const input = Uint8Array.from({ length: 2 * 1024 * 1024 + 17 }, (_, i) => i % 251);
  const output = new Uint8Array(input.length);
  const scope = new Disposer();
  const sdk = createPluginSdk('p.binary', { permissions: ['rpc:binary'] }, scope);
  let buffer;
  let id;
  let writes = 0;
  impl = async (cmd, args, options) => {
    if (cmd === 'plugin_binary_control') {
      assert.equal(args.pluginId, 'p.binary');
      if (args.action.kind === 'open') {
        assert.equal(args.action.size, input.length);
        id = args.id;
        buffer = new Uint8Array(args.action.size);
        return { maxChunkBytes };
      }
      assert.equal(args.action.kind, 'close');
      assert.equal(args.id, id);
      buffer = undefined;
      return true;
    }
    if (cmd === 'plugin_binary_write') {
      assert.ok(args instanceof Uint8Array, 'the whole invoke payload is a byte view');
      const headers = options.headers;
      assert.equal(headers['x-toolkit-plugin'], 'p.binary');
      assert.equal(headers['x-toolkit-transfer'], id);
      const offset = Number(headers['x-toolkit-offset']);
      assert.ok(args.byteLength <= maxChunkBytes);
      buffer.set(args, offset);
      writes++;
      return offset + args.byteLength;
    }
    assert.equal(cmd, 'plugin_binary_read');
    assert.equal(args.id, id);
    assert.equal(args.maxBytes, maxChunkBytes);
    const chunk = buffer.slice(args.offset, args.offset + args.maxBytes);
    return chunk.byteLength < maxChunkBytes ? [...chunk] : chunk.buffer;
  };

  const transfer = await sdk.binary.open(input.length);
  for (let offset = 0; offset < input.length; offset += transfer.maxChunkBytes) {
    const chunk = input.subarray(offset, offset + transfer.maxChunkBytes);
    assert.equal(await transfer.write(offset, chunk), offset + chunk.length);
  }
  for (let offset = 0; offset < output.length; offset += transfer.maxChunkBytes) {
    output.set(await transfer.read(offset), offset);
  }
  assert.ok(writes > 1);
  assert.deepEqual(output, input);
  await scope.run();
  assert.equal(buffer, undefined);
  await assert.rejects(() => transfer.read(0), { code: Code.NOT_FOUND });
});

test('disposing while a binary open is pending closes the eventual native session', async () => {
  const scope = new Disposer();
  const sdk = createPluginSdk('p.pending', { permissions: ['rpc:binary'] }, scope);
  let finishOpen;
  let closeCount = 0;
  impl = async (cmd, args) => {
    assert.equal(cmd, 'plugin_binary_control');
    if (args.action.kind === 'open') return new Promise((resolve) => { finishOpen = resolve; });
    closeCount++;
    return true;
  };
  const opening = sdk.binary.open(1024);
  const rejected = assert.rejects(opening, { code: Code.NOT_FOUND });
  const disposing = scope.run({ parallel: true });
  finishOpen({ maxChunkBytes: 256 * 1024 });
  await Promise.all([rejected, disposing]);
  assert.equal(closeCount, 1);
});

test('a binary open timeout releases a late native allocation', async () => {
  let finishOpen;
  let allocated = false;
  impl = async (_cmd, args) => {
    if (args.action.kind === 'open') return new Promise((resolve) => { finishOpen = resolve; });
    allocated = false;
    return true;
  };
  const sdk = createPluginSdk('p.timeout', { permissions: ['rpc:binary'] }, new Disposer());
  await assert.rejects(() => sdk.binary.open(1024, { timeoutMs: 10 }), { code: Code.TIMEOUT });
  allocated = true;
  finishOpen({ maxChunkBytes: 256 * 1024 });
  await new Promise(setImmediate);
  assert.equal(allocated, false);
});

test('a chunk timeout holds the IPC slot until the actual reply settles', async () => {
  let finishWrite;
  impl = async (cmd, args) => {
    if (cmd === 'plugin_binary_write') return new Promise((resolve) => { finishWrite = resolve; });
    if (cmd === 'plugin_binary_read') return [42];
    return args.action.kind === 'open' ? { maxChunkBytes: 256 * 1024 } : true;
  };
  const sdk = createPluginSdk('p.slots', { permissions: ['rpc:binary'] }, new Disposer());
  const transfer = await sdk.binary.open(1, { timeoutMs: 10 });
  await assert.rejects(() => transfer.write(0, Uint8Array.of(42)), { code: Code.TIMEOUT });
  await assert.rejects(() => transfer.read(0), { code: Code.CONFLICT });
  finishWrite(1);
  await new Promise(setImmediate);
  assert.deepEqual(await transfer.read(0), Uint8Array.of(42));
  await transfer.close();
});

test('a host rejection keeps its code and message', async () => {
  // This is the asymmetry with `rpc`: the response channel is bytes, so a
  // failure cannot ride in an `err` envelope. It arrives as a rejection with
  // the same two fields, and must still be branchable on `code`.
  impl = async () => {
    throw { code: Code.UNSUPPORTED, msg: '`storage/get` has no binary answer' };
  };
  await assert.rejects(
    () => hub.requestBytes('p', 'storage', 'get', { key: 'x' }),
    (e) => {
      assert.equal(e.name, 'ProtocolError');
      assert.equal(e.code, 'unsupported');
      assert.match(e.message, /no binary answer/);
      return true;
    },
  );
});

test('a denial is a denial, not a transport failure', async () => {
  impl = async () => {
    throw { code: Code.DENIED, msg: 'plugin `p` is not allowed to call `rpc:screen`' };
  };
  await assert.rejects(
    () => hub.requestBytes('p', 'screen', 'capture'),
    (e) => e.code === Code.DENIED,
  );
});

test('a rejection with no code is a transport failure, with the cause kept', async () => {
  impl = async () => {
    throw 'command plugin_rpc_raw not found';
  };
  await assert.rejects(
    () => hub.requestBytes('p', 'screen', 'capture'),
    (e) => {
      assert.equal(e.code, Code.TRANSPORT);
      assert.match(e.message, /not found/);
      return true;
    },
  );
});

test('a JSON answer where bytes were promised is a protocol break', async () => {
  // What a mis-wired gateway (or a host that answered the JSON route) looks
  // like. Coercing it would hand the caller a byte array of zeros.
  impl = async () => JSON.stringify({ kind: 'res', p: { png: '…' } });
  await assert.rejects(
    () => hub.requestBytes('p', 'screen', 'capture'),
    (e) => {
      assert.equal(e.code, Code.PROTOCOL);
      assert.match(e.message, /expected binary/);
      return true;
    },
  );
});

test('the caller can bound how long it waits', async () => {
  impl = () => new Promise(() => {}); // never settles
  await assert.rejects(
    () => hub.requestBytes('p', 'screen', 'capture', null, { timeoutMs: 10 }),
    (e) => e.code === Code.TIMEOUT,
  );
});

test('the transport rejects an action the host says has no byte form', async () => {
  // End-to-end shape of the host's answer for e.g. `storage/get`: the caller
  // gets `unsupported`, and the message names the actions that DO work.
  impl = async () => {
    throw { code: Code.UNSUPPORTED, msg: '`storage/get` has no binary answer — use one of: screen/capture' };
  };
  const t = transport('rpc-raw');
  await assert.rejects(
    () => t.request({ pluginId: 'p', svc: 'storage', act: 'get' }),
    (e) => e.code === 'unsupported' && /screen\/capture/.test(e.message),
  );
});
