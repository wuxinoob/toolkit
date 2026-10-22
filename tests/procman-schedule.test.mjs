/**
 * A schedule must not turn into a busy loop when it wakes up and finds the
 * process it supervises already running.
 *
 * The reported defect: a profile with an INTERVAL schedule was left running
 * overnight; the machine slept through a slot; on wake the plugin posted
 * `"…" is already running` to the bottom-right corner again and again, forever,
 * and the app was unusable until the plugin was deactivated.
 *
 * The loop was two ordinary behaviours that are each correct alone:
 *
 *   `dueAt` counts an interval from the LAST FIRING (so a slept-through night
 *   runs once on wake), which after a sleep is a time in the PAST →
 *   `armSchedules` arms a 0ms timer → the firing calls `launchProfile`, which
 *   found the process alive and returned early WITHOUT stamping `lastFired` →
 *   the slot was still overdue → 0ms again. Nothing in the state ever changed,
 *   so it never ended.
 *
 * So the property under test is a BEHAVIOUR, not a shape: with a process that
 * stays up, one interval of wall clock must produce at most ONE firing, no
 * matter how the clock got there. A regex on `lastFired.set(...)` would pass
 * for any placement of that line — which is the mistake this repo has made
 * before, so the test drives the real timers of the real plugin module.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// CSS imports, xterm and the Vue component vocabulary are a bundler concern.
register('./browser-stubs-loader.mjs', import.meta.url);

// The only user of rAF here is the row/detail refresh, and this test never
// renders. A no-op keeps those helpers off `document`.
globalThis.requestAnimationFrame = () => 0;

// A document with no view mounted: every lookup misses, which is the state the
// plugin is in when its view is not the active one. `selectProfile` (the manual
// Run path) must survive that — the toast is the whole point, and it must not
// depend on a mounted view.
globalThis.document = { querySelector: () => null };

const { activate, deactivate } = await import('../src/plugins/procman.js');

const T0 = new Date(2026, 8, 18, 9, 0, 0, 0).getTime();
const MINUTE = 60_000;

/**
 * The profile from the report: an interval schedule and a process that stays up.
 *
 * The id is a parameter because the plugin module is a singleton for the whole
 * test file — sessions and timers outlive `deactivate()` (that is deliberate:
 * a process must not die because a view was rebuilt), so a second activation
 * with the SAME id would find a live session and skip its auto-start.
 */
function makeCtx(id = 'p1', schedule = { kind: 'interval', everyMinutes: 1 }, overrides = {}) {
  const profile = {
    id,
    name: `watcher-${id}`,
    program: 'node',
    args: ['-e', 'setInterval(() => {}, 1000)'],
    enabled: true,
    autoStart: true,
    schedule,
    ...overrides,
  };
  const spawns = [];
  const notifies = [];
  const logs = [];
  const ctx = {
    storage: {
      get: async (key) => (key === 'profiles' ? [profile] : null),
      set: async () => {},
    },
    // A handle that never emits: the session stays `running`, which is the
    // state the schedule woke up to.
    pty: async (ch, cfg) => {
      spawns.push({ ch, cfg });
      return {
        pid: 1000 + spawns.length,
        bells: () => 0,
        write() {},
        resize() {},
        close: async () => {},
      };
    },
    ui: {
      notify: (msg, level) => notifies.push({ msg, level }),
      el: () => null,
      native: () => null,
      render: () => {},
    },
    log: { info: (cat, msg) => logs.push(`${cat} ${msg}`), warn: () => {} },
    cleanup: () => {},
    registerView: () => {},
  };
  return { ctx, spawns, notifies, logs };
}

/** Let promise chains (launchProfile → .finally → armSchedules) settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a schedule that finds the process up consumes the slot instead of spinning', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const { ctx, spawns, notifies, logs } = makeCtx();
  t.after(() => deactivate());

  await activate(ctx);
  assert.equal(spawns.length, 1, 'auto-start launches the profile once');
  assert.equal(notifies.length, 0, `nothing to report yet: ${JSON.stringify(notifies)}`);

  const firings = () => logs.filter((line) => /already running/.test(line)).length;

  // The machine sleeps through eight hours of one-minute slots. The timer armed
  // for +60s is now hours overdue — that IS the wake-up state, and the reason
  // the report says "after a long standby" rather than "every minute".
  t.mock.timers.setTime(T0 + 8 * 60 * MINUTE);

  // One second of wall clock: the catch-up run happens once, not once per
  // missed slot ("a slept-through night runs once").
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(firings(), 1, 'waking up fires the overdue slot exactly once');

  // Then eleven minutes at one second per turn. A schedule that re-arms itself
  // without moving its anchor fires on every turn here; a schedule fires eleven
  // times.
  for (let i = 0; i < 11 * 60; i++) {
    t.mock.timers.tick(1000);
    await settle();
  }

  assert.equal(spawns.length, 1, 'the schedule must never start a second copy of a live profile');
  assert.equal(
    notifies.length,
    0,
    `a scheduled no-op is not news — one interval of wall clock produced ${notifies.length} ` +
      `toast(s), first: ${notifies[0]?.msg ?? 'none'}`,
  );
  // The window is deliberately loose (a slot can land a second early or late);
  // what matters is the order of magnitude: a spin is hundreds, and a 0ms spin
  // is unbounded.
  assert.ok(
    firings() >= 10 && firings() <= 12,
    `one firing per interval, not one per event-loop turn — saw ${firings()} firings in 11 minutes`,
  );
});

test('a manual Run still says the profile is already running', async (t) => {
  // The toast is not the bug: it is the answer to a question a person asked.
  // Only the scheduled path goes quiet.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const { ctx, spawns, notifies } = makeCtx('p2');
  t.after(() => deactivate());

  await activate(ctx);
  assert.equal(spawns.length, 1, 'auto-start launched it');

  await globalThis.window.__toolbox.procman.launch('p2', 'manual');

  assert.equal(spawns.length, 1, 'pressing Run on a live profile does not start a second copy');
  assert.equal(notifies.length, 1, 'a person pressing Run gets an answer');
  assert.match(notifies[0].msg, /already running/);
});

// ------------------------------------ cron -----------------------------------

/**
 * A cron schedule is the one kind whose slots are NOT evenly spaced, so "fire
 * every time the timer wakes up" and "fire at each matching minute" are
 * different answers. Both tests below would pass for a schedule that simply
 * fired once per minute — so the five-minute case is the one that matters: it
 * must produce nothing for four minutes.
 */
test('a cron schedule fires at its matching minutes, once each', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const { ctx, spawns, logs } = makeCtx(
    'cron1',
    { kind: 'cron', cron: '* * * * *' },
    { autoStart: false },
  );
  t.after(() => deactivate());

  await activate(ctx);
  assert.equal(spawns.length, 0, 'auto-start is off, so nothing runs yet');

  const advance = async (seconds) => {
    for (let i = 0; i < seconds; i++) {
      t.mock.timers.tick(1000);
      await settle();
    }
  };

  // T0 is exactly 09:00:00; the first match is 09:01:00.
  await advance(60);
  assert.equal(spawns.length, 1, 'fired at the top of the minute');
  assert.match(logs.find((l) => /launch/.test(l)) ?? '', /\(schedule\)/, 'and it was the schedule that did it');

  // The process stays up, so the next slot is consumed as a no-op — which is
  // exactly how we can tell the timer fired at 09:02 without a second spawn.
  await advance(60);
  assert.equal(spawns.length, 1, 'one profile still owns one process');
  assert.equal(
    logs.filter((l) => /already running/.test(l)).length,
    1,
    `the 09:02 slot must fire exactly once, log: ${JSON.stringify(logs)}`,
  );
});

test('a five-minute cron is silent for the four minutes in between', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const { ctx, spawns } = makeCtx(
    'cron5',
    { kind: 'cron', cron: '*/5 * * * *' },
    { autoStart: false },
  );
  t.after(() => deactivate());

  await activate(ctx);
  for (let i = 0; i < 4 * 60; i++) {
    t.mock.timers.tick(1000);
    await settle();
  }
  assert.equal(spawns.length, 0, '09:01–09:04 do not match */5');

  for (let i = 0; i < 61; i++) {
    t.mock.timers.tick(1000);
    await settle();
  }
  assert.equal(spawns.length, 1, '09:05 does');
});

/**
 * `setTimeout` cannot hold a delay above 2^31-1 ms (~24.8 days): the timer is
 * armed at the ceiling instead. So "the timer fired" is not "it is due" — and a
 * schedule that treats the two as the same runs in the middle of the year.
 *
 * `0 0 1 1 *` is ~105 days out from the test clock, i.e. four ceiling-length
 * checkpoints before the real slot.
 */
test('a cron slot beyond the timer ceiling waits, then fires on the day', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const { ctx, spawns } = makeCtx(
    'cronYear',
    { kind: 'cron', cron: '0 0 1 1 *' },
    { autoStart: false },
  );
  t.after(() => deactivate());

  await activate(ctx);

  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(2 ** 31 - 1);
    await settle();
    assert.equal(spawns.length, 0, `checkpoint ${i + 1} is not the due date`);
  }

  t.mock.timers.tick(2 ** 31 - 1);
  await settle();
  assert.equal(spawns.length, 1, 'the fifth wake-up crosses Jan 1 and fires');
});
