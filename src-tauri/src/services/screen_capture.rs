//! Physical desktop geometry shared by monitor, desktop and window selectors.
use super::ServiceError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const MAX_PIXELS: u64 = 64_000_000;
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}
impl Rect {
    pub fn validate(self) -> Result<Self, ServiceError> {
        if self.width == 0
            || self.height == 0
            || u64::from(self.width) * u64::from(self.height) > MAX_PIXELS
        {
            return Err(ServiceError::bad_params(
                "capture must contain 1..64000000 physical pixels",
            ));
        }
        Ok(self)
    }
    pub fn intersection(self, other: Self) -> Option<Self> {
        let x = i64::from(self.x).max(i64::from(other.x));
        let y = i64::from(self.y).max(i64::from(other.y));
        let right = (i64::from(self.x) + i64::from(self.width))
            .min(i64::from(other.x) + i64::from(other.width));
        let bottom = (i64::from(self.y) + i64::from(self.height))
            .min(i64::from(other.y) + i64::from(other.height));
        (right > x && bottom > y).then(|| Self {
            x: x as i32,
            y: y as i32,
            width: (right - x) as u32,
            height: (bottom - y) as u32,
        })
    }
    pub fn region(self, local: Option<Self>) -> Result<Self, ServiceError> {
        let Some(local) = local else {
            return self.validate();
        };
        local.validate()?;
        if local.x < 0
            || local.y < 0
            || i64::from(local.x) + i64::from(local.width) > i64::from(self.width)
            || i64::from(local.y) + i64::from(local.height) > i64::from(self.height)
        {
            return Err(ServiceError::bad_params(
                "rect must fit within the selected target in physical pixels",
            ));
        }
        let x = i64::from(self.x) + i64::from(local.x);
        let y = i64::from(self.y) + i64::from(local.y);
        Ok(Self {
            x: i32::try_from(x).map_err(|_| ServiceError::bad_params("capture x overflow"))?,
            y: i32::try_from(y).map_err(|_| ServiceError::bad_params("capture y overflow"))?,
            width: local.width,
            height: local.height,
        })
    }
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowSelector {
    pub id: Option<u32>,
    pub pid: Option<u32>,
    pub app_name: Option<String>,
}
impl WindowSelector {
    pub fn validate(&self) -> Result<(), ServiceError> {
        if self.id == Some(0)
            || self.pid == Some(0)
            || self
                .app_name
                .as_ref()
                .is_some_and(|s| s.trim().is_empty() || s.len() > 256)
        {
            return Err(ServiceError::bad_params("invalid window selector"));
        }
        Ok(())
    }
    pub fn matches(&self, w: &WindowInfo) -> bool {
        self.id.is_none_or(|id| id == w.id)
            && self.pid.is_none_or(|pid| pid == w.pid)
            && self.app_name.as_ref().is_none_or(|name| {
                let name = name.trim().to_ascii_lowercase();
                name.eq_ignore_ascii_case(&w.app_name)
                    || w.exe_name.as_ref().is_some_and(|exe| {
                        let exe = exe.to_ascii_lowercase();
                        name.strip_suffix(".exe").unwrap_or(&name)
                            == exe.strip_suffix(".exe").unwrap_or(&exe)
                    })
            })
    }
}

/// Capture only intersections with real displays, retaining transparent pixels
/// for desktop gaps. The native provider and deterministic fixtures share this.
pub fn capture_desktop(
    bounds: Rect,
    displays: &[Rect],
    mut capture: impl FnMut(usize, Rect) -> Result<image::RgbaImage, ServiceError>,
) -> Result<image::RgbaImage, ServiceError> {
    bounds.validate()?;
    let tiles: Vec<_> = displays
        .iter()
        .enumerate()
        .filter_map(|(index, display)| {
            bounds
                .intersection(*display)
                .map(|tile| (index, *display, tile))
        })
        .collect();
    if tiles.is_empty() {
        return Err(ServiceError::not_found(
            "capture rect does not intersect an attached display",
        ));
    }
    let mut image = image::RgbaImage::new(bounds.width, bounds.height);
    for (index, display, tile) in tiles {
        let local = Rect {
            x: (i64::from(tile.x) - i64::from(display.x)) as i32,
            y: (i64::from(tile.y) - i64::from(display.y)) as i32,
            width: tile.width,
            height: tile.height,
        };
        let pixels = capture(index, local)?;
        if pixels.width() != tile.width || pixels.height() != tile.height {
            return Err(ServiceError::conflict(
                "display geometry changed during capture; refresh monitors and retry",
            ));
        }
        image::imageops::replace(
            &mut image,
            &pixels,
            i64::from(tile.x) - i64::from(bounds.x),
            i64::from(tile.y) - i64::from(bounds.y),
        );
    }
    Ok(image)
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: u32,
    pub pid: u32,
    pub app_name: String,
    pub exe_name: Option<String>,
    pub title: String,
    pub bounds: Rect,
    pub minimized: bool,
    pub focused: bool,
    pub unit: &'static str,
}
pub fn select_window(
    windows: &[WindowInfo],
    selector: &WindowSelector,
) -> Result<WindowInfo, ServiceError> {
    selector.validate()?;
    if selector.id.is_none() && selector.pid.is_none() && selector.app_name.is_none() {
        return Err(ServiceError::bad_params(
            "window target requires id, pid or appName",
        ));
    }
    let found: Vec<_> = windows.iter().filter(|w| selector.matches(w)).collect();
    match found.as_slice() {
        [] => Err(ServiceError::not_found("no window matches this selector")),
        [window] if window.minimized => Err(ServiceError::unsupported(
            "a minimized window has no visible desktop region",
        )),
        [window] => Ok((*window).clone()),
        _ => Err(ServiceError::conflict(
            "multiple windows match; use screen.windows and select an id",
        )),
    }
}

pub fn windows(selector: &WindowSelector) -> Result<Vec<WindowInfo>, ServiceError> {
    selector.validate()?;
    let mut apps = std::collections::HashMap::new();
    let mut out = Vec::new();
    for window in
        xcap::Window::all().map_err(|e| ServiceError::io(format!("enumerate windows: {e}")))?
    {
        let Ok(pid) = window.pid() else {
            continue;
        };
        if selector.pid.is_some_and(|expected| expected != pid) {
            continue;
        }
        let Ok(id) = window.id() else {
            continue;
        };
        if selector.id.is_some_and(|expected| expected != id) {
            continue;
        }
        let (app_name, exe_name) = apps
            .entry(pid)
            .or_insert_with(|| (window.app_name().unwrap_or_default(), exe_name(pid)))
            .clone();
        let geometry = (|| {
            Some(Rect {
                x: window.x().ok()?,
                y: window.y().ok()?,
                width: window.width().ok()?,
                height: window.height().ok()?,
            })
        })();
        let Some(bounds) = geometry else {
            continue;
        };
        let info = WindowInfo {
            id,
            pid,
            app_name,
            exe_name,
            title: window.title().unwrap_or_default(),
            bounds,
            minimized: window.is_minimized().unwrap_or(true),
            focused: window.is_focused().unwrap_or(false),
            unit: "physical",
        };
        if selector.matches(&info) {
            out.push(info);
        }
    }
    Ok(out)
}
#[cfg(windows)]
fn exe_name(pid: u32) -> Option<String> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buffer = vec![0u16; 32768];
        let mut len = buffer.len() as u32;
        let success = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        if success == 0 {
            return None;
        }
        std::path::Path::new(&String::from_utf16_lossy(&buffer[..len as usize]))
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
    }
}
#[cfg(not(windows))]
fn exe_name(_: u32) -> Option<String> {
    None
}

pub fn pointer() -> Result<Value, ServiceError> {
    #[cfg(windows)]
    {
        let mut point = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
        if unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetPhysicalCursorPos(&mut point) }
            == 0
        {
            return Err(ServiceError::io("cannot read physical cursor position"));
        }
        Ok(json!({"x":point.x,"y":point.y,"unit":"physical"}))
    }
    #[cfg(not(windows))]
    {
        Err(ServiceError::unsupported(
            "physical pointer query currently requires Windows",
        ))
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Target {
    Monitor {
        index: Option<usize>,
    },
    Desktop,
    Window {
        id: Option<u32>,
        pid: Option<u32>,
        #[serde(rename = "appName")]
        app_name: Option<String>,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Physical,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub unit: Option<Unit>,
    pub monitor: Option<usize>,
    pub target: Option<Target>,
    pub rect: Option<Rect>,
    #[serde(default)]
    pub include_info: bool,
}
impl Request {
    pub fn parse(params: Value) -> Result<Self, ServiceError> {
        let value = if params.is_null() { json!({}) } else { params };
        let request: Self = serde_json::from_value(value)
            .map_err(|_| ServiceError::bad_params("invalid capture target or physical rect"))?;
        if request.monitor.is_some() && request.target.is_some() {
            return Err(ServiceError::bad_params("use either monitor or target"));
        }
        Ok(request)
    }
}
