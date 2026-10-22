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
pub mod clipboard;
pub mod external;
pub mod hotkey;
pub mod notify;
pub mod proc;
pub mod screen;
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

    /// Which of [`Service::actions`] have a BYTE answer, in addition to (or
    /// instead of) a JSON one.
    ///
    /// Declared rather than inferred, exactly like `actions()`: the raw gateway
    /// validates against this list before dispatching, and `host/schema`
    /// publishes it — so a plugin can ask "what can I read as bytes?" instead of
    /// discovering it by getting `unsupported`. A declaration the implementation
    /// does not honour is reported as an `internal` bug, not as the caller's
    /// mistake.
    fn binary_actions(&self) -> &'static [&'static str] {
        &[]
    }

    /// The BINARY answer to an action, when the action has one.
    ///
    /// Two gateways exist over one table: `plugin_rpc` returns a JSON envelope,
    /// `plugin_rpc_raw` returns bytes. An action that has a natural byte form
    /// (a PNG, a file, a bitmap) declares it in [`Service::binary_actions`] and
    /// answers here — the caller picks the codec by picking the method, exactly
    /// like one stream provider serving both `channel-json` and `channel-raw`.
    ///
    /// `None` means "not a binary action". It is checked against the
    /// declaration, so the two cannot silently disagree.
    fn dispatch_bytes(
        &self,
        _app: &tauri::AppHandle,
        _plugin_id: &str,
        _action: &str,
        _params: Value,
    ) -> Option<Result<Vec<u8>, ServiceError>> {
        None
    }
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
            Box::new(notify::NotifyService),
            Box::new(clipboard::ClipboardService),
            Box::new(screen::ScreenService),
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
        // Which actions can answer with BYTES (`plugin_rpc_raw` / `ctx.bytes`),
        // so a plugin asks instead of finding out by getting `unsupported`.
        // Additive like `providerPermissions`: the plain `services` map keeps
        // its shape, and a caller that does not care never reads this.
        "binaryActions": table()
            .iter()
            .filter(|s| !s.binary_actions().is_empty())
            .map(|s| (s.name().to_string(), json!(s.binary_actions())))
            .collect::<serde_json::Map<String, Value>>(),
        "providers": stream::providers().iter().map(|p| p.name()).collect::<Vec<_>>(),
        // Which providers need a permission of their OWN, beyond `rpc:stream`.
        //
        // Additive rather than a change to `providers`: a caller that only wants
        // the names should not have to restructure, and the extra detail is what
        // lets a plugin ask "what does `clipboard` need?" instead of discovering
        // it by failing. Only providers that declare one appear here.
        "providerPermissions": stream::providers()
            .iter()
            .filter_map(|p| p.permission().map(|perm| (p.name().to_string(), Value::String(perm.to_string()))))
            .collect::<serde_json::Map<String, Value>>(),
        // Uplink consumers, so a plugin knows where it may push to.
        "sinks": uplink::sink_names(),
        // The error vocabulary, so a caller can branch on codes it has actually
        // been told about rather than guessing at strings.
        "codes": crate::protocol::codes::ALL,
    })
}

/// Look a service up by name. Shared by both gateways, so neither grows a
/// special case for a service it knows about.
fn find(service: &str) -> Result<&'static dyn Service, ServiceError> {
    use crate::protocol::codes::code;
    table()
        .iter()
        .find(|s| s.name() == service)
        .map(|s| s.as_ref())
        .ok_or_else(|| {
            ServiceError::new(
                code::UNKNOWN_SERVICE,
                format!("unknown service `{service}` (known: {})", service_names().join(", ")),
            )
        })
}

/// "No such action", listing BOTH kinds so the caller sees everything the
/// service offers. Since the two lists are disjoint (an action answers JSON or
/// bytes, never both), a single list would hide half the surface.
fn unknown_action(s: &dyn Service, service: &str, action: &str) -> ServiceError {
    use crate::protocol::codes::code;
    let list = |a: &'static [&'static str]| {
        if a.is_empty() {
            "none".to_string()
        } else {
            a.join(", ")
        }
    };
    ServiceError::new(
        code::UNKNOWN_ACTION,
        format!(
            "unknown action `{service}/{action}` (json: {}; bytes: {})",
            list(s.actions()),
            list(s.binary_actions())
        ),
    )
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
    let s = find(service)?;
    if !s.actions().contains(&action) {
        // A byte-only action reached the JSON gateway. "unknown action" would be
        // technically true and practically useless: the action exists, the
        // CALLER used the wrong method. Say which one.
        if s.binary_actions().contains(&action) {
            return Err(ServiceError::unsupported(format!(
                "`{service}/{action}` answers with BYTES — use `ctx.bytes` (rpc-raw), not `ctx.rpc`"
            )));
        }
        return Err(unknown_action(s, service, action));
    }
    s.dispatch(app, plugin_id, action, params)
}

/// The same routing, but the answer is bytes (`plugin_rpc_raw`).
///
/// Validation is identical to [`route`] — same table, same action list, same
/// error codes — so a caller cannot reach an action through the raw gateway
/// that the JSON one would have refused. What differs is only the reply: an
/// action that does not declare a byte form is `unsupported`, never a JSON
/// document stuffed into a `Vec<u8>`.
pub fn route_bytes(
    app: &tauri::AppHandle,
    plugin_id: &str,
    service: &str,
    action: &str,
    params: Value,
) -> Result<Vec<u8>, ServiceError> {
    use crate::protocol::codes::code;
    let s = find(service)?;
    if !s.binary_actions().contains(&action) {
        if s.actions().contains(&action) {
            return Err(ServiceError::unsupported(format!(
                "`{service}/{action}` answers with JSON — use `ctx.rpc`, not `ctx.bytes`"
            )));
        }
        return Err(unknown_action(s, service, action));
    }
    match s.dispatch_bytes(app, plugin_id, action, params) {
        Some(reply) => reply,
        // Declared but unimplemented: a host bug, and it must not look like the
        // caller's mistake (which `unsupported` would say).
        None => Err(ServiceError::new(
            code::INTERNAL,
            format!("`{service}/{action}` declares a binary answer but returned none"),
        )),
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

    /// The two lists are the contract for "which gateway can reach it", so they
    /// must stay DISJOINT: an action answering both ways would make "which
    /// encoding is this?" depend on how the caller asked — exactly the ambiguity
    /// that got the base64 capture removed.
    #[test]
    fn every_service_keeps_json_and_byte_actions_apart() {
        for s in table() {
            let both: Vec<_> = s
                .actions()
                .iter()
                .filter(|a| s.binary_actions().contains(a))
                .collect();
            assert!(
                both.is_empty(),
                "`{}` declares {both:?} in BOTH lists — an action answers one way or the other",
                s.name()
            );
        }

        // The one byte-only action that exists today, pinned in both directions.
        let screen = find("screen").unwrap();
        assert!(screen.actions().contains(&"monitors"), "monitors is metadata → JSON");
        assert!(screen.binary_actions().contains(&"capture"), "capture is bytes");
        assert!(
            !screen.actions().contains(&"capture"),
            "capture must not answer JSON any more — the base64 encoding is gone"
        );
    }

    #[test]
    fn find_reports_an_unknown_service_with_the_list_of_known_ones() {
        // `.err()` rather than `unwrap_err()`: `&dyn Service` is not `Debug`, and
        // demanding it just to print a failure would be the tail wagging the dog.
        let e = find("nope").err().expect("an unknown service must not resolve");
        assert_eq!(e.code, "unknown_service");
        assert!(e.msg.contains("screen"), "the error must list what exists, got: {}", e.msg);
    }

    /// A byte-capable action must be DISCOVERABLE. Without this a plugin can
    /// only learn that `screen/capture` has a byte form by calling it and
    /// reading an error — which is what `host/schema` exists to prevent.
    #[test]
    fn schema_advertises_which_actions_answer_with_bytes() {
        assert_eq!(schema()["binaryActions"], json!({ "screen": ["capture"] }));
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
