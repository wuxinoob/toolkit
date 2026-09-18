//! Uplink streams — the plugin pushes frames to a HOST-side sink.
//!
//! Downlink streams hand the plugin a `Channel` (Rust -> JS). Tauri's `Channel`
//! is one-directional: the JS side has no `send` at all, only a receive
//! callback. So there is no framework carrier for the opposite direction, and an
//! uplink stream is carried by **batched `invoke`** instead: open a stream, send
//! frames in batches, close it.
//!
//! That is an honest trade, not a hidden one:
//!
//!   - the API shape is identical to every other stream (open / send / close,
//!     envelope frames), so a plugin does not learn a second model;
//!   - batching turns N round trips into one per batch, which is the actual cost
//!     the old "one `rpc` per frame" had;
//!   - the host validates every frame and hands it to a named SINK, so the
//!     plugin does not need to know how the host consumes the data.
//!
//! A sink is a host-side consumer looked up by name; adding one is a table
//! entry, and `host/schema` advertises the names.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use super::{proc, session, ServiceError};
use crate::protocol::codes::code;
use crate::protocol::envelope::Envelope;

/// Most frames accepted in one `write_in` call. A batch is one IPC payload, so
/// this bounds it — an unbounded batch would just move the memory problem.
pub const MAX_FRAMES_PER_BATCH: usize = 256;

/// What a sink does with the frames it is handed. Returns how many it consumed.
type SinkFn = fn(&str, &Value, &[Envelope]) -> Result<usize, ServiceError>;

#[derive(Debug)]
struct Sink {
    name: &'static str,
    write: SinkFn,
}

/// The sink table — the only place a sink name is bound to an implementation.
fn sinks() -> &'static [Sink] {
    &[Sink { name: "proc", write: sink_proc }]
}

pub fn sink_names() -> Vec<&'static str> {
    sinks().iter().map(|s| s.name).collect()
}

fn find_sink(name: &str) -> Result<&'static Sink, ServiceError> {
    sinks().iter().find(|s| s.name == name).ok_or_else(|| {
        ServiceError::new(
            code::NOT_FOUND,
            format!("unknown sink `{name}` (known: {})", sink_names().join(", ")),
        )
    })
}

/// `proc` sink: each frame becomes one `line-json` line on that sidecar's stdin.
///
/// This is the concrete case that motivated uplink streams — feeding a plugin's
/// own backend — so it is the first sink rather than a special case in the
/// transport.
fn sink_proc(plugin_id: &str, params: &Value, frames: &[Envelope]) -> Result<usize, ServiceError> {
    let key = params.get("key").and_then(|v| v.as_str()).ok_or_else(|| {
        ServiceError::bad_params("sink `proc` requires params.key (the sidecar channel)")
    })?;
    let mut n = 0;
    for f in frames {
        let line = serde_json::to_string(f)
            .map_err(|e| ServiceError::internal(format!("encode frame: {e}")))?;
        proc::send_line(plugin_id, key, &line)?;
        n += 1;
    }
    Ok(n)
}

/// One open uplink: which sink, and the params it was opened with.
struct Uplink {
    sink: &'static Sink,
    params: Value,
}

/// Open uplinks, keyed by `plugin/ch` — the same identity the session registry
/// and the hub use, so a stream is addressable the same way everywhere.
fn registry() -> &'static Mutex<HashMap<String, Uplink>> {
    static REG: OnceLock<Mutex<HashMap<String, Uplink>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Uplink>> {
    registry().lock().unwrap_or_else(|e| e.into_inner())
}

fn id_of(plugin_id: &str, ch: &str) -> String {
    format!("{plugin_id}/{ch}")
}

/// Open an uplink stream. Registers it in the session registry too, so it shows
/// up in `host/sessions` and is released on app exit like every other stream.
pub fn open(plugin_id: &str, ch: &str, sink_name: &str, params: &Value) -> Result<Value, ServiceError> {
    let sink = find_sink(sink_name)?;
    let id = id_of(plugin_id, ch);
    {
        let mut map = lock();
        if map.contains_key(&id) {
            return Err(ServiceError::conflict(format!(
                "uplink `{id}` is already open"
            )));
        }
        map.insert(id, Uplink { sink, params: params.clone() });
    }
    // No process of our own; the stop closure is a no-op. Registering keeps the
    // stream visible and uniformly cleaned up.
    if let Err(e) = session::open(
        plugin_id,
        ch,
        session::SessionKind::Stream,
        None,
        std::sync::Arc::new(|| {}),
    ) {
        lock().remove(&id_of(plugin_id, ch));
        return Err(e);
    }
    Ok(json!({ "opened": true, "ch": ch, "sink": sink_name }))
}

/// Hand a batch of frames to the stream's sink. Every frame is validated first,
/// so a malformed one is rejected rather than half-written.
pub fn write(plugin_id: &str, ch: &str, frames: &[Value]) -> Result<Value, ServiceError> {
    if frames.is_empty() {
        return Err(ServiceError::bad_params("`frames` must not be empty"));
    }
    if frames.len() > MAX_FRAMES_PER_BATCH {
        return Err(ServiceError::bad_params(format!(
            "batch of {} exceeds the {MAX_FRAMES_PER_BATCH}-frame limit — split it",
            frames.len()
        )));
    }
    let (sink, params) = {
        let map = lock();
        let u = map
            .get(&id_of(plugin_id, ch))
            .ok_or_else(|| ServiceError::not_found(format!("uplink `{ch}` is not open")))?;
        (u.sink, u.params.clone())
    };

    let mut parsed: Vec<Envelope> = Vec::with_capacity(frames.len());
    for (i, raw) in frames.iter().enumerate() {
        let env: Envelope = serde_json::from_value(raw.clone()).map_err(|e| {
            ServiceError::bad_params(format!("frame {i} is not a valid envelope: {e}"))
        })?;
        env.validate().map_err(|e| {
            ServiceError::bad_params(format!("frame {i} violates the contract: {e}"))
        })?;
        parsed.push(env);
    }

    let written = (sink.write)(plugin_id, &params, &parsed)?;
    Ok(json!({ "written": written }))
}

/// Close an uplink stream and release its session record.
pub fn close(plugin_id: &str, ch: &str) -> Result<Value, ServiceError> {
    let removed = lock().remove(&id_of(plugin_id, ch)).is_some();
    session::close(plugin_id, ch);
    Ok(json!({ "closed": removed }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sink_table_is_unique_and_advertises_proc() {
        let names = sink_names();
        assert!(names.contains(&"proc"), "got {names:?}");
        let unique: std::collections::HashSet<_> = names.iter().collect();
        assert_eq!(unique.len(), names.len(), "duplicate sink name");
    }

    #[test]
    fn an_unknown_sink_is_rejected_with_not_found() {
        let err = find_sink("nope").unwrap_err();
        assert_eq!(err.code, code::NOT_FOUND);
        assert!(err.msg.contains("unknown sink"), "got: {err}");
    }

    #[test]
    fn opening_registering_and_closing_round_trips() {
        let _g = crate::services::serial();
        session::kill_all();
        lock().clear();

        open("u.plugin", "a", "proc", &json!({ "key": "backend" })).unwrap();
        assert!(lock().contains_key(&id_of("u.plugin", "a")));
        assert_eq!(session::list(Some("u.plugin")).len(), 1, "an uplink is a session too");

        // a second open of the same ch is a conflict, not a silent replacement
        let err = open("u.plugin", "a", "proc", &json!({})).unwrap_err();
        assert_eq!(err.code, code::CONFLICT);

        // writing to a stream that is not open is not_found, not a panic
        let err = write("u.plugin", "missing", &[json!({"v":1,"kind":"data","ch":"a"})]).unwrap_err();
        assert_eq!(err.code, code::NOT_FOUND);

        close("u.plugin", "a").unwrap();
        assert!(!lock().contains_key(&id_of("u.plugin", "a")));
        assert!(session::list(Some("u.plugin")).is_empty(), "the session goes with it");
        lock().clear();
    }

    #[test]
    fn a_batch_is_validated_before_anything_is_written() {
        let _g = crate::services::serial();
        session::kill_all();
        lock().clear();
        // the `proc` sink has no sidecar running, so a VALID batch fails at the
        // sink — but a malformed frame must be rejected before that, with a
        // different code, which is what this pins.
        open("u.plugin", "b", "proc", &json!({ "key": "backend" })).unwrap();

        let bad = write("u.plugin", "b", &[json!({ "v": 1, "kind": "nonsense" })]).unwrap_err();
        assert_eq!(bad.code, code::BAD_PARAMS);
        assert!(bad.msg.contains("not a valid envelope"), "got: {bad}");

        let empty = write("u.plugin", "b", &[]).unwrap_err();
        assert_eq!(empty.code, code::BAD_PARAMS);

        let too_many = write(
            "u.plugin",
            "b",
            &vec![json!({"v":1,"kind":"data","ch":"b"}); MAX_FRAMES_PER_BATCH + 1],
        )
        .unwrap_err();
        assert_eq!(too_many.code, code::BAD_PARAMS);
        assert!(too_many.msg.contains("exceeds"), "got: {too_many}");

        close("u.plugin", "b").unwrap();
        lock().clear();
    }
}
