//! The black box: what was true in the minutes *before* the UI stopped
//! answering, recorded continuously instead of only at the moment the watchdog
//! noticed.
//!
//! ## Why this exists
//!
//! Five separate incidents produced the SAME four numbers in `debug.log`:
//!
//! ```text
//! mainThread=ok, inFlight=1, oldest=Some((7457423, "proc/recv")), sessions=Some(2)
//! ```
//!
//! Those four numbers are consistent with at least four different faults:
//!
//!   1. the renderer was suspended by the OS and is running no JavaScript;
//!   2. the renderer is fine but the WebView2 IPC channel is wedged, so every
//!      `fetch('http://ipc.localhost/…')` stays pending forever;
//!   3. the page never booted at all — which is exactly what a "successful"
//!      rebuild produces when it fails: `debug.log` has no `--- boot ---` line
//!      after the 00:24 rebuild that claimed to have restored the UI;
//!   4. one call is genuinely stuck inside the host.
//!
//! Every fix so far picked one of them and the symptom came back, because the
//! instrumentation could not separate them. A monitor that cannot separate the
//! hypotheses is not a monitor.
//!
//! ## What makes this one different
//!
//!   * **Continuous.** A 5 s tick into a rotating file, so the last minutes
//!     before the failure exist — not just the instant the ladder fired.
//!   * **Title-beacon protocol.** The page writes a counter into `document.title`
//!     and the recorder reads native window titles. DOM-to-native title
//!     forwarding is not currently installed, so an absent or unchanged native
//!     marker cannot establish renderer liveness. The parser checks do not
//!     validate the full WebView path; see docs/FREEZE-ROOT-CAUSE.md, section 5.
//!   * **A single file to hand back.** [`freeze_report`] writes the last 300
//!     ticks plus a live snapshot, so one attachment answers "what happened".
//!
//! Files: `<data_dir>/logs/flight.jsonl` (4 MiB, one rotated copy) and
//! `<data_dir>/logs/freeze-<stamp>.txt`.

use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;

/// Lines kept in memory. At one line per 5 s this is ~50 minutes — enough to
/// cover "it was fine, then it was not" without holding a day of history.
const RING_CAP: usize = 600;
/// Rotate at 4 MiB. A compact tick is ~120 bytes, so one file is ~9 hours and
/// the pair covers the "left it running overnight" case that produced every
/// incident so far.
const FLIGHT_MAX: u64 = 4 * 1024 * 1024;
const TICK: Duration = Duration::from_secs(5);
/// A tick that arrives this late means the machine slept (or this thread was
/// frozen). Both are worth a line, and neither is an outage.
const SLEEP_GAP: Duration = Duration::from_secs(30);
/// A full snapshot this often, in addition to every time something changes.
const FULL_EVERY: Duration = Duration::from_secs(60);

fn start() -> &'static Instant {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now)
}

fn now_ms() -> u64 {
    start().elapsed().as_millis() as u64
}

fn ring() -> &'static Mutex<VecDeque<String>> {
    static RING: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(VecDeque::with_capacity(RING_CAP)))
}

// ---------------------------------------------------------------------------
// The out-of-band liveness probe
// ---------------------------------------------------------------------------

/// What the last look at a window's title saw.
///
/// `stable` counts consecutive samples with an unchanged counter. One is a
/// pause; two in a row is 10 s of a renderer that is not running JavaScript.
#[derive(Clone, Copy)]
struct Beacon {
    seq: u64,
    stable: u8,
    state: &'static str,
}

fn beacons() -> &'static Mutex<HashMap<String, Beacon>> {
    static B: OnceLock<Mutex<HashMap<String, Beacon>>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The counter the page appends to its title while it is in distress:
/// `… #hb:37`.
///
/// Parsing is deliberately dumb — the title is user-visible text written by
/// whoever wants it, so anything clever here would break on a plugin that
/// retitles its window (the eye-care plugin sets it to `护眼助手`).
pub fn parse_beacon(title: &str) -> Option<u64> {
    let at = title.rfind("#hb:")?;
    let rest = &title[at + 4..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

/// Turn two observations into an answer, as a pure function so `host-checks`
/// can pin the rule without a webview.
///
/// `prev` is the previous counter, `cur` the current one, `stable` how many
/// consecutive samples (including this one) have been identical.
pub fn classify(prev: Option<u64>, cur: Option<u64>, stable: u8) -> &'static str {
    match (prev, cur) {
        // No counter at all: the page never armed the beacon, which means it
        // never got far enough to notice its own bridge failing — a page that
        // did not boot, or one whose timers never ran.
        (_, None) => "no-beacon",
        (Some(p), Some(c)) if c != p => "alive",
        (Some(_), Some(_)) if stable >= 2 => "frozen",
        _ => "unknown",
    }
}

/// Sample every window's title and update the beacon table.
fn observe_titles(app: &tauri::AppHandle) -> Map<String, Value> {
    let mut out = Map::new();
    let mut table = beacons().lock().unwrap_or_else(|e| e.into_inner());
    for (label, w) in app.webview_windows() {
        let title = w.title().unwrap_or_default();
        let seq = parse_beacon(&title);
        let prev = table.get(&label).copied();
        let (prev_seq, stable) = match (prev, seq) {
            (Some(b), Some(s)) if b.seq == s => (Some(b.seq), b.stable.saturating_add(1)),
            (Some(b), _) => (Some(b.seq), 0),
            (None, _) => (None, 0),
        };
        let state = classify(prev_seq, seq, stable);
        if let Some(s) = seq {
            table.insert(label.clone(), Beacon { seq: s, stable, state });
        } else if let Some(mut b) = prev {
            // The title was restored (recovery): keep the last verdict but stop
            // counting it as a live signal.
            b.state = "no-beacon";
            table.insert(label.clone(), b);
        }
        out.insert(
            label,
            json!({
                "title": truncate(&title, 80),
                "hb": seq,
                "state": state,
                "visible": w.is_visible().unwrap_or(false),
            }),
        );
    }
    // A closed window must not keep reporting a verdict: `renderer=main=alive,
    // pill=frozen` where the pill was closed an hour ago is a false lead, and
    // this report exists to remove false leads.
    let live: Vec<String> = out.keys().cloned().collect();
    table.retain(|k, _| live.contains(k));
    out
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    s.chars().take(n).collect::<String>() + "…"
}

/// `main=alive,plugin-ec-pill=frozen` — the one field that would have changed
/// every diagnosis so far.
pub fn renderer_summary(_app: &tauri::AppHandle) -> String {
    let table = beacons().lock().unwrap_or_else(|e| e.into_inner());
    if table.is_empty() {
        return "none".into();
    }
    let mut parts: Vec<String> = table
        .iter()
        .map(|(label, b)| format!("{label}={}", b.state))
        .collect();
    parts.sort();
    parts.join(",")
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

fn log_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let root = crate::services::storage::data_root(app).ok()?;
    let dir = root.join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Append one line to the flight recorder and the in-memory ring.
///
/// Best effort by design: a diagnostic that panics or propagates errors would
/// turn "the UI is stuck" into "the app is gone".
pub fn record(app: &tauri::AppHandle, kind: &str, extra: Value) {
    let mut line = Map::new();
    line.insert("t".into(), json!(crate::ui_heartbeat::utc_stamp()));
    line.insert("ms".into(), json!(now_ms()));
    line.insert("k".into(), json!(kind));
    if let Value::Object(m) = extra {
        for (k, v) in m {
            line.insert(k, v);
        }
    }
    let text = Value::Object(line).to_string();
    {
        let mut r = ring().lock().unwrap_or_else(|e| e.into_inner());
        if r.len() >= RING_CAP {
            r.pop_front();
        }
        r.push_back(text.clone());
    }
    let Some(dir) = log_dir(app) else { return };
    let path = dir.join("flight.jsonl");
    if std::fs::metadata(&path).map(|m| m.len() > FLIGHT_MAX).unwrap_or(false) {
        // One rotated copy: the interesting window is "the last day", not
        // "every day since install".
        let old = dir.join("flight.1.jsonl");
        let _ = std::fs::remove_file(&old);
        let _ = std::fs::rename(&path, &old);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{text}");
    }
}

fn snapshot_from(app: &tauri::AppHandle, windows: Map<String, Value>) -> Value {
    // A no-op posted to the UI thread: if it does not run within 300 ms the
    // thread is not pumping. Called from a plain thread (not a runtime worker),
    // so blocking here is safe and costs nothing while things are healthy.
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let posted = app
        .run_on_main_thread(move || {
            let _ = tx.send(());
        })
        .is_ok();
    let main_ok = posted && rx.recv_timeout(Duration::from_millis(300)).is_ok();
    let (in_flight, oldest) = crate::gateway_stats::snapshot();
    json!({
        "pump": if main_ok { "ok" } else { "blocked" },
        "gw": in_flight,
        "oldest": oldest.map(|(ms, what)| json!({ "ms": ms as u64, "what": what })),
        "sessions": crate::services::session::count_if_free(),
        "pty": tauri_plugin_pty::backend::diagnostics(),
        // Monotonic, so a diff between two ticks is authoritative: 0 means the
        // UI really made no call, and that is the difference between "wedged"
        // and "quiet" — the one thing the 5 s `gw` sample could not say.
        "calls": crate::ui_heartbeat::calls(),
        "silent": crate::ui_heartbeat::silent_ms(),
        // 0 while the async runtime is dead, growing while it is alive.
        "beat": async_beat(),
        // Same question, asked WITHOUT the blocking pool. The pair is the
        // diagnosis: `beat` frozen + `tbeat` moving = the blocking pool is full.
        "tbeat": async_task_beat(),
        "windows": windows,
    })
}

/// Everything the host can see about itself and its windows, right now.
pub fn snapshot(app: &tauri::AppHandle) -> Value {
    let windows = observe_titles(app);
    snapshot_from(app, windows)
}

/// The compact form written on most ticks: the file has to stay small enough
/// to survive hours, so only the fields a post-mortem reads are kept.
fn compact(windows: &Map<String, Value>, in_flight: usize, oldest: Option<u64>, pump: &str) -> Value {
    let mut hb = Map::new();
    for (label, v) in windows {
        hb.insert(label.clone(), json!(v.get("hb").cloned().unwrap_or(Value::Null)));
    }
    json!({
        "gw": in_flight,
        "old": oldest,
        "pump": pump,
        "hb": hb,
        "calls": crate::ui_heartbeat::calls(),
        "silent": crate::ui_heartbeat::silent_ms(),
        "beat": async_beat(),
        "tbeat": async_task_beat(),
    })
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/// The last `n` lines of Chromium's own log, if it has one.
///
/// The host can describe the world around the webview; only Chromium can
/// describe what the webview was doing when it stopped. `--enable-logging` (see
/// `tauri.conf.json`) makes it write `chrome_debug.log` into the webview's user
/// data directory, and on the 2026-10-29 hang that file would have said whether
/// the browser process lost its GPU channel, its renderer, or its IPC — the
/// three candidates that look identical from outside.
fn chromium_log_tail(app: &tauri::AppHandle, n: usize) -> Option<String> {
    let dir = app.path().app_local_data_dir().ok()?.join("EBWebView");
    let path = dir.join("chrome_debug.log");
    let text = std::fs::read_to_string(&path).ok()?;
    let lines: Vec<&str> = text.lines().collect();
    let skip = lines.len().saturating_sub(n);
    Some(lines[skip..].join("\n"))
}

/// Write one file that answers "what was happening", and return its path.
///
/// Called before every rung of the recovery ladder, because the moment after a
/// reload is exactly when the evidence stops being reachable.
pub fn freeze_report(app: &tauri::AppHandle, why: &str) -> Option<PathBuf> {
    let dir = log_dir(app)?;
    let stamp = crate::ui_heartbeat::utc_stamp()
        .replace(' ', "_")
        .replace(':', "");
    let path = dir.join(format!("freeze-{stamp}.txt"));
    let mut text = String::new();
    text.push_str("Toolbox freeze report\n");
    text.push_str(&format!("when   : {}\n", crate::ui_heartbeat::utc_stamp()));
    text.push_str(&format!("why    : {why}\n"));
    text.push_str(&format!("pid    : {}\n", std::process::id()));
    text.push_str(&format!("uptime : {}s\n", now_ms() / 1000));
    text.push_str(&format!("version: {}\n", env!("CARGO_PKG_VERSION")));
    text.push_str("\n--- snapshot ---\n");
    text.push_str(&serde_json::to_string_pretty(&snapshot(app)).unwrap_or_default());
    text.push_str("\n\n--- last ticks (oldest first) ---\n");
    {
        let r = ring().lock().unwrap_or_else(|e| e.into_inner());
        let skip = r.len().saturating_sub(300);
        for line in r.iter().skip(skip) {
            text.push_str(line);
            text.push('\n');
        }
    }
    // The rotated file is the part before the ring: keep a pointer, not a copy,
    // so a 4 MiB file does not get duplicated into every report.
    text.push_str("\n--- full history ---\n");
    text.push_str(&format!("{}\n", dir.join("flight.jsonl").display()));
    text.push_str("\n--- chromium (last 200 lines of chrome_debug.log) ---\n");
    match chromium_log_tail(app, 200) {
        Some(tail) => text.push_str(&tail),
        None => text.push_str("(none — either the log is off or the browser never wrote one)\n"),
    }
    std::fs::write(&path, text).ok()?;
    Some(path)
}

// ---------------------------------------------------------------------------
// The ticker
// ---------------------------------------------------------------------------

/// Start the recorder. One thread, one sleep, no locks on any hot path.
pub fn spawn(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new()
        .name("forensics".into())
        .spawn(move || {
            record(&app, "boot", json!({ "pid": std::process::id() }));
            let mut last = Instant::now();
            let mut last_full = Instant::now();
            let mut last_gw = usize::MAX;
            let mut last_pump = String::new();
            let mut last_sess = u64::MAX;
            let mut last_calls = u64::MAX;
            let mut still: u32 = 0;
            let mut reg_held: u32 = 0;
            let mut gw_held: u32 = 0;
            let mut last_poke = Instant::now();
            let mut hung_logged = false;
            loop {
                std::thread::sleep(TICK);
                // Once a second, from THIS thread: a task that does nothing.
                // If the runtime stops running even that, the workers are
                // stuck; if it keeps running, only the blocking pool is.
                if last_poke.elapsed() >= Duration::from_secs(1) {
                    last_poke = Instant::now();
                    poke_async_task();
                }
                // A recorder that can die is worse than no recorder: it dies
                // exactly when it matters and the file just stops. That already
                // happened once (a `u8` overflow 21 minutes into an outage), so
                // one bad tick must never take the thread with it.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let gap = last.elapsed();
                    last = Instant::now();
                    if gap > SLEEP_GAP {
                        // The machine slept (or this thread was frozen). Recorded
                        // by the HOST, so it exists even when the page's own
                        // "timer fired late" heuristic never ran.
                        record(&app, "sleep", json!({ "gapMs": gap.as_millis() as u64 }));
                        last_full = Instant::now() - FULL_EVERY;
                    }
                // Sampled ONCE per tick: `observe_titles` advances the beacon
                // table, so calling it twice would count every tick twice.
                let windows = observe_titles(&app);
                let snap = snapshot_from(&app, windows.clone());
                let pump = snap["pump"].as_str().unwrap_or("?").to_string();
                // The transition itself, at 15 s instead of the ladder's 60 s.
                // A counter that stops moving is the one unambiguous "the UI
                // stopped talking" signal: this app polls a sidecar at 4 Hz, so
                // three quiet ticks cannot be idleness.
                let calls = crate::ui_heartbeat::calls();
                if calls == last_calls {
                    // `u8` here overflowed after 255 quiet ticks and PANICKED —
                    // i.e. the recorder killed itself 21 minutes into exactly
                    // the outage it exists to record. Saturating, and wider.
                    still = still.saturating_add(1);
                } else {
                    still = 0;
                    hung_logged = false;
                }
                last_calls = calls;
                if still >= 3 && !hung_logged {
                    hung_logged = true;
                    record(&app, "hung", json!({
                        "silent": crate::ui_heartbeat::silent_ms(),
                        "calls": calls,
                        "windows": windows,
                    }));
                }
                // A session appearing or disappearing is its own event, not a
                // diff to be inferred later: on 2026-10-29 the count went 1 -> 2
                // in the same 5 s sample the UI died in, and that was the only
                // trace of the `proc/spawn` that preceded it.
                let sessions = snap["sessions"].as_u64().unwrap_or(0);
                let sess_changed = sessions != last_sess;
                if sess_changed {
                    record(&app, "sess", json!({ "n": sessions, "was": last_sess }));
                    last_sess = sessions;
                }
                // Which lock is stuck? `beat` + `tbeat` both frozen says the
                // WORKERS are gone, and the only thing every worker takes
                // before its first await is one of these two locks. Probing
                // them costs two `try_lock`s and turns "some shared lock" into
                // a name.
                let reg_free = crate::host::registry::lock_is_free();
                let gw_free = crate::gateway_stats::lock_is_free();
                reg_held = if reg_free { 0 } else { reg_held.saturating_add(1) };
                gw_held = if gw_free { 0 } else { gw_held.saturating_add(1) };
                if reg_held == 3 || gw_held == 3 {
                    record(&app, "lock", json!({
                        "registryTicks": reg_held,
                        "gatewayTicks": gw_held,
                        "beat": async_beat(),
                        "tbeat": async_task_beat(),
                    }));
                }
                let (in_flight, oldest) = crate::gateway_stats::snapshot();
                let changed = in_flight != last_gw || pump != last_pump || sess_changed;
                last_gw = in_flight;
                last_pump = pump.clone();
                if changed || last_full.elapsed() >= FULL_EVERY {
                    last_full = Instant::now();
                    record(&app, "snap", snap);
                } else {
                    record(
                        &app,
                        "t",
                        compact(&windows, in_flight, oldest.map(|(ms, _)| ms as u64), &pump),
                    );
                }
                }));
            }
        });
}

/// Where the files are, for the log line that tells the user what to send.
pub fn paths(app: &tauri::AppHandle) -> String {
    log_dir(app)
        .map(|d| d.display().to_string())
        .unwrap_or_else(|| "(no data dir)".into())
}

/// Deadline (ms since start, 0 = none) by which the last recovery rung should
/// have made the UI talk again. Set by the ladder, read by the tick — this is
/// what turns "rebuilt the webview" into "rebuilt the webview AND it worked".
pub static RECOVERY_PENDING_UNTIL: AtomicU64 = AtomicU64::new(0);
/// Which rung is being verified (1 = reload, 2 = recreate).
pub static RECOVERY_STEP: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// Is the async runtime still running at all?
// ---------------------------------------------------------------------------

static ASYNC_BEAT: AtomicU64 = AtomicU64::new(0);

/// Tick a counter **on the async runtime**, every second, forever.
///
/// This exists because of one number in the 2026-10-30 report:
///
/// ```text
/// oldest = Some((1265257, "proc/recv@main[returned]"))
/// ```
///
/// `[returned]` is written by the blocking thread as its LAST act, so the work
/// finished — and the future that was awaiting it was still not polled 21
/// minutes later. That is not a slow service and not a wedged webview; that is
/// the runtime no longer resuming futures. The old instrumentation could only
/// say "a call is stuck", which fits both.
///
/// The probe deliberately uses the SAME shape as `plugin_rpc`
/// (`spawn_blocking(...).await`), so if that shape stops resuming, this counter
/// stops with it — while the plain-thread ticker keeps writing. Two numbers
/// moving apart is the proof; one number alone never was.
pub fn spawn_async_beat() {
    tauri::async_runtime::spawn(async move {
        loop {
            let _ = tauri::async_runtime::spawn_blocking(|| {
                std::thread::sleep(Duration::from_secs(1));
            })
            .await;
            ASYNC_BEAT.fetch_add(1, Ordering::Relaxed);
        }
    });
}

/// How many times the async runtime has completed a blocking round trip.
pub fn async_beat() -> u64 {
    ASYNC_BEAT.load(Ordering::Relaxed)
}

static ASYNC_TASK_BEAT: AtomicU64 = AtomicU64::new(0);

/// A **pure-async** counterpart to [`async_beat`]: a trivial task, spawned from
/// a plain thread once a second, that only increments a counter.
///
/// The two together are what finally separates the two ways "the runtime
/// stopped" can be true:
///
/// ```text
/// beat frozen, tbeat moving  -> workers are fine, the BLOCKING POOL is full
///                               (a blocking task never returned, 512 of them)
/// beat frozen, tbeat frozen  -> workers themselves are stuck (a shared lock)
/// ```
///
/// `beat` alone cannot tell them apart, and on 2026-11-01 it froze together
/// with `calls` after climbing 64485 -> 64787 — which is either. The fix is
/// completely different, so guessing here would be one more round of the same
/// mistake.
pub fn async_task_beat() -> u64 {
    ASYNC_TASK_BEAT.load(Ordering::Relaxed)
}

/// Poke the runtime with a task that touches nothing but an atomic.
pub fn poke_async_task() {
    tauri::async_runtime::spawn(async {
        ASYNC_TASK_BEAT.fetch_add(1, Ordering::Relaxed);
    });
}

/// How many gateway calls the UI had made when the rung was issued.
///
/// The verification is a TRAFFIC delta, not a silence reading. `silent_ms` can
/// be reset without the UI ever speaking — the tray does it, and so does the
/// rebuild itself — and when the check used it, every rung "verified" itself:
/// `04:13:24 recovery step 2 verified` while `calls` had not moved for hours,
/// ATTEMPTS went back to 0, and the ladder destroyed and rebuilt the window
/// every three minutes for hours.
static RECOVERY_CALLS_AT: AtomicU64 = AtomicU64::new(0);

/// Arm the verification for a rung. Pure bookkeeping, kept here so the ladder
/// and the tick share one definition of "we are waiting on a recovery".
pub fn expect_recovery(step: u64, within: Duration) {
    RECOVERY_CALLS_AT.store(crate::ui_heartbeat::calls(), Ordering::SeqCst);
    RECOVERY_STEP.store(step, Ordering::SeqCst);
    RECOVERY_PENDING_UNTIL.store(now_ms() + within.as_millis() as u64, Ordering::SeqCst);
}

/// Has the UI actually spoken since the rung was issued?
pub fn recovery_has_traffic() -> bool {
    crate::ui_heartbeat::calls() > RECOVERY_CALLS_AT.load(Ordering::SeqCst)
}

/// `Some((step, expired))` while a rung is being verified.
pub fn recovery_state() -> Option<(u64, bool)> {
    let until = RECOVERY_PENDING_UNTIL.load(Ordering::SeqCst);
    if until == 0 {
        return None;
    }
    Some((RECOVERY_STEP.load(Ordering::SeqCst), now_ms() >= until))
}

pub fn clear_recovery() {
    RECOVERY_PENDING_UNTIL.store(0, Ordering::SeqCst);
    RECOVERY_STEP.store(0, Ordering::SeqCst);
}
