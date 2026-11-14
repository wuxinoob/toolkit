import test from 'node:test';
import assert from 'node:assert/strict';
import { Disposer } from '../src/host/disposer.js';
import { createPluginSdk } from '../src/host/plugin-sdk.js';

function setup(invoke, permissions = ['rpc:fs']) {
  const scope = new Disposer();
  globalThis.window = { __TAURI_INTERNALS__: { invoke } };
  return { scope, fs: createPluginSdk('test.fs', { permissions }, scope).fs };
}

test('file selection and block I/O preserve the reference and raw byte payload', async () => {
  const active = new Map();
  const bytes = Uint8Array.of(42, 0, 255);
  const path = 'D:/large.bin';
  const offset = 18 * 1024 * 1024;
  const { scope, fs } = setup(async (cmd, args, options) => {
    if (cmd === 'plugin_fs_write') {
      assert.deepEqual(args, bytes);
      const headers = options.headers;
      assert.equal(headers['x-toolkit-plugin'], 'test.fs');
      assert.equal(headers['x-toolkit-offset'], '0');
      assert.equal(active.get(headers['x-toolkit-transfer']), true);
      return bytes.length;
    }
    assert.equal(args.pluginId, 'test.fs');
    if (cmd === 'plugin_fs_read') {
      assert.equal(active.get(args.id), false);
      assert.equal(args.offset, offset);
      return [...bytes];
    }
    assert.equal(cmd, 'plugin_fs_control');
    const { action, id } = args;
    if (action.kind === 'open') {
      assert.equal(action.path, undefined);
      active.set(id, action.write);
      return { path, size: offset + bytes.length, maxChunkBytes: 256 * 1024 };
    }
    if (action.kind === 'stat') return { size: offset + bytes.length };
    if (action.kind === 'close') return active.delete(id);
    assert.equal(action.kind, 'commit');
    assert.equal(active.get(id), true);
    return true;
  });
  const input = await fs.open();
  const output = await fs.createWriter();
  assert.equal(input.path, path);
  assert.equal((await input.stat()).size, input.size);
  assert.deepEqual(await input.readAt(offset, bytes.length), bytes);
  const padded = Uint8Array.of(9, ...bytes, 8);
  assert.equal(await output.write(0, padded.subarray(1, 4)), bytes.length);
  await output.commit();
  await output.close();
  await scope.run();
  assert.equal(active.size, 0);
  await assert.rejects(() => input.readAt(offset), { code: 'not_found' });
});

test('disposal invalidates a file picker reservation and cleans up a late reply', async () => {
  let finish;
  let reserved;
  let closes = 0;
  const { scope, fs } = setup(async (_cmd, { id, action }) => {
    if (action.kind === 'open') {
      reserved = id;
      return new Promise((resolve) => { finish = resolve; });
    }
    assert.equal(action.kind, 'close');
    assert.equal(id, reserved);
    closes++;
    return true;
  });
  const opening = fs.open();
  const result = assert.rejects(opening, { code: 'not_found' });
  await scope.run();
  assert.equal(closes, 1, 'disposal sends close without waiting for the picker');
  finish({ path: 'D:/late.bin', size: 0, maxChunkBytes: 256 * 1024 });
  await result;
  assert.equal(closes, 2, 'a late reference is closed as well');
});

test('an ungranted fs call never opens a native dialog', async () => {
  const { fs } = setup(() => assert.fail('unexpected IPC'), []);
  await assert.rejects(() => fs.open(), /rpc:fs/);
});
