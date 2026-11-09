//! What the gateway is doing RIGHT NOW — the answer to "the UI is dead, why?".
//!
//! A stuck UI has five plausible layers and the JS side can only see the last
//! one (`invoke` never settles). `host/info` timing out proves none of them:
//! the request may never have reached Rust (main thread / webview IPC), it may
//! be queued behind a blocked task, or a service may be stuck. So the gateway
//! keeps two numbers that separate those cases:
//!
//!   `inFlight` — tracked `plugin_rpc` calls currently inside the JSON gateway.
//!   `oldest`   — how long the oldest one has been running, and what it is.
//!   Hours-old `proc/recv` is a different bug from hours-old `host/info`.
//!
//! Each live call owns a ticket. Count, oldest call and phase come from the
//! same registry, so overlapping calls cannot leave a completed request behind.
//! Raw RPC, stream commands and the PTY plugin have separate entry points and
//! do not contribute to these numbers. Zero alone does not diagnose an IPC fault.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

struct Call {
    started: Instant,
    name: String,
    phase: Option<String>,
}

#[derive(Default)]
struct Registry {
    next_id: u64,
    calls: BTreeMap<u64, Call>,
}

fn registry() -> &'static Mutex<Registry> {
    static CALLS: OnceLock<Mutex<Registry>> = OnceLock::new();
    CALLS.get_or_init(Mutex::default)
}

/// Held for the duration of one gateway call; dropping it removes that call.
pub struct Ticket(u64);

impl Drop for Ticket {
    fn drop(&mut self) {
        registry()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .calls
            .remove(&self.0);
    }
}

/// Count one call in flight. `what` is `svc/act`, for the diagnostic.
pub fn enter(what: impl Into<String>) -> Ticket {
    let name = what.into();
    let mut registry = registry().lock().unwrap_or_else(|e| e.into_inner());
    let id = registry.next_id;
    registry.next_id += 1;
    registry.calls.insert(
        id,
        Call {
            started: Instant::now(),
            name,
            phase: None,
        },
    );
    Ticket(id)
}

impl Ticket {
    /// Update only this request, even if another request has the same name.
    /// `returned` means native work finished but the async reply is still pending.
    pub fn mark(&self, phase: &str) {
        let mut registry = registry().lock().unwrap_or_else(|e| e.into_inner());
        registry
            .calls
            .get_mut(&self.0)
            .expect("live gateway ticket")
            .phase = Some(phase.to_owned());
    }
}

/// Is the in-flight bookkeeping lock free right now? Same reasoning as
/// `host::registry::lock_is_free`: this one is taken by `enter()` on every
/// gateway call, so holding it stalls every worker.
pub fn lock_is_free() -> bool {
    registry().try_lock().is_ok()
}

/// `(in flight, (oldest age ms, what))`.
pub fn snapshot() -> (usize, Option<(u128, String)>) {
    let registry = registry().lock().unwrap_or_else(|e| e.into_inner());
    let oldest = registry.calls.first_key_value().map(|(_, call)| {
        let label = match &call.phase {
            Some(phase) => format!("{}[{phase}]", call.name),
            None => call.name.clone(),
        };
        (call.started.elapsed().as_millis(), label)
    });
    (registry.calls.len(), oldest)
}
