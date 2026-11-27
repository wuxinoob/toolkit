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

use super::screen_capture::{self, Rect, Request, Target, WindowSelector};
use super::{caller::Caller, ServiceFuture};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Manager;

use super::{Service, ServiceError};
use crate::protocol::codes::code;

/// Refuse to encode anything larger than this.
///
/// A capture is bounded by the monitor, so this is not a normal case — it is the
/// guard for the abnormal one (a virtual desktop spanning many 8K displays), and
/// it fails with a reason instead of building a 40 MB JSON string that the
/// webview then has to parse.
use super::screen_capture::MAX_PIXELS;

/// The monitor fields this service uses, read once.
///
/// Every `xcap` accessor returns a `Result` — a monitor can be unplugged between
/// enumeration and use — so they are read together here. A monitor that cannot
/// describe itself is **skipped**, not reported with zeros: a `0x0` entry in a
/// picker is worse than a shorter list.
struct MonitorInfo {
    index: usize,
    name: String,
    x: i32,
    y: i32,
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
            x: m.x().ok()?,
            y: m.y().ok()?,
            width: m.width().ok()?,
            height: m.height().ok()?,
            scale_factor: m.scale_factor().ok()?,
            primary: m.is_primary().ok()?,
        })
    }

    fn to_json(&self, monitors: &[tauri::Monitor]) -> Value {
        // Match native geometry, never enumeration order. Screenshot and
        // window APIs can enumerate displays in a different order.
        let monitor = monitors.iter().find(|monitor| {
            monitor.position().x == self.x
                && monitor.position().y == self.y
                && monitor.size().width == self.width
                && monitor.size().height == self.height
        });
        let work_area = monitor.map(|monitor| {
            let area = monitor.work_area();
            json!({ "x": area.position.x, "y": area.position.y,
                "width": area.size.width, "height": area.size.height })
        });
        json!({
            "index": self.index,
            "name": self.name,
            "position": { "x": self.x, "y": self.y },
            "workArea": work_area,
            "unit": "physical",
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
        &["monitors", "windows", "pointer", "capture_resource"]
    }
    /// Byte actions (`rpc-raw`). `capture` lives here and nowhere else.
    fn binary_actions(&self) -> &'static [&'static str] {
        &["capture"]
    }

    fn dispatch(
        &self,
        app: &tauri::AppHandle,
        _plugin_id: &str,
        action: &str,
        params: Value,
    ) -> Result<Value, ServiceError> {
        match action {
            "windows" => {
                let selector: WindowSelector =
                    serde_json::from_value(if params.is_null() { json!({}) } else { params })
                        .map_err(|_| ServiceError::bad_params("invalid window selector"))?;
                let result = json!(screen_capture::windows(&selector)?);
                if serde_json::to_vec(&result)
                    .map_err(|_| ServiceError::internal("cannot encode windows"))?
                    .len()
                    > 512 * 1024
                {
                    return Err(ServiceError::bad_params(
                        "window list exceeds the control-message budget; filter by pid or appName",
                    ));
                }
                Ok(result)
            }
            "pointer" => screen_capture::pointer(),
            // Enumerating is separate from capturing so a plugin can offer a
            // monitor picker without paying for a screenshot of each one.
            "monitors" => {
                let displays = app
                    .available_monitors()
                    .map_err(|e| ServiceError::io(format!("enumerate work areas: {e}")))?;
                Ok(Value::Array(
                    Self::monitors()?
                        .iter()
                        .map(|(i, _)| i.to_json(&displays))
                        .collect(),
                ))
            }

            _ => Err(ServiceError::new(
                code::UNKNOWN_ACTION,
                format!("unknown screen action `{action}`"),
            )),
        }
    }

    fn asynchronous(&self) -> bool {
        true
    }
    fn dispatch_async(
        &self,
        app: tauri::AppHandle,
        caller: Caller,
        action: String,
        params: Value,
    ) -> ServiceFuture {
        Box::pin(async move {
            if action != "capture_resource" {
                return tokio::task::spawn_blocking(move || {
                    ScreenService.dispatch(&app, &caller.plugin, &action, params)
                })
                .await
                .map_err(|_| ServiceError::internal("screen worker failed"))?;
            }
            crate::host::registry::is_allowed(&caller.plugin, "rpc:binary").map_err(|_| {
                ServiceError::new("denied", "capture_resource also requires rpc:binary")
            })?;
            let store = app.state::<crate::binary_ipc::Transfers>().inner().clone();
            let id = format!("capture-{}", crate::sidecar_rpc::instance_id());
            let key = crate::binary_ipc::Transfers::key(&caller, &id)?;
            store.open(key.clone(), crate::binary_ipc::MAX_TRANSFER_BYTES)?;
            struct Pending(
                crate::binary_ipc::Transfers,
                crate::binary_ipc::TransferKey,
                bool,
            );
            impl Drop for Pending {
                fn drop(&mut self) {
                    if !self.2 {
                        self.0.close(&self.1);
                    }
                }
            }
            let mut pending = Pending(store.clone(), key.clone(), false);
            let result = tokio::task::spawn_blocking(move || {
                capture_png(&params, crate::binary_ipc::MAX_TRANSFER_BYTES)
            })
            .await
            .map_err(|_| ServiceError::internal("screen capture worker failed"))??;
            let (bytes, info, include_info) = result;
            let resource = store.finish(&key, bytes)?;
            pending.2 = true;
            Ok(if include_info {
                json!({"source":resource,"capture":info})
            } else {
                resource
            })
        })
    }
    fn sidecar_handler(
        &self,
        app: &tauri::AppHandle,
        caller: Caller,
    ) -> Result<Option<crate::sidecar_rpc::PeerService>, ServiceError> {
        let app = app.clone();
        Ok(Some(crate::sidecar_rpc::PeerService {
            actions: self.actions().iter().map(|s| s.to_string()).collect(),
            handler: std::sync::Arc::new(move |a, p| {
                ScreenService.dispatch_async(app.clone(), caller.clone(), a, p)
            }),
            close: std::sync::Arc::new(|| {}),
        }))
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
            "capture" => Some(if params["includeInfo"] == true {
                Err(ServiceError::bad_params(
                    "includeInfo requires captureResource",
                ))
            } else {
                capture_png(&params, super::image_work::MAX_RAW_BYTES).map(|(bytes, _, _)| bytes)
            }),
            _ => None,
        }
    }
}

/// One capture, resolved to the monitor the caller asked for.
///
/// The monitor pick, the size guard and the PNG encode live here rather than in
/// `dispatch_bytes` so the selection rules have exactly one home — the reason
/// this is a function and not three lines inside the trait method.
fn capture_png(
    params: &Value,
    encoded_limit: usize,
) -> Result<(Vec<u8>, Value, bool), ServiceError> {
    let request = Request::parse(params.clone())?;
    let monitors = ScreenService::monitors()?;
    let monitor_rect = |info: &MonitorInfo| Rect {
        x: info.x,
        y: info.y,
        width: info.width,
        height: info.height,
    };
    let (bounds, target) = match request.target {
        Some(Target::Desktop) => (
            request
                .rect
                .ok_or_else(|| ServiceError::bad_params("desktop target requires a rect"))?
                .validate()?,
            json!({"kind":"desktop"}),
        ),
        Some(Target::Window { id, pid, app_name }) => {
            let selector = WindowSelector { id, pid, app_name };
            let window =
                screen_capture::select_window(&screen_capture::windows(&selector)?, &selector)?;
            let bounds = window.bounds.region(request.rect)?;
            (
                bounds,
                json!({"kind":"window","id":window.id,"pid":window.pid,"bounds":window.bounds}),
            )
        }
        target => {
            let index = match target {
                Some(Target::Monitor { index }) => index,
                _ => request.monitor,
            };
            let picked = match index {
                Some(index) => monitors.iter().find(|(info, _)| info.index == index),
                None => monitors
                    .iter()
                    .find(|(info, _)| info.primary)
                    .or_else(|| monitors.first()),
            }
            .ok_or_else(|| {
                ServiceError::not_found("no usable monitor matches the capture target")
            })?;
            (
                monitor_rect(&picked.0).region(request.rect)?,
                json!({"kind":"monitor","index":picked.0.index}),
            )
        }
    };
    let _work = super::image_work::acquire(
        u64::from(bounds.width) * u64::from(bounds.height),
        encoded_limit,
    )?;
    // Each tile is captured natively at the intersected physical rectangle.
    // Off-screen areas and gaps between monitors remain transparent.
    let displays: Vec<_> = monitors
        .iter()
        .map(|(info, _)| monitor_rect(info))
        .collect();
    let image = screen_capture::capture_desktop(bounds, &displays, |index, local| {
        monitors[index]
            .1
            .capture_region(local.x as u32, local.y as u32, local.width, local.height)
            .map_err(|e| ServiceError::io(format!("capture failed: {e}")))
    })?;
    let mut png = super::image_work::Output::new(encoded_limit);
    image::ImageEncoder::write_image(
        image::codecs::png::PngEncoder::new(&mut png),
        image.as_raw(),
        image.width(),
        image.height(),
        image::ExtendedColorType::Rgba8,
    )
    .map_err(|e| {
        if png.exceeded {
            ServiceError::bad_params(
                "encoded screenshot exceeds byte limit; use a smaller rectangle or captureResource",
            )
        } else {
            ServiceError::io(format!("png encode failed: {e}"))
        }
    })?;
    Ok((
        png.bytes,
        json!({"bounds":bounds,"unit":"physical","target":target,"mode":"visible-desktop"}),
        request.include_info,
    ))
}

#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}
pub fn validate_region(
    width: u32,
    height: u32,
    rect: Option<Region>,
) -> Result<Option<Region>, ServiceError> {
    let r = rect.unwrap_or(Region {
        x: 0,
        y: 0,
        width,
        height,
    });
    if r.width == 0
        || r.height == 0
        || r.x.checked_add(r.width).is_none_or(|v| v > width)
        || r.y.checked_add(r.height).is_none_or(|v| v > height)
    {
        return Err(ServiceError::bad_params("capture rect must fit within one monitor; coordinates are monitor-relative physical pixels"));
    }
    if u64::from(r.width) * u64::from(r.height) > MAX_PIXELS {
        return Err(ServiceError::bad_params(
            "capture exceeds 64 million pixels",
        ));
    }
    Ok(rect)
}
