/**
 * Renderer-local evidence while IPC is unresponsive: a title counter and,
 * for the main window, a persisted record. DOM titles are not yet forwarded
 * to native window titles, so GetWindowText cannot reliably observe it.
 */

/** Marker the host parses. Keep in sync with `forensics::parse_beacon`. */
const MARK = '#hb:';
const INTERVAL_MS = 1_000;
/** localStorage is a synchronous, cross-process write — once a second is rude. */
const PERSIST_EVERY = 5;

let armed = false;
let base = '';
let seq = 0;
let startedAt = 0;
let reason = '';
let timer = null;
let persist = true;

const KEY = 'toolbox.beacon';

/**
 * The title the host will read. Pure, so a test can pin the exact format
 * without a DOM — the host parses this string and nothing else.
 */
export function beaconTitle(baseTitle, secs, seqNo) {
  const head = baseTitle ? `${baseTitle} · ` : '';
  return `${head}桥接异常 ${secs}s ${MARK}${seqNo}`;
}

export function isArmed() {
  return armed;
}

/** What the page can still say about itself with no IPC at all. */
export function beaconState() {
  return { armed, seq, secs: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0, reason };
}

function tick() {
  if (!armed) return;
  seq += 1;
  const secs = Math.round((Date.now() - startedAt) / 1000);
  try {
    document.title = beaconTitle(base, secs, seq);
  } catch {
    /* a locked-down document must not break the beacon */
  }
  if (seq % PERSIST_EVERY === 0 && persist) {
    try {
      // Survives a restart, which is how the user recovers — and it is the only
      // record of "the beacon was alive" that outlives the page.
      globalThis.localStorage?.setItem(
        KEY,
        JSON.stringify({ seq, secs, at: new Date().toISOString(), reason }),
      );
    } catch {
      /* ignore */
    }
  }
}

/**
 * Start beaconing. Idempotent: the watchdog and the stuck-call check can both
 * ask for it without stacking timers.
 *
 * `opts.persist = false` for secondary windows: they share `localStorage` with
 * the main window, and one of them clearing `toolbox.beacon` would delete the
 * main window's last words.
 */
export function armBeacon(why = 'bridge', opts = {}) {
  if (armed) return;
  armed = true;
  persist = opts.persist !== false;
  reason = String(why ?? 'bridge');
  seq = 0;
  startedAt = Date.now();
  try {
    base = String(document.title ?? '');
  } catch {
    base = '';
  }
  // `setInterval` is deliberate: if the renderer is throttled or suspended the
  // counter stops, and that stall IS the finding.
  //
  // `unref` exists on Node timers only. A beacon that keeps the event loop
  // alive would hang every test that arms it — an app-level diagnostic must
  // never be the reason a test cannot exit.
  timer = setInterval(tick, INTERVAL_MS);
  timer?.unref?.();
  tick();
}

/** Stop beaconing and put the title back (only if it is still ours). */
export function disarmBeacon() {
  if (!armed) return;
  armed = false;
  if (timer !== null) clearInterval(timer);
  timer = null;
  try {
    if (String(document.title ?? '').includes(MARK)) document.title = base;
  } catch {
    /* ignore */
  }
  try {
    if (persist) globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* ignore */
  }
  seq = 0;
  startedAt = 0;
  reason = '';
}

/**
 * Secondary windows inspect local pending calls instead of probing the host:
 * their IPC traffic would mask a silent main window in the native watchdog.
 */
export function watchStuckCalls(hub, { afterMs = 30_000, everyMs = 5_000 } = {}) {
  const id = setInterval(() => {
    const stuck = hub.stuckCalls(afterMs)[0];
    if (stuck) armBeacon(`stuck ${stuck.key}`, { persist: false });
    else if (armed) disarmBeacon();
  }, everyMs);
  // Never the reason a test cannot exit (see `armBeacon`).
  id?.unref?.();
  return () => clearInterval(id);
}
