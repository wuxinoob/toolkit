/**
 * eyecare.demo — behavioural test of the example plugin, driven through a MOCK
 * `ctx`.
 *
 * Why this exists on top of `tests/plugins.test.mjs`: that file is a static
 * audit (it reads the source as text). It can prove the manifest is honest and
 * that the tag names exist, but not that the state machine does what it claims.
 * This one calls the real `activate()` against a recording fake of the host, so
 * the timer, the work/rest transitions, the click-through lock, the position
 * clamping and the view tree are all actually executed.
 *
 * It is possible at all because the plugin imports nothing and touches no DOM
 * at module scope — which is itself the property worth protecting. A plugin
 * that needed a browser merely to load could not be tested like this.
 *
 * `window`/`document` are only reached from the window UIs (`mountWindow`),
 * which this file deliberately does not call; the main-window half needs only
 * `window.screen`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = path.join(root, 'tests/fixtures/plugins/eyecare/main.js');

const Kind = { REQ: 'req', RES: 'res', ERR: 'err', EVT: 'evt', DATA: 'data', END: 'end', EXIT: 'exit' };

/** The window labels the plugin owns. */
const L = {
  pill: 'plugin-ec-pill',
  lock: 'plugin-ec-lock',
  menu: 'plugin-ec-menu',
  rest: 'plugin-ec-rest',
  ctl: 'plugin-ec-restctl',
};

/** A fresh module instance per test: the plugin keeps its state in module scope. */
let seq = 0;
const freshPlugin = () => import(pathToFileURL(ENTRY).href + '?isolate=' + (seq += 1));

/** A recording fake of the host SDK. Every call lands in `calls`. */
function makeCtx() {
  const calls = [];
  const logs = [];
  const store = new Map();
  const subscribers = new Map();
  const views = new Map();
  const hotkeys = new Map();
  const closeHandlers = [];
  const cleanups = [];
  const handles = { sidecar: null };
  const say = (level) => (m) => logs.push({ level, m: String(m) });

  const ctx = {
    id: 'eyecare.demo',
    protocol: { Kind },
    log: { info: say('info'), warn: say('warn'), error: say('error') },
    storage: {
      get: async (k) => (store.has(k) ? store.get(k) : null),
      set: async (k, v) => {
        const copy = JSON.parse(JSON.stringify(v));
        store.set(k, copy);
        calls.push({ op: 'storage.set', key: k, value: copy });
      },
      remove: async () => {},
      keys: async () => [...store.keys()],
    },
    bus: {
      subscribe: async (topic, fn) => {
        subscribers.set(topic, fn);
        return () => subscribers.delete(topic);
      },
      once: async () => () => {},
      publish: async (topic, p) => {
        calls.push({ op: 'publish', topic, p: JSON.parse(JSON.stringify(p)) });
      },
    },
    windows: {
      create: async (label, opts) => {
        calls.push({ op: 'create', label, opts });
        return 'created';
      },
      exists: async () => false,
      control: async (label, name, value) => {
        calls.push({ op: 'control', label, name, value });
      },
      onCloseRequested: async (fn) => {
        closeHandlers.push(fn);
      },
    },
    sidecar: async (ch, opts) => {
      calls.push({ op: 'sidecar', ch, exe: opts.exe });
      handles.sidecar = opts;
      return { ch, send: async () => {}, close: async () => {} };
    },
    closeStream: async (ch) => {
      calls.push({ op: 'closeStream', ch });
      return true;
    },
    rpc: async () => ({}),
    sessions: async () => [],
    schemes: () => [],
    schema: async () => ({}),
    onHotkey: async (action, fn) => {
      hotkeys.set(action, fn);
      return () => hotkeys.delete(action);
    },
    registerView: (id, render) => views.set(id, render),
    cleanup: (fn) => cleanups.push(fn),
    ui: {
      notify: (message, type) => calls.push({ op: 'notify', message, type }),
      // The factory, reduced to what this plugin needs from it: `el` builds a
      // descriptor (so the whole view tree really executes) and `render`
      // records what it was given.
      el: (tag, props, children, ...rest) => ({
        tag,
        props: props || {},
        children: rest.length ? [children, ...rest] : children,
      }),
      render: (container, tree) => {
        container.__tree = tree;
      },
    },
  };

  return { ctx, calls, logs, store, subscribers, views, hotkeys, closeHandlers, cleanups, handles };
}

/** A stand-in for a view container: `paintView` only reads these two fields. */
function fakeRoot() {
  const cache = new Map();
  return {
    __tree: null,
    querySelector(sel) {
      if (!cache.has(sel)) cache.set(sel, { textContent: '', className: '' });
      return cache.get(sel);
    },
    node(sel) {
      return cache.get(sel);
    },
  };
}

/**
 * Let the plugin's fire-and-forget async work settle.
 *
 * `setImmediate` is a macrotask, so by the time it fires the whole microtask
 * queue has drained and every `await` in the plugin's chains has been resumed.
 * Counting bare microtask turns instead is fragile: adding one `await` to the
 * plugin silently makes a test that was only just deep enough read a
 * half-applied transition.
 */
async function flush(n = 6) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

/** Collect the plugin's intervals instead of scheduling them. */
function captureIntervals() {
  const real = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  const intervals = [];
  globalThis.setInterval = (fn) => intervals.push(fn);
  globalThis.clearInterval = () => {};
  return {
    intervals,
    restore() {
      globalThis.setInterval = real.setInterval;
      globalThis.clearInterval = real.clearInterval;
    },
  };
}

/**
 * Boot the plugin with a frozen clock, manual intervals and a fake screen.
 * Everything is restored by `restore()`, so tests cannot leak into each other.
 *
 * `window` stays patched for the whole test, not just for `activate()`: the
 * plugin re-reads the work area on wake recovery, so a test that restores it
 * early would silently take the recovery path in the `catch` of the tick.
 */
async function boot() {
  const world = makeCtx();
  const clock = { now: 1_700_000_000_000 };
  const realNow = Date.now;
  const realWindow = globalThis.window;
  Date.now = () => clock.now;
  const intervals = captureIntervals();
  // The plugin listens for `resize` on the main window (the fast path for a
  // display-scale change), so the fake window has to be an event target and has
  // to let a test fire one.
  const listeners = new Map();
  globalThis.window = {
    // A 1920x1080 monitor with a 40 px taskbar: the WORK AREA is what the pill
    // is clamped to, the full size is what the break mask has to cover.
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      availLeft: 0,
      availTop: 0,
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      listeners.get(type)?.delete(fn);
    },
  };
  /** Fire a window event, as the browser would. */
  const emit = (type) => {
    for (const fn of listeners.get(type) ?? []) fn({ type });
  };

  const mod = await freshPlugin();
  await mod.activate(world.ctx);
  await flush();

  return {
    mod,
    ...world,
    clock,
    intervals,
    /**
     * Run `n` ticks, one second apart (a bigger jump looks like a wake-up).
     *
     * The interval callback returns `undefined` — the plugin deliberately
     * fires the tick and forgets it (`onTick().catch(...)`), which is right for
     * a timer but means awaiting the callback awaits nothing. So each step
     * drains the microtask queue afterwards; without that the assertions race
     * the async chain and read a half-applied transition.
     */
    async run(n, stepMs = 1000) {
      for (let i = 0; i < n; i++) {
        clock.now += stepMs;
        await intervals.intervals[0]();
        await flush();
      }
    },
    /** Deliver a command as one of the plugin's own windows would. */
    async cmd(p) {
      const fn = world.subscribers.get('eyecare.cmd');
      assert.ok(fn, 'the plugin must subscribe to eyecare.cmd');
      await fn({ kind: Kind.EVT, topic: 'eyecare.cmd', svc: 'eyecare.demo', p });
      await flush();
    },
    /**
     * Deliver a drag frame the way the pill does — on its OWN topic.
     *
     * `eyecare.cmd` is subscribed by every window this plugin opens and the host
     * delivers to each of them separately, so a message that goes out once per
     * animation frame has no business on the shared topic.
     */
    async drag(p) {
      const fn = world.subscribers.get('eyecare.drag');
      assert.ok(fn, 'the plugin must subscribe to eyecare.drag');
      await fn({ kind: Kind.EVT, topic: 'eyecare.drag', svc: 'eyecare.demo', p });
      await flush();
    },
    states() {
      return world.calls.filter((c) => c.op === 'publish' && c.topic === 'eyecare.state').map((c) => c.p);
    },
    state() {
      const all = this.states();
      assert.ok(all.length, 'the plugin must publish state');
      return all[all.length - 1];
    },
    created(label) {
      return world.calls.filter((c) => c.op === 'create' && c.label === label);
    },
    controls(label, name) {
      return world.calls.filter((c) => c.op === 'control' && c.label === label && c.name === name);
    },
    /** Fire a window event, e.g. `resize`, as the browser would. */
    emit,
    /**
     * Change what `window.screen` reports, then let the plugin notice.
     *
     * There is no event for a resolution change — the plugin polls the
     * signature on every tick — so a test has to move the numbers and then tick.
     */
    async setScreen(next) {
      globalThis.window.screen = { ...globalThis.window.screen, ...next };
      await flush();
    },
    async restore() {
      await mod.deactivate(world.ctx);
      Date.now = realNow;
      intervals.restore();
      globalThis.window = realWindow;
    },
  };
}

// ────────────────────────────────── tests ──────────────────────────────────

test('activate: registers the declared view, arms one tick, starts no idle helper', async () => {
  const w = await boot();
  try {
    assert.ok(w.views.has('eyecare'), 'the view declared in contributes.views must be registered');
    assert.equal(w.intervals.intervals.length, 1, 'exactly one 1 Hz tick');
    assert.ok(w.hotkeys.has('toggle-menu'), 'the declared hotkey must be listened for');
    assert.equal(w.closeHandlers.length, 1, 'the app-close path must be hooked');
    // The helper IS the plugin's only always-on background cost, so what it is
    // allowed to be tied to matters. It serves two phases now — a break being
    // typed through, and a work stretch walked away from — and with
    // `pauseWorkWhenIdle` on by default, a fresh session in `work` wants it.
    assert.equal(
      w.calls.filter((c) => c.op === 'sidecar').length,
      1,
      'the helper runs in the work phase too, for the work-idle reset',
    );
    assert.equal(w.handles.sidecar.exe, 'idle.exe', 'shipped inside the plugin folder');
  } finally {
    await w.restore();
  }
});

test('the idle helper serves both phases, and only the phases that read it', async () => {
  const w = await boot();
  try {
    const sidecars = () => w.calls.filter((c) => c.op === 'sidecar');
    const closed = () => w.calls.filter((c) => c.op === 'closeStream' && c.ch === 'ec-idle');
    assert.equal(sidecars().length, 1, 'the work phase wants it while the switch is on');

    // Turning both switches off must release the process: that is the whole
    // reason the helper is not simply always-on.
    await w.cmd({ act: 'save-config', patch: { pauseWorkWhenIdle: false, pauseOnActive: false } });
    assert.equal(w.state().cfg.pauseWorkWhenIdle, false);
    assert.equal(closed().length, 1, 'neither phase reads it, so it is released');
    assert.equal(w.state().idleOk, false, 'and the capability is withdrawn with it');

    // A phase that reads it starts it again. The session is in `work`, so the
    // switch that matters is the work one — `pauseOnActive` is the break's.
    await w.cmd({ act: 'save-config', patch: { pauseWorkWhenIdle: true } });
    assert.equal(sidecars().length, 2, 'a phase that reads it starts it again');
    w.handles.sidecar.onFrame({ kind: Kind.EVT, topic: 'idle', p: { idleMs: 0 } });
    assert.equal(w.state().idleOk, true, 'sampling is live once a frame arrives');
  } finally {
    await w.restore();
  }
});

test('windows are created hidden and shown only once they report in', async () => {
  const w = await boot();
  try {
    // Until `mountWindow` has run, a plugin window is nothing but the user
    // agent's white page background — that is the white flash on creation.
    assert.equal(w.created(L.pill)[0].opts.visible, false, 'the pill must be created hidden');
    assert.equal(w.controls(L.pill, 'show').length, 0, 'nothing is shown before a window reports in');

    // The window mounts and reports in...
    await w.cmd({ act: 'hello', from: L.pill });
    assert.equal(w.controls(L.pill, 'show').length, 1, 'the pill is shown once it reports in');

    // ...and a re-mount must not show it a second time.
    await w.cmd({ act: 'hello', from: L.pill });
    assert.equal(w.controls(L.pill, 'show').length, 1);

    // The unlock hit-box obeys the same handshake — but it only exists at all
    // while the pill is locked (see `ensureLock`).
    await w.cmd({ act: 'toggle-lock' });
    assert.equal(w.created(L.lock).length, 1, 'locking creates the hit-box');
    assert.equal(w.created(L.lock)[0].opts.visible, false, 'and it is created hidden too');
    assert.equal(w.controls(L.lock, 'show').length, 0, 'still hidden until it reports in');
    await w.cmd({ act: 'hello', from: L.lock });
    assert.equal(w.controls(L.lock, 'show').length, 1);
  } finally {
    await w.restore();
  }
});

test('the pill is a transparent, unfocusable, on-top window and the lock box tracks it', async () => {
  const w = await boot();
  try {
    const pill = w.created(L.pill);
    assert.equal(pill.length, 1, 'one pill window');

    const o = pill[0].opts;
    assert.equal(o.transparent, true);
    assert.equal(o.decorations, false);
    assert.equal(o.shadow, false);
    assert.equal(o.alwaysOnTop, true);
    assert.equal(o.skipTaskbar, true);
    assert.equal(o.resizable, false);
    assert.equal(o.focus, false, 'the pill must never steal the caret');
    // The WIDTH here is only the pre-measurement fallback: the pill measures
    // what it actually holds and reports it (`win-size`), because a fixed 186 px
    // left a 35 px dead gap between the clock and the pause button. The height
    // is a design decision and stays a constant. The fallback is the sum of the
    // chrome plus the widest label at the default 12 px font.
    assert.equal(o.width, 180);
    assert.equal(o.height, 34);

    // The URL is the app's own entry page with all three parameters — the
    // pluginwin loader rejects anything else.
    assert.match(o.url, /^pluginwin\.html\?plugin=eyecare\.demo&label=plugin-ec-pill$/);

    // Default position: the work area's top-right corner.
    assert.equal(o.x, 1920 - 180 - 20);
    assert.equal(o.y, 40);

    // Unlocked: the pill is NOT click-through, and there is no second window.
    // The pill's own lock icon is the target, so target and icon cannot differ.
    assert.deepEqual(w.controls(L.pill, 'clickThrough').map((c) => c.value), [false]);
    assert.equal(w.created(L.lock).length, 0, 'no hit-box window while the pill is clickable');

    // The pill measures where its lock icon actually is and reports the rect.
    await w.cmd({ act: 'lock-rect', from: L.pill, rect: { x: 156, y: 6, w: 22, h: 22 } });

    // Locking parks a hit-box on exactly that rect: a click-through window
    // cannot receive the click that would undo the lock.
    await w.cmd({ act: 'toggle-lock' });
    const lock = w.created(L.lock);
    assert.equal(lock.length, 1, 'one lock hit-box window');
    assert.equal(lock[0].opts.width, 22, 'the target is the size of the icon, not bigger');
    assert.equal(lock[0].opts.height, 22);
    assert.equal(lock[0].opts.x, o.x + 156, 'and it sits where the icon was measured');
    assert.equal(lock[0].opts.y, o.y + 6);
    assert.equal(lock[0].opts.focus, false);
    assert.equal(w.controls(L.pill, 'clickThrough').pop().value, true);

    // Unlocking puts the pill back in charge and takes the window away.
    await w.cmd({ act: 'toggle-lock' });
    assert.equal(w.controls(L.pill, 'clickThrough').pop().value, false);
    assert.equal(w.controls(L.lock, 'close').length, 1, 'the hit-box is closed, not left parked');
  } finally {
    await w.restore();
  }
});

test('the view tree is built through the factory and its status follows the state', async () => {
  const w = await boot();
  try {
    const root = fakeRoot();
    w.views.get('eyecare')(root);

    assert.ok(root.__tree, 'render() must be called with a tree');
    // Walk it: every node is a descriptor from the mock factory, and the tags
    // are the ones the static audit checks against the real vocabulary.
    const tags = new Set();
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object' || !node.tag) return;
      tags.add(node.tag);
      walk(node.children);
    };
    walk(root.__tree);
    for (const t of [
      'card',
      'card-header',
      'card-content',
      'button',
      'input',
      'slider',
      'switch',
      // The real `select` component, not `native-select`: a trigger plus a
      // portalled popup. Its parts are all separate tags in the vocabulary.
      'select',
      'select-trigger',
      'select-value',
      'select-content',
      'select-item',
    ]) {
      assert.ok(tags.has(t), `the view should use <${t}> (used: ${[...tags].join(', ')})`);
    }

    // paintView() ran as part of renderPanel(): the status row is live, not a
    // placeholder, and it is painted WITHOUT re-rendering (which would drop
    // focus in the inputs).
    assert.equal(root.node('.ec-mode').textContent, '专注中');
    assert.match(root.node('.ec-remain').textContent, /^\d{2}:\d{2}$/);
    assert.match(root.node('.ec-win').textContent, /悬浮窗/);
    assert.match(root.node('.ec-idle').textContent, /空闲检测/);
  } finally {
    await w.restore();
  }
});

test('work -> rest: a full-screen click-through mask plus its control window', async () => {
  const w = await boot();
  try {
    // Shorten the cycle through the same command path the UI uses.
    await w.cmd({ act: 'save-config', patch: { workMinutes: 0.1 } });
    assert.equal(w.state().cfg.workMinutes, 0.1);
    await w.cmd({ act: 'reset' });

    // 6 s of work: the tick must flip the mode on its own.
    await w.run(7);
    assert.equal(w.state().mode, 'rest');

    const mask = w.created(L.rest);
    const ctl = w.created(L.ctl);
    assert.equal(mask.length, 1);
    assert.equal(ctl.length, 1);
    // No `fullscreen` option exists in the allow-list, so the mask is an
    // oversized window instead — that is the documented emulation. It is sized
    // to the WHOLE monitor (1080 tall, not the 1040-tall work area), which is
    // what makes it cover the TASKBAR: the mask used to be work-area-sized, so
    // the taskbar stayed visible through the break. The pad is only a few
    // pixels to absorb a fractional-pixel monitor origin — it used to be 80 on
    // every side, i.e. 25% more transparent surface than the screen.
    assert.equal(mask[0].opts.width, 1920 + 12);
    assert.equal(mask[0].opts.height, 1080 + 12);
    assert.equal(mask[0].opts.x, -6);
    assert.equal(mask[0].opts.y, -6);
    assert.equal(mask[0].opts.focus, false);
    // ...and it is click-through, so it never eats a click.
    assert.deepEqual(w.controls(L.rest, 'clickThrough').map((c) => c.value), [true]);
    // The pill is raised AFTER the mask was created: every window here is
    // alwaysOnTop, so among themselves the z-order is creation order and a
    // later mask would otherwise bury the countdown.
    const maskAt = w.calls.findIndex((c) => c.op === 'create' && c.label === L.rest);
    const raised = w.calls.findIndex(
      (c, i) => i > maskAt && c.op === 'control' && c.label === L.pill && c.name === 'show',
    );
    assert.ok(raised > maskAt, 'the pill must be re-shown after the mask exists');

    assert.ok(
      w.calls.some((c) => c.op === 'notify' && c.message.includes('工作时间到')),
      'the user must be told the break started',
    );
    assert.equal(w.state().label.startsWith('Rest:'), true);
  } finally {
    await w.restore();
  }
});

test('the break windows are pre-loaded, so the mask is painted before the break starts', async () => {
  const w = await boot();
  try {
    await w.cmd({ act: 'save-config', patch: { workMinutes: 0.5 } }); // 30 s
    await w.cmd({ act: 'reset' });
    await w.run(10); // 20 s left — the lead time
    assert.equal(w.created(L.rest).length, 1, 'the mask is loaded ahead of time');
    assert.equal(w.created(L.ctl).length, 1);
    assert.equal(w.controls(L.rest, 'show').length, 0, 'pre-loading must not show anything');
    assert.equal(w.state().mode, 'work', 'and it must not start the break either');

    // The window mounts while it is still hidden...
    await w.cmd({ act: 'hello', from: L.rest });
    assert.equal(w.controls(L.rest, 'show').length, 0, 'still hidden: no break yet');

    // ...so when the break does start there is nothing left to wait for.
    await w.run(20);
    assert.equal(w.state().mode, 'rest');
    assert.equal(w.controls(L.rest, 'show').length, 1, 'shown the moment the break starts');
    assert.equal(w.created(L.rest).length, 1, 'reused, not re-created');
  } finally {
    await w.restore();
  }
});

test('the rest countdown freezes while the user is still typing', async () => {
  const w = await boot();
  try {
    await w.cmd({ act: 'rest-now' });
    assert.equal(w.state().mode, 'rest');
    const before = w.state().label;

    // The helper says "input 0 ms ago" — the user is active.
    w.handles.sidecar.onFrame({ kind: Kind.EVT, topic: 'idle', p: { idleMs: 0 } });
    await flush();
    assert.equal(w.state().userActive, true);

    await w.run(5);
    assert.equal(w.state().label, before, 'the countdown must not advance while the user is active');

    // Hands off: the countdown resumes.
    w.handles.sidecar.onFrame({ kind: Kind.EVT, topic: 'idle', p: { idleMs: 60000 } });
    await flush();
    assert.equal(w.state().userActive, false);
    await w.run(5);
    assert.notEqual(w.state().label, before, 'the countdown resumes once the user is idle');
  } finally {
    await w.restore();
  }
});

test('the idle helper survives a phase flip, and degrades if it dies', async () => {
  const w = await boot();
  const sidecars = () => w.calls.filter((c) => c.op === 'sidecar');
  try {
    // It is already running: the work phase reads it too.
    assert.equal(sidecars().length, 1);
    w.handles.sidecar.onFrame({ kind: Kind.EVT, topic: 'idle', p: { idleMs: 0 } });
    await flush();
    assert.equal(w.state().idleOk, true, 'sampling is live once a frame arrives');

    // A break does NOT tear it down and rebuild it. Both phases read it, so the
    // phase flip is invisible to the helper — which is also what keeps the
    // channel from being closed and reopened on every cycle.
    await w.cmd({ act: 'rest-now' });
    assert.equal(w.state().mode, 'rest');
    assert.equal(sidecars().length, 1, 'the helper is not restarted for a break');
    assert.equal(
      w.calls.filter((c) => c.op === 'closeStream' && c.ch === 'ec-idle').length,
      0,
      'and it is not released either',
    );
    assert.equal(w.state().idleOk, true, 'it keeps sampling across the flip');

    // No capability is claimed until the helper has actually reported: a
    // sidecar that was spawned but never speaks is not evidence of sampling.
    w.handles.sidecar.onFrame({ kind: Kind.EVT, topic: 'idle', p: { idleMs: 5000 } });
    await flush();
    assert.equal(w.state().userActive, false, '5 s of silence is not "active"');

    // A crash degrades instead of breaking: the countdown keeps running.
    w.handles.sidecar.onEnd({ kind: Kind.EXIT, p: 1 });
    await flush();
    assert.equal(w.state().idleOk, false, 'the plugin reports the capability as unavailable');
    assert.match(w.state().idleWhy, /idle\.exe/, 'and says why, so it is not a silent failure');
    await w.run(3);
    assert.ok(w.state().label.length > 0);
  } finally {
    await w.restore();
  }
});

test('commands from the windows: lock, drag clamping, config clamps, skip', async () => {
  const w = await boot();
  try {
    // Lock toggles the pill's click-through, which is the whole point of it.
    await w.cmd({ act: 'toggle-lock', from: L.lock });
    assert.equal(w.state().locked, true);
    assert.equal(w.controls(L.pill, 'clickThrough').pop().value, true);
    await w.cmd({ act: 'toggle-lock', from: L.lock });
    assert.equal(w.controls(L.pill, 'clickThrough').pop().value, false);

    // A drag is clamped into the work area, and the CLAMPED value is what gets
    // persisted — otherwise a bad drag would restore off screen.
    await w.cmd({ act: 'move', x: -99999, y: -99999, live: false });
    const pos = w.controls(L.pill, 'position').pop().value;
    assert.equal(pos.x, -10);
    assert.equal(pos.y, -10);
    const saved = w.calls.filter((c) => c.op === 'storage.set' && c.key === 'config').pop().value;
    assert.equal(saved.pillX, -10);
    assert.equal(saved.pillY, -10);

    // Out-of-range numbers from the settings page are converged, not trusted.
    await w.cmd({ act: 'save-config', patch: { workMinutes: 99999, fadeMs: -50, theme: 'Nope' } });
    const cfg = w.state().cfg;
    assert.equal(cfg.workMinutes, 600);
    assert.equal(cfg.fadeMs, 0);
    assert.equal(cfg.theme, 'Dark', 'an unknown theme falls back rather than breaking every window');

    // The menu is created lazily on first open, sized for the action list.
    assert.equal(w.created(L.menu).length, 0, 'no menu window before it is opened');
    await w.cmd({ act: 'toggle-menu' });
    assert.equal(w.state().menuOpen, true);
    assert.equal(w.created(L.menu).length, 1);
    assert.equal(w.created(L.menu)[0].opts.width, 186);

    // The settings page needs a bigger window, so the menu is RESIZED in place
    // rather than re-created — a second webview per page switch would be waste.
    // The height here is the FALLBACK: in the app the menu measures its own
    // content and reports it (`win-size`), which is how the 200 px of empty
    // space the old hardcoded 566 left at the bottom of this page went away.
    await w.cmd({ act: 'menu-page', page: 'cfg' });
    assert.equal(w.state().menuPage, 'cfg');
    const size = w.controls(L.menu, 'size').pop();
    assert.deepEqual(size.value, { width: 276, height: 372 });
    assert.equal(w.created(L.menu).length, 1, 'resized, not re-created');

    // Closing the menu returns it to the action list, so the next open is the
    // small one again.
    await w.cmd({ act: 'close-menu' });
    assert.equal(w.state().menuOpen, false);
    assert.equal(w.state().menuPage, 'menu');

    await w.cmd({ act: 'rest-now' });
    assert.equal(w.state().mode, 'rest');
    await w.cmd({ act: 'skip-rest', from: L.ctl });
    assert.equal(w.state().mode, 'work');
  } finally {
    await w.restore();
  }
});

test('a long gap is treated as a wake-up, not as a missed tick', async () => {
  const w = await boot();
  try {
    await w.cmd({ act: 'reset' });
    // 10 minutes pass between two ticks: the machine slept.
    await w.run(1, 10 * 60 * 1000);
    const s = w.state();
    assert.equal(s.mode, 'work');
    // The cycle restarted rather than being counted down by the sleep.
    assert.equal(s.label, 'Work: 25:00');
    // ...and it went through recovery, not through the ordinary tick path: a
    // long gap must re-read the work area (the machine may have woken on a
    // different monitor) instead of trusting a stale one.
    assert.ok(
      w.logs.some((l) => l.level === 'info' && l.m.includes('wake detected')),
      'a gap this large must be treated as a wake-up',
    );
  } finally {
    await w.restore();
  }
});

test('a live drag moves the pill and nothing else', async () => {
  const w = await boot();
  try {
    // Set up the worst case: a lock hit-box AND an open menu, i.e. two more
    // windows that have to follow the pill.
    await w.cmd({ act: 'lock-rect', from: L.pill, rect: { x: 156, y: 6, w: 22, h: 22 } });
    await w.cmd({ act: 'toggle-lock' });
    await w.cmd({ act: 'toggle-menu' });
    assert.equal(w.created(L.lock).length, 1);
    assert.equal(w.created(L.menu).length, 1);

    const from = w.calls.length;
    await w.drag({ act: 'move', x: 100, y: 100, live: true });
    const live = w.calls
      .slice(from)
      .filter((c) => c.op === 'control' && c.name === 'position')
      .map((c) => c.label);
    // Every `control` call is two IPC round trips (`getByLabel` + the setter),
    // and this runs once per animation frame. Dragging the companion windows
    // along as well is what made dragging the pill stutter.
    assert.deepEqual(live, [L.pill], 'a live drag must touch the pill only');

    // The END of the drag is where everything is put back in line, and where
    // the new position is persisted.
    await w.drag({ act: 'move', x: 120, y: 130, live: false });
    const all = w.calls
      .slice(from)
      .filter((c) => c.op === 'control' && c.name === 'position')
      .map((c) => c.label);
    assert.deepEqual(all, [L.pill, L.pill, L.lock, L.menu], 'the drag end re-syncs the companions');
    const saved = w.calls.filter((c) => c.op === 'storage.set' && c.key === 'config').pop().value;
    assert.equal(saved.pillX, 120);
    assert.equal(saved.pillY, 130);
  } finally {
    await w.restore();
  }
});

test('changing the current phase duration restarts it, immediately', async () => {
  const w = await boot();
  try {
    await w.cmd({ act: 'reset' });
    await w.run(5);
    assert.equal(w.state().label, 'Work: 24:55');

    // The phase being edited restarts at the new length. Without this the pill
    // kept counting down the OLD duration, so "set it to 1 minute" looked like
    // it had done nothing until the next cycle.
    await w.cmd({ act: 'save-config', patch: { workMinutes: 1 } });
    assert.equal(w.state().label, 'Work: 01:00');

    // The other phase's length must NOT throw the work countdown away.
    await w.run(5);
    assert.equal(w.state().label, 'Work: 00:55');
    await w.cmd({ act: 'save-config', patch: { restMinutes: 30 } });
    assert.equal(w.state().label, 'Work: 00:55', 'editing the break length must not restart work');

    // Inside a break it is the break that restarts.
    await w.cmd({ act: 'rest-now' });
    assert.equal(w.state().label, 'Rest: 30:00');
    await w.cmd({ act: 'save-config', patch: { restMinutes: 2 } });
    assert.equal(w.state().label, 'Rest: 02:00');
  } finally {
    await w.restore();
  }
});

test('windows size themselves from what they measure', async () => {
  const w = await boot();
  try {
    // The worst case: a lock hit-box and an open menu — two more windows that
    // have to follow the pill.
    await w.cmd({ act: 'lock-rect', from: L.pill, rect: { x: 150, y: 6, w: 22, h: 22 } });
    await w.cmd({ act: 'toggle-lock' });
    await w.cmd({ act: 'toggle-menu' });

    // The hit-box is parked on the pill's right edge, from the reported rect.
    assert.equal(w.created(L.lock)[0].opts.x, 1720 + 150);
    assert.equal(w.created(L.lock)[0].opts.y, 40 + 6);

    // The pill measured its content and asks for the width it needs. This is the
    // only source of truth for it: a constant goes stale the moment the font,
    // the scale or the theme changes — and a fixed 186 px left a 35 px dead gap.
    await w.cmd({ act: 'win-size', from: L.pill, w: 300 });
    assert.deepEqual(w.controls(L.pill, 'size').pop().value, { width: 300, height: 34 });
    // It grew past the screen edge it was parked against, so it is re-clamped
    // rather than left hanging off the monitor.
    assert.equal(w.controls(L.pill, 'position').pop().value.x, 1920 - 300 - 10);
    // The hit-box rides on that edge, so it has to be re-glued.
    assert.equal(w.controls(L.lock, 'position').pop().value.x, 1920 - 300 - 10 + 150);
    // ...and the state carries the measurement, so the view can show it.
    assert.equal(w.state().pillW, 300);

    // An unchanged report must not cause a second resize — that is what stops
    // the measure -> resize -> measure exchange from spinning.
    const before = w.controls(L.pill, 'size').length;
    await w.cmd({ act: 'win-size', from: L.pill, w: 300 });
    assert.equal(w.controls(L.pill, 'size').length, before, 'an unchanged report is ignored');

    // A one-axis report must not zero the other axis. The pill reports a width
    // only, and defaulting the height to 0 collapsed it to a sliver.
    const pillSizes = w.controls(L.pill, 'size').map((c) => c.value.height);
    assert.ok(pillSizes.every((h) => h === 34), 'the height must survive a width-only report');

    // The menu measures its height per page, and only the height: a menu whose
    // width changed with its longest row would twitch.
    await w.cmd({ act: 'win-size', from: L.menu, h: 259, page: 'menu' });
    assert.equal(w.controls(L.menu, 'size').pop().value.height, 259);
    await w.cmd({ act: 'menu-page', page: 'cfg' });
    // A report for the OTHER page must not be reused for this one.
    assert.equal(w.controls(L.menu, 'size').pop().value.height, 372, 'falls back for an unmeasured page');
    await w.cmd({ act: 'win-size', from: L.menu, h: 579, page: 'cfg' });
    assert.equal(w.controls(L.menu, 'size').pop().value.height, 579);

    // Now the mask. It is created at its rect and never resized on creation.
    await w.cmd({ act: 'rest-now' });
    assert.equal(w.created(L.rest).length, 1);
    const maskTouches = () => w.controls(L.rest, 'size').length + w.controls(L.rest, 'position').length;
    const maskBefore = maskTouches();

    // A 22 px hit-box reporting itself must not touch the screen-sized mask.
    // It used to: `lock-rect` went through `syncGeometry`, which re-applied the
    // mask rect — a full-screen move + resize triggered by an icon, on a path
    // that runs on every state broadcast while the pill is locked.
    await w.cmd({ act: 'lock-rect', from: L.pill, rect: { x: 270, y: 6, w: 22, h: 22 } });
    assert.equal(maskTouches(), maskBefore, 'a hit-box report must not move the mask');
    assert.equal(w.controls(L.lock, 'position').pop().value.x, 1920 - 300 - 10 + 270);

    // The break buttons measure both axes: they needed 254x39 where the window
    // used to be 250x42, which is why their labels wrapped to two lines and the
    // 999 px radius clipped each one into a squashed ellipse.
    await w.cmd({ act: 'win-size', from: L.ctl, w: 254, h: 39 });
    assert.deepEqual(w.controls(L.ctl, 'size').pop().value, { width: 254, height: 39 });
    assert.equal(w.controls(L.ctl, 'position').pop().value.x, 1920 - 254 - 24);
    assert.equal(maskTouches(), maskBefore, 'the buttons must not move the mask either');
  } finally {
    await w.restore();
  }
});

test('the pill size knobs are ordinary config, carried in the state', async () => {
  const w = await boot();
  try {
    const s = w.state();
    assert.equal(s.pillScale, 1);
    assert.equal(s.pillFontSize, 12);
    assert.ok(s.pillW > 0 && s.pillH > 0, 'the state must carry the pill geometry');
    const before = s.pillW;

    // Converged like every other knob, so a bad value cannot produce a pill
    // that is one pixel tall.
    await w.cmd({ act: 'save-config', patch: { pillScale: 99, pillFontSize: 1 } });
    assert.equal(w.state().cfg.pillScale, 1.8);
    assert.equal(w.state().cfg.pillFontSize, 9);
    // Scale moves the height, font moves the width — two orthogonal knobs, so
    // "bigger widget" and "bigger text" stay separate decisions.
    assert.ok(w.state().pillH > 34, 'the scale knob moves the height');
    assert.notEqual(w.state().pillW, before, 'the knobs move the width too');
  } finally {
    await w.restore();
  }
});

test('deactivate closes every window it opened', async () => {
  const w = await boot();
  try {
    await w.cmd({ act: 'rest-now' });
    await w.restore();
    const closed = w.calls.filter((c) => c.op === 'control' && c.name === 'close').map((c) => c.label);
    for (const label of [L.pill, L.lock, L.rest, L.ctl]) {
      assert.ok(closed.includes(label), `${label} must be closed on deactivate`);
    }
  } finally {
    // already restored
  }
});

test('the menu hangs off the pill’s right edge, which is the edge that stays put', async () => {
  const w = await boot();
  try {
    await w.cmd({ act: 'toggle-menu' });
    // The menu reports its own height; that report is what re-places it.
    await w.cmd({ act: 'win-size', from: L.menu, h: 259, page: 'menu' });
    const box = w.controls(L.menu, 'position').pop();
    assert.ok(box, 'the menu must be placed');
    const pill = w.created(L.pill)[0].opts;
    const s = w.state();
    // Right edges coincide. Aligning LEFT edges cannot work here: the menu is
    // wider than the pill and the pill is anchored to the right of the work
    // area, so the left edge gets clamped and then matches nothing.
    const menuW = 186; // the menu's width is a design constant; only its height is measured
    assert.equal(box.value.x + menuW, pill.x + s.pillW, 'the menu and the pill share a right edge');
    assert.ok(box.value.x >= 6, 'and the menu stays inside the work area');

    // The alignment is a property of the RULE, not of these two numbers: widen
    // the pill and the menu has to move with it.
    await w.cmd({ act: 'win-size', from: L.pill, w: 300 });
    const moved = w.controls(L.menu, 'position').pop().value;
    const pillNow = w.controls(L.pill, 'position').pop().value;
    assert.equal(moved.x + menuW, pillNow.x + 300, 'still flush after the pill grows');
  } finally {
    await w.restore();
  }
});

test('work-time idle resets the focus countdown and holds it until input returns', async () => {
  const w = await boot();
  try {
    // The helper runs in the work phase now, because the work phase reads it.
    w.handles.sidecar.onFrame({ kind: Kind.EVT, topic: 'idle', p: { idleMs: 0 } });
    await flush();
    await w.run(5);
    assert.match(w.state().label, /^Work: 2[45]:/, 'the work countdown is running');

    // The user walks away: 400 s of silence is past the 300 s default.
    w.handles.sidecar.onFrame({ kind: Kind.EVT, topic: 'idle', p: { idleMs: 400_000 } });
    await flush();
    assert.equal(w.state().workIdlePaused, true, 'the focus countdown is held');
    assert.equal(w.state().label, 'Work: 25:00', 'and reset to the top, not merely paused');

    // Held means held: ten seconds of ticks must not move it.
    await w.run(10);
    assert.equal(w.state().label, 'Work: 25:00');

    // Input returns. The hold is released and a fresh period starts counting.
    w.handles.sidecar.onFrame({ kind: Kind.EVT, topic: 'idle', p: { idleMs: 0 } });
    await flush();
    assert.equal(w.state().workIdlePaused, false);
    await w.run(3);
    assert.equal(w.state().label, 'Work: 24:57', 'the new period counts from the moment they returned');
  } finally {
    await w.restore();
  }
});

test('the work-idle hold never fights the pause button', async () => {
  const w = await boot();
  try {
    w.handles.sidecar.onFrame({ kind: Kind.EVT, topic: 'idle', p: { idleMs: 0 } });
    await flush();
    // The user pauses on purpose, then leaves.
    await w.cmd({ act: 'toggle-pause' });
    assert.equal(w.state().paused, true);
    w.handles.sidecar.onFrame({ kind: Kind.EVT, topic: 'idle', p: { idleMs: 400_000 } });
    await flush();
    assert.equal(w.state().workIdlePaused, true, 'the hold is a separate flag');
    // Coming back must NOT undo a pause the user chose.
    w.handles.sidecar.onFrame({ kind: Kind.EVT, topic: 'idle', p: { idleMs: 0 } });
    await flush();
    assert.equal(w.state().workIdlePaused, false);
    assert.equal(w.state().paused, true, 'the manual pause survives the round trip');
  } finally {
    await w.restore();
  }
});

test('a resolution change re-places the pill and its hit-box together', async () => {
  const w = await boot();
  try {
    await w.cmd({ act: 'lock-rect', from: L.pill, rect: { x: 156, y: 6, w: 22, h: 22 } });
    await w.cmd({ act: 'toggle-lock' });
    // The hit-box is created AT its rect, so the creation options are the
    // position until something moves it.
    assert.equal(w.created(L.lock)[0].opts.x, 1720 + 156, 'the hit-box sits on the icon');

    // The screen shrinks. The pill is now outside the new work area, so both it
    // and the hit-box have to move — and they have to move TOGETHER, which is
    // what failed before: the plugin kept clamping against the old screen and
    // the hit-box kept being placed from its own stale idea of where the pill
    // was, so the click-through control and the lock icon drifted apart.
    await w.setScreen({ width: 1280, height: 720, availWidth: 1280, availHeight: 680 });
    await w.run(1);

    const pill = w.controls(L.pill, 'position').pop().value;
    const lock = w.controls(L.lock, 'position').pop().value;
    assert.equal(pill.x, 1280 - w.state().pillW - 10, 'the pill is clamped into the new screen');
    assert.equal(lock.x, pill.x + 156, 'and the hit-box follows it exactly');
    assert.equal(lock.y, pill.y + 6);

    // A display-scale change fires `resize` without changing any of those
    // numbers, so the listener alone would miss it — the tick comparison is the
    // path that catches a plain resolution change.
    await w.setScreen({ width: 1024, height: 768, availWidth: 1024, availHeight: 728 });
    w.emit('resize');
    await flush();
    assert.equal(
      w.controls(L.pill, 'position').pop().value.x,
      1024 - w.state().pillW - 10,
      'the resize listener is the fast path',
    );
  } finally {
    await w.restore();
  }
});
