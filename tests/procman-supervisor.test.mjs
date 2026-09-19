/**
 * Launch-profile rules: clock arithmetic, restart policy, env parsing.
 *
 * These are the parts of subprocess supervision that are easy to get subtly
 * wrong — a schedule that fires a burst on wake, a restart cap that never
 * engages, an env line silently dropped. They are pure functions so they can be
 * pinned exactly, with a fixed clock instead of a real one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PROFILE,
  dueAt,
  normalizeProfile,
  parseClock,
  parseEnv,
  shouldRestart,
  describeSchedule,
  describeRestart,
} from '../src/plugins/procman-supervisor.js';

const at = (h, m = 0, day = 18) => new Date(2026, 8, day, h, m, 0, 0).getTime();
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// --------------------------------- normalize ---------------------------------

test('normalizeProfile fills every field and clamps out-of-range input', () => {
  const p = normalizeProfile({ program: 'node', cols: 9999, rows: -4, schedule: { everyMinutes: 0 } });
  assert.equal(p.program, 'node');
  assert.equal(p.cols, 500, 'cols is clamped');
  assert.equal(p.rows, 5, 'rows is clamped');
  assert.equal(p.schedule.everyMinutes, 1, 'a zero interval is not allowed');
  assert.deepEqual(p.args, []);
  assert.equal(p.autoStart, false);
  assert.equal(p.restart.policy, 'never');
});

test('normalizeProfile rejects unknown enum values instead of trusting them', () => {
  const p = normalizeProfile({
    schedule: { kind: 'whenever' },
    restart: { policy: 'sometimes' },
    enabled: 'yes-please',
  });
  assert.equal(p.schedule.kind, 'none', 'an unknown kind must not become a live schedule');
  assert.equal(p.restart.policy, 'never');
  assert.equal(p.enabled, true, 'only an explicit false disables');
});

test('normalizeProfile survives garbage without throwing', () => {
  for (const bad of [undefined, null, 42, 'nope', { args: 'not-an-array', env: { a: 1 } }]) {
    const p = normalizeProfile(bad);
    assert.equal(typeof p.program, 'string');
    assert.ok(Array.isArray(p.args));
    assert.ok(Array.isArray(p.env));
  }
});

// ----------------------------------- env -------------------------------------

test('parseEnv reads KEY=VALUE, skipping blanks, comments and unusable names', () => {
  const env = parseEnv([
    'FOO=1',
    '',
    '   ',
    '# a comment',
    '  BAR = two words  ',
    'URL=https://x.test/?a=1&b=2',
    '=no-key',
    '3BAD=x',
    'NO_EQUALS',
  ]);
  assert.deepEqual(env, {
    FOO: '1',
    BAR: 'two words',
    URL: 'https://x.test/?a=1&b=2',
  });
});

test('parseEnv splits on the FIRST = so values may contain more', () => {
  assert.deepEqual(parseEnv(['A=b=c']), { A: 'b=c' });
  assert.deepEqual(parseEnv(['EMPTY=']), { EMPTY: '' });
});

// --------------------------------- schedule ----------------------------------

test('dueAt: no schedule means never', () => {
  assert.equal(dueAt({ kind: 'none' }, at(10)), null);
  assert.equal(dueAt(undefined, at(10)), null);
});

test('dueAt: an interval counts from the last firing, not from now', () => {
  const s = { kind: 'interval', everyMinutes: 30 };
  // never fired -> one interval after activation
  assert.equal(dueAt(s, at(10)), at(10) + 30 * 60_000);
  // fired at 10:00, now 10:05 -> 10:30, not 10:35
  assert.equal(dueAt(s, at(10, 5), at(10)), at(10, 30));
});

test('dueAt: a daily time later today fires today, an earlier one tomorrow', () => {
  assert.equal(hhmm(dueAt({ kind: 'daily', at: '12:00' }, at(10))), '12:00');
  assert.equal(hhmm(dueAt({ kind: 'daily', at: '09:00' }, at(10))), '09:00');
  assert.equal(new Date(dueAt({ kind: 'daily', at: '09:00' }, at(10))).getDate(), 19, 'tomorrow');
});

test('dueAt: a daily time already fired today waits for tomorrow', () => {
  const next = dueAt({ kind: 'daily', at: '09:00' }, at(10), at(9));
  assert.equal(hhmm(next), '09:00');
  assert.equal(new Date(next).getDate(), 19);
  // and a later time today is still ahead
  assert.equal(hhmm(dueAt({ kind: 'daily', at: '12:00' }, at(10), at(9))), '12:00');
});

test('dueAt: a daily schedule never returns a time at or before now', () => {
  // the exact minute, to catch an off-by-one that would fire in a tight loop
  const now = at(9);
  const next = dueAt({ kind: 'daily', at: '09:00' }, now, at(9));
  assert.ok(next > now, `next (${new Date(next)}) must be strictly after now`);
  assert.equal(new Date(next).getDate(), 19);
});

test('dueAt: an unparseable time disables the schedule rather than guessing', () => {
  assert.equal(dueAt({ kind: 'daily', at: '25:00' }, at(10)), null);
  assert.equal(dueAt({ kind: 'daily', at: 'nonsense' }, at(10)), null);
  assert.equal(parseClock('9:05'), 9 * 60 + 5, 'a single-digit hour is fine');
  assert.equal(parseClock('09:5'), null, 'a single-digit minute is not');
});

// --------------------------------- restart -----------------------------------

test('shouldRestart honours the policy', () => {
  const base = { maxRetries: 3 };
  assert.equal(shouldRestart({ ...base, policy: 'never' }, 1, 0), false, 'never means never');
  assert.equal(shouldRestart({ ...base, policy: 'on-failure' }, 0, 0), false, 'a clean exit is not a failure');
  assert.equal(shouldRestart({ ...base, policy: 'on-failure' }, 1, 0), true);
  assert.equal(shouldRestart({ ...base, policy: 'always' }, 0, 0), true);
});

test('shouldRestart stops at the retry budget, whatever the policy', () => {
  for (const policy of ['on-failure', 'always']) {
    assert.equal(shouldRestart({ policy, maxRetries: 3 }, 1, 3), false, `${policy} at the cap`);
    assert.equal(shouldRestart({ policy, maxRetries: 3 }, 1, 4), false, `${policy} past the cap`);
    assert.equal(shouldRestart({ policy, maxRetries: 0 }, 1, 0), false, 'zero retries means none');
  }
});

// ---------------------------------- summaries --------------------------------

test('the summaries say something a user can act on', () => {
  assert.equal(describeSchedule({ kind: 'none' }), 'manual');
  assert.equal(describeSchedule({ kind: 'daily', at: '09:30' }), 'daily at 09:30');
  assert.equal(describeSchedule({ kind: 'interval', everyMinutes: 15 }), 'every 15 min');
  assert.equal(describeRestart({ policy: 'never' }), 'no restart');
  assert.equal(describeRestart({ policy: 'always', maxRetries: 2 }), 'always, up to 2×');
  assert.equal(describeRestart({ policy: 'on-failure', maxRetries: 5 }), 'on failure, up to 5×');
});

test('the defaults are internally consistent', () => {
  const p = normalizeProfile(DEFAULT_PROFILE);
  assert.deepEqual(p, { ...DEFAULT_PROFILE, id: '', name: '' });
  assert.equal(p.schedule.kind, 'none', 'a new profile does not run itself');
  assert.equal(p.autoStart, false);
});
