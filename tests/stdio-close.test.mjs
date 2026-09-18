import test from 'node:test';
import assert from 'node:assert/strict';

import { MessageHub } from '../src/protocol/hub.js';
import { rpcTransport } from '../src/protocol/transports/rpc.js';
import * as Envelope from '../src/protocol/envelope.js';
import { spawn } from 'node:child_process';

for (const requestId of [0, 17]) {
  test(`sidecar request error ${requestId} leaves the session usable`, async () => {
    const originalRequest = rpcTransport.request;
    const replies = [
      Envelope.err(requestId, 'div_by_zero', 'division by zero'),
      Envelope.res(requestId + 1, { result: 42 }),
      Envelope.end('worker'),
    ];
    let received = 0;
    rpcTransport.request = async ({ act }) => act === 'recv'
      ? { line: JSON.stringify(replies[received++]) }
      : {};
    let handle;
    try {
      const hub = new MessageHub();
      const frames = [];
      let resolveEnded;
      const ended = new Promise((resolve) => { resolveEnded = resolve; });
      handle = await hub.sidecar('errors-test', 'worker', {
        exe: 'stub', pollMs: 0,
        onFrame: (frame) => frames.push(frame),
        onEnd: resolveEnded,
      });
      await ended;
      assert.deepEqual(frames, replies);
      assert.deepEqual(hub.openStreamKeys(), []);
    } finally {
      await handle?.close();
      rpcTransport.request = originalRequest;
    }
  });
}

test('sidecar stream error still terminates the session', async () => {
  const originalRequest = rpcTransport.request;
  const fatal = Envelope.streamErr('worker', 'io', 'pipe failed');
  rpcTransport.request = async ({ act }) => act === 'recv'
    ? { line: JSON.stringify(fatal) } : {};
  let handle;
  try {
    const hub = new MessageHub();
    let resolveEnded;
    const endedFrames = [];
    const ended = new Promise((resolve) => {
      resolveEnded = (frame) => {
        endedFrames.push(frame);
        resolve(frame);
      };
    });
    handle = await hub.sidecar('errors-test', 'worker', {
      exe: 'stub', onEnd: resolveEnded,
    });
    assert.deepEqual(await ended, fatal);
    assert.deepEqual(hub.openStreamKeys(), []);
  } finally {
    await handle?.close();
    rpcTransport.request = originalRequest;
  }
});

test('sidecar explicit close notifies onEnd once and removes the hub record', async () => {
  const originalRequest = rpcTransport.request;
  const calls = [];
  rpcTransport.request = async (request) => {
    calls.push(request);
    return {};
  };

  try {
    const hub = new MessageHub();
    const ended = [];
    const handle = await hub.sidecar('close-test', 'worker', {
      exe: 'stub',
      onEnd: (frame) => ended.push(frame),
    });
    assert.deepEqual(hub.openStreamKeys(), ['close-test/worker']);

    await handle.close();
    await handle.close();

    assert.equal(ended.length, 1);
    assert.equal(ended[0].kind, 'end');
    assert.equal(ended[0].ch, 'worker');
    assert.deepEqual(hub.openStreamKeys(), []);
    assert.equal(calls.filter((request) => request.svc === 'proc' && request.act === 'kill').length, 1);
  } finally {
    rpcTransport.request = originalRequest;
  }
});

test('sidecar close ignores a pending receive result', async () => {
  const originalRequest = rpcTransport.request;
  let resolveReceive;
  let markReceiving;
  const receiving = new Promise((resolve) => { markReceiving = resolve; });
  rpcTransport.request = async ({ act }) => {
    if (act !== 'recv') return {};
    return new Promise((resolve) => {
      resolveReceive = resolve;
      markReceiving();
    });
  };

  let handle;
  try {
    const hub = new MessageHub();
    const frames = [];
    const ended = [];
    handle = await hub.sidecar('close-test', 'pending', {
      exe: 'stub',
      onFrame: (frame) => frames.push(frame),
      onEnd: (frame) => ended.push(frame),
    });
    await receiving;
    await Promise.all([handle.close(), handle.close()]);
    resolveReceive({ line: 'late output' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(frames, []);
    assert.equal(ended.length, 1);
    assert.deepEqual(hub.openStreamKeys(), []);
  } finally {
    await handle?.close();
    rpcTransport.request = originalRequest;
  }
});

test('sidecar close kills a real child process and notifies onEnd once', async () => {
  const originalRequest = rpcTransport.request;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  rpcTransport.request = async ({ act }) => {
    if (act === 'kill') {
      child.kill();
      await exited;
      return {};
    }
    return {};
  };

  try {
    const hub = new MessageHub();
    let resolveEnded;
    const endedFrames = [];
    const ended = new Promise((resolve) => {
      resolveEnded = (frame) => {
        endedFrames.push(frame);
        resolve(frame);
      };
    });
    const handle = await hub.sidecar('real-kill', 'worker', {
      exe: 'stub',
      onEnd: resolveEnded,
    });
    await handle.close();
    const exitInfo = await exited;
    assert.equal(endedFrames.length, 1);
    assert.ok(child.killed);
    assert.ok(exitInfo.code !== null || exitInfo.signal !== null);
  } finally {
    rpcTransport.request = originalRequest;
  }
});
