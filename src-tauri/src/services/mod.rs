//! The host's service layer.
//!
//! Two tables, one shape:
//!   - [`Service`]         request/response services (uplink `req` -> `res|err`)
//!   - [`StreamProvider`]  push producers (downlink `data|end|exit|err`)
//!
//! Streams live in their own table because opening one hands the host an IPC
//! `Channel` handle, which cannot travel inside a JSON request/response. The
//! important part is that BOTH are looked up by name in a table — the gateway
//! and the stream commands contain no `if service == "..."` branching, so a
//! new capability is a new table entry, never a new branch in the host.
//!
//! Each service also declares its [`Service::actions`]. The gateway validates
//! against that list before dispatching, so "which actions exist" is stated
//! once and cannot drift from the documentation — and the same list backs
//! `host/schema`, which is how a plugin discovers what the host supports.

pub mod bus;
pub mod external;
pub mod hotkey;
pub mod proc;
pub mod session;
pub mod storage;
pub mod stream;
pub mod uplink;

use serde_json::{json, Value};
use std::sync::OnceLock;

pub use stream::{JsonSink, RawSink, StreamProvider};

/// A service failure, carrying a code from the closed set in
/// [`crate::protocol::codes`].
///
/// The code says what KIND of thing went wrong; where it happened is already in
/// the envelope. Services used to return bare strings, which forced the gateway
/// to invent a code from the service and action names — so every service failure
/// looked alike to a caller and none of them could be branched on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceError {
    pub code: &'static str,
    pub msg: String,
}

impl ServiceError {
    pub fn new(code: &'static str, msg: impl Into<String>) -> Self {
        debug_assert!(
            crate::protocol::codes::is_known(code),
            "service error code `{code}` is not in the declared set"
        );
        Self { code, msg: msg.into() }
    }
    pub fn bad_params(msg: impl Into<String>) -> Self {
        Self::new(crate::protocol::codes::code::BAD_PARAMS, msg)
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new(crate::protocol::codes::code::NOT_FOUND, msg)
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        Self::new(crate::protocol::codes::code::CONFLICT, msg)
    }
    pub fn unsupported(msg: impl Into<String>) -> Self {
        Self::new(crate::protocol::codes::code::UNSUPPORTED, msg)
    }
    pub fn io(msg: impl Into<String>) -> Self {
        Self::new(crate::protocol::codes::code::IO, msg)
    }
    pub fn spawn_failed(msg: impl Into<String>) -> Self {
        Self::new(crate::protocol::codes::code::SPAWN_FAILED, msg)
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new(crate::protocol::codes::code::INTERNAL, msg)
    }
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.msg)
    }
}

/// Anything that already produced a plain string becomes `internal` — the
/// honest code for "the host did not classify this". Sites that can do better
/// should construct a typed error instead.
impl From<std::io::Error> for ServiceError {
    fn from(e: std::io::Error) -> Self {
        Self::io(e.to_string())
    }
}

impl From<String> for ServiceError {
    fn from(msg: String) -> Self {
        Self::internal(msg)
    }
}
impl From<&str> for ServiceError {
    fn from(msg: &str) -> Self {
        Self::internal(msg)
    }
}

/// A plugin-facing request/response service behind the `plugin_rpc` gateway.
///
/// Implementations resolve their own root (app data dir / plugins dir) from
/// the `AppHandle` and delegate to a pure path-based `*_at` core, so unit
/// tests run without a Tauri runtime.
pub trait Service: Send + Sync {
    fn name(&self) -> &'static str;

    /// Every action this service accepts. Authoritative: the gateway rejects
    /// anything not listed, so a service's `match` no longer needs a fallback
    /// arm to stay safe.
    fn actions(&self) -> &'static [&'static str];

    fn dispatch(
        &self,
        app: &tauri::AppHandle,
        plugin_id: &str,
        action: &str,
        params: Value,
    ) -> Result<Value, ServiceError>;
}

/// The `plugin_rpc` routing table — the only place a service name is bound to
/// an implementation.
pub fn table() -> &'static [Box<dyn Service>] {
    static TABLE: OnceLock<Vec<Box<dyn Service>>> = OnceLock::new();
    TABLE.get_or_init(|| {
        vec![
            Box::new(storage::StorageService),
            Box::new(storage::HostService),
            Box::new(proc::ProcService),
            Box::new(stream::StreamService),
            Box::new(bus::BusService),
            Box::new(hotkey::HotkeyService),
        ]
    })
}

pub fn service_names() -> Vec<&'static str> {
    table().iter().map(|s| s.name()).collect()
}

/// What the host offers: protocol version, every service with its actions, the
/// stream providers, and the error codes it may produce. Backs `host/schema`,
/// which doubles as the negotiation surface — a plugin asks what exists instead
/// of discovering it by failing.
pub fn schema() -> Value {
    let services: serde_json::Map<String, Value> = table()
        .iter()
        .map(|s| (s.name().to_string(), json!(s.actions())))
        .collect();
    json!({
        "protocol": crate::protocol::envelope::PROTOCOL_VERSION,
        "services": services,
        "providers": stream::providers().iter().map(|p| p.name()).collect::<Vec<_>>(),
        // Uplink consumers, so a plugin knows where it may push to.
        "sinks": uplink::sink_names(),
        // The error vocabulary, so a caller can branch on codes it has actually
        // been told about rather than guessing at strings.
        "codes": crate::protocol::codes::ALL,
    })
}

/// Table-driven dispatch, with the action validated against the service's own
/// declaration. An unknown name or action is a clear error listing what exists,
/// instead of a silent fallthrough.
pub fn route(
    app: &tauri::AppHandle,
    plugin_id: &str,
    service: &str,
    action: &str,
    params: Value,
) -> Result<Value, ServiceError> {
    use crate::protocol::codes::code;
    match table().iter().find(|s| s.name() == service) {
        None => Err(ServiceError::new(
            code::UNKNOWN_SERVICE,
            format!("unknown service `{service}` (known: {})", service_names().join(", ")),
        )),
        Some(s) if !s.actions().contains(&action) => Err(ServiceError::new(
            code::UNKNOWN_ACTION,
            format!(
                "unknown action `{service}/{action}` (known: {})",
                s.actions().join(", ")
            ),
        )),
        Some(s) => s.dispatch(app, plugin_id, action, params),
    }
}

/// Serialises tests that touch process-global state (the session registry and
/// the permission registry). Rust runs tests in parallel threads, so without
/// this a `kill_all()` in one test silently empties another's fixture.
#[cfg(test)]
pub(crate) fn serial() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn the_routing_table_is_unique_and_complete() {
        let names = service_names();
        let unique: HashSet<_> = names.iter().collect();
        assert_eq!(unique.len(), names.len(), "duplicate service name in table: {names:?}");
        for expected in ["storage", "host", "proc", "stream", "bus", "hotkey"] {
            assert!(names.contains(&expected), "missing service `{expected}` in {names:?}");
        }
    }

    #[test]
    fn every_service_declares_a_non_empty_and_unique_action_list() {
        for s in table() {
            assert!(!s.actions().is_empty(), "service `{}` declares no actions", s.name());
            let unique: HashSet<_> = s.actions().iter().collect();
            assert_eq!(
                unique.len(),
                s.actions().len(),
                "service `{}` declares a duplicate action",
                s.name()
            );
        }
    }

    #[test]
    fn schema_reports_every_service_and_its_actions() {
        let schema = schema();
        assert_eq!(schema["protocol"], json!(1));
        for s in table() {
            assert_eq!(
                schema["services"][s.name()],
                json!(s.actions()),
                "schema is out of step with the table for `{}`",
                s.name()
            );
        }
        assert_eq!(schema["providers"], json!(["ticker", "blob"]));
    }

    #[test]
    fn stream_provider_table_is_registered() {
        let names: Vec<_> = stream::providers().iter().map(|p| p.name()).collect();
        assert_eq!(names, vec!["ticker", "blob"]);
    }
}
