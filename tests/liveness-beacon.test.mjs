/**
 * The distress beacon — the only liveness signal that does not travel over IPC.
 *
 * Why this needs a test: the beacon's whole value is that it keeps moving while
 * the bridge is dead. A beacon that silently stops (a typo in the marker, a
 * timer that never starts, a `disarm` that runs too early) looks exactly like a
 * frozen renderer, so it would *manufacture* the wrong diagnosis — worse than
 * having no probe at all.
 *
 * The format is pinned against the host's parser by hand: `forensics.rs`
 * looks for `#hb:` followed by digits, and `host-checks` asserts the same
 * string from the Rust side.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};
globalThis.document = { title: '' };

const { beaconTitle, armBeacon, disarmBeacon, isArmed, beaconState } = await import(
  '../src/host/liveness.js'
);

test('beacon title is what the host parser expects', () => {
  // Exactly the shape `forensics::parse_beacon` reads: `#hb:<digits>` at the
  // end, so a plugin that retitles its window cannot confuse it.
  assert.equal(beaconTitle('护眼助手', 42, 42), '护眼助手 · 桥接异常 42s #hb:42');
  assert.equal(beaconTitle('', 1, 1), '桥接异常 1s #hb:1');
  // The marker must be the LAST thing in the string.
  assert.ok(beaconTitle('x', 5, 9).endsWith('#hb:9'));
});

test('arming starts the counter, disarming restores the title', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  globalThis.document.title = '护眼助手';
  ls.clear();

  assert.equal(isArmed(), false);
  armBeacon('test outage');
  assert.equal(isArmed(), true);
  // Armed and published immediately: a beacon that waits for its first tick
  // would be invisible in exactly the case where timers are the thing stalling.
  assert.match(globalThis.document.title, /#hb:1$/);
  assert.equal(beaconState().reason, 'test outage');

  t.mock.timers.tick(1000);
  assert.match(globalThis.document.title, /#hb:2$/);
  t.mock.timers.tick(1000);
  assert.match(globalThis.document.title, /#hb:3$/);
  // The counter is what the host samples: it must strictly increase while the
  // renderer is running JavaScript, no matter what the wall clock does.
  assert.equal(beaconState().seq, 3);

  disarmBeacon();
  assert.equal(isArmed(), false);
  assert.equal(globalThis.document.title, '护眼助手');
  assert.equal(ls.has('toolbox.beacon'), false);
});

test('disarming does not clobber a title someone else set meanwhile', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  globalThis.document.title = '护眼助手';
  armBeacon('x');
  // A plugin retitles its window during the outage.
  globalThis.document.title = '别人的标题';
  disarmBeacon();
  // Restoring the captured base here would overwrite the newer, correct title.
  assert.equal(globalThis.document.title, '别人的标题');
});

test('arming twice does not stack timers', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  globalThis.document.title = 'a';
  armBeacon('one');
  armBeacon('two');
  t.mock.timers.tick(1000);
  // One interval -> seq 2. Two intervals would make it 3 (or worse).
  assert.equal(beaconState().seq, 2);
  disarmBeacon();
});

test('the beacon is persisted so a restart keeps the evidence', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  globalThis.document.title = 'a';
  ls.clear();
  armBeacon('persisted');
  // Written every 5th tick, not every tick: localStorage is a synchronous
  // cross-process write and doing it once a second is a real cost.
  // `armBeacon` publishes tick 1 itself, so three more lands on 4.
  t.mock.timers.tick(3000);
  assert.equal(ls.has('toolbox.beacon'), false);
  t.mock.timers.tick(1000);
  const rec = JSON.parse(ls.get('toolbox.beacon'));
  assert.equal(rec.seq, 5);
  assert.equal(rec.reason, 'persisted');
  disarmBeacon();
  assert.equal(ls.has('toolbox.beacon'), false);
});

test('browser timer IDs are released across repeated outages', (t) => {
  const active = new Map();
  let nextId = 1;
  t.mock.method(globalThis, 'setInterval', (fn) => {
    const id = nextId++;
    active.set(id, fn);
    return id;
  });
  t.mock.method(globalThis, 'clearInterval', (id) => active.delete(id));
  t.after(disarmBeacon);
  for (let outage = 0; outage < 3; outage++) {
    armBeacon('browser outage');
    armBeacon('same outage');
    assert.equal(active.size, 1);
    active.values().next().value();
    assert.equal(beaconState().seq, 2);
    disarmBeacon();
    assert.equal(active.size, 0, 'recovery must clear the browser interval');
  }
});

test('secondary windows preserve the main window beacon record', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  t.after(disarmBeacon);
  ls.set('toolbox.beacon', 'main-window evidence');
  armBeacon('secondary outage', { persist: false });
  t.mock.timers.tick(5000);
  assert.equal(ls.get('toolbox.beacon'), 'main-window evidence');
  disarmBeacon();
  assert.equal(ls.get('toolbox.beacon'), 'main-window evidence');
});
