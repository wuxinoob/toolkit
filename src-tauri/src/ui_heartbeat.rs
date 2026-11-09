//! Is the UI still talking to us? — and if not, say so in the log OURSELVES.
//!
//! ## Why the host has to tell on itself
//!
//! Every piece of evidence about a dead UI used to come from the UI: the JS
//! watchdog writes a line through `host/write_debug_log`, i.e. over the very
//! IPC it is reporting on. When that IPC is what broke, the evidence never
//! lands. The result was an app that had been unresponsive for a day with
//! **not one line** in `debug.log` — we could see it was wedged, and nothing
//! about where.
//!
//! So the host keeps a heartbeat (`touch()` on every gateway call) and a small
//! thread watches it. When the UI has been silent for a minute, the HOST writes
//! the line — with the numbers only it can see: whether the UI thread can run a
//! task, how many gateway calls are in flight, and what the oldest one is.
//!
//! This also covers the case nothing else can: the renderer process is gone or
//! frozen, so no JS will ever write anything again.

use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
// `get_webview_window` / `config()` live on the Manager trait.
use tauri::Manager;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

fn start() -> &'static Instant {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now)
}

fn now_ms() -> u64 {
    start().elapsed().as_millis() as u64
}

/// ms since process start at the last gateway call.
static LAST: AtomicU64 = AtomicU64::new(0);
/// Separate from `LAST == 0`: the very first call can legitimately land at
/// 0 ms, and treating that as "no call yet" made the heartbeat report
/// silence for a UI that had just spoken (caught by `host-checks`).
static SEEN: AtomicBool = AtomicBool::new(false);

/// Record that the UI talked to us. Called from the gateway.
pub fn touch() {
    LAST.store(now_ms(), Ordering::Relaxed);
    SEEN.store(true, Ordering::Relaxed);
    CALLS.fetch_add(1, Ordering::Relaxed);
}

/// Total calls seen since start.
///
/// Why a counter and not just `silent_ms`: the flight recorder samples
/// every 5 s, so an instantaneous "in flight" number cannot tell "the UI
/// made no call" from "it made one that finished between two samples".
/// A monotonic counter can: two consecutive ticks with the same value mean
/// genuinely nothing arrived, and a diff says how much did.
static CALLS: AtomicU64 = AtomicU64::new(0);

pub fn calls() -> u64 {
    CALLS.load(Ordering::Relaxed)
}

/// How long the UI has been quiet. 0 while booting (nothing has called yet).
pub fn silent_ms() -> u64 {
    if !SEEN.load(Ordering::Relaxed) {
        return 0;
    }
    now_ms().saturating_sub(LAST.load(Ordering::Relaxed))
}

/// Start the silence clock over, without pretending the UI spoke.
///
/// Called when the user brings the main window back from the tray. While it
/// was hidden the page may have been frozen by Chromium (a hidden window is
/// not the same thing as an occluded one), so `silent_ms` grows with no
/// outage behind it — and the first visible tick would then "repair" a
/// perfectly healthy window by reloading it, which reads as "showing it
/// takes ten seconds and then it flickers".
/// Start the silence clock over, without pretending the UI spoke.
///
/// Used when the user brings the main window back, and after the host has
/// rebuilt it. It must NOT touch `ATTEMPTS` or the recovery verification:
/// doing that made every rebuild look like a cure (see `forgive_outage`),
/// and the ladder rebuilt the window every three minutes forever.
pub fn reset_silence() {
    LAST.store(now_ms(), Ordering::Relaxed);
    SEEN.store(true, Ordering::Relaxed);
}

/// Start over completely: the user summoned the window themselves, so the
/// outage is over as far as the ladder is concerned.
pub fn forgive_outage() {
    reset_silence();
    ATTEMPTS.store(0, Ordering::SeqCst);
    crate::forensics::clear_recovery();
}

/// `YYYY-MM-DD HH:MM:SS` in UTC, without pulling in a date crate.
pub(crate) fn utc_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    // Civil-from-days (Howard Hinnant): 1970-01-01 is day 0.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

/// How often the watcher wakes up.
const TICK: Duration = Duration::from_secs(10);
/// A gap this long between two ticks means the machine slept (or the thread
/// was starved), not that the UI is broken.
const RESUME_GAP: Duration = Duration::from_secs(60);

/// Injected into the main window by the tray's 重新加载界面 and by the
/// recovery ladder: mark the next boot as "these sessions are mine", then
/// reload. Without the flag a reload reaps every live pty and sidecar.
pub const UI_RELOAD_JS: &str =
    "try{sessionStorage.setItem('toolbox.keepSessions','1')}catch(e){};location.reload()";

/// What to do about a UI that has stopped calling. Ordered by how much it
/// costs the user, not by how likely it is to work.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Action {
    /// Nothing yet: either it is talking, or it has not been silent long
    /// enough for this rung.
    None,
    /// Cheapest repair: rebuild the page. Sessions survive.
    Reload,
    /// Rebuild the WEBVIEW. The host keeps every session, so this is still
    /// not a restart — but it is the only thing left that can re-create the
    /// renderer's IPC channel.
    Recreate,
    /// Tell the user, because nothing the host can do has worked.
    Notify,
    /// Last resort: restart the process.
    ///
    /// Restart replaces the process-wide async runtime and shared WebView2
    /// browser process. Reload and Recreate leave those resources alive.
    ///
    /// This costs the user their ptys and sidecars, which is why it is the
    /// last rung and why `Notify` comes first. It is still better than
    /// `GiveUp`: that left the app dead until someone noticed, and the
    /// notification is easy to miss on a machine nobody is looking at.
    Restart,
    /// Stop trying: a loop of reloads is worse than a dead window.
    GiveUp,
}

/// The recovery ladder, as a pure function so `host-checks` can pin it.
///
/// `attempts` counts what has already been tried for THIS outage and is
/// reset the moment the UI talks again. Each rung needs a longer silence
/// than the one before, so a slow start cannot cascade into a reload, and a
/// dead bridge cannot cascade into a loop.
pub fn action_for(silent_ms: u64, attempts: u8) -> Action {
    match attempts {
        0 if silent_ms >= 60_000 => Action::Reload,
        1 if silent_ms >= 180_000 => Action::Recreate,
        2 if silent_ms >= 360_000 => Action::Notify,
        // Restart before giving up. "Give up" was the rung that left the
        // app dead for hours on 2026-10-29 while the host was perfectly
        // healthy — a wedged WebView2 browser process cannot be repaired
        // from inside the process it lives in.
        3 if silent_ms >= 600_000 => Action::Restart,
        4 if silent_ms >= 900_000 => Action::GiveUp,
        _ => Action::None,
    }
}

static ATTEMPTS: AtomicU8 = AtomicU8::new(0);

/// The call counter as of the previous tick — the only honest answer to
/// "did the UI say anything since I last looked?".
static LAST_CALLS_SEEN: AtomicU64 = AtomicU64::new(0);

/// Set while the watchdog is destroying and rebuilding the main window.
///
/// Destroying the LAST window makes the runtime emit `ExitRequested`, and
/// unless the app says otherwise the loop then exits — which runs the
/// session drain and kills every pty and sidecar. That is the exact
/// opposite of what a "rebuild the UI" step is for, so the run handler in
/// `run()` consults this flag.
pub static RECREATING: AtomicBool = AtomicBool::new(false);

/// One line in `debug.log`, timestamped. Best effort: if the file cannot be
/// written there is nothing useful to do about it here.
fn log(app: &tauri::AppHandle, msg: String) {
    let _ = crate::services::storage::append_debug_log(app, &format!("{} host: {msg}", utc_stamp()));
}

/// The numbers only the host can see. `mainThread` is the one that separates
/// "a call is stuck" from "nothing can be delivered".
fn diag(app: &tauri::AppHandle) -> String {
    let (in_flight, oldest) = crate::gateway_stats::snapshot();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let posted = app
        .run_on_main_thread(move || {
            let _ = tx.send(());
        })
        .is_ok();
    let main_ok = posted && rx.recv_timeout(Duration::from_millis(300)).is_ok();
    format!(
        "mainThread={}, renderer={}, inFlight={}, oldest={:?}, sessions={:?}",
        if main_ok { "ok" } else { "blocked" },
        // The out-of-band probe: read from each window's TITLE, which needs
        // no IPC. `alive` here with a silent gateway is a completely
        // different bug from `frozen`, and until now the log said the same
        // thing for both.
        crate::forensics::renderer_summary(app),
        in_flight,
        oldest,
        crate::services::session::count_if_free()
    )
}

/// Rebuild the page in place. The renderer keeps running; only the document
/// is replaced.
fn reload_ui(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(w) = app.get_webview_window("main") else {
        // There is no document to reload — the window itself is gone (see
        // `show_main_window` for how that happens). Spending this rung on a
        // missing window is what made the tray feel dead for minutes:
        // `eval` failed, the rung was consumed, and nothing happened until
        // the 180 s rebuild.
        crate::show_main_window(app);
        return Ok(());
    };
    w.eval(UI_RELOAD_JS).map_err(|e| e.to_string())
}

/// Destroy and rebuild the main webview — a new renderer, a new IPC channel,
/// and the same host process, so every pty and sidecar survives.
///
/// Refused when the window is hidden: recreating it would pop a window up in
/// front of whatever the user is doing, and a hidden app whose bridge died
/// is not urgent — the tray still works.
fn recreate_ui(app: &tauri::AppHandle) -> Result<(), String> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or_else(|| "no `main` window in tauri.conf.json".to_string())?;
    if let Some(w) = app.get_webview_window("main") {
        if !w.is_visible().unwrap_or(true) {
            return Err("the window is hidden — not recreating it behind the user's back".into());
        }
        // `destroy`, not `close`: closing runs the frontend's close-to-tray
        // handler, which would just hide it again. And destroying the last
        // window asks the app to exit (see `RECREATING`), so the flag goes up
        // BEFORE the call and comes down however this ends.
        RECREATING.store(true, Ordering::SeqCst);
        if let Err(e) = w.destroy() {
            RECREATING.store(false, Ordering::SeqCst);
            return Err(format!("destroy failed: {e}"));
        }
        // `destroy()` returns when the message is handled, but the window is
        // forgotten by the manager when the `Destroyed` event is processed —
        // which is a moment later. Building immediately then failed with
        // "a webview with label `main` already exists", and the ONE recovery
        // that can outlive a wedged renderer never ran. Wait for the label
        // to actually disappear.
        let deadline = Instant::now() + Duration::from_secs(2);
        while app.get_webview_window("main").is_some() {
            if Instant::now() >= deadline {
                RECREATING.store(false, Ordering::SeqCst);
                return Err("the old window is still registered after destroy".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    // Whatever happens, the exit guard comes down: leaving it up would make
    // the next `destroy` unable to exit the app at all.
    let built = build_main_window(app, &config);
    if built.is_ok() {
        // `visible: false` in the config means the fresh window is HIDDEN
        // until the page reveals it. A rebuild whose page never boots would
        // then leave an invisible window — and `tick` treats a hidden window
        // as "not an outage", so that state is permanent. Show it here.
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
        }
        reset_silence();
    }
    RECREATING.store(false, Ordering::SeqCst);
    built
}

/// Build the `main` webview from `tauri.conf.json`.
///
/// Split out of `recreate_ui` because there is a SECOND caller now: the
/// tray's 显示主窗口. That used to be `if let Some(w) = get_webview_window`
/// — a no-op when the window was gone, which is exactly when the user
/// clicks it. See `show_main_window`.
pub fn build_main_window(
    app: &tauri::AppHandle,
    config: &tauri::utils::config::WindowConfig,
) -> Result<(), String> {
    // The new page boots from scratch, so its `plugin_reap_orphans` would
    // treat every live session as an orphan of a dead frontend. It is not:
    // the host never went away.
    crate::KEEP_SESSIONS.store(true, Ordering::SeqCst);
    tauri::WebviewWindowBuilder::from_config(app, config)
        .and_then(|b| b.build().map(|_| ()))
        .map_err(|e| e.to_string())
}

/// Last rung: say it out loud. The in-app toast cannot help here — the
/// channel that would carry it is the broken one.
fn notify_ui_dead(app: &tauri::AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("Toolbox 界面失联")
        .body(
            "界面与后台的连接已断开（长时间待机后可能出现）。请右键托盘图标，先用「重新加载界面」，仍无效再用「重启应用」。",
        )
        .show();
}

/// One tick. Public so the setup hook reads as one line.
pub fn tick(app: &tauri::AppHandle) {
    // A hidden window is not an outage: the user put it in the tray, so
    // nothing they can see is broken. But the moment it comes BACK, the
    // silence that accumulated while it was away must not be read as a
    // fault — otherwise the first visible tick "repairs" a healthy window
    // by reloading it, and the user sees the boot splash again for no
    // reason. This is checked here rather than in the tray handler because
    // the window can also be summoned by the taskbar or the hotkey.
    let hidden = app
        .get_webview_window("main")
        .map(|w| !w.is_visible().unwrap_or(true))
        .unwrap_or(false);
    {
        static WAS_HIDDEN: AtomicBool = AtomicBool::new(false);
        let was = WAS_HIDDEN.swap(hidden, Ordering::SeqCst);
        if was && !hidden {
            forgive_outage();
            log(app, "the main window is back from the tray — silence clock restarted".into());
        }
    }

    // Is the UI actually talking? A call COUNTER that moved, not a silence
    // reading: `silent_ms` is reset by the tray and by the rebuild itself,
    // and treating that as "talking" is what made the ladder rebuild the
    // window every three minutes (each rebuild reset the attempt counter).
    let calls_now = calls();
    let prev_calls = LAST_CALLS_SEEN.swap(calls_now, Ordering::SeqCst);
    let talking = calls_now > prev_calls;

    // A rung that was issued is verified by TRAFFIC, and a rung that ran out
    // of time is reported as failed. Both are checked before anything else,
    // because "we tried something" and "it worked" are different facts and
    // the log used to confuse them.
    if let Some((step, expired)) = crate::forensics::recovery_state() {
        if talking && crate::forensics::recovery_has_traffic() {
            log(app, format!("recovery step {step} verified — the UI is talking again"));
            crate::forensics::clear_recovery();
        } else if expired {
            log(app, format!(
                "recovery step {step} did NOT bring the UI back — {} — report: {}",
                diag(app),
                crate::forensics::paths(app)
            ));
            crate::forensics::clear_recovery();
        }
    }

    let silent = silent_ms();
    if silent < 60_000 {
        // Talking (or booting). Close the outage, if there was one — but
        // only when traffic really arrived.
        if talking {
            let used = ATTEMPTS.swap(0, Ordering::SeqCst);
            if used > 0 {
                // `silent` is the CURRENT gap (under a minute), not the
                // length of the outage — quoting it as the outage is a lie.
                log(app, format!("the UI is talking again — {used} recovery step(s) were used"));
            }
        }
        return;
    }

    if hidden {
        return;
    }

    let attempts = ATTEMPTS.load(Ordering::SeqCst);
    match action_for(silent, attempts) {
        Action::None => {}
        Action::Reload => {
            ATTEMPTS.store(1, Ordering::SeqCst);
            // Snapshot BEFORE touching anything: a reload replaces the
            // document, and the state that explains the outage goes with it.
            let report = crate::forensics::freeze_report(app, "reload");
            log(app, format!(
                "the UI has been silent for {}s — {} — reloading the page — report: {}",
                silent / 1000,
                diag(app),
                report.map(|p| p.display().to_string()).unwrap_or_else(|| "unavailable".into())
            ));
            match reload_ui(app) {
                Ok(()) => crate::forensics::expect_recovery(1, Duration::from_secs(25)),
                Err(e) => log(app, format!("reload failed: {e}")),
            }
        }
        Action::Recreate => {
            ATTEMPTS.store(2, Ordering::SeqCst);
            let report = crate::forensics::freeze_report(app, "recreate");
            log(app, format!(
                "the UI is still silent after {}s — {} — rebuilding the webview — report: {}",
                silent / 1000,
                diag(app),
                report.map(|p| p.display().to_string()).unwrap_or_else(|| "unavailable".into())
            ));
            // Off this thread: `build()` waits for the event loop, and a
            // watchdog that blocks is a watchdog that cannot report.
            let app = app.clone();
            let _ = std::thread::Builder::new()
                .name("ui-rebuild".into())
                .spawn(move || match recreate_ui(&app) {
                    Ok(()) => {
                        // "Built" is not "working". The rebuild at 00:24
                        // logged success and the page never booted; the
                        // deadline is what makes that visible next time.
                        crate::forensics::expect_recovery(2, Duration::from_secs(40));
                        log(&app, "the main webview was rebuilt; sessions were kept — waiting for it to talk".into());
                    }
                    Err(e) => log(&app, format!("webview rebuild not attempted: {e}")),
                });
        }
        Action::Notify => {
            ATTEMPTS.store(3, Ordering::SeqCst);
            let report = crate::forensics::freeze_report(app, "notify");
            log(app, format!(
                "the UI is still silent after {}s — {} — telling the user — report: {}",
                silent / 1000,
                diag(app),
                report.map(|p| p.display().to_string()).unwrap_or_else(|| "unavailable".into())
            ));
            notify_ui_dead(app);
        }
        Action::Restart => {
            ATTEMPTS.store(4, Ordering::SeqCst);
            let report = crate::forensics::freeze_report(app, "restart");
            log(app, format!(
                "the UI is still silent after {}s — {} — restarting the app (a wedged WebView2 browser process cannot be rebuilt from inside it) — report: {}",
                silent / 1000,
                diag(app),
                report.map(|p| p.display().to_string()).unwrap_or_else(|| "unavailable".into())
            ));
            // `request_restart`, not `restart`: the latter runs on the main
            // thread and skips `RunEvent::Exit`, so `kill_all()` never runs
            // and every pty and sidecar is orphaned.
            app.request_restart();
        }
        Action::GiveUp => {
            ATTEMPTS.store(5, Ordering::SeqCst);
            let report = crate::forensics::freeze_report(app, "giveup");
            log(app, format!(
                "the UI is still silent after {}s — giving up until it talks again (use the tray) — report: {}",
                silent / 1000,
                report.map(|p| p.display().to_string()).unwrap_or_else(|| "unavailable".into())
            ));
        }
    }
}

/// The watcher thread. One thread, one sleep, no locks on the hot path.
pub fn spawn(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new()
        .name("ui-heartbeat".into())
        .spawn(move || {
            let mut last = Instant::now();
            loop {
                std::thread::sleep(TICK);
                let gap = last.elapsed();
                last = Instant::now();
                // The machine slept. The UI could not have called, so the gap
                // is not an outage — and treating it as one would fire the
                // whole ladder on every resume.
                if gap > RESUME_GAP {
                    LAST.store(now_ms(), Ordering::Relaxed);
                    SEEN.store(true, Ordering::Relaxed);
                    ATTEMPTS.store(0, Ordering::SeqCst);
                    log(&app, format!(
                        "the machine was suspended for ~{}s (resume detected) — silence clock restarted",
                        gap.as_secs()
                    ));
                    continue;
                }
                // A panic in here would silently kill the only thing that
                // reports on a dead UI, which is exactly when it matters.
                // And a swallowed panic is worse than a dead thread: the
                // 2026-10-30 outage stopped logging after step 2, so the
                // Restart rung never ran and the app sat dead for 2.5 h
                // with nothing in the log to say why.
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| tick(&app))).is_err() {
                    log(&app, "the recovery tick PANICKED — that rung did not run (see stderr for the backtrace)".into());
                }
            }
        });
}
