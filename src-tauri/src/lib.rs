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

use protocol::envelope::Envelope;

/// Declare a plugin's manifest permissions. Called once per plugin at load
/// time; the registry is fail-closed, so an unregistered plugin can reach
/// nothing.
#[tauri::command]
fn plugin_register(plugin_id: String, permissions: Vec<String>) -> Result<(), String> {
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
#[tauri::command]
fn plugin_rpc(app: tauri::AppHandle, plugin_id: String, msg: Envelope) -> Result<Envelope, String> {
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

    // The authoritative permission gate. The JS `ctx` gate is a convenience
    // check; this one cannot be bypassed by reaching invoke() directly.
    if let Err(e) = host::registry::is_allowed(&plugin_id, &format!("rpc:{svc}")) {
        return Ok(Envelope::err(Some(id), "denied", e));
    }

    match services::route(&app, &plugin_id, &svc, &act, msg.p) {
        Ok(v) => Ok(Envelope::res(id, v)),
        // The service classified it; the caller gets that code, not a
        // synthesized `svc/act` string it cannot branch on.
        Err(e) => Ok(Envelope::err(Some(id), e.code, e.msg)),
    }
}

/// Open a push stream framed as `json-envelope` (one `Channel<Envelope>`).
#[tauri::command]
fn plugin_stream_open(
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
fn plugin_stream_open_raw(
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
fn plugin_stream_close(plugin_id: String, ch: String) -> Result<Value, String> {
    host::registry::is_allowed(&plugin_id, "rpc:stream")?;
    Ok(json!({ "stopped": services::session::stop_one(&plugin_id, &ch) }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            plugin_rpc,
            plugin_register,
            plugin_stream_open,
            plugin_stream_open_raw,
            plugin_stream_close,
            services::external::plugin_scan,
            services::external::plugin_read_entry,
            services::external::plugin_open_dir
        ])
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
