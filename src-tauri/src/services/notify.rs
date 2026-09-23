//! `notify` service: OS-level notifications (the Windows action centre, macOS
//! Notification Center, a Linux notification daemon).
//!
//! Distinct from `ctx.ui.notify`, which is the in-app toast. Both exist on
//! purpose: a toast is right for "saved" while the user is looking at the app,
//! and an OS notification is right for "your build finished" while they are not
//! — which is the case the toast cannot serve at all, because a toast only
//! exists inside a window the user may not be looking at.
//!
//! **Why a gateway service and not a raw async command like `plugin_dialog`**:
//! `NotificationBuilder::show()` is synchronous and needs no message loop, so it
//! is safe inside the (main-thread) gateway. The dialog needed a raw async
//! command precisely because it DOES block. Same rule, different answer — the
//! deciding factor is whether the call blocks.
//!
//! A plugin never touches `@tauri-apps/plugin-notification` (it cannot import
//! it); it calls `ctx.ui.notifyOS(...)` and the host does the rest.

use serde_json::{json, Value};
use tauri_plugin_notification::NotificationExt;

use super::{Service, ServiceError};
use crate::protocol::codes::code;

pub struct NotifyService;

impl Service for NotifyService {
    fn name(&self) -> &'static str {
        "notify"
    }
    fn actions(&self) -> &'static [&'static str] {
        &["send"]
    }

    fn dispatch(
        &self,
        app: &tauri::AppHandle,
        plugin_id: &str,
        action: &str,
        params: Value,
    ) -> Result<Value, ServiceError> {
        match action {
            "send" => {
                let title = params
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Toolbox")
                    .to_string();
                let body = params
                    .get("body")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ServiceError::bad_params("missing string param `body`"))?
                    .to_string();

                app.notification()
                    .builder()
                    .title(&title)
                    .body(&body)
                    .show()
                    .map_err(|e| ServiceError::new(code::INTERNAL, format!("notify: {e}")))?;

                // The plugin id comes back so the caller — and the trace line —
                // can attribute it. An OS notification is out-of-band, so
                // attribution is the only handle anyone has on where it came from.
                Ok(json!({ "sent": true, "by": plugin_id }))
            }
            other => Err(ServiceError::new(
                code::UNKNOWN_ACTION,
                format!("unknown action `notify/{other}`"),
            )),
        }
    }
}
