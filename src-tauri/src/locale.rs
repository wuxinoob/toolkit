//! Host-owned language preference. File IO runs on blocking workers; no WebView
//! writes a second copy or restarts plugins when the language changes.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicU8, Ordering},
        LazyLock, Mutex,
    },
};
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    System,
    Manual,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Preference {
    pub mode: Mode,
    pub locale: String,
}
impl Default for Preference {
    fn default() -> Self {
        Self {
            mode: Mode::System,
            locale: "en-US".into(),
        }
    }
}
impl Preference {
    fn validate(&self) -> Result<(), String> {
        if matches!(self.locale.as_str(), "zh-CN" | "en-US") {
            Ok(())
        } else {
            Err("unsupported interface language".into())
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(flatten)]
    pub preference: Preference,
    pub resolved_locale: String,
    pub revision: u64,
}

pub fn resolve_system(tag: &str) -> &'static str {
    let parts: Vec<_> = tag.split(['-', '_']).collect();
    if parts.first().is_some_and(|p| p.eq_ignore_ascii_case("zh")) {
        if parts.iter().any(|p| p.eq_ignore_ascii_case("Hant")) {
            return "en-US";
        }
        if parts.iter().any(|p| p.eq_ignore_ascii_case("Hans"))
            || parts
                .iter()
                .any(|p| p.eq_ignore_ascii_case("CN") || p.eq_ignore_ascii_case("SG"))
        {
            return "zh-CN";
        }
    }
    "en-US"
}

pub struct Preferences {
    path: PathBuf,
    document: Value,
    snapshot: Snapshot,
}
impl Preferences {
    pub fn open(path: &Path, system: &str) -> Result<Self, String> {
        let document: Value = match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "invalid preferences JSON")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
            Err(error) => return Err(format!("cannot read preferences: {error}")),
        };
        if !document.is_object() {
            return Err("preferences must be a JSON object".into());
        }
        let preference = serde_json::from_value::<Preference>(document["language"].clone())
            .ok()
            .filter(|p| p.validate().is_ok())
            .unwrap_or_default();
        let resolved_locale = if preference.mode == Mode::Manual {
            preference.locale.clone()
        } else {
            resolve_system(system).into()
        };
        Ok(Self {
            path: path.into(),
            document,
            snapshot: Snapshot {
                preference,
                resolved_locale,
                revision: 1,
            },
        })
    }
    pub fn snapshot(&mut self, system: &str) -> Snapshot {
        let resolved = if self.snapshot.preference.mode == Mode::Manual {
            self.snapshot.preference.locale.as_str()
        } else {
            resolve_system(system)
        };
        if resolved != self.snapshot.resolved_locale {
            self.snapshot.resolved_locale = resolved.into();
            self.snapshot.revision += 1;
        }
        self.snapshot.clone()
    }
    pub fn set(&mut self, preference: Preference, system: &str) -> Result<Snapshot, String> {
        preference.validate()?;
        if preference == self.snapshot.preference {
            return Ok(self.snapshot(system));
        }
        let mut document = self.document.clone();
        document["language"] = serde_json::to_value(&preference).map_err(|e| e.to_string())?;
        let parent = self.path.parent().ok_or("invalid preferences path")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(&document).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        file.persist(&self.path)
            .map_err(|e| format!("cannot save language preference: {e}"))?;
        self.document = document;
        self.snapshot.preference = preference;
        self.snapshot.revision += 1;
        Ok(self.snapshot(system))
    }
}

#[cfg(windows)]
pub fn system_locale() -> String {
    use windows_sys::Win32::Globalization::{GetUserDefaultUILanguage, LCIDToLocaleName};
    let mut name = [0u16; 85];
    let length = unsafe {
        LCIDToLocaleName(
            GetUserDefaultUILanguage() as u32,
            name.as_mut_ptr(),
            name.len() as i32,
            0,
        )
    };
    if length > 1 {
        String::from_utf16_lossy(&name[..length as usize - 1])
    } else {
        "en-US".into()
    }
}
#[cfg(not(windows))]
pub fn system_locale() -> String {
    std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_default()
        .split('.')
        .next()
        .unwrap_or_default()
        .into()
}

#[derive(Default)]
pub struct Host {
    inner: Mutex<Option<Preferences>>,
    applied: AtomicU64,
    // UI window creation must never wait for the preference file's fsync.
    resolved: AtomicU8,
}

static EN: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/i18n/locales/en-US/native.json"))
        .expect("English native messages")
});
static ZH: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/i18n/locales/zh-CN/native.json"))
        .expect("Chinese native messages")
});
pub fn text(locale: &str, key: &'static str) -> &'static str {
    let messages = if locale == "zh-CN" { &*ZH } else { &*EN };
    messages[key]
        .as_str()
        .or_else(|| EN[key].as_str())
        .unwrap_or(key)
}
pub fn cached_locale(app: &tauri::AppHandle) -> String {
    match app
        .try_state::<Host>()
        .map(|host| host.resolved.load(Ordering::Relaxed))
    {
        Some(1) => "en-US".into(),
        Some(2) => "zh-CN".into(),
        _ => resolve_system(&system_locale()).into(),
    }
}

pub struct TrayLabels {
    pub show: tauri::menu::MenuItem<tauri::Wry>,
    pub reload: tauri::menu::MenuItem<tauri::Wry>,
    pub restart: tauri::menu::MenuItem<tauri::Wry>,
    pub quit: tauri::menu::MenuItem<tauri::Wry>,
}
fn publish(app: &tauri::AppHandle, snapshot: Snapshot) -> Result<(), String> {
    let target = app.clone();
    // Never wait for UI operations while holding the preference lock. Window
    // creation also reads the cached language on the main thread.
    app.run_on_main_thread(move || {
        let host = target.state::<Host>();
        if snapshot.revision <= host.applied.load(Ordering::Relaxed) {
            return;
        }
        host.applied.store(snapshot.revision, Ordering::Relaxed);
        if let Some(menu) = target.try_state::<TrayLabels>() {
            for (item, key) in [
                (&menu.show, "tray.show"),
                (&menu.reload, "tray.reload"),
                (&menu.restart, "tray.restart"),
                (&menu.quit, "tray.quit"),
            ] {
                if let Err(error) = item.set_text(text(&snapshot.resolved_locale, key)) {
                    eprintln!("[locale] tray update failed: {error}");
                }
            }
        }
        if let Some(window) = target.get_webview_window("host-llm-settings") {
            let _ = window.set_title(text(&snapshot.resolved_locale, "model.title"));
        }
        let _ = target.emit("host:locale-changed", snapshot);
    })
    .map_err(|e| e.to_string())
}
fn update(app: &tauri::AppHandle, preference: Option<Preference>) -> Result<Snapshot, String> {
    let host = app.state::<Host>();
    let mut inner = host
        .inner
        .lock()
        .map_err(|_| "language state lock poisoned")?;
    let system = system_locale();
    let initial = inner.is_none();
    if initial {
        let path = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("preferences.json");
        *inner = Some(Preferences::open(&path, &system)?);
    }
    let prefs = inner.as_mut().unwrap();
    let previous = prefs.snapshot.revision;
    let snapshot = if let Some(preference) = preference {
        prefs.set(preference, &system)?
    } else {
        prefs.snapshot(&system)
    };
    let changed = initial || previous != snapshot.revision;
    host.resolved.store(
        if snapshot.resolved_locale == "zh-CN" {
            2
        } else {
            1
        },
        Ordering::Relaxed,
    );
    drop(inner);
    if changed {
        publish(app, snapshot.clone())?;
    }
    Ok(snapshot)
}
#[tauri::command]
pub async fn host_locale_get(app: tauri::AppHandle) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || update(&app, None))
        .await
        .map_err(|e| e.to_string())?
}
pub(crate) fn read(app: &tauri::AppHandle) -> Result<Snapshot, String> {
    update(app, None)
}
#[tauri::command]
pub async fn host_locale_set(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    preference: Preference,
) -> Result<Snapshot, String> {
    if window.label() != "main" {
        return Err("interface language can only be changed in the main settings window".into());
    }
    tauri::async_runtime::spawn_blocking(move || update(&app, Some(preference)))
        .await
        .map_err(|e| e.to_string())?
}
pub fn warm(app: tauri::AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = update(&app, None) {
            eprintln!("[locale] initialization failed: {error}");
        }
    });
}
