/**
 * The bridge watchdog — the only thing in the app that notices a host which
 * stopped answering.
 *
 * Why it needs a test at all: a watchdog that silently stops working looks
 * exactly like a healthy app, right up until the moment someone needs it. And
 * the failure it watches for (`invoke` never settling) has no error path to
 * assert on — the *absence* of a signal is the signal.
 *
 * Driven with mock timers and a controllable `invoke`, so the whole thing runs
 * in milliseconds and needs no webview.
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

let hostAnswers = false;
const calls = [];
globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      if (!hostAnswers) throw new Error('ipc wedged');
      return { v: 1, kind: 'res', id: args?.msg?.id, p: { dataDir: '/tmp', liveSessions: 0 } };
    },
    transformCallback: (cb) => cb,
    unregisterCallback: () => {},
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
};

const { installBridgeWatchdog } = await import('../src/host/boot.js');
const { store } = await import('../src/host/store.js');

const KEY = 'toolbox.bridgeOutage';
const STEP = 20_000;

/** Advance the watchdog by `n` probe intervals and let the promises settle. */
async function ticks(t, n) {
  for (let i = 0; i < n; i++) {
    t.mock.timers.tick(STEP);
    // Two drains: the probe's own await, then `report`'s.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }
}

test('three missed probes surface a toast and leave evidence for the next boot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  store.toasts.length = 0;
  ls.clear();
  hostAnswers = false;
  calls.length = 0;

  installBridgeWatchdog();

  await ticks(t, 1);
  assert.equal(calls.filter((c) => c.args?.msg?.svc === 'host').length > 0, true, 'it must probe');
  assert.equal(store.toasts.length, 0, 'one miss is not an outage');
  assert.match(ls.get(KEY) ?? '', /1 missed probe/, 'the miss is recorded immediately');

  await ticks(t, 1);
  assert.equal(store.toasts.length, 0, 'two misses are still not an outage');

  await ticks(t, 1);
  assert.equal(store.toasts.length, 1, 'three consecutive misses must tell the user');
  assert.match(store.toasts[0].message, /重启应用/, 'and must name the recovery');
  assert.match(ls.get(KEY) ?? '', /3 missed probe/, 'the outage survives a restart');
});

test('a host that answers again clears the evidence and re-arms the warning', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  store.toasts.length = 0;
  ls.clear();
  hostAnswers = false;

  installBridgeWatchdog();
  await ticks(t, 3);
  assert.equal(store.toasts.length, 1);
  const firstId = store.toasts[0].id;

  hostAnswers = true;
  await ticks(t, 1);
  assert.equal(ls.get(KEY), undefined, 'a healthy probe clears the recorded outage');

  // …and a NEW outage warns again rather than staying silent forever. Compared
  // by id, not by length: a toast expires after 15 s and every tick here is
  // 20 s, so the previous one may already be gone.
  hostAnswers = false;
  await ticks(t, 3);
  const fresh = store.toasts.filter((x) => x.id > firstId);
  assert.equal(fresh.length, 1, 'the warning must not be one-shot for the session');
});
