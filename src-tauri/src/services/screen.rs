//! `screen` service: enumerate monitors and capture one.
//!
//! ## Why this is a service and not a stream
//!
//! A capture is **one answer to one question**, so it is request/response. The
//! push-shaped sibling is `clipboard`, which has to tell a plugin that something
//! *changed* — a service action cannot do that. The rule the two settle:
//! **pull → service, push → stream provider.**
//!
//! ## The payload is base64, and that is a real cost
//!
//! A 1080p desktop PNG is 0.5–2 MB, and base64 makes it a third larger again,
//! inside a JSON envelope that both sides parse. It works — Tauri moves large
//! responses over its own protocol rather than through `eval` — but it is the
//! heaviest thing this gateway carries, and it is a one-shot for a reason.
//!
//! The lighter shape is a `raw-binary` stream provider (the bytes never become
//! text). It was not done here because a one-shot capture as a "stream" would be
//! a stream that opens, emits once and ends — a shape that exists (`blob`) but
//! reads as a workaround when the honest description is "one question, one
//! answer".

use base64::Engine as _;
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
    fn actions(&self) -> &'static [&'static str] {
        &["monitors", "capture"]
    }

    fn dispatch(
        &self,
        _app: &tauri::AppHandle,
        _plugin_id: &str,
        action: &str,
        params: Value,
    ) -> Result<Value, ServiceError> {
        match action {
            // Enumerating is separate from capturing so a plugin can offer a
            // monitor picker without paying for a screenshot of each one.
            "monitors" => Ok(Value::Array(
                Self::monitors()?.iter().map(|(i, _)| i.to_json()).collect(),
            )),

            "capture" => {
                let monitors = Self::monitors()?;
                if monitors.is_empty() {
                    return Err(ServiceError::new(code::INTERNAL, "no usable monitors found"));
                }

                // Default to the PRIMARY monitor rather than index 0: the order
                // of `Monitor::all()` is the OS's, not the user's, and "capture
                // the screen" almost always means the one they are looking at.
                let requested = params.get("monitor").and_then(|v| v.as_u64());
                let picked = match requested {
                    Some(i) => monitors.iter().find(|(info, _)| info.index as u64 == i),
                    None => monitors
                        .iter()
                        .find(|(info, _)| info.primary)
                        .or_else(|| monitors.first()),
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

                let image = monitor.capture_image().map_err(|e| {
                    ServiceError::new(code::INTERNAL, format!("capture failed: {e}"))
                })?;

                let mut png = Vec::new();
                image
                    .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                    .map_err(|e| {
                        ServiceError::new(code::INTERNAL, format!("png encode failed: {e}"))
                    })?;

                Ok(json!({
                    "png": base64::engine::general_purpose::STANDARD.encode(&png),
                    "width": info.width,
                    "height": info.height,
                    "monitor": info.index,
                    "name": info.name,
                    "bytes": png.len(),
                }))
            }

            _ => Err(ServiceError::new(
                code::UNKNOWN_ACTION,
                format!("unknown screen action `{action}`"),
            )),
        }
    }
}
