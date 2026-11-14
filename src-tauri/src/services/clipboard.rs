//! `clipboard` service (text, formats, and PNG reads) and its change stream.
//!
//! ## Why two halves, and why they are shaped differently
//!
//! Reading and writing are **pull**: the plugin asks, the host answers. That is a
//! service action, like every other request/response in the gateway.
//!
//! Watching is **push**: the host has to tell the plugin something changed, and
//! a service action cannot do that. It is a stream provider instead, which means
//! it inherits the whole existing push machinery for free — it only polls while a
//! plugin is subscribed, it appears in the host's unified session list, it is
//! closed by the plugin's disposer when the plugin is disabled, and `kill_all()`
//! drains it on exit. A bespoke notification mechanism would have had to
//! reimplement all four.
//!
//! **The rule this settles**: pull → service, push → stream provider. It is why
//! `screen` is a service (a capture is one answer to one question) and this is
//! both.
//!
//! ## Why `arboard` and not `tauri-plugin-clipboard-manager`
//!
//! The Tauri plugin needs an `AppHandle`, and `StreamProvider` does not have one
//! — a provider runs on its own thread with no app. `arboard` is the same
//! underlying platform API without the Tauri plumbing, so both halves use one
//! library and neither needs the trait widened for one caller.
//!
//! ## The permission, and why it is not `rpc:stream`
//!
//! Clipboard subscriptions also require `rpc:clipboard`. Format subscriptions
//! carry only the sequence number and available formats. Reading image bytes
//! takes a separate request.

use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::time::Duration;

use super::stream::{self, Outcome, Sink, StreamProvider};
use super::{Service, ServiceError};
use crate::protocol::codes::code;

/// The permission both halves need. Declared once; the provider reports it
/// through `permission()` so the stream layer enforces it.
pub const PERMISSION: &str = "rpc:clipboard";
const MAX_IMAGE_PIXELS: usize = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;

fn clipboard() -> Result<arboard::Clipboard, ServiceError> {
    // `arboard` retries internally: the clipboard is a global OS resource and
    // another process may hold it open at the moment we ask.
    arboard::Clipboard::new()
        .map_err(|e| ServiceError::new(code::INTERNAL, format!("clipboard unavailable: {e}")))
}

#[cfg(windows)]
fn revision() -> Result<u32, ServiceError> {
    Ok(unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() })
}

#[cfg(not(windows))]
fn revision() -> Result<u32, ServiceError> {
    Err(ServiceError::unsupported(
        "clipboard revisions are available on Windows",
    ))
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Formats {
    revision: u32,
    text: bool,
    image: bool,
}

impl Formats {
    fn payload(self) -> Value {
        let mut formats = Vec::new();
        if self.text {
            formats.push("text");
        }
        if self.image {
            formats.push("image");
        }
        json!({ "revision": self.revision, "formats": formats })
    }
}

#[cfg(windows)]
fn formats() -> Result<Formats, ServiceError> {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::{
        DataExchange::{IsClipboardFormatAvailable, RegisterClipboardFormatW},
        Ole::{CF_DIBV5, CF_UNICODETEXT},
    };

    static PNG: OnceLock<u32> = OnceLock::new();
    let png = *PNG.get_or_init(|| unsafe { RegisterClipboardFormatW(windows_sys::w!("PNG")) });
    let available = |format: u32| unsafe { IsClipboardFormatAvailable(format) != 0 };
    Ok(Formats {
        revision: revision()?,
        text: available(CF_UNICODETEXT.into()),
        // Windows can synthesize DIBV5 from a DIB or bitmap.
        image: available(CF_DIBV5.into()) || (png != 0 && available(png)),
    })
}

#[cfg(not(windows))]
fn formats() -> Result<Formats, ServiceError> {
    Err(ServiceError::unsupported(
        "clipboard format detection is available on Windows",
    ))
}

fn check_revision(expected: Option<u32>) -> Result<(), ServiceError> {
    if let Some(expected) = expected {
        if revision()? != expected {
            return Err(ServiceError::conflict(
                "clipboard changed; refresh its formats",
            ));
        }
    }
    Ok(())
}

pub fn encode_image(image: &arboard::ImageData<'_>) -> Result<Vec<u8>, ServiceError> {
    let pixels = image
        .width
        .checked_mul(image.height)
        .filter(|count| *count > 0 && *count <= MAX_IMAGE_PIXELS)
        .ok_or_else(|| ServiceError::bad_params("clipboard image exceeds the pixel limit"))?;
    if image.bytes.len() != pixels * 4 {
        return Err(ServiceError::new(
            code::CODEC,
            "invalid RGBA clipboard image",
        ));
    }
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(
            &image.bytes,
            image.width as u32,
            image.height as u32,
            ExtendedColorType::Rgba8,
        )
        .map_err(|error| {
            ServiceError::new(code::CODEC, format!("encode clipboard PNG: {error}"))
        })?;
    if png.len() > MAX_IMAGE_BYTES {
        return Err(ServiceError::bad_params("clipboard PNG exceeds 8 MiB"));
    }
    Ok(png)
}

fn read_image(params: &Value) -> Result<Vec<u8>, ServiceError> {
    let expected = params
        .get("revision")
        .map(|value| {
            value
                .as_u64()
                .and_then(|number| u32::try_from(number).ok())
                .ok_or_else(|| ServiceError::bad_params("invalid clipboard revision"))
        })
        .transpose()?;
    check_revision(expected)?;
    let image = clipboard()?.get_image();
    check_revision(expected)?;
    let image = image.map_err(|error| match error {
        arboard::Error::ContentNotAvailable => ServiceError::not_found("clipboard has no image"),
        arboard::Error::ClipboardOccupied => ServiceError::conflict("clipboard is busy"),
        arboard::Error::ConversionFailure => {
            ServiceError::new(code::CODEC, "invalid clipboard image data")
        }
        error => ServiceError::io(format!("read clipboard image: {error}")),
    })?;
    encode_image(&image)
}

pub struct ClipboardService;

impl Service for ClipboardService {
    fn name(&self) -> &'static str {
        "clipboard"
    }
    fn actions(&self) -> &'static [&'static str] {
        &["read", "write", "formats"]
    }

    fn binary_actions(&self) -> &'static [&'static str] {
        &["readImage"]
    }

    fn dispatch_bytes(
        &self,
        _app: &tauri::AppHandle,
        _plugin_id: &str,
        action: &str,
        params: Value,
    ) -> Option<Result<Vec<u8>, ServiceError>> {
        (action == "readImage").then(|| read_image(&params))
    }

    fn dispatch(
        &self,
        _app: &tauri::AppHandle,
        _plugin_id: &str,
        action: &str,
        params: Value,
    ) -> Result<Value, ServiceError> {
        match action {
            "formats" => formats().map(Formats::payload),
            "read" => {
                let mut cb = clipboard()?;
                // An empty clipboard is NOT an error. `get_text` fails when the
                // clipboard holds an image, holds a format we do not read, or is
                // empty — and "there is no text" is a normal answer, not a
                // failure a plugin should have to catch. The distinction that
                // matters is "could not open the clipboard" (an error above) vs
                // "opened it and there is no text".
                Ok(json!({ "text": cb.get_text().ok() }))
            }
            "write" => {
                let text = params
                    .get("text")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ServiceError::bad_params("missing string param `text`"))?;
                let mut cb = clipboard()?;
                cb.set_text(text.to_string()).map_err(|e| {
                    ServiceError::new(code::INTERNAL, format!("clipboard write failed: {e}"))
                })?;
                Ok(json!({ "written": true }))
            }
            _ => Err(ServiceError::new(
                code::UNKNOWN_ACTION,
                format!("unknown clipboard action `{action}`"),
            )),
        }
    }
}

/// Pushes text changes or format snapshots, depending on the subscriber's mode.
pub struct ClipboardWatch;

impl StreamProvider for ClipboardWatch {
    fn name(&self) -> &'static str {
        "clipboard"
    }

    fn permission(&self) -> Option<&'static str> {
        Some(PERMISSION)
    }

    fn open_json(
        &self,
        plugin_id: &str,
        ch: &str,
        params: Value,
        sink: stream::JsonSink,
    ) -> Result<(), String> {
        // Polling, not an OS change hook: a hook needs a message loop on the
        // thread that registered it, and this runs on a stream thread. The
        // default is a compromise — fast enough that a copy feels immediate,
        // slow enough that it is not a busy loop on a global OS resource.
        let interval = params
            .get("intervalMs")
            .and_then(|v| v.as_u64())
            .unwrap_or(500)
            .clamp(100, 10_000);
        // Two names for one thing: `run_stream` borrows the channel for the
        // session key, the closure owns it for the frames it sends.
        let ch_key = ch.to_string();
        let ch_frame = ch.to_string();

        if params.get("mode").and_then(Value::as_str) == Some("formats") {
            return stream::run_stream(
                plugin_id,
                &ch_key,
                Sink::Json(sink),
                move |sink, cancel, _| {
                    let mut last = None;
                    while !cancel.load(Ordering::SeqCst) {
                        let current =
                            formats().map_err(|error| (error.code.to_string(), error.msg))?;
                        // Delayed rendering can announce a format before the sequence advances.
                        if last != Some(current) {
                            sink.data(&ch_frame, current.payload())
                                .map_err(|error| (code::INTERNAL.to_string(), error))?;
                            last = Some(current);
                        }
                        std::thread::sleep(Duration::from_millis(interval));
                    }
                    Ok(Outcome::End)
                },
            );
        }

        stream::run_stream(
            plugin_id,
            &ch_key,
            Sink::Json(sink),
            move |sink, cancel, _bytes| {
                let mut cb = arboard::Clipboard::new().map_err(|e| {
                    (
                        code::INTERNAL.to_string(),
                        format!("clipboard unavailable: {e}"),
                    )
                })?;

                // Push the CURRENT value first. A subscriber should not have to
                // change the clipboard to learn what is already on it — and that is
                // also what makes the stream self-describing when a plugin attaches
                // mid-session.
                let mut last = cb.get_text().ok();
                if let Some(text) = last.clone() {
                    sink.data(&ch_frame, json!({ "text": text }))
                        .map_err(|e| (code::INTERNAL.to_string(), e))?;
                }

                while !cancel.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(interval));
                    if cancel.load(Ordering::SeqCst) {
                        break;
                    }
                    let now = cb.get_text().ok();
                    if now != last {
                        last = now.clone();
                        sink.data(&ch_frame, json!({ "text": now }))
                            .map_err(|e| (code::INTERNAL.to_string(), e))?;
                    }
                }
                Ok(Outcome::End)
            },
        )
    }
}
