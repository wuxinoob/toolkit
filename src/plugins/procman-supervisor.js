/**
 * Launch-profile model and supervision rules.
 *
 * Pure functions only — no ctx, no timers, no DOM — so the parts that are easy
 * to get subtly wrong (clock arithmetic, restart policy, env parsing) are
 * testable on their own. `procman.js` does the wiring: it owns the timers and
 * the UI, and asks this module what a profile means and when it is next due.
 *
 * A *profile* is the persisted, repeatable description of a process: what to
 * run, how, and when. A *session* is one running instance of it.
 */

/** Where the profiles live in the plugin's own storage. */
export const PROFILES_KEY = 'profiles';

export const SCHEDULE_KINDS = ['none', 'daily', 'interval'];
export const RESTART_POLICIES = ['never', 'on-failure', 'always'];

/** What a profile looks like when nothing is known about it. */
export const DEFAULT_PROFILE = Object.freeze({
  id: '',
  name: '',
  program: '',
  args: [],
  cwd: '',
  env: [], // 'KEY=VALUE' lines, as a form edits them
  cols: 80,
  rows: 24,
  enabled: true,
  autoStart: false,
  schedule: { kind: 'none', at: '09:00', everyMinutes: 30 },
  restart: { policy: 'never', maxRetries: 3, delayMs: 2000 },
});

const clampInt = (v, lo, hi, fallback) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

/** 'HH:MM' -> minutes since midnight, or null if it is not a valid time. */
export function parseClock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const h = Number.parseInt(m[1], 10);
  const min = Number.parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** A stored profile -> a complete, valid one. Never throws on bad input. */
export function normalizeProfile(input) {
  // A default parameter only covers `undefined`; stored JSON can hold null, and
  // a corrupted profile must not take the whole panel down.
  const raw = input && typeof input === 'object' ? input : {};
  const sched = raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : {};
  const restart = raw.restart && typeof raw.restart === 'object' ? raw.restart : {};
  const kind = SCHEDULE_KINDS.includes(sched.kind) ? sched.kind : 'none';
  const policy = RESTART_POLICIES.includes(restart.policy) ? restart.policy : 'never';
  return {
    ...DEFAULT_PROFILE,
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    program: String(raw.program ?? ''),
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    cwd: String(raw.cwd ?? ''),
    env: Array.isArray(raw.env) ? raw.env.map(String) : [],
    cols: clampInt(raw.cols, 20, 500, 80),
    rows: clampInt(raw.rows, 5, 200, 24),
    enabled: raw.enabled !== false,
    autoStart: raw.autoStart === true,
    schedule: {
      kind,
      at: parseClock(sched.at) === null ? '09:00' : String(sched.at),
      everyMinutes: clampInt(sched.everyMinutes, 1, 24 * 60, 30),
    },
    restart: {
      policy,
      maxRetries: clampInt(restart.maxRetries, 0, 100, 3),
      delayMs: clampInt(restart.delayMs, 0, 10 * 60_000, 2000),
    },
  };
}

/**
 * 'KEY=VALUE' lines -> the object the pty spawn takes.
 *
 * Blank lines and `#` comments are dropped so a pasted env block works; the
 * value keeps any further `=` (only the FIRST one splits), which is what a URL
 * or a query string needs.
 */
export function parseEnv(lines) {
  const out = {};
  for (const line of lines ?? []) {
    const text = String(line).trim();
    if (!text || text.startsWith('#')) continue;
    const eq = text.indexOf('=');
    if (eq <= 0) continue; // no '=' or an empty key
    const key = text.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // not a usable name
    // Trim the value too: a value typed into a form with padding means the
    // trimmed text. (Only the FIRST `=` splits, so the value keeps the rest.)
    out[key] = text.slice(eq + 1).trim();
  }
  return out;
}

/**
 * When should this profile next start? `null` means "it has no schedule".
 *
 * Both kinds are relative to the LAST firing, not to "now", so a machine that
 * was asleep does not fire a burst of catch-up runs on wake: the next due time
 * is simply recomputed from where it left off.
 */
export function dueAt(schedule, nowMs, lastFiredMs = null) {
  const kind = schedule?.kind;
  if (kind === 'interval') {
    const every = clampInt(schedule.everyMinutes, 1, 24 * 60, 30) * 60_000;
    return (lastFiredMs ?? nowMs) + every;
  }
  if (kind === 'daily') {
    const minutes = parseClock(schedule.at);
    if (minutes === null) return null;
    const d = new Date(nowMs);
    d.setSeconds(0, 0);
    d.setHours(Math.floor(minutes / 60), minutes % 60);
    let t = d.getTime();
    // strictly after both now and the previous firing
    const floor = Math.max(nowMs, lastFiredMs ?? 0);
    while (t <= floor) t += 24 * 60 * 60 * 1000;
    return t;
  }
  return null;
}

/**
 * Should a session that just exited be started again?
 *
 * `attempts` counts restarts already made for this session, so the cap is a
 * total budget rather than a per-burst one — otherwise a crash loop with a
 * long-enough delay would restart forever.
 */
export function shouldRestart(restart, exitCode, attempts) {
  const { policy, maxRetries } = normalizeProfile({ restart }).restart;
  if (attempts >= maxRetries) return false;
  if (policy === 'always') return true;
  if (policy === 'on-failure') return exitCode !== 0;
  return false;
}

/** A short human summary of when a profile runs, for the list. */
export function describeSchedule(schedule) {
  const s = normalizeProfile({ schedule }).schedule;
  if (s.kind === 'daily') return `daily at ${s.at}`;
  if (s.kind === 'interval') return `every ${s.everyMinutes} min`;
  return 'manual';
}

/** A short human summary of the restart policy. */
export function describeRestart(restart) {
  const r = normalizeProfile({ restart }).restart;
  if (r.policy === 'never') return 'no restart';
  const what = r.policy === 'always' ? 'always' : 'on failure';
  return `${what}, up to ${r.maxRetries}×`;
}

/**
 * Which of a profile's sessions is THE one, right now.
 *
 * A profile can own more than one entry, and that is by design: Stop keeps its
 * session so the output stays readable, and a later Run adds a second one. So
 * "the first match" is the DEAD one — and every consumer of that answer is then
 * wrong in the same way, which is one bug wearing four faces:
 *
 *   the row keeps saying `stopped` while a process is running;
 *   the pane shows the old run's output instead of the live one;
 *   the header offers **Run** for something that is already running;
 *   and typing goes nowhere, because that session is not running any more.
 *
 * A live session therefore always wins, whatever its position. With nothing
 * live, the NEWEST entry is the one the user last looked at (iteration order is
 * insertion order, which is age).
 *
 * Takes any iterable so callers can pass `state.sessions.values()` directly.
 */
export function pickSession(sessions, profileId) {
  if (!profileId) return null;
  let newest = null;
  for (const s of sessions) {
    if (!s || s.profileId !== profileId) continue;
    if (s.status === 'running' || s.status === 'starting') return s;
    newest = s;
  }
  return newest;
}

/**
 * A profile's sessions that have ENDED — the leftovers a new round replaces.
 *
 * Stop keeps its session on purpose (so the output stays readable), which is
 * what makes `pickSession` necessary; the other half of that decision is that
 * those records accumulate forever. A manual Run is the point where they stop
 * being reachable — the selection moves to the new session — so that is where
 * they are dropped.
 *
 * Live sessions are never returned, whatever else is wrong with the list: this
 * answer is used to DELETE things, so "nothing that could still be running"
 * is the property that matters.
 */
export function endedSessions(sessions, profileId) {
  const out = [];
  if (!profileId) return out;
  for (const s of sessions) {
    if (!s || s.profileId !== profileId) continue;
    if (s.status === 'running' || s.status === 'starting') continue;
    out.push(s);
  }
  return out;
}
