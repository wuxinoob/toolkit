//! Toolbox host entry point.
//!
//! Everything a plugin can reach the native side with goes through THREE
//! entry points, and all three are table-driven:
//!
//! ```text
//!   plugin_rpc            uplink req -> res | err        (services::table)
//!   plugin_stream_open*   downlink data|end|exit|err     (services::stream providers)
//!   plugin_register       declares a plugin's permissions
//! ```
//!
//! The gateway itself contains no per-service branching and no per-transport
//! branching: it validates the envelope, checks the permission registry, and
//! looks the service up. Adding a capability means adding a table entry.

pub mod host;
pub mod protocol;
pub mod services;

use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Manager;

use protocol::envelope::Envelope;

/// Declare a plugin's manifest permissions. Called once per plugin at load
/// time; the registry is fail-closed, so an unregistered plugin can reach
/// nothing.
///
/// `async` for the same reason as `plugin_rpc`: **no command in this app is
/// allowed to run on the main thread.** The failure mode of getting that wrong
/// is invisible — a stalled message pump looks like "the UI is laggy", not like
/// "a command blocked" — so the rule is uniform rather than judged per command.
#[tauri::command]
async fn plugin_register(plugin_id: String, permissions: Vec<String>) -> Result<(), String> {
    services::storage::validate_plugin_id(&plugin_id).map_err(|e| e.msg)?;
    host::registry::register(&plugin_id, &permissions);
    Ok(())
}

/// The single request/response gateway.
///
/// Returns `Ok(Envelope)` for every service-level outcome (a `res` or an
/// `err` envelope), so the caller always has one shape to switch on. The
/// `Err(String)` channel is reserved for protocol breakage — a malformed
/// envelope or an unknown service — which no well-behaved caller can hit.
///
/// ## Why this is `async` and then `spawn_blocking`
///
/// It used to be a plain `fn`. Tauri runs a command without the `async` keyword
/// **on the main thread** — the same thread that pumps window messages for every
/// webview in the process. So the gateway, which every plugin call goes
/// through, was doing blocking file I/O on the UI thread:
///
///   storage/get           `create_dir_all` + read whole file + parse
///   storage/set           `create_dir_all` + rewrite whole file
///   host/write_debug_log  metadata + open + write + close, once per line
///   bus/publish           `app.emit`, which posts to EVERY window
///
/// A window that cannot be pumped cannot be dragged, resized or repainted, and
/// it takes the OTHER windows down with it because the thread is shared. That is
/// why a plugin chattering over the gateway made the main window feel stuck.
///
/// `async` alone already lifts this off the main thread. The extra
/// `spawn_blocking` is because the work is genuinely blocking: a blocking call
/// inside an async task parks a runtime WORKER, and there are only as many of
/// those as there are CPU cores — a burst of storage calls would then stall
/// every other async task in the app, which is the same bug wearing a different
/// hat. The blocking pool is the right home for it, and it is unbounded-ish by
/// design so a burst queues instead of starving.
#[tauri::command]
async fn plugin_rpc(
    app: tauri::AppHandle,
    plugin_id: String,
    msg: Envelope,
) -> Result<Envelope, String> {
    services::storage::validate_plugin_id(&plugin_id).map_err(|e| e.msg)?;
    msg.validate()?;
    if !msg.kind.is_uplink() {
        return Err(format!(
            "plugin_rpc expects a `req` envelope, got `{}`",
            msg.kind.as_str()
        ));
    }
    let id = msg.id.unwrap_or(0);
    let svc = msg.svc.clone().unwrap_or_default();
    let act = msg.act.clone().unwrap_or_default();
    let params = msg.p;

    // The authoritative permission gate. The JS `ctx` gate is a convenience
    // check; this one cannot be bypassed by reaching invoke() directly.
    if let Err(e) = host::registry::is_allowed(&plugin_id, &format!("rpc:{svc}")) {
        return Ok(Envelope::err(Some(id), "denied", e));
    }

    tauri::async_runtime::spawn_blocking(move || {
        match services::route(&app, &plugin_id, &svc, &act, params) {
            Ok(v) => Ok(Envelope::res(id, v)),
            // The service classified it; the caller gets that code, not a
            // synthesized `svc/act` string it cannot branch on.
            Err(e) => Ok(Envelope::err(Some(id), e.code, e.msg)),
        }
    })
    .await
    .map_err(|e| format!("rpc task failed: {e}"))?
}

/// Open a push stream framed as `json-envelope` (one `Channel<Envelope>`).
#[tauri::command]
async fn plugin_stream_open(
    plugin_id: String,
    provider: String,
    ch: String,
    params: Option<Value>,
    on_frame: Channel<Envelope>,
) -> Result<(), String> {
    host::registry::is_allowed(&plugin_id, "rpc:stream")?;
    services::stream::open_json(&plugin_id, &provider, &ch, params.unwrap_or(Value::Null), on_frame)
}

/// Open a push stream framed as `raw-binary` (1 kind byte + payload).
#[tauri::command]
async fn plugin_stream_open_raw(
    plugin_id: String,
    provider: String,
    ch: String,
    params: Option<Value>,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    host::registry::is_allowed(&plugin_id, "rpc:stream")?;
    services::stream::open_raw(&plugin_id, &provider, &ch, params.unwrap_or(Value::Null), on_frame)
}

/// Cancel an open stream (cooperative, through the unified session registry).
#[tauri::command]
async fn plugin_stream_close(plugin_id: String, ch: String) -> Result<Value, String> {
    host::registry::is_allowed(&plugin_id, "rpc:stream")?;
    Ok(json!({ "stopped": services::session::stop_one(&plugin_id, &ch) }))
}

/// Console control events, so the exit path is not skipped.
///
/// `RunEvent::Exit` only fires on a graceful shutdown (the window closing). A
/// `Ctrl+C` in the terminal kills the process outright — Tauri installs no
/// console handler — so the session drain would never run and any live sidecar
/// or pty would be left behind. In a dev loop that is the *common* way to quit,
/// so the orphans would accumulate exactly where nobody is watching.
#[cfg(windows)]
mod console_exit {
    use windows_sys::Win32::Foundation::BOOL;
    use windows_sys::Win32::System::Console::{
        SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT, CTRL_C_EVENT,
    };

    unsafe extern "system" fn handler(ctrl_type: u32) -> BOOL {
        if matches!(ctrl_type, CTRL_C_EVENT | CTRL_BREAK_EVENT | CTRL_CLOSE_EVENT) {
            let n = crate::services::session::kill_all();
            if n > 0 {
                eprintln!("[host] stopped {n} live session(s) on console exit");
            }
            // Exit ourselves rather than returning FALSE: returning lets the
            // default handler kill us mid-drain, and the whole point is to
            // finish the drain first.
            std::process::exit(130); // 128 + SIGINT
        }
        // Anything else (logoff, shutdown) keeps the default behaviour.
        0
    }

    pub fn install() {
        let ok = unsafe { SetConsoleCtrlHandler(Some(handler), 1) };
        if ok == 0 {
            eprintln!("[host] could not install the console exit handler");
        }
    }
}

/// Drop sessions left behind by a previous frontend.
///
/// A page reload replaces the JS context while this process keeps running — in
/// dev that is every HMR update. The previous incarnation's sessions stay
/// registered, and they hold **real OS processes**, so this is a leak rather
/// than a stale entry: reload ten times and ten orphans accumulate, and the
/// in-app selftest starts reporting failures that are not failures.
///
/// `RunEvent::Exit` and the console handler both drain on the way out. A reload
/// passes through neither, so the new frontend has to say so itself.
///
/// Main window only. This is the host's own boot talking; a plugin window has no
/// business ending sessions it did not open, and app commands are not ACL-gated,
/// so the label check is the gate.
#[tauri::command]
async fn plugin_reap_orphans(window: tauri::WebviewWindow) -> Result<usize, String> {
    require_main(&window)?;
    // Killing a process tree waits on children, so it is blocking work — and it
    // runs on the path that reveals the window at boot.
    tauri::async_runtime::spawn_blocking(crate::services::session::kill_all)
        .await
        .map_err(|e| format!("reap task failed: {e}"))
}

/// Native file picker / save dialog / message box, on a plugin's behalf.
///
/// **Why this is NOT a gateway action.** `plugin_rpc` is a *synchronous*
/// command, so it runs on the main thread — and `blocking_pick_file()` there
/// would deadlock: the dialog needs the main thread's message loop to pump
/// while we sit on it waiting. The plugin's own commands are `async fn` for
/// exactly this reason (they run on the runtime's thread pool).
///
/// So this is a raw command, like `plugin_stream_open`, and it gates itself
/// with the same registry check the gateway would have used.
///
/// Nothing is granted to the plugin for free: the paths returned are the ones
/// the USER picked in a dialog they could see and cancel. That is why there is
/// no `ctx.fs` here — the user's action is the grant, and the plugin gets back
/// only what was handed over.
#[tauri::command]
async fn plugin_dialog(
    app: tauri::AppHandle,
    plugin_id: String,
    action: String,
    params: Option<Value>,
) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;

    // Same fail-closed gate as every other plugin entry point.
    host::registry::is_allowed(&plugin_id, "rpc:dialog")?;

    let params = params.unwrap_or(Value::Null);
    let str_param = |key: &str| -> Option<String> {
        params.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
    };

    match action.as_str() {
        "open" => {
            let multiple = params.get("multiple").and_then(|v| v.as_bool()).unwrap_or(false);
            let folder = params.get("folder").and_then(|v| v.as_bool()).unwrap_or(false);

            let mut builder = app.dialog().file();
            if let Some(t) = str_param("title") {
                builder = builder.set_title(t);
            }
            if let Some(d) = str_param("directory") {
                builder = builder.set_directory(d);
            }
            if let Some(filters) = params.get("filters").and_then(|v| v.as_array()) {
                for f in filters {
                    let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("files");
                    let exts: Vec<&str> = f
                        .get("extensions")
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().filter_map(|e| e.as_str()).collect())
                        .unwrap_or_default();
                    let exts: Vec<&str> = exts;
                    builder = builder.add_filter(name, &exts);
                }
            }

            // `blocking_*` is safe HERE and only here: this is an async command,
            // so it is running on the runtime's pool, not the main thread.
            let picked: Vec<String> = if folder {
                let v = if multiple {
                    builder.blocking_pick_folders()
                } else {
                    builder.blocking_pick_folder().map(|p| vec![p])
                };
                v.unwrap_or_default()
                    .into_iter()
                    .map(|p| p.to_string())
                    .collect()
            } else {
                let v = if multiple {
                    builder.blocking_pick_files()
                } else {
                    builder.blocking_pick_file().map(|p| vec![p])
                };
                v.unwrap_or_default()
                    .into_iter()
                    .map(|p| p.to_string())
                    .collect()
            };

            // An empty list means "cancelled" — not an error. The caller decides
            // whether that is worth mentioning.
            Ok(json!({ "paths": picked, "cancelled": picked.is_empty() }))
        }

        "save" => {
            let mut builder = app.dialog().file();
            if let Some(t) = str_param("title") {
                builder = builder.set_title(t);
            }
            if let Some(name) = str_param("defaultPath") {
                builder = builder.set_file_name(name);
            }
            let path = builder.blocking_save_file().map(|p| p.to_string());
            Ok(json!({ "path": path, "cancelled": path.is_none() }))
        }

        "message" => {
            let message = str_param("message")
                .ok_or_else(|| "dialog/message needs a `message`".to_string())?;
            let mut builder = app.dialog().message(message);
            if let Some(t) = str_param("title") {
                builder = builder.title(t);
            }
            builder.blocking_show();
            Ok(json!({ "shown": true }))
        }

        other => Err(format!("unknown dialog action `{other}`")),
    }
}

/// Read the OS autostart state.
///
/// Not stored in our own settings: the registry is the source of truth, and a
/// user can turn the entry off from Task Manager without telling us. Asking the
/// OS every time is the only answer that cannot go stale.
///
/// Main window only — see `plugin_reap_orphans` for why app commands need a
/// label check.
#[tauri::command]
async fn host_autostart_get(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    require_main(&window)?;
    // The autostart plugin reads the registry, and a registry read on the
    // message thread is the same class of mistake as a file read there.
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch()
            .is_enabled()
            .map_err(|e| format!("autostart query: {e}"))
    })
    .await
    .map_err(|e| format!("autostart task failed: {e}"))?
}

/// Turn autostart on or off, and report the state the OS ended up in.
///
/// Returns the re-read state rather than the requested one: enabling can fail
/// silently on some Windows policies, and the UI should show what actually
/// happened, not what was asked for.
#[tauri::command]
async fn host_autostart_set(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<bool, String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_autostart::ManagerExt;
        let mgr = app.autolaunch();
        if enabled {
            mgr.enable().map_err(|e| format!("autostart enable: {e}"))?;
        } else {
            mgr.disable().map_err(|e| format!("autostart disable: {e}"))?;
        }
        mgr.is_enabled()
            .map_err(|e| format!("autostart query after set: {e}"))
    })
    .await
    .map_err(|e| format!("autostart task failed: {e}"))?
}

/// App commands are not ACL-gated, so the window label is the gate.
fn require_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(format!(
            "this command is main-window only (called from \"{}\")",
            window.label()
        ))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before the window exists: Ctrl+C must drain sessions too.
    #[cfg(windows)]
    console_exit::install();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Registered for its RUST API only. The plugin's own JS commands are
        // deliberately left un-permissioned in the capability files: a plugin
        // cannot import `@tauri-apps/plugin-dialog`, so the only way to a dialog
        // is through `plugin_dialog`, which gates on `rpc:dialog`.
        .plugin(tauri_plugin_dialog::init())
        // Rust API only, like the dialog plugin: a plugin cannot import the JS
        // package, so `notify` is reachable solely through the gateway service,
        // which gates on `rpc:notify`. Its own JS commands stay un-permissioned
        // in the capability files, so the direct path is ACL-denied.
        .plugin(tauri_plugin_notification::init())
        // LaunchAgent is the macOS mechanism; on Windows the plugin writes the
        // HKCU Run entry. No extra args: we want the app started plainly, and
        // the main window is what the user asked to see.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            plugin_rpc,
            plugin_register,
            plugin_stream_open,
            plugin_stream_open_raw,
            plugin_stream_close,
            plugin_reap_orphans,
            host_autostart_get,
            host_autostart_set,
            plugin_dialog,
            services::external::plugin_scan,
            services::external::plugin_read_entry,
            services::external::plugin_open_dir
        ])
        .setup(|app| {
            // The main window is created hidden so nobody ever sees an unpainted
            // frame; the frontend reveals it after its first paint (see
            // `src/main.js`). If the frontend never gets that far — a JS error,
            // a dev server that is down, a blank page — the window would stay
            // hidden forever and the app would look like it failed to launch.
            // This is the backstop for that, and the reason the hidden start is
            // safe to ship.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                if let Some(w) = handle.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                        eprintln!(
                            "[host] frontend did not reveal the window within 5s — showing it anyway"
                        );
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // ONE shutdown path for every live endpoint — sidecars, streams and
            // PTY sessions alike. Previously only sidecars were stopped, so PTY
            // children were orphaned.
            if let tauri::RunEvent::Exit = event {
                let n = services::session::kill_all();
                if n > 0 {
                    eprintln!("[host] stopped {n} live session(s) on exit");
                }
            }
        });
}
