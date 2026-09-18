//! `hotkey` service — global shortcuts registered on a plugin's behalf.
//!
//! A plugin cannot register a hotkey itself: it is loaded from a Blob URL and
//! is not allowed to import a Tauri API (see the plugin audit test). So the
//! host registers on its behalf and delivers the press as an ordinary `evt`
//! envelope on `hotkey:<action>` — the same downlink every other notification
//! uses, so a plugin handles it with `ctx.onHotkey(action, fn)`.
//!
//! ```text
//!   manifest.contributes.hotkeys  ->  host registers at activate
//!   OS press  ->  Rust handler  ->  app.emit(evt topic=hotkey:<action>)
//!              ->  every window's listener  ->  ctx.onHotkey(action, fn)
//! ```
//!
//! Registration is declarative: the manifest entry IS the declaration, so the
//! plugin needs no extra permission. A conflict is reported, not fatal — one
//! taken shortcut must not stop a plugin from activating.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::Emitter;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use super::{Service, ServiceError};
use crate::protocol::codes::code;
use crate::host::registry::HOST_IDENTITY;
use crate::protocol::envelope::{Envelope, BROADCAST_EVENT};

/// Who a registration belongs to.
///
/// Normally the caller itself. The host may pass an explicit `owner` to
/// register ON BEHALF OF a plugin — that is how a declared
/// `contributes.hotkeys` entry gets wired up without the plugin needing a
/// shortcut permission of its own. Only the host identity may do that, so a
/// plugin cannot register shortcuts for another plugin.
pub fn resolve_owner(caller: &str, params: &Value) -> Result<String, ServiceError> {
    match params.get("owner").and_then(|v| v.as_str()) {
        None => Ok(caller.to_string()),
        Some(owner) if caller == HOST_IDENTITY => {
            if owner.trim().is_empty() {
                return Err(ServiceError::bad_params("empty `owner`"));
            }
            Ok(owner.to_string())
        }
        Some(_) => Err(ServiceError::new(
            code::DENIED,
            format!("plugin `{caller}` may not register a hotkey for another plugin"),
        )),
    }
}

/// plugin id -> the shortcut strings it holds, so a deactivate can release
/// exactly its own and nothing else.
fn registry() -> &'static Mutex<HashMap<String, Vec<String>>> {
    static REG: OnceLock<Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Vec<String>>> {
    registry().lock().unwrap_or_else(|e| e.into_inner())
}

/// The topic a press is delivered on. Part of the contract, so it is defined
/// once and mirrored in `ctx.onHotkey`.
pub fn topic_for(action: &str) -> String {
    format!("hotkey:{action}")
}

/// Validate a shortcut string without touching the OS. Pure, so it is testable.
pub fn parse_shortcut(key: &str) -> Result<Shortcut, ServiceError> {
    if key.trim().is_empty() {
        return Err(ServiceError::bad_params("empty shortcut"));
    }
    key.parse::<Shortcut>()
        .map_err(|e| ServiceError::bad_params(format!("invalid shortcut `{key}`: {e}")))
}

/// Remember that `plugin` holds `key` (idempotent).
fn remember(plugin: &str, key: &str) {
    let mut map = lock();
    let held = map.entry(plugin.to_string()).or_default();
    if !held.iter().any(|k| k == key) {
        held.push(key.to_string());
    }
}

fn forget(plugin: &str, key: &str) -> bool {
    let mut map = lock();
    match map.get_mut(plugin) {
        Some(held) => {
            let before = held.len();
            held.retain(|k| k != key);
            let removed = held.len() != before;
            if held.is_empty() {
                map.remove(plugin);
            }
            removed
        }
        None => false,
    }
}

fn held_by(plugin: &str) -> Vec<String> {
    lock().get(plugin).cloned().unwrap_or_default()
}

/// Release every shortcut a plugin holds (called on deactivate).
pub fn release_all_for(app: &tauri::AppHandle, plugin: &str) -> usize {
    let keys = lock().remove(plugin).unwrap_or_default();
    for key in &keys {
        if let Ok(sc) = parse_shortcut(key) {
            let _ = app.global_shortcut().unregister(sc);
        }
    }
    keys.len()
}

pub struct HotkeyService;

impl Service for HotkeyService {
    fn name(&self) -> &'static str {
        "hotkey"
    }

    fn actions(&self) -> &'static [&'static str] {
        &["register", "unregister", "unregister_all", "list"]
    }

    fn dispatch(
        &self,
        app: &tauri::AppHandle,
        plugin_id: &str,
        action: &str,
        params: Value,
    ) -> Result<Value, ServiceError> {
        let str_param = |key: &str| -> Result<String, ServiceError> {
            params
                .get(key)
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| ServiceError::bad_params(format!("missing string param `{key}`")))
        };

        match action {
            "register" => {
                let key = str_param("key")?;
                let action_name = str_param("action")?;
                let shortcut = parse_shortcut(&key)?;
                let owner = resolve_owner(plugin_id, &params)?;
                let owner_for_handler = owner.clone();
                let app_for_handler = app.clone();
                let topic = topic_for(&action_name);
                let key_for_event = key.clone();
                app.global_shortcut()
                    .on_shortcut(shortcut, move |_app, _sc, event| {
                        if event.state != ShortcutState::Pressed {
                            return;
                        }
                        let mut env = Envelope::evt(topic.clone(), json!({ "key": key_for_event.clone() }));
                        // the owner travels with the event so a subscriber can
                        // ignore another plugin's hotkey with the same action
                        env.svc = Some(owner_for_handler.clone());
                        let _ = app_for_handler.emit(BROADCAST_EVENT, &env);
                    })
                    .map_err(|e| format!("register `{key}`: {e}"))?;

                remember(&owner, &key);
                Ok(json!({ "registered": true, "owner": owner, "key": key, "topic": topic_for(&action_name) }))
            }
            "unregister" => {
                let key = str_param("key")?;
                let owner = resolve_owner(plugin_id, &params)?;
                if let Ok(sc) = parse_shortcut(&key) {
                    let _ = app.global_shortcut().unregister(sc);
                }
                Ok(json!({ "released": forget(&owner, &key) }))
            }
            "unregister_all" => {
                let owner = resolve_owner(plugin_id, &params)?;
                Ok(json!({ "released": release_all_for(app, &owner) }))
            }
            "list" => {
                let owner = resolve_owner(plugin_id, &params)?;
                Ok(json!({ "keys": held_by(&owner) }))
            }
            _ => Err(ServiceError::new(code::UNKNOWN_ACTION, format!("unknown action `hotkey/{action}`"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_strings_are_validated_without_touching_the_os() {
        assert!(parse_shortcut("alt+shift+h").is_ok());
        assert!(parse_shortcut("Ctrl+Alt+T").is_ok());
        assert!(parse_shortcut("F9").is_ok());
        let err = parse_shortcut("not+a+key").unwrap_err();
        assert_eq!(err.code, code::BAD_PARAMS);
        assert!(err.msg.contains("invalid shortcut"), "got: {err}");
        assert!(parse_shortcut("").is_err());
    }

    #[test]
    fn only_the_host_may_register_on_behalf_of_another_plugin() {
        // a plugin registering for itself
        assert_eq!(resolve_owner("a.plugin", &json!({})).unwrap(), "a.plugin");
        // the host registering for a plugin (how contributes.hotkeys is wired)
        assert_eq!(
            resolve_owner(HOST_IDENTITY, &json!({ "owner": "a.plugin" })).unwrap(),
            "a.plugin"
        );
        // a plugin trying to act for another plugin is refused
        let err = resolve_owner("a.plugin", &json!({ "owner": "b.plugin" })).unwrap_err();
        assert_eq!(err.code, code::DENIED, "acting for another plugin is an authorization failure");
        assert!(err.msg.contains("may not register"), "got: {err}");
        // an empty owner is refused
        assert!(resolve_owner(HOST_IDENTITY, &json!({ "owner": "  " })).is_err());
    }

    #[test]
    fn the_topic_shape_is_part_of_the_contract() {
        assert_eq!(topic_for("greet"), "hotkey:greet");
    }

    #[test]
    fn bookkeeping_is_per_plugin_and_idempotent() {
        let _g = crate::services::serial();
        lock().clear();
        remember("a.plugin", "alt+1");
        remember("a.plugin", "alt+1"); // idempotent
        remember("a.plugin", "alt+2");
        remember("b.plugin", "alt+1");
        assert_eq!(held_by("a.plugin"), vec!["alt+1", "alt+2"]);
        assert_eq!(held_by("b.plugin"), vec!["alt+1"]);
        assert_eq!(held_by("nobody"), Vec::<String>::new());

        assert!(forget("a.plugin", "alt+1"));
        assert!(!forget("a.plugin", "alt+1"), "second release is a no-op");
        assert_eq!(held_by("a.plugin"), vec!["alt+2"]);
        // releasing one plugin must not disturb another
        assert_eq!(held_by("b.plugin"), vec!["alt+1"]);
        forget("a.plugin", "alt+2");
        assert_eq!(held_by("a.plugin"), Vec::<String>::new());
        lock().clear();
    }
}
