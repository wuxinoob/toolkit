//! Unified session registry — one place that knows about every live IO
//! endpoint, whatever mechanism created it.
//!
//! Previously a sidecar pipe and a PTY session were tracked by two unrelated
//! registries, so "clean up on exit" only covered one of them (PTY children
//! were orphaned). Now every endpoint registers here with a `stop` closure,
//! so shutdown is a single `kill_all()` — and the UI has a single session
//! list regardless of transport.
//!
//! `ch` (channel id) is the session key, matching the `ch` field of stream
//! envelopes; a session's id is `plugin/ch`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};

/// What kind of endpoint a session is. Purely descriptive — the host never
/// branches on it, it is for the UI and for diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    /// a plugin-shipped helper executable spoken to over stdio
    Sidecar,
    /// a host-side push stream
    Stream,
    /// a pseudo-terminal running a command-line program
    Pty,
}

impl SessionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionKind::Sidecar => "sidecar",
            SessionKind::Stream => "stream",
            SessionKind::Pty => "pty",
        }
    }
}

type StopFn = Arc<dyn Fn() + Send + Sync>;

pub struct Session {
    pub id: String,
    pub plugin: String,
    pub ch: String,
    pub kind: SessionKind,
    pub pid: Option<u32>,
    pub opened_at_ms: u128,
    /// Shared with the producer so metrics stay live without re-registering.
    pub bytes_out: Arc<AtomicU64>,
    stop: StopFn,
}

fn registry() -> &'static Mutex<HashMap<String, Session>> {
    static REG: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Session>> {
    registry().lock().unwrap_or_else(|e| e.into_inner())
}

pub fn id_of(plugin: &str, ch: &str) -> String {
    format!("{plugin}/{ch}")
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Register a session. Fails if `plugin/ch` is already live, so a leaked
/// session surfaces immediately instead of silently shadowing.
pub fn open(
    plugin: &str,
    ch: &str,
    kind: SessionKind,
    pid: Option<u32>,
    stop: StopFn,
) -> Result<Arc<AtomicU64>, String> {
    let id = id_of(plugin, ch);
    let mut map = lock();
    if map.contains_key(&id) {
        return Err(format!("session `{id}` is already open"));
    }
    let bytes_out = Arc::new(AtomicU64::new(0));
    map.insert(
        id.clone(),
        Session {
            id,
            plugin: plugin.to_string(),
            ch: ch.to_string(),
            kind,
            pid,
            opened_at_ms: now_ms(),
            bytes_out: Arc::clone(&bytes_out),
            stop,
        },
    );
    Ok(bytes_out)
}

/// Deregister without stopping (the producer already finished on its own).
pub fn close(plugin: &str, ch: &str) -> bool {
    lock().remove(&id_of(plugin, ch)).is_some()
}

/// Deregister AND run the stop closure (user-initiated cancel).
pub fn stop_one(plugin: &str, ch: &str) -> bool {
    let removed = lock().remove(&id_of(plugin, ch));
    match removed {
        Some(s) => {
            (s.stop)();
            true
        }
        None => false,
    }
}

/// Every live session, optionally scoped to one plugin.
pub fn list(plugin: Option<&str>) -> Vec<Value> {
    let mut out: Vec<Value> = lock()
        .values()
        .filter(|s| plugin.map(|p| p == s.plugin).unwrap_or(true))
        .map(|s| {
            json!({
                "id": s.id,
                "plugin": s.plugin,
                "ch": s.ch,
                "kind": s.kind.as_str(),
                "pid": s.pid,
                "openedAt": s.opened_at_ms,
                "bytesOut": s.bytes_out.load(Ordering::Relaxed),
            })
        })
        .collect();
    out.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    out
}

pub fn count() -> usize {
    lock().len()
}

/// Stop closure for an endpoint whose process is owned by SOMEONE ELSE — a
/// third-party plugin (tauri-plugin-pty keeps its own state) or a browser-side
/// spawn. We only have the pid, so kill the tree by pid. This is what closes
/// the "pty children outlive the host" gap: any transport that owns an OS
/// process registers its pid here and shutdown covers it like everything else.
pub fn pid_stop(pid: u32) -> StopFn {
    Arc::new(move || kill_pid_tree(pid))
}

#[cfg(windows)]
fn kill_pid_tree(pid: u32) {
    // /T also takes the children ConPTY spawns, which is the whole point.
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(unix)]
fn kill_pid_tree(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(not(any(windows, unix)))]
fn kill_pid_tree(_pid: u32) {}

/// Shutdown hook: drain first (so a `stop` that re-enters the registry can
/// not deadlock), then run every stop closure.
pub fn kill_all() -> usize {
    let drained: Vec<Session> = {
        let mut map = lock();
        map.drain().map(|(_, s)| s).collect()
    };
    let n = drained.len();
    for s in drained {
        (s.stop)();
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn noop() -> StopFn {
        Arc::new(|| {})
    }

    #[test]
    fn open_close_and_duplicate_guard() {
        let _g = crate::services::serial();
        kill_all();
        open("p", "a", SessionKind::Stream, None, noop()).unwrap();
        assert_eq!(count(), 1);
        let err = open("p", "a", SessionKind::Stream, None, noop()).unwrap_err();
        assert!(err.contains("already open"), "got: {err}");
        assert!(close("p", "a"));
        assert!(!close("p", "a"));
        assert_eq!(count(), 0);
    }

    #[test]
    fn stop_one_runs_the_closure_close_does_not() {
        let _g = crate::services::serial();
        kill_all();
        let hit = Arc::new(AtomicBool::new(false));
        let h = Arc::clone(&hit);
        open("p", "s", SessionKind::Sidecar, Some(42), Arc::new(move || h.store(true, Ordering::SeqCst))).unwrap();

        assert!(stop_one("p", "s"));
        assert!(hit.load(Ordering::SeqCst), "stop_one must invoke the stop closure");
        assert!(!stop_one("p", "s"), "already stopped");

        let hit2 = Arc::new(AtomicBool::new(false));
        let h2 = Arc::clone(&hit2);
        open("p", "t", SessionKind::Stream, None, Arc::new(move || h2.store(true, Ordering::SeqCst))).unwrap();
        assert!(close("p", "t"));
        assert!(!hit2.load(Ordering::SeqCst), "close must NOT invoke the stop closure");
    }

    #[test]
    fn kill_all_covers_every_kind_and_reports_the_count() {
        let _g = crate::services::serial();
        kill_all();
        let hits = Arc::new(AtomicU64::new(0));
        for (ch, kind) in [("a", SessionKind::Sidecar), ("b", SessionKind::Stream), ("c", SessionKind::Pty)] {
            let h = Arc::clone(&hits);
            open("p", ch, kind, None, Arc::new(move || {
                h.fetch_add(1, Ordering::SeqCst);
            }))
            .unwrap();
        }
        assert_eq!(count(), 3);
        assert_eq!(kill_all(), 3, "all three kinds must be stopped");
        assert_eq!(hits.load(Ordering::SeqCst), 3);
        assert_eq!(count(), 0);
    }

    #[test]
    fn list_reports_metadata_and_scopes_by_plugin() {
        let _g = crate::services::serial();
        kill_all();
        let bytes = open("p.one", "x", SessionKind::Stream, Some(7), noop()).unwrap();
        bytes.fetch_add(128, Ordering::Relaxed);
        open("p.two", "y", SessionKind::Pty, None, noop()).unwrap();

        let all = list(None);
        assert_eq!(all.len(), 2);
        let mine = list(Some("p.one"));
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0]["id"], json!("p.one/x"));
        assert_eq!(mine[0]["kind"], json!("stream"));
        assert_eq!(mine[0]["pid"], json!(7));
        assert_eq!(mine[0]["bytesOut"], json!(128));
        kill_all();
    }
}
