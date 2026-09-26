//! `stream` service + the stream provider table — the host's push data plane.
//!
//! A stream is the one thing that cannot travel as a request/response: the
//! host keeps talking after the call returns. It therefore uses a dedicated
//! command family carrying an IPC `Channel` handle, but it is registered in a
//! table exactly like the request/response services, so the host still only
//! ever does a lookup:
//!
//! ```text
//!   plugin JS --plugin_stream_open(provider, ch)--> provider table
//!              <-- data | end | exit | err frames --  Channel
//! ```
//!
//! Two codecs are available for the same producer, which is the whole point
//! of separating transport from framing:
//!   - `json-envelope` -> `Channel<Envelope>` (structured events)
//!   - `raw-binary`    -> `Channel<InvokeResponseBody>` (1 kind byte + payload)
//!
//! A provider declares which codecs it supports by leaving the other `open_*`
//! at its default, so a mismatch is reported at setup time with a clear
//! message instead of failing mid-stream.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};

use super::session::{self, SessionKind};
use super::{Service, ServiceError};
use crate::protocol::codes::code;
use crate::protocol::codec::raw_binary;
use crate::protocol::envelope::Envelope;

/// Downlink sink for the `json-envelope` codec.
pub type JsonSink = Channel<Envelope>;
/// Downlink sink for the `raw-binary` codec.
pub type RawSink = Channel<InvokeResponseBody>;

/// How a producer finished, so the runner can emit the right terminal frame.
/// `Exit` is for process-like producers (a pty or a batch job reporting a
/// status code); pure data producers use `End`.
pub enum Outcome {
    End,
    Exit(i32),
}

/// One sink, two wire formats. Producers call `data` / `data_bytes` and never
/// know which codec is in play.
pub enum Sink {
    Json(JsonSink),
    Raw(RawSink),
}

impl Sink {
    pub fn is_raw(&self) -> bool {
        matches!(self, Sink::Raw(_))
    }

    /// One data frame carrying a JSON payload.
    pub fn data(&self, ch: &str, p: Value) -> Result<(), String> {
        match self {
            Sink::Json(c) => c.send(Envelope::data(ch, p)).map_err(|e| format!("channel: {e}")),
            Sink::Raw(c) => {
                let bytes = raw_binary::encode(crate::protocol::envelope::Kind::Data, &raw_binary::payload_bytes(&p))
                    .map_err(|e| format!("encode: {e}"))?;
                c.send(InvokeResponseBody::Raw(bytes)).map_err(|e| format!("channel: {e}"))
            }
        }
    }

    /// One data frame carrying raw bytes — only the binary codec can do this.
    pub fn data_bytes(&self, ch: &str, bytes: &[u8]) -> Result<(), String> {
        let _ = ch; // the channel id is implied by the Channel itself
        match self {
            Sink::Raw(c) => {
                let framed = raw_binary::encode(crate::protocol::envelope::Kind::Data, bytes)
                    .map_err(|e| format!("encode: {e}"))?;
                c.send(InvokeResponseBody::Raw(framed)).map_err(|e| format!("channel: {e}"))
            }
            // NOT a coded error: this surfaces through the stream COMMANDS as an
            // invoke rejection, not as an `err` envelope, so it stays a plain string.
            Sink::Json(_) => Err("the json-envelope codec cannot carry raw bytes".into()),
        }
    }

    /// A terminal frame (end / exit / err).
    pub fn send(&self, env: Envelope) -> Result<(), String> {
        match self {
            Sink::Json(c) => c.send(env).map_err(|e| format!("channel: {e}")),
            Sink::Raw(c) => {
                let kind = env.kind;
                let payload = match kind {
                    crate::protocol::envelope::Kind::Exit => {
                        raw_binary::encode_code(env.p.as_i64().unwrap_or(-1) as i32)
                    }
                    crate::protocol::envelope::Kind::Err => {
                        format!("{}|{}", env.code.clone().unwrap_or_default(), env.msg.clone().unwrap_or_default())
                            .into_bytes()
                    }
                    _ => raw_binary::payload_bytes(&env.p),
                };
                let framed = raw_binary::encode(kind, &payload).map_err(|e| format!("encode: {e}"))?;
                c.send(InvokeResponseBody::Raw(framed)).map_err(|e| format!("channel: {e}"))
            }
        }
    }
}

/// A producer of pushed data. Implementors override only the codecs they
/// actually support — the defaults are the capability declaration.
pub trait StreamProvider: Send + Sync {
    fn name(&self) -> &'static str;

    /// The permission this provider needs ON TOP of `rpc:stream`.
    ///
    /// `rpc:stream` means "I can open a stream" — granted for a pty, a sidecar,
    /// a ticker. A provider whose DATA is more sensitive than that says so here:
    /// the `clipboard` provider returns `rpc:clipboard`, because watching the
    /// clipboard means reading everything the user copies, and letting that ride
    /// on `rpc:stream` would widen a permission nobody edited.
    ///
    /// `None` (the default) means the provider's data is what `rpc:stream`
    /// already describes.
    fn permission(&self) -> Option<&'static str> {
        None
    }

    fn open_json(&self, plugin_id: &str, ch: &str, params: Value, sink: JsonSink) -> Result<(), String> {
        let _ = (plugin_id, ch, params, sink);
        Err(format!("stream provider `{}` does not support the json-envelope codec", self.name()))
    }

    fn open_raw(&self, plugin_id: &str, ch: &str, params: Value, sink: RawSink) -> Result<(), String> {
        let _ = (plugin_id, ch, params, sink);
        Err(format!("stream provider `{}` does not support the raw-binary codec", self.name()))
    }
}

// ------------------------------ providers -------------------------------------

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `ticker` — emits a monotonically increasing counter. Supports BOTH codecs:
/// as JSON it sends `{n, t}` objects, as raw it sends the counter as 8 LE
/// bytes. Same producer, two wires.
pub struct TickerProvider;

impl TickerProvider {
    fn run(&self, plugin_id: &str, ch: &str, params: Value, sink: Sink) -> Result<(), String> {
        let interval = params.get("intervalMs").and_then(|v| v.as_u64()).unwrap_or(500).clamp(1, 60_000);
        let count = params.get("count").and_then(|v| v.as_u64()).unwrap_or(10).min(100_000);
        let raw = sink.is_raw();
        let cid = ch.to_string();
        run_stream(plugin_id, ch, sink, move |sink, cancel, bytes| {
            let mut n: u64 = 0;
            loop {
                if cancel.load(Ordering::SeqCst) {
                    return Ok(Outcome::End); // cancelled: terminate quietly
                }
                if count > 0 && n >= count {
                    return Ok(Outcome::End);
                }
                let payload = if raw {
                    json!(n) // -> 8 little-endian bytes on the raw wire
                } else {
                    json!({ "n": n, "t": now_ms() })
                };
                sink.data(&cid, payload).map_err(|e| ("sink".to_string(), e))?;
                bytes.fetch_add(1, Ordering::Relaxed);
                n += 1;
                std::thread::sleep(Duration::from_millis(interval));
            }
        })
    }
}

impl StreamProvider for TickerProvider {
    fn name(&self) -> &'static str {
        "ticker"
    }
    fn open_json(&self, plugin_id: &str, ch: &str, params: Value, sink: JsonSink) -> Result<(), String> {
        self.run(plugin_id, ch, params, Sink::Json(sink))
    }
    fn open_raw(&self, plugin_id: &str, ch: &str, params: Value, sink: RawSink) -> Result<(), String> {
        self.run(plugin_id, ch, params, Sink::Raw(sink))
    }
}

/// `blob` — emits synthetic binary payloads. RAW ONLY on purpose: it is the
/// capability-negotiation demo (asking for it over JSON fails at setup).
pub struct BlobProvider;

impl StreamProvider for BlobProvider {
    fn name(&self) -> &'static str {
        "blob"
    }
    fn open_raw(&self, plugin_id: &str, ch: &str, params: Value, sink: RawSink) -> Result<(), String> {
        let chunks = params.get("chunks").and_then(|v| v.as_u64()).unwrap_or(8).min(10_000);
        let size = params
            .get("chunkBytes")
            .and_then(|v| v.as_u64())
            .unwrap_or(4096)
            .clamp(1, 1 << 20);
        let delay = params.get("delayMs").and_then(|v| v.as_u64()).unwrap_or(0).min(1000);
        run_stream(plugin_id, ch, Sink::Raw(sink), move |sink, cancel, bytes| {
            for i in 0..chunks {
                if cancel.load(Ordering::SeqCst) {
                    return Ok(Outcome::End);
                }
                let buf: Vec<u8> = (0..size).map(|b| (i as u8).wrapping_add(b as u8)).collect();
                sink.data_bytes("", &buf).map_err(|e| ("sink".to_string(), e))?;
                bytes.fetch_add(buf.len() as u64, Ordering::Relaxed);
                if delay > 0 {
                    std::thread::sleep(Duration::from_millis(delay));
                }
            }
            Ok(Outcome::End)
        })
    }
}

pub fn providers() -> &'static [Box<dyn StreamProvider>] {
    static TABLE: std::sync::OnceLock<Vec<Box<dyn StreamProvider>>> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| {
        vec![
            Box::new(TickerProvider),
            Box::new(BlobProvider),
            // Lives with its service (`clipboard.rs`) because the two halves share
            // a permission and a library; the table is still the one place that
            // decides which providers exist.
            Box::new(super::clipboard::ClipboardWatch),
        ]
    })
}

fn provider_names() -> String {
    providers().iter().map(|p| p.name()).collect::<Vec<_>>().join(", ")
}

fn find_provider(name: &str) -> Result<&'static dyn StreamProvider, String> {
    providers()
        .iter()
        .find(|p| p.name() == name)
        .map(|p| p.as_ref())
        .ok_or_else(|| format!("unknown stream provider `{name}` (known: {})", provider_names()))
}

/// Channel ids are part of the session key, so keep them simple and
/// traversal-proof.
fn validate_ch(ch: &str) -> Result<(), String> {
    let ok = !ch.is_empty()
        && ch.len() <= 64
        && ch.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(())
    } else {
        Err(format!("invalid channel id `{ch}` (use [A-Za-z0-9._-]{{1,64}})"))
    }
}

/// Shared producer runner: registers the session, runs the body on its own
/// thread, emits exactly one terminal frame, then deregisters. Cancellation is
/// cooperative through the session's stop closure, so `kill_all()` on exit
/// stops streams the same way it stops sidecars.
pub(super) fn run_stream<F>(plugin_id: &str, ch: &str, sink: Sink, body: F) -> Result<(), String>
where
    F: FnOnce(&Sink, &Arc<AtomicBool>, &Arc<AtomicU64>) -> Result<Outcome, (String, String)> + Send + 'static,
{
    validate_ch(ch)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_for_stop = Arc::clone(&cancel);
    let bytes = session::open(
        plugin_id,
        ch,
        SessionKind::Stream,
        None,
        Arc::new(move || cancel_for_stop.store(true, Ordering::SeqCst)),
    )
    .map_err(|e| e.msg)?;

    let pid = plugin_id.to_string();
    let cid = ch.to_string();
    std::thread::Builder::new()
        .name(format!("stream-{pid}-{cid}"))
        .spawn(move || {
            let outcome = body(&sink, &cancel, &bytes);
            let terminal = match outcome {
                Ok(Outcome::End) => Envelope::end(&cid),
                Ok(Outcome::Exit(code)) => Envelope::exit(&cid, code),
                Err((code, msg)) => Envelope::stream_err(&cid, code, msg),
            };
            if let Err(e) = sink.send(terminal) {
                // The consumer is gone (window closed); nothing to report to.
                eprintln!("[stream] {pid}/{cid} terminal frame failed: {e}");
            }
            session::close(&pid, &cid);
        })
        .map_err(|e| format!("spawn stream thread: {e}"))?;
    Ok(())
}

// ------------------------------- dispatch -------------------------------------

/// Open a JSON-codec stream (called by the `plugin_stream_open` command).
///
/// The provider's OWN permission is checked here, in addition to the `rpc:stream`
/// the command already required. See `StreamProvider::permission`.
pub fn open_json(plugin_id: &str, provider: &str, ch: &str, params: Value, sink: JsonSink) -> Result<(), String> {
    let p = find_provider(provider)?;
    if let Some(perm) = p.permission() {
        crate::host::registry::is_allowed(plugin_id, perm)?;
    }
    p.open_json(plugin_id, ch, params, sink)
}

/// Open a raw-binary-codec stream (called by `plugin_stream_open_raw`).
pub fn open_raw(plugin_id: &str, provider: &str, ch: &str, params: Value, sink: RawSink) -> Result<(), String> {
    let p = find_provider(provider)?;
    if let Some(perm) = p.permission() {
        crate::host::registry::is_allowed(plugin_id, perm)?;
    }
    p.open_raw(plugin_id, ch, params, sink)
}

/// `stream` service: lifecycle for streams that are already open.
pub struct StreamService;

impl Service for StreamService {
    fn name(&self) -> &'static str {
        "stream"
    }
    fn actions(&self) -> &'static [&'static str] {
        &["close", "providers", "list", "session_open", "session_close", "open_in", "write_in", "close_in"]
    }
    fn dispatch(
        &self,
        _app: &tauri::AppHandle,
        plugin_id: &str,
        action: &str,
        params: Value,
    ) -> Result<Value, ServiceError> {
        match action {
            "close" => {
                let ch = params
                    .get("ch")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ServiceError::bad_params("missing string param `ch`"))?;
                Ok(json!({ "stopped": session::stop_one(plugin_id, ch) }))
            }
            // Session lifecycle for an endpoint whose process the host does NOT
            // own (a pty spawned by a third-party plugin). It lives here rather
            // than in `host` so that `rpc:stream` alone covers the whole push
            // data plane — one capability, one permission.
            "session_open" => {
                let ch = params
                    .get("ch")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ServiceError::bad_params("missing string param `ch`"))?;
                let kind = match params.get("kind").and_then(|v| v.as_str()).unwrap_or("stream") {
                    "pty" => SessionKind::Pty,
                    "sidecar" => SessionKind::Sidecar,
                    _ => SessionKind::Stream,
                };
                let pid = params.get("pid").and_then(|v| v.as_u64()).map(|p| p as u32);
                let stop = match pid {
                    Some(p) => session::pid_stop(p),
                    None => Arc::new(|| {}),
                };
                session::open(plugin_id, ch, kind, pid, stop)?;
                Ok(Value::Bool(true))
            }
            "session_close" => {
                let ch = params
                    .get("ch")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ServiceError::bad_params("missing string param `ch`"))?;
                Ok(Value::Bool(session::close(plugin_id, ch)))
            }
            "providers" => Ok(json!(
                providers().iter().map(|p| p.name()).collect::<Vec<_>>()
            )),
            "list" => Ok(Value::Array(
                session::list(Some(plugin_id))
                    .into_iter()
                    .filter(|s| s["kind"] == json!("stream"))
                    .collect(),
            )),
            // ---- uplink: the plugin pushes frames to a host-side sink ----
            // Carried by batched invoke because Tauri's Channel is Rust -> JS
            // only; see services/uplink.rs for why that trade is deliberate.
            "open_in" => {
                let ch = params
                    .get("ch")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ServiceError::bad_params("missing string param `ch`"))?;
                let sink = params
                    .get("sink")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ServiceError::bad_params("missing string param `sink`"))?;
                let inner = params.get("params").cloned().unwrap_or(Value::Null);
                super::uplink::open(plugin_id, ch, sink, &inner)
            }
            "write_in" => {
                let ch = params
                    .get("ch")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ServiceError::bad_params("missing string param `ch`"))?;
                let frames = params
                    .get("frames")
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| ServiceError::bad_params("missing array param `frames`"))?;
                super::uplink::write(plugin_id, ch, frames)
            }
            "close_in" => {
                let ch = params
                    .get("ch")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ServiceError::bad_params("missing string param `ch`"))?;
                super::uplink::close(plugin_id, ch)
            }
            _ => Err(ServiceError::new(code::UNKNOWN_ACTION, format!("unknown action `stream/{action}`"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_table_lookup_reports_unknown_names() {
        assert_eq!(provider_names(), "ticker, blob");
        assert!(find_provider("ticker").is_ok());
        let err = find_provider("nope").err().expect("unknown provider must be an error");
        assert!(err.contains("unknown stream provider") && err.contains("ticker"), "got: {err}");
    }

    #[test]
    fn channel_ids_are_validated() {
        assert!(validate_ch("s1").is_ok());
        assert!(validate_ch("a-b_c.d").is_ok());
        assert!(validate_ch("").is_err());
        assert!(validate_ch("has space").is_err());
        assert!(validate_ch("../escape").is_err());
        assert!(validate_ch(&"x".repeat(65)).is_err());
    }

    /// Capability negotiation: `blob` declares raw only, and saying otherwise
    /// fails at setup rather than mid-stream.
    #[test]
    fn blob_declares_raw_only() {
        let p = BlobProvider;
        assert_eq!(p.name(), "blob");
        let json_err = p.open_json("p", "c", Value::Null, Channel::new(|_| Ok(())));
        assert!(json_err.unwrap_err().contains("does not support the json-envelope codec"));
    }

    /// The SAME producer over the raw wire: one kind byte, then the counter as
    /// 8 little-endian bytes. This is the two-axis claim, verified.
    #[test]
    fn the_same_ticker_produces_raw_binary_frames() {
        let _g = crate::services::serial();
        session::kill_all();
        let got = Arc::new(std::sync::Mutex::new(Vec::<Vec<u8>>::new()));
        let sink: RawSink = Channel::new({
            let got = Arc::clone(&got);
            move |body: InvokeResponseBody| {
                if let InvokeResponseBody::Raw(bytes) = body {
                    got.lock().unwrap().push(bytes);
                }
                Ok(())
            }
        });
        TickerProvider
            .open_raw("test.raw", "r1", json!({ "intervalMs": 1, "count": 2 }), sink)
            .unwrap();

        for _ in 0..200 {
            if session::list(Some("test.raw")).is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let frames = got.lock().unwrap().clone();
        assert_eq!(frames.len(), 3, "2 data + 1 end, got {}", frames.len());

        let (kind, payload) = raw_binary::decode(&frames[0]).expect("first frame must decode");
        assert_eq!(kind, crate::protocol::envelope::Kind::Data);
        assert_eq!(payload.len(), 8, "counter travels as 8 LE bytes");
        assert_eq!(raw_binary::decode_code(payload), Some(0));

        let (kind, payload) = raw_binary::decode(&frames[1]).unwrap();
        assert_eq!(kind, crate::protocol::envelope::Kind::Data);
        assert_eq!(raw_binary::decode_code(payload), Some(1));

        let (kind, payload) = raw_binary::decode(&frames[2]).unwrap();
        assert_eq!(kind, crate::protocol::envelope::Kind::End);
        assert!(payload.is_empty(), "end frame carries no payload");
        assert!(session::list(Some("test.raw")).is_empty(), "session must be released");
    }

    /// A provider can be driven headlessly with a real `Channel`, which is how
    /// the conformance harness exercises framing without a webview. The channel
    /// callback receives the wire body, so this decodes it exactly like the
    /// JS side does — proving the JSON codec end to end.
    #[test]
    fn ticker_runs_to_completion_and_deregisters_its_session() {
        let _g = crate::services::serial();
        session::kill_all();
        let got = Arc::new(std::sync::Mutex::new(Vec::<Envelope>::new()));
        let sink: JsonSink = Channel::new({
            let got = Arc::clone(&got);
            move |body: InvokeResponseBody| {
                if let InvokeResponseBody::Json(text) = body {
                    if let Ok(env) = serde_json::from_str::<Envelope>(&text) {
                        got.lock().unwrap().push(env);
                    }
                }
                Ok(())
            }
        });
        TickerProvider
            .open_json("test.stream", "t1", json!({ "intervalMs": 1, "count": 3 }), sink)
            .unwrap();

        // wait for the producer thread to finish
        for _ in 0..200 {
            if session::list(Some("test.stream")).is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let frames = got.lock().unwrap().clone();
        let data: Vec<_> = frames.iter().filter(|f| f.kind == crate::protocol::envelope::Kind::Data).collect();
        assert_eq!(data.len(), 3, "three data frames expected, got {frames:?}");
        assert_eq!(data[0].p["n"], json!(0));
        assert_eq!(data[2].p["n"], json!(2));
        assert_eq!(frames.last().unwrap().kind, crate::protocol::envelope::Kind::End);
        assert!(session::list(Some("test.stream")).is_empty(), "session must be released at end");
    }
}
