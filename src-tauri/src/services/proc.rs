//! Sidecar process service ("proc") — dynamic *backend* logic for plugins.
//!
//! Native code cannot be loaded into the host process at runtime (no stable
//! Rust ABI, and a crashing dylib would take the host down), so the gateway
//! grows a process boundary instead: a plugin may spawn a helper executable
//! that lives INSIDE its own plugin folder and talk to it over a line-based
//! stdio protocol (one JSON document per line, UTF-8):
//!
//! ```text
//!  plugin JS --plugin_rpc--> proc service --stdin-->  sidecar exe
//!           <-- {line} ---- proc service <--stdout--  sidecar exe
//! ```
//!
//! The service is a dumb, backend-agnostic pipe: message framing and id
//! correlation live in the plugin. Rust adds only:
//!   - exe path validation (must canonicalize under the plugin's own dir)
//!   - a lifecycle registry keyed by (plugin_id, key), max 4 per plugin
//!   - bounded line reads, timeout recv and exact exit-code detection
//!   - a `session` registration so app exit stops it with everything else
//!
//! Two registries exist on purpose: this module owns the *data path*
//! (the handle used by send/recv), while `services::session` owns the
//! *lifecycle* (stop closure + unified listing). Both are updated together.

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::external;
use super::session::{self, SessionKind};
use super::storage::validate_plugin_id;
use super::Service;

const MAX_PROCS_PER_PLUGIN: usize = 4;
/// Defense-in-depth: one stdout line may never exceed 1 MiB.
const MAX_LINE_BYTES: usize = 1 << 20;
const RECV_TIMEOUT_CAP_MS: u64 = 30_000;

#[derive(Clone, PartialEq, Eq, Hash)]
struct ProcKey {
    plugin: String,
    key: String,
}

#[derive(Default)]
struct ProcState {
    lines: VecDeque<String>,
    exited: Option<i32>,
}

struct ProcShared {
    state: Mutex<ProcState>,
    cv: Condvar,
}

#[derive(Clone)]
struct ProcHandle {
    pid: u32,
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    shared: Arc<ProcShared>,
}

fn registry() -> &'static Mutex<HashMap<ProcKey, ProcHandle>> {
    static REG: OnceLock<Mutex<HashMap<ProcKey, ProcHandle>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn params_str(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing string param `{key}`"))
}

/// Read one `\n`-terminated line, bounded. `Ok(None)` on clean EOF.
/// Trims the trailing `\n`/`\r` (a CRLF sidecar must not leak `\r` into JSON
/// payloads). Errors when the line exceeds `max` bytes. Pure + unit-testable.
fn read_line_bounded(r: &mut impl Read, max: usize) -> std::io::Result<Option<String>> {
    let mut buf: Vec<u8> = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match r.read(&mut byte)? {
            0 => {
                if buf.is_empty() {
                    return Ok(None);
                }
                break; // EOF right after a chunk without newline: keep partial line
            }
            _ => {
                if byte[0] == b'\n' {
                    break;
                }
                buf.push(byte[0]);
                if buf.len() > max {
                    return Err(std::io::Error::new(ErrorKind::InvalidData, "line too long"));
                }
            }
        }
    }
    while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
        buf.pop();
    }
    Ok(Some(String::from_utf8_lossy(&buf).into_owned()))
}

/// Per-process reader thread: stdout lines -> shared queue; on EOF, wait() the
/// child so the exit code is exact, then publish `exited` and wake recv()ers.
fn reader_thread(stdout: std::process::ChildStdout, child: Arc<Mutex<Child>>, shared: Arc<ProcShared>) {
    let mut r = std::io::BufReader::new(stdout);
    loop {
        match read_line_bounded(&mut r, MAX_LINE_BYTES) {
            Ok(Some(line)) => {
                let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                st.lines.push_back(line);
                shared.cv.notify_all();
            }
            Ok(None) => break, // EOF: stdout closed
            Err(_) => break,   // oversized line or read error: recv reports exit
        }
    }
    let code = child
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .wait()
        .ok()
        .and_then(|s| s.code())
        .unwrap_or(-1);
    let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    st.exited = Some(code);
    shared.cv.notify_all();
}

/// Spawn the sidecar. No path validation here — callers validate; tests use
/// this directly with system binaries.
fn spawn_handle(exe: &Path, args: &[String], cwd: &Path) -> Result<ProcHandle, String> {
    let mut child = Command::new(exe)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit()) // sidecar diagnostics land in the host console
        .spawn()
        .map_err(|e| format!("spawn {}: {e}", exe.display()))?;
    let stdin = child.stdin.take().ok_or("child stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("child stdout unavailable")?;
    let pid = child.id();
    let shared = Arc::new(ProcShared {
        state: Mutex::new(ProcState::default()),
        cv: Condvar::new(),
    });
    let child = Arc::new(Mutex::new(child));
    let reader_child = Arc::clone(&child);
    let reader_shared = Arc::clone(&shared);
    std::thread::Builder::new()
        .name(format!("proc-reader-{pid}"))
        .spawn(move || reader_thread(stdout, reader_child, reader_shared))
        .map_err(|e| format!("spawn reader thread: {e}"))?;
    Ok(ProcHandle {
        pid,
        stdin: Arc::new(Mutex::new(stdin)),
        child,
        shared,
    })
}

/// Pure path core: `exe` (relative to the plugin dir, subfolders allowed) must
/// resolve to a file that stays INSIDE the plugin dir. Canonicalize-then-prefix
/// check, mirroring external::read_entry_at (folds `..` and follows symlinks).
pub fn resolve_exe_at(plugin_dir: &Path, exe: &str) -> Result<PathBuf, String> {
    if exe.is_empty() {
        return Err("empty exe path".into());
    }
    let dir_canon = plugin_dir
        .canonicalize()
        .map_err(|e| format!("resolve plugin dir: {e}"))?;
    let file = dir_canon
        .join(exe)
        .canonicalize()
        .map_err(|e| format!("resolve exe: {e}"))?;
    if !file.starts_with(&dir_canon) {
        return Err("exe escapes plugin dir".into()); // traversal guard
    }
    if !file.is_file() {
        return Err("exe is not a file".into());
    }
    Ok(file)
}

fn write_line(h: &ProcHandle, line: &str) -> Result<(), String> {
    let mut sin = h.stdin.lock().unwrap_or_else(|e| e.into_inner());
    match writeln!(sin, "{line}").and_then(|_| sin.flush()) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Broken pipe: attach the exit code for better diagnostics.
            let code = h
                .child
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .try_wait()
                .ok()
                .flatten()
                .and_then(|s| s.code());
            Err(match code {
                Some(c) => format!("sidecar exited (code {c}): {e}"),
                None => format!("write sidecar: {e}"),
            })
        }
    }
}

/// Drain-before-exit semantics: queued stdout lines are returned even after
/// the process exits, so the last messages are never lost.
fn recv_from(shared: &Arc<ProcShared>, timeout: Duration) -> Value {
    let deadline = Instant::now() + timeout;
    let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if let Some(line) = st.lines.pop_front() {
            return json!({ "line": line });
        }
        if let Some(code) = st.exited {
            return json!({ "exited": true, "code": code });
        }
        let now = Instant::now();
        if now >= deadline {
            return json!({ "timeout": true });
        }
        let (guard, _) = shared
            .cv
            .wait_timeout(st, deadline - now)
            .unwrap_or_else(|e| e.into_inner());
        st = guard;
    }
}

/// Kill + reap one sidecar.
fn kill_handle(h: &ProcHandle) {
    let mut child = h.child.lock().unwrap_or_else(|e| e.into_inner());
    let _ = child.kill();
    let _ = child.wait();
}

/// Stop closure handed to the session registry: kills the process only, so it
/// is safe to call while the registry is being drained.
fn stop_closure(h: ProcHandle) -> Arc<dyn Fn() + Send + Sync> {
    Arc::new(move || kill_handle(&h))
}

fn kill_one(plugin: &str, key: &str) -> bool {
    let pkey = ProcKey { plugin: plugin.into(), key: key.into() };
    let removed = registry().lock().unwrap_or_else(|e| e.into_inner()).remove(&pkey);
    match removed {
        Some(h) => {
            kill_handle(&h);
            session::close(plugin, key);
            true
        }
        None => false,
    }
}

fn kill_all_for(plugin: &str) -> usize {
    let keys: Vec<ProcKey> = {
        let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
        let mine: Vec<ProcKey> = map.keys().filter(|k| k.plugin == plugin).cloned().collect();
        for k in &mine {
            map.remove(k);
        }
        mine
    };
    for k in &keys {
        session::close(&k.plugin, &k.key);
    }
    // Stop through the session registry so there is exactly one kill path.
    for k in &keys {
        session::stop_one(&k.plugin, &k.key);
    }
    keys.len()
}

// ------------------------------- actions --------------------------------------

fn action_spawn(root: &Path, plugin_id: &str, params: &Value) -> Result<Value, String> {
    let key = params_str(params, "key")?;
    let exe = params_str(params, "exe")?;
    let args: Vec<String> = params
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();

    // Locate the plugin's source dir by manifest id (scan is cheap: few dirs).
    let dir = external::scan_at(root)?
        .into_iter()
        .find(|p| p.id == plugin_id)
        .ok_or("plugin not found in plugins root — install its folder (plugin.json) first")?
        .dir;
    let exe_path = resolve_exe_at(Path::new(&dir), &exe)?;

    let pkey = ProcKey { plugin: plugin_id.into(), key: key.clone() };
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(h) = map.get(&pkey) {
        return Ok(json!({ "reused": true, "pid": h.pid }));
    }
    let per_plugin = map.keys().filter(|k| k.plugin == plugin_id).count();
    if per_plugin >= MAX_PROCS_PER_PLUGIN {
        return Err(format!(
            "too many sidecars for `{plugin_id}` (max {MAX_PROCS_PER_PLUGIN}) — proc.killAll() first"
        ));
    }
    let handle = spawn_handle(&exe_path, &args, Path::new(&dir))?;
    let pid = handle.pid;
    // Register with the unified session registry BEFORE publishing the handle,
    // so a failure can never leave an untracked child running.
    if let Err(e) = session::open(plugin_id, &key, SessionKind::Sidecar, Some(pid), stop_closure(handle.clone())) {
        kill_handle(&handle);
        return Err(e);
    }
    map.insert(pkey, handle);
    Ok(json!({ "reused": false, "pid": pid }))
}

fn action_send(plugin_id: &str, params: &Value) -> Result<Value, String> {
    let key = params_str(params, "key")?;
    let line = params_str(params, "line")?;
    let h = registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&ProcKey { plugin: plugin_id.into(), key })
        .cloned()
        .ok_or("sidecar not running — spawn first")?;
    write_line(&h, &line)?;
    Ok(Value::Bool(true))
}

fn action_recv(plugin_id: &str, params: &Value) -> Result<Value, String> {
    let key = params_str(params, "key")?;
    let ms = params
        .get("timeoutMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(5000)
        .min(RECV_TIMEOUT_CAP_MS);
    let h = registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&ProcKey { plugin: plugin_id.into(), key })
        .cloned()
        .ok_or("sidecar not running — spawn first")?;
    Ok(recv_from(&h.shared, Duration::from_millis(ms)))
}

/// `proc` service: poll-mode sidecar pipes (request/response driven by the
/// plugin via `send`/`recv`).
pub struct ProcService;

impl Service for ProcService {
    fn name(&self) -> &'static str {
        "proc"
    }
    fn actions(&self) -> &'static [&'static str] {
        &["spawn", "send", "recv", "kill", "kill_all", "list"]
    }
    fn dispatch(
        &self,
        app: &tauri::AppHandle,
        plugin_id: &str,
        action: &str,
        params: Value,
    ) -> Result<Value, String> {
        validate_plugin_id(plugin_id)?;
        let root = external::plugins_root(app)?;
        dispatch_at(&root, plugin_id, action, params)
    }
}

/// Core dispatch (root-based; spawn performs a real process spawn, the rest is
/// cheap bookkeeping — see the tests for which parts are exercised how).
pub fn dispatch_at(root: &Path, plugin_id: &str, action: &str, params: Value) -> Result<Value, String> {
    match action {
        "spawn" => action_spawn(root, plugin_id, &params),
        "send" => action_send(plugin_id, &params),
        "recv" => action_recv(plugin_id, &params),
        "kill" => Ok(Value::Bool(kill_one(plugin_id, &params_str(&params, "key")?))),
        "kill_all" => Ok(json!({ "killed": kill_all_for(plugin_id) })),
        "list" => {
            let map = registry().lock().unwrap_or_else(|e| e.into_inner());
            Ok(Value::Array(
                map.iter()
                    .filter(|(k, _)| k.plugin == plugin_id)
                    .map(|(k, h)| json!({ "key": k.key, "pid": h.pid }))
                    .collect(),
            ))
        }
        _ => Err(format!("unknown action `proc/{action}`")),
    }
}

// -------------------------------- tests ---------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("toolbox-proc-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ---- read_line_bounded ----

    #[test]
    fn bounded_reader_lines_eof_and_crlf() {
        let mut r = Cursor::new(b"one\r\ntwo\nthree".to_vec());
        assert_eq!(read_line_bounded(&mut r, 100).unwrap(), Some("one".into()));
        assert_eq!(read_line_bounded(&mut r, 100).unwrap(), Some("two".into()));
        assert_eq!(read_line_bounded(&mut r, 100).unwrap(), Some("three".into()));
        assert_eq!(read_line_bounded(&mut r, 100).unwrap(), None, "clean EOF");
    }

    #[test]
    fn bounded_reader_rejects_oversized_line() {
        let big = vec![b'x'; 64];
        let mut r = Cursor::new(big);
        let err = read_line_bounded(&mut r, 8).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::InvalidData);
    }

    // ---- resolve_exe_at ----

    #[test]
    fn resolve_exe_validates_paths() {
        let root = temp_root("resolve");
        let plugin = root.join("p");
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(plugin.join("calc.exe"), b"MZ").unwrap();

        let ok = resolve_exe_at(&plugin, "calc.exe").unwrap();
        assert!(ok.is_file());
        assert!(resolve_exe_at(&plugin, "../evil.exe").is_err(), "traversal must be rejected");
        assert!(resolve_exe_at(&plugin, "missing.exe").is_err(), "missing exe must be rejected");
        assert!(resolve_exe_at(&plugin, "").is_err(), "empty exe must be rejected");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- queue/recv semantics (no real process) ----

    #[test]
    fn recv_drains_lines_then_reports_exit_and_times_out() {
        let shared = Arc::new(ProcShared {
            state: Mutex::new(ProcState::default()),
            cv: Condvar::new(),
        });
        assert_eq!(recv_from(&shared, Duration::from_millis(30))["timeout"], json!(true));

        {
            let mut st = shared.state.lock().unwrap();
            st.lines.push_back("a".into());
            st.lines.push_back("b".into());
            st.exited = Some(3);
            shared.cv.notify_all();
        }
        assert_eq!(recv_from(&shared, Duration::from_secs(1))["line"], json!("a"));
        assert_eq!(recv_from(&shared, Duration::from_secs(1))["line"], json!("b"), "drain order");
        let last = recv_from(&shared, Duration::from_secs(1));
        assert_eq!(last["exited"], json!(true));
        assert_eq!(last["code"], json!(3));
    }

    // ---- real sidecar roundtrips (Windows) ----

    #[cfg(windows)]
    fn win_cmd() -> String {
        std::env::var("ComSpec").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into())
    }

    #[cfg(windows)]
    #[test]
    fn real_sidecar_stdout_and_exit_code() {
        let h = spawn_handle(Path::new(&win_cmd()), &["/C".into(), "echo sidecar-ok".into()], Path::new("."))
            .unwrap();
        let line = recv_from(&h.shared, Duration::from_secs(10));
        assert_eq!(line["line"], json!("sidecar-ok"));
        let end = recv_from(&h.shared, Duration::from_secs(10));
        assert_eq!(end["exited"], json!(true));
        assert_eq!(end["code"], json!(0));
    }

    #[cfg(windows)]
    #[test]
    fn real_sidecar_stdin_roundtrip() {
        let args: Vec<String> = [
            "-NoProfile",
            "-Command",
            "$l=[Console]::In.ReadLine(); Write-Output ('got:'+$l)",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let h = spawn_handle(Path::new("powershell"), &args, Path::new(".")).unwrap();
        write_line(&h, "abc").unwrap();
        let line = recv_from(&h.shared, Duration::from_secs(15));
        assert_eq!(line["line"], json!("got:abc"), "stdin must reach sidecar stdout");
        kill_handle(&h);
    }

    #[cfg(windows)]
    #[test]
    fn dispatch_spawn_recv_kill_registers_and_releases_the_session() {
        let _g = crate::services::serial();
        session::kill_all();
        let root = temp_root("dispatch");
        let plugin = root.join("calc-demo");
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(plugin.join("plugin.json"), r#"{"id":"test.proc","entry":"main.js"}"#).unwrap();
        std::fs::write(plugin.join("main.js"), "export default {};").unwrap();
        let exe_copy = plugin.join("cmdunder.exe");
        std::fs::copy(win_cmd(), &exe_copy).unwrap();

        let spawn = dispatch_at(
            &root,
            "test.proc",
            "spawn",
            json!({ "key": "k1", "exe": "cmdunder.exe", "args": ["/C", "echo full-path-ok"] }),
        )
        .unwrap();
        assert_eq!(spawn["reused"], json!(false));
        assert!(spawn["pid"].as_u64().unwrap() > 0);
        // the unified registry must know about it
        let live = session::list(Some("test.proc"));
        assert_eq!(live.len(), 1, "spawn must register a session");
        assert_eq!(live[0]["kind"], json!("sidecar"));

        let line = dispatch_at(&root, "test.proc", "recv", json!({ "key": "k1", "timeoutMs": 10000 })).unwrap();
        assert_eq!(line["line"], json!("full-path-ok"));

        let again = dispatch_at(&root, "test.proc", "spawn", json!({ "key": "k1", "exe": "cmdunder.exe" })).unwrap();
        assert_eq!(again["reused"], json!(true));

        assert_eq!(dispatch_at(&root, "test.proc", "kill", json!({ "key": "k1" })).unwrap(), Value::Bool(true));
        assert_eq!(session::list(Some("test.proc")).len(), 0, "kill must release the session");
        assert!(validate_plugin_id("bad/id").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// End-to-end: a REAL plugin backend (examples/calc-plugin) that speaks the
    /// unified envelope over the `line-json` codec. This is the test that proves
    /// the sidecar data plane is not a bespoke protocol — the helper answers in
    /// exactly the shapes the host uses.
    ///
    /// Skipped when calc.exe has not been built:
    ///   cd examples/calc-plugin && gcc -O2 -o calc.exe calc.c
    #[cfg(windows)]
    #[test]
    fn real_sidecar_speaks_the_unified_envelope_protocol() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/calc-plugin/calc.exe");
        if !src.is_file() {
            eprintln!("SKIP: build examples/calc-plugin/calc.exe first (gcc -O2 -o calc.exe calc.c)");
            return;
        }
        let _g = crate::services::serial();
        session::kill_all();

        let root = temp_root("calc");
        let plugin = root.join("calc.demo");
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(plugin.join("plugin.json"), r#"{"id":"calc.demo","entry":"main.js"}"#).unwrap();
        std::fs::write(plugin.join("main.js"), "export default {};").unwrap();
        std::fs::copy(&src, plugin.join("calc.exe")).unwrap();

        let spawn = dispatch_at(&root, "calc.demo", "spawn", json!({ "key": "calc", "exe": "calc.exe" })).unwrap();
        assert!(spawn["pid"].as_u64().unwrap() > 0);
        assert_eq!(session::list(Some("calc.demo")).len(), 1, "the sidecar must be tracked");

        // 1. a normal request travels as a `req` envelope and answers with `res`
        let ask = |id: u64, op: &str, a: i64, b: i64| {
            json!({ "v": 1, "kind": "req", "id": id, "svc": "calc", "act": "eval",
                    "p": { "op": op, "a": a, "b": b } })
            .to_string()
        };
        dispatch_at(&root, "calc.demo", "send", json!({ "key": "calc", "line": ask(1, "mul", 6, 7) })).unwrap();
        let line = dispatch_at(&root, "calc.demo", "recv", json!({ "key": "calc", "timeoutMs": 10000 })).unwrap();
        let res: Value = serde_json::from_str(line["line"].as_str().unwrap()).unwrap();
        assert_eq!(res["kind"], json!("res"));
        assert_eq!(res["id"], json!(1));
        assert_eq!(res["p"]["result"], json!(42));

        // 2. a protocol error comes back on the SAME envelope, as an `err`
        dispatch_at(&root, "calc.demo", "send", json!({ "key": "calc", "line": ask(2, "div", 1, 0) })).unwrap();
        let line = dispatch_at(&root, "calc.demo", "recv", json!({ "key": "calc", "timeoutMs": 10000 })).unwrap();
        let err: Value = serde_json::from_str(line["line"].as_str().unwrap()).unwrap();
        assert_eq!(err["kind"], json!("err"));
        assert_eq!(err["id"], json!(2));
        assert_eq!(err["code"], json!("div_by_zero"));

        // 3. and the envelope survives a round trip through our own decoder
        let decoded = crate::protocol::codec::line_json::decode_line(line["line"].as_str().unwrap()).unwrap();
        assert_eq!(decoded.kind, crate::protocol::envelope::Kind::Err);

        dispatch_at(&root, "calc.demo", "kill", json!({ "key": "calc" })).unwrap();
        assert_eq!(session::list(Some("calc.demo")).len(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }
}
