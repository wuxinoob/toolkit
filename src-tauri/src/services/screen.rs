//! `screen` service: enumerate monitors and capture one.
//!
//! ## Why this is a service and not a stream
//!
//! A capture is **one answer to one question**, so it is request/response. The
//! push-shaped sibling is `clipboard`, which has to tell a plugin that something
//! *changed* — a service action cannot do that. The rule the two settle:
//! **pull → service, push → stream provider.**
//!
//! ## `capture` answers with BYTES, and only bytes
//!
//! A 1080p desktop PNG is 0.5–2 MB. Carried as base64 inside a JSON envelope it
//! is a third larger, parsed as text on both sides, and decoded back to bytes by
//! the caller anyway — four copies of something that was already a byte array.
//! That encoding is **gone**: `capture` is a byte-only action, reachable through
//! `ctx.bytes('screen','capture')` / `bridge.bytes(...)` (the `rpc-raw` scheme),
//! and asking for it over `ctx.rpc` is an `unsupported` error that names the
//! right method.
//!
//! It is still request/response, not a stream: one question, one answer. The
//! stream shape would be "open, emit once, end", which reads as a workaround.
//!
//! `monitors` stays JSON — it is metadata, and there is nothing to encode.

use serde_json::{json, Value};

use super::{Service, ServiceError};
use crate::protocol::codes::code;

/// Refuse to encode anything larger than this.
///
/// A capture is bounded by the monitor, so this is not a normal case — it is the
/// guard for the abnormal one (a virtual desktop spanning many 8K displays), and
/// it fails with a reason instead of building a 40 MB JSON string that the
/// webview then has to parse.
const MAX_PIXELS: u64 = 64_000_000; // ~8K x 8K

/// The monitor fields this service uses, read once.
///
/// Every `xcap` accessor returns a `Result` — a monitor can be unplugged between
/// enumeration and use — so they are read together here. A monitor that cannot
/// describe itself is **skipped**, not reported with zeros: a `0x0` entry in a
/// picker is worse than a shorter list.
struct MonitorInfo {
    index: usize,
    name: String,
    width: u32,
    height: u32,
    scale_factor: f32,
    primary: bool,
}

impl MonitorInfo {
    fn read(index: usize, m: &xcap::Monitor) -> Option<Self> {
        Some(Self {
            index,
            name: m.name().ok()?,
            width: m.width().ok()?,
            height: m.height().ok()?,
            scale_factor: m.scale_factor().ok()?,
            primary: m.is_primary().ok()?,
        })
    }

    fn to_json(&self) -> Value {
        json!({
            "index": self.index,
            "name": self.name,
            "width": self.width,
            "height": self.height,
            "scaleFactor": self.scale_factor,
            "primary": self.primary,
        })
    }
}

pub struct ScreenService;

impl ScreenService {
    fn monitors() -> Result<Vec<(MonitorInfo, xcap::Monitor)>, ServiceError> {
        let all = xcap::Monitor::all()
            .map_err(|e| ServiceError::new(code::INTERNAL, format!("enumerate monitors: {e}")))?;
        Ok(all
            .into_iter()
            .enumerate()
            .filter_map(|(i, m)| MonitorInfo::read(i, &m).map(|info| (info, m)))
            .collect())
    }
}

impl Service for ScreenService {
    fn name(&self) -> &'static str {
        "screen"
    }
    /// JSON actions. `capture` is deliberately NOT here: its answer is bytes,
    /// and the two lists are disjoint so "which encoding does this action use"
    /// has exactly one answer.
    fn actions(&self) -> &'static [&'static str] {
        &["monitors"]
    }
    /// Byte actions (`rpc-raw`). `capture` lives here and nowhere else.
    fn binary_actions(&self) -> &'static [&'static str] {
        &["capture"]
    }

    fn dispatch(
        &self,
        _app: &tauri::AppHandle,
        _plugin_id: &str,
        action: &str,
        _params: Value,
    ) -> Result<Value, ServiceError> {
        match action {
            // Enumerating is separate from capturing so a plugin can offer a
            // monitor picker without paying for a screenshot of each one.
            "monitors" => Ok(Value::Array(
                Self::monitors()?.iter().map(|(i, _)| i.to_json()).collect(),
            )),

            _ => Err(ServiceError::new(
                code::UNKNOWN_ACTION,
                format!("unknown screen action `{action}`"),
            )),
        }
    }

    /// The capture, as PNG bytes. This is the ONLY encoding `capture` has.
    fn dispatch_bytes(
        &self,
        _app: &tauri::AppHandle,
        _plugin_id: &str,
        action: &str,
        params: Value,
    ) -> Option<Result<Vec<u8>, ServiceError>> {
        match action {
            "capture" => Some(capture_png(&params)),
            _ => None,
        }
    }
}

/// One capture, resolved to the monitor the caller asked for.
///
/// The monitor pick, the size guard and the PNG encode live here rather than in
/// `dispatch_bytes` so the selection rules have exactly one home — the reason
/// this is a function and not three lines inside the trait method.
fn capture_png(params: &Value) -> Result<Vec<u8>, ServiceError> {
    let monitors = ScreenService::monitors()?;
    if monitors.is_empty() {
        return Err(ServiceError::new(code::INTERNAL, "no usable monitors found"));
    }

    // Default to the PRIMARY monitor rather than index 0: the order of
    // `Monitor::all()` is the OS's, not the user's, and "capture the screen"
    // almost always means the one they are looking at.
    let requested = params.get("monitor").and_then(|v| v.as_u64());
    let picked = match requested {
        Some(i) => monitors.iter().find(|(info, _)| info.index as u64 == i),
        None => monitors.iter().find(|(info, _)| info.primary).or_else(|| monitors.first()),
    }
    .ok_or_else(|| {
        ServiceError::bad_params(format!(
            "no monitor {} (there are {})",
            requested.unwrap_or(0),
            monitors.len()
        ))
    })?;
    let (info, monitor) = picked;

    let pixels = u64::from(info.width) * u64::from(info.height);
    if pixels > MAX_PIXELS {
        return Err(ServiceError::new(
            code::INTERNAL,
            format!(
                "monitor {} is {}x{} — too large to return through the gateway",
                info.index, info.width, info.height
            ),
        ));
    }

    let image = monitor
        .capture_image()
        .map_err(|e| ServiceError::new(code::INTERNAL, format!("capture failed: {e}")))?;

    let mut png = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| ServiceError::new(code::INTERNAL, format!("png encode failed: {e}")))?;

    Ok(png)
}
