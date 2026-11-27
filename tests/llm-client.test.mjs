import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmClient } from '../src/host/llm-client.js';
import { Disposer } from '../src/host/disposer.js';
import { ProtocolError } from '../src/protocol/errors.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(impl) {
  const calls = [];
  const disposer = new Disposer();
  const client = createLlmClient(async (action, params) => {
    calls.push({ action, params });
    if (action === 'start') return impl?.(action, params) ?? { id: 'job-1' };
    if (action === 'cancel' || action === 'cancel_all') return impl?.(action, params) ?? true;
    return impl(action, params);
  }, disposer);
  return { client, disposer, calls };
}

test('llm streams advance only when consumed, including waiting polls, without aggregating history', async () => {
  const events = [{ type: 'waiting' }, { type: 'text-delta', text: '你' }, { type: 'text-delta', text: '好' }, { type: 'completed', usage: null, finishReason: 'stop' }];
  const { client, calls } = fixture(action => action === 'next' ? events.shift() : undefined);
  const stream = client.stream({ messages: [] });
  assert.equal(calls.length, 0);
  assert.equal((await stream.next()).value.text, '你');
  assert.equal(calls.filter(c => c.action === 'next').length, 2);
  await tick();
  assert.equal(calls.filter(c => c.action === 'next').length, 2);
  assert.equal((await stream.next()).value.text, '好');
  assert.equal((await stream.next()).value.type, 'completed');
  assert.equal((await stream.next()).done, true);
  assert.equal(calls.filter(c => c.action === 'cancel').length, 0);
});

test('llm complete generation preserves text and unknown usage', async () => {
  const events = [{ type: 'text-delta', text: '你好' }, { type: 'completed', usage: { inputTokens: null }, finishReason: 'length' }];
  const { client } = fixture(action => action === 'next' ? events.shift() : undefined);
  const result = await client.generate({ messages: [] });
  assert.deepEqual(result.output, [{ type: 'text', text: '你好' }]);
  assert.equal(result.usage.inputTokens, null);
  assert.equal(result.finishReason, 'length');
});

test('llm exposes effort policy to plugins and forwards a per-call choice', async () => {
  const profile = { id: 'reasoning', reasoning: { defaultEffort: 'medium', allowedEfforts: ['low', 'medium', 'high'] } };
  const events = [{ type: 'text-delta', text: 'done' }, { type: 'completed', usage: null, finishReason: 'stop' }];
  const { client, calls } = fixture(action => action === 'profiles' ? [profile] : action === 'next' ? events.shift() : undefined);
  assert.deepEqual((await client.profiles())[0].reasoning, profile.reasoning);
  await client.generate({ profile: profile.id, messages: [], reasoningEffort: 'low' });
  assert.equal(calls.find(call => call.action === 'start').params.reasoningEffort, 'low');
});

test('llm breaking an iterator awaits native cancellation', async () => {
  const { client, calls } = fixture(action => action === 'next' ? { type: 'text-delta', text: 'first' } : undefined);
  for await (const event of client.stream({})) { assert.equal(event.text, 'first'); break; }
  assert.deepEqual(calls.map(c => c.action), ['start', 'next', 'cancel']);
});

test('llm AbortSignal cancels a native request before its first token', { timeout: 3000 }, async () => {
  let rejectNext;
  const { client, calls } = fixture(action => {
    if (action === 'next') return new Promise((_, reject) => { rejectNext = reject; });
    if (action === 'cancel') { rejectNext?.(new ProtocolError('conflict', 'cancelled')); return true; }
  });
  const controller = new AbortController();
  const next = client.stream({}, { signal: controller.signal }).next();
  await tick(); controller.abort();
  await assert.rejects(next, error => error.name === 'AbortError');
  assert.equal(calls.filter(c => c.action === 'cancel').length, 1);
});

test('llm aborting a pending start is prompt and releases its eventual native handle', { timeout: 3000 }, async () => {
  let resolveStart;
  const { client, calls } = fixture(action => action === 'start' ? new Promise(resolve => { resolveStart = resolve; }) : undefined);
  const controller = new AbortController();
  const next = client.stream({}, { signal: controller.signal }).next();
  await tick(); controller.abort();
  await assert.rejects(next, error => error.name === 'AbortError');
  resolveStart({ id: 'late-job' }); await tick();
  assert.deepEqual(calls.find(c => c.action === 'cancel').params, { id: 'late-job' });
});

test('llm dispose cancels the native scope even when start has not returned', { timeout: 3000 }, async () => {
  let rejectStart;
  const { client, disposer, calls } = fixture(action => {
    if (action === 'start') return new Promise((_, reject) => { rejectStart = reject; });
    if (action === 'cancel_all') { rejectStart(new ProtocolError('conflict', 'scope closed during open')); return true; }
  });
  const next = client.stream({}).next();
  const rejected = assert.rejects(next, /scope closed/);
  await tick(); await disposer.run(); await rejected;
  assert.equal(calls.filter(c => c.action === 'cancel_all').length, 1);
  await assert.rejects(client.stream({}).next(), /scope is closed/);
});

test('llm bounded aggregation cancels instead of retaining an oversized response', async () => {
  const { client, calls } = fixture(action => action === 'next' ? { type: 'text-delta', text: 'x'.repeat(2048) } : undefined);
  await assert.rejects(client.generate({}), /4 MiB/);
  assert.equal(calls.filter(c => c.action === 'cancel').length, 1);
});

test('llm an error after partial output rejects the complete result', async () => {
  let count = 0;
  const { client } = fixture(action => {
    if (action === 'next') { if (!count++) return { type: 'text-delta', text: 'partial' }; throw new ProtocolError('io', 'upstream disconnected'); }
  });
  await assert.rejects(client.generate({}), error => error.code === 'io');
});
