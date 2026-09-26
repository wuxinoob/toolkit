//! `clipboard` service (read / write) and the `clipboard` stream provider
//! (change notifications).
//!
//! ## Why two halves, and why they are shaped differently
//!
//! Reading and writing are **pull**: the plugin asks, the host answers. That is a
//! service action, like every other request/response in the gateway.
//!
//! Watching is **push**: the host has to tell the plugin something changed, and
//! a service action cannot do that. It is a stream provider instead, which means
//! it inherits the whole existing push machinery for free — it only polls while a
//! plugin is subscribed, it appears in the host's unified session list, it is
//! closed by the plugin's disposer when the plugin is disabled, and `kill_all()`
//! drains it on exit. A bespoke notification mechanism would have had to
//! reimplement all four.
//!
//! **The rule this settles**: pull → service, push → stream provider. It is why
//! `screen` is a service (a capture is one answer to one question) and this is
//! both.
//!
//! ## Why `arboard` and not `tauri-plugin-clipboard-manager`
//!
//! The Tauri plugin needs an `AppHandle`, and `StreamProvider` does not have one
//! — a provider runs on its own thread with no app. `arboard` is the same
//! underlying platform API without the Tauri plumbing, so both halves use one
//! library and neither needs the trait widened for one caller.
//!
//! ## The permission, and why it is not `rpc:stream`
//!
//! Watching the clipboard means reading **everything the user copies**. That is
//! not what `rpc:stream` says — that permission means "I can open a stream", and
//! it is already granted for a pty or a sidecar. Letting a provider widen it
//! silently is how a read grant becomes a surveillance grant, so the provider
//! declares its own permission and the stream layer checks it.

use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::time::Duration;

use super::stream::{self, Outcome, Sink, StreamProvider};
use super::{Service, ServiceError};
use crate::protocol::codes::code;

/// The permission both halves need. Declared once; the provider reports it
/// through `permission()` so the stream layer enforces it.
pub const PERMISSION: &str = "rpc:clipboard";

fn clipboard() -> Result<arboard::Clipboard, ServiceError> {
    // `arboard` retries internally: the clipboard is a global OS resource and
    // another process may hold it open at the moment we ask.
    arboard::Clipboard::new()
        .map_err(|e| ServiceError::new(code::INTERNAL, format!("clipboard unavailable: {e}")))
}

pub struct ClipboardService;

impl Service for ClipboardService {
    fn name(&self) -> &'static str {
        "clipboard"
    }
    fn actions(&self) -> &'static [&'static str] {
        &["read", "write"]
    }

    fn dispatch(
        &self,
        _app: &tauri::AppHandle,
        _plugin_id: &str,
        action: &str,
        params: Value,
    ) -> Result<Value, ServiceError> {
        match action {
            "read" => {
                let mut cb = clipboard()?;
                // An empty clipboard is NOT an error. `get_text` fails when the
                // clipboard holds an image, holds a format we do not read, or is
                // empty — and "there is no text" is a normal answer, not a
                // failure a plugin should have to catch. The distinction that
                // matters is "could not open the clipboard" (an error above) vs
                // "opened it and there is no text".
                Ok(json!({ "text": cb.get_text().ok() }))
            }
            "write" => {
                let text = params
                    .get("text")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ServiceError::bad_params("missing string param `text`"))?;
                let mut cb = clipboard()?;
                cb.set_text(text.to_string()).map_err(|e| {
                    ServiceError::new(code::INTERNAL, format!("clipboard write failed: {e}"))
                })?;
                Ok(json!({ "written": true }))
            }
            _ => Err(ServiceError::new(
                code::UNKNOWN_ACTION,
                format!("unknown clipboard action `{action}`"),
            )),
        }
    }
}

/// Pushes a `data` frame whenever the clipboard text changes.
pub struct ClipboardWatch;

impl StreamProvider for ClipboardWatch {
    fn name(&self) -> &'static str {
        "clipboard"
    }

    fn permission(&self) -> Option<&'static str> {
        Some(PERMISSION)
    }

    fn open_json(
        &self,
        plugin_id: &str,
        ch: &str,
        params: Value,
        sink: stream::JsonSink,
    ) -> Result<(), String> {
        // Polling, not an OS change hook: a hook needs a message loop on the
        // thread that registered it, and this runs on a stream thread. The
        // default is a compromise — fast enough that a copy feels immediate,
        // slow enough that it is not a busy loop on a global OS resource.
        let interval = params
            .get("intervalMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(500)
            .clamp(100, 10_000);
        // Two names for one thing: `run_stream` borrows the channel for the
        // session key, the closure owns it for the frames it sends.
        let ch_key = ch.to_string();
        let ch_frame = ch.to_string();

        stream::run_stream(plugin_id, &ch_key, Sink::Json(sink), move |sink, cancel, _bytes| {
            let mut cb = arboard::Clipboard::new()
                .map_err(|e| (code::INTERNAL.to_string(), format!("clipboard unavailable: {e}")))?;

            // Push the CURRENT value first. A subscriber should not have to
            // change the clipboard to learn what is already on it — and that is
            // also what makes the stream self-describing when a plugin attaches
            // mid-session.
            let mut last = cb.get_text().ok();
            if let Some(text) = last.clone() {
                sink.data(&ch_frame, json!({ "text": text }))
                    .map_err(|e| (code::INTERNAL.to_string(), e))?;
            }

            while !cancel.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(interval));
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                let now = cb.get_text().ok();
                if now != last {
                    last = now.clone();
                    sink.data(&ch_frame, json!({ "text": now }))
                        .map_err(|e| (code::INTERNAL.to_string(), e))?;
                }
            }
            Ok(Outcome::End)
        })
    }
}
