//! `bus` service: the cross-window broadcast.
//!
//! The frontend event bus is a per-window `Map`, so anything that must reach
//! *another* window (the floating widget, an external plugin window) cannot
//! use it. Rather than a bespoke mechanism per feature, publishing goes
//! through the same gateway as everything else and the host fans it out:
//!
//!   plugin JS --plugin_rpc(bus/publish)--> Rust `app.emit` --> every window
//!
//! Subscribers in any window just `listen(BROADCAST_EVENT)` and filter by
//! topic, so the same code works in-window and cross-window. This replaces
//! the old 250 ms storage poll.

use serde_json::{json, Value};
use tauri::Emitter;

use super::{Service, ServiceError};
use crate::protocol::codes::code;
use crate::protocol::envelope::{Envelope, BROADCAST_EVENT};

pub struct BusService;

impl Service for BusService {
    fn name(&self) -> &'static str {
        "bus"
    }
    fn actions(&self) -> &'static [&'static str] {
        &["publish"]
    }

    fn dispatch(
        &self,
        app: &tauri::AppHandle,
        plugin_id: &str,
        action: &str,
        params: Value,
    ) -> Result<Value, ServiceError> {
        match action {
            "publish" => {
                let topic = params
                    .get("topic")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ServiceError::bad_params("missing string param `topic`"))?;
                let payload = params.get("payload").cloned().unwrap_or(Value::Null);
                // The publisher travels with the event so subscribers can
                // ignore their own echoes without guessing.
                let mut env = Envelope::evt(topic, payload);
                env.svc = Some(plugin_id.to_string());
                app.emit(BROADCAST_EVENT, &env)
                    .map_err(|e| format!("broadcast: {e}"))?;
                Ok(json!({ "topic": topic, "delivered": true }))
            }
            _ => Err(ServiceError::new(code::UNKNOWN_ACTION, format!("unknown action `bus/{action}`"))),
        }
    }
}
