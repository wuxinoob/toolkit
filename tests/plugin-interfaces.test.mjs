/**
 * "Can a new plugin drive the existing interfaces?" — answered by actually
 * doing it.
 *
 * This loads the real `tests/fixtures/plugins/probe/main.js`, builds it a real `ctx`
 * (the same `buildCtx` the host uses), and runs its `activate()`. The plugin
 * throws if ANY interface step fails, so a clean resolve is the assertion.
 *
 * The mock sits at the `__TAURI_INTERNALS__.invoke` boundary, so everything
 * above it — ctx gates, the hub, the transports, the codecs — is production
 * code. Nothing here reaches into plugin internals.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// `lifecycle.js` now pulls in the component factory (host/ui.js -> Vue SFCs +
// `import.meta.glob`), none of which Node can resolve. The stub loader fakes the
// rendering but keeps every tag name real, so the kernel tests still exercise
// the actual activation path.
register('./browser-stubs-loader.mjs', import.meta.url);


// ------------------------------ environment shims -----------------------------
const callbacks = new Map();
let cbSeq = 0;
const invokeCalls = [];

globalThis.localStorage = {
  store: new Map(),
  getItem(k) {
    return this.store.has(k) ? this.store.get(k) : null;
  },
  setItem(k, v) {
    this.store.set(k, String(v));
  },
  removeItem(k) {
    this.store.delete(k);
  },
  clear() {
    this.store.clear();
  },
};

/** Deliver a frame to a `Channel` the way the Rust side does. */
function deliver(channel, message, index = 0) {
  const cb = callbacks.get(channel.id);
  assert.ok(cb, `no callback registered for channel ${channel.id}`);
  cb({ index, message });
}

const kv = new Map();
const seen = { streamJson: 0, streamRaw: 0, publish: 0, sessions: 0, info: 0, schema: 0, hotkeys: 0 };
let busHandler = null;

const rawCounter = (n) => {
  const out = new Uint8Array(9);
  out[0] = 0x01; // data kind byte
  new DataView(out.buffer).setBigInt64(1, BigInt(n), true);
  return out.buffer;
};

let invokeImpl = async (cmd, args) => {
  throw new Error(`unexpected invoke: ${cmd}`);
};

globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => {
      invokeCalls.push({ cmd, args });
      return invokeImpl(cmd, args);
    },
    transformCallback: (cb) => {
      const id = ++cbSeq;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main', windowLabel: 'main' },
    },
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
};

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({
    style: {},
    className: '',
    textContent: '',
    innerHTML: '',
    addEventListener() {},
    appendChild(c) {
      return c;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  }),
  head: { appendChild() {} },
  body: { appendChild() {}, style: {} },
  documentElement: { style: {} },
};
globalThis.requestAnimationFrame ||= (fn) => setTimeout(() => fn(0), 0);
globalThis.cancelAnimationFrame ||= (id) => clearTimeout(id);

// dynamic imports AFTER shims are in place
const { buildCtx } = await import('../src/host/ctx.js');
const { store } = await import('../src/host/store.js');
const probe = await import('../tests/fixtures/plugins/probe/main.js');

/** A gateway that answers exactly what the probe's sweep needs. */
function installGateway() {
  invokeImpl = async (cmd, args) => {
    // --- control plane ---------------------------------------------------
    if (cmd === 'plugin_rpc') {
      const { msg } = args;
      const { svc, act, p } = msg;
      const res = (payload) => ({ v: 1, kind: 'res', id: msg.id, p: payload });

      if (svc === 'host' && act === 'info') {
        seen.info += 1;
        return res({ dataDir: '/tmp/toolbox-test/plugin-data/probe.demo', liveSessions: 0 });
      }
      if (svc === 'host' && act === 'sessions') {
        seen.sessions += 1;
        return res([]);
      }
      if (svc === 'host' && act === 'schema') {
        seen.schema += 1;
        // mirrors what the native `schema()` returns
        return res({
          protocol: 1,
          services: {
            storage: ['get', 'set', 'remove', 'keys'],
            host: ['info', 'write_debug_log', 'sessions', 'plugins', 'schema'],
            proc: ['spawn', 'send', 'recv', 'kill', 'kill_all', 'list'],
            stream: ['close', 'providers', 'list', 'session_open', 'session_close'],
            bus: ['publish'],
            hotkey: ['register', 'unregister', 'unregister_all', 'list'],
          },
          providers: ['ticker', 'blob'],
          sinks: ['proc'],
        });
      }
      if (svc === 'hotkey' && act === 'list') {
        seen.hotkeys += 1;
        // the host registers contributes.hotkeys on the plugin's behalf
        return res({ keys: ['ctrl+alt+shift+p'] });
      }
      if (svc === 'host' && act === 'schema') {
        seen.schema += 1;
        // mirrors what the native `schema()` returns
        return res({
          protocol: 1,
          services: {
            storage: ['get', 'set', 'remove', 'keys'],
            host: ['info', 'write_debug_log', 'sessions', 'plugins', 'schema'],
            proc: ['spawn', 'send', 'recv', 'kill', 'kill_all', 'list'],
            stream: ['close', 'providers', 'list', 'session_open', 'session_close'],
            bus: ['publish'],
            hotkey: ['register', 'unregister', 'unregister_all', 'list'],
          },
          providers: ['ticker', 'blob'],
          sinks: ['proc'],
        });
      }
      if (svc === 'hotkey' && act === 'list') {
        seen.hotkeys += 1;
        // the host registers contributes.hotkeys on the plugin's behalf
        return res({ keys: ['ctrl+alt+shift+p'] });
      }
      if (svc === 'storage' && act === 'set') {
        kv.set(p.key, p.value);
        return res(true);
      }
      if (svc === 'storage' && act === 'get') {
        return res(kv.has(p.key) ? kv.get(p.key) : null);
      }
      if (svc === 'storage' && act === 'keys') {
        return res([...kv.keys()]);
      }
      if (svc === 'bus' && act === 'publish') {
        seen.publish += 1;
        // the host fans it out; deliver it to this window's listener
        assert.ok(busHandler, 'bus.publish happened before subscribe');
        callbacks.get(busHandler)({
          event: 'ump://evt',
          id: seen.publish,
          payload: { v: 1, kind: 'evt', topic: p.topic, p: p.payload },
        });
        return res({ topic: p.topic, delivered: true });
      }
      throw new Error(`probe called an unexpected service: ${svc}/${act}`);
    }

    // --- data plane ------------------------------------------------------
    if (cmd === 'plugin_stream_open') {
      seen.streamJson += 1;
      setTimeout(() => {
        const ch = args.ch;
        deliver(args.onFrame, { v: 1, kind: 'data', ch, p: { n: 0, t: 1 } }, 0);
        deliver(args.onFrame, { v: 1, kind: 'data', ch, p: { n: 1, t: 2 } }, 1);
        deliver(args.onFrame, { v: 1, kind: 'data', ch, p: { n: 2, t: 3 } }, 2);
        deliver(args.onFrame, { v: 1, kind: 'end', ch }, 3);
      }, 5);
      return null;
    }
    if (cmd === 'plugin_stream_open_raw') {
      seen.streamRaw += 1;
      setTimeout(() => {
        const ch = args.ch;
        deliver(args.onFrame, rawCounter(0), 0);
        deliver(args.onFrame, rawCounter(1), 1);
        deliver(args.onFrame, new Uint8Array([0x02]).buffer, 2); // end
      }, 5);
      return null;
    }
    if (cmd === 'plugin_stream_close') return { stopped: true };

    // --- events ----------------------------------------------------------
    if (cmd === 'plugin:event|listen') {
      busHandler = args.handler;
      return 1;
    }
    if (cmd === 'plugin:event|unlisten') return null;

    throw new Error(`unexpected invoke: ${cmd}`);
  };
}

// ----------------------------------- tests ------------------------------------

test('a new plugin can drive every existing interface with no host changes', async () => {
  installGateway();
  kv.clear();
  store.views.length = 0;

  const ctx = buildCtx({ manifest: probe.manifest }, { track() {} });

  // The plugin runs its whole sweep inside activate() and throws if any step
  // failed, so a clean resolve means every interface check passed.
  await probe.activate(ctx);

  assert.equal(seen.info, 1, 'rpc (host/info) not exercised');
  assert.equal(seen.sessions, 1, 'the session registry was not queried');
  assert.equal(seen.streamJson, 1, 'channel-json was not exercised');
  assert.equal(seen.streamRaw, 1, 'channel-raw was not exercised');
  assert.equal(seen.publish, 1, 'event-bus was not exercised');
  assert.equal(seen.schema, 1, 'the negotiation surface (host/schema) was not exercised');
  assert.equal(seen.hotkeys, 1, 'the declared hotkey was not readable back');
  assert.ok(kv.has('probe'), 'storage round trip did not persist');
  assert.ok(kv.has('lastSweep'), 'the sweep result was not persisted');
  const sweep = kv.get('lastSweep');
  // A FLOOR, not the exact count. `passed === total` below is satisfied
  // trivially by a sweep that stopped after one step, so something has to say
  // "enough steps ran" — and a floor is the version of that which does not need
  // editing every time a step is added.
  assert.ok(sweep.total >= 8, `expected at least 8 interface checks, got ${sweep.total}`);
  assert.equal(sweep.passed, sweep.total, `failed checks: ${JSON.stringify(sweep.results.filter((r) => !r.ok))}`);
  // every scheme in the table should be covered by at least one step
  const schemes = new Set(sweep.results.map((r) => r.iface));
  for (const expected of ['rpc', 'channel-json', 'channel-raw', 'event-bus', 'in-process', 'registry', 'guard']) {
    assert.ok(schemes.has(expected), `no step exercised \`${expected}\``);
  }
});

test('the plugin declared exactly the permissions it needed, and no more', async () => {
  const declared = probe.manifest.permissions.slice().sort();
  assert.deepEqual(declared, ['rpc:bus', 'rpc:host', 'rpc:hotkey', 'rpc:storage', 'rpc:stream']);
  // the sweep's deliberate negative test must have been rejected by the JS gate
  assert.ok(
    !invokeCalls.some((c) => c.args?.msg?.svc === 'nope'),
    'the undeclared service call reached the native side — the gate did not hold',
  );
});

test('the plugin registered its view through the same ctx contract as built-ins', () => {
  const view = store.views.find((v) => v.viewId === 'probe.demo/probe');
  assert.ok(view, 'view was not registered');
  assert.equal(view.title, 'Plane Probe');
  assert.equal(typeof view.render, 'function');
});
