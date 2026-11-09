/**
 * "The host stopped it" is not "it crashed".
 *
 * `proc/kill` terminates a sidecar with exit code 1, and every sidecar plugin
 * reads an `exit` frame as a failure: the eyecare plugin showed
 * `idle.exe 退出（code 1）` — for a helper it had asked the host to stop — and
 * gave up retrying after three of them, which turned a normal stop into a
 * permanently disabled feature.
 *
 * The host now records WHY it killed, and the transport reports a deliberate
 * stop as `end`. Both halves are pinned here, because either one alone leaves
 * the plugin misreading the frame:
 *
 *   1. `{exited: true, code: 1, killed: 'proc/kill'}` → `onEnd` gets `end`;
 *      no `exit` frame is delivered at all.
 *   2. `{exited: true, code: 1}` with no `killed` → still an `exit` frame: a
 *      process that really died must stay visible as a death.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./browser-stubs-loader.mjs', import.meta.url);

const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
  clear: () => ls.clear(),
};

/** What `proc/recv` answers. Each test sets it. */
let recvReply = () => ({ timeout: true });

globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => {
      if (cmd !== 'plugin_rpc') throw new Error(`unexpected invoke: ${cmd}`);
      const { msg } = args;
      const base = { v: 1, kind: 'res', id: msg.id };
      if (msg.act === 'recv') return { ...base, p: recvReply() };
      if (msg.act === 'spawn') return { ...base, p: { pid: 4242 } };
      if (msg.act === 'kill') return { ...base, p: true };
      throw new Error(`unexpected action: ${msg.act}`);
    },
    transformCallback: (cb) => cb,
    unregisterCallback: () => {},
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
};

const { hub } = await import('../src/protocol/hub.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open one sidecar and collect everything the plugin would see. */
async function run(ch, reply) {
  recvReply = () => reply;
  const frames = [];
  const ended = [];
  await hub.sidecar('p.stop', ch, {
    exe: 'x.exe',
    pollMs: 10,
    timeoutMs: 10,
    onFrame: (env) => frames.push(env),
    onEnd: (env) => ended.push(env),
  });
  // Long enough for at least one poll to come back with the terminal answer.
  for (let i = 0; i < 20 && ended.length === 0; i++) await sleep(15);
  return { frames, ended };
}

test('a sidecar the host killed ends with `end`, not with exit code 1', async () => {
  const { frames, ended } = await run('k1', { exited: true, code: 1, killed: 'proc/kill' });

  assert.equal(ended.length, 1, 'exactly one terminal frame');
  assert.equal(ended[0].kind, 'end', `expected end, got ${ended[0].kind} (code ${ended[0].p})`);
  assert.equal(
    frames.filter((f) => f.kind === 'exit').length,
    0,
    'a deliberate stop must not be delivered as a death',
  );
  assert.equal(hub.streams.has('p.stop/k1'), false, 'and the channel is free to open again');
});

test('a sidecar that died on its own is still reported as an exit', async () => {
  const { frames, ended } = await run('k2', { exited: true, code: 3 });

  assert.equal(ended.length, 1);
  assert.equal(ended[0].kind, 'exit', 'a real death must stay visible');
  assert.equal(ended[0].p, 3, 'with the real code');
  assert.equal(frames.filter((f) => f.kind === 'exit').length, 1, 'the frame reaches the plugin too');
});
