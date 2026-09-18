//! `storage` and `host` services.
//!
//! Both are plain request/response services behind the gateway, and both
//! delegate to a pure path-based `dispatch_at` core so unit tests run
//! without a Tauri runtime.

use serde_json::{Map, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::Manager;

use super::session;
use super::Service;

const DEBUG_LOG_MAX: u64 = 1_000_000; // keep debug.log a debug artifact, not a data store

pub(crate) fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {
    let valid_chars = plugin_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    // Traversal guard: every dot-separated segment must be non-empty, so
    // ".", "..", "a..b", ".x", "x." are all rejected — `..` would otherwise
    // escape the plugin-data root via Path::join.
    let no_traversal = !plugin_id.is_empty() && plugin_id.split('.').all(|seg| !seg.is_empty());
    if !valid_chars || !no_traversal {
        return Err(format!("invalid plugin id: `{plugin_id}`"));
    }
    Ok(())
}

fn plugin_data_dir_at(data_root: &Path, plugin_id: &str) -> Result<PathBuf, String> {
    validate_plugin_id(plugin_id)?;
    let dir = data_root.join("plugin-data").join(plugin_id);
    fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    Ok(dir)
}

fn store_path_at(data_root: &Path, plugin_id: &str) -> Result<PathBuf, String> {
    Ok(plugin_data_dir_at(data_root, plugin_id)?.join("data.json"))
}

fn read_store(path: &Path) -> Result<Map<String, Value>, String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            let v: Value = serde_json::from_str(&text).map_err(|e| format!("corrupt store: {e}"))?;
            Ok(v.as_object().cloned().unwrap_or_default())
        }
        Err(_) => Ok(Map::new()), // not exists -> empty
    }
}

fn write_store(path: &Path, map: &Map<String, Value>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| format!("write store: {e}"))?;
    Ok(())
}

fn params_str(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing string param `{key}`"))
}

fn append_debug_log_at(data_root: &Path, content: &str) -> Result<(), String> {
    let path = data_root.join("debug.log");
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > DEBUG_LOG_MAX {
            fs::write(&path, "").map_err(|e| format!("truncate debug.log: {e}"))?;
        }
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open debug.log: {e}"))?;
    writeln!(f, "{content}").map_err(|e| format!("append debug.log: {e}"))?;
    Ok(())
}

/// `storage` service: namespaced JSON KV persisted on disk.
pub struct StorageService;

/// `host` service: paths / metadata / the unified session list / debug artifacts.
pub struct HostService;

fn data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))
}

impl Service for StorageService {
    fn name(&self) -> &'static str {
        "storage"
    }
    fn actions(&self) -> &'static [&'static str] {
        &["get", "set", "remove", "keys"]
    }
    fn dispatch(
        &self,
        app: &tauri::AppHandle,
        plugin_id: &str,
        action: &str,
        params: Value,
    ) -> Result<Value, String> {
        dispatch_at(&data_root(app)?, plugin_id, self.name(), action, params)
    }
}

impl Service for HostService {
    fn name(&self) -> &'static str {
        "host"
    }
    fn actions(&self) -> &'static [&'static str] {
        &["info", "write_debug_log", "sessions", "plugins", "schema", "unregister"]
    }
    fn dispatch(
        &self,
        app: &tauri::AppHandle,
        plugin_id: &str,
        action: &str,
        params: Value,
    ) -> Result<Value, String> {
        match action {
            // The unified session list: one view over sidecars, streams and
            // PTYs, whichever mechanism created them. A host-wide query, hence
            // the `host` service (session *lifecycle* lives with the data plane
            // in `stream`, so one permission covers opening a stream).
            "sessions" => Ok(Value::Array(session::list(None))),
            // Which plugins the host has authorised. Reachable through the
            // gateway so a plugin or a window can ask without a bespoke command.
            "plugins" => Ok(serde_json::json!({
                "plugins": crate::host::registry::known(),
                "services": crate::services::service_names(),
            })),
            // What this host supports: protocol version, services + actions,
            // stream providers. The negotiation surface — a plugin asks instead
            // of discovering the surface by failing.
            "schema" => Ok(crate::services::schema()),
            // Revoke a plugin's native grant. Called when a plugin disappears
            // from disk: without it the permission registry keeps the grant
            // forever, so a plugin that is uninstalled stays authorised.
            //
            // Host-only: a plugin must not be able to drop another plugin's
            // permissions.
            "unregister" => {
                if plugin_id != crate::host::registry::HOST_IDENTITY {
                    return Err(format!(
                        "plugin `{plugin_id}` may not revoke a plugin registration"
                    ));
                }
                let target = params_str(&params, "plugin")?;
                Ok(serde_json::json!({
                    "unregistered": crate::host::registry::unregister(&target),
                }))
            }
            _ => dispatch_at(&data_root(app)?, plugin_id, self.name(), action, params),
        }
    }
}

/// Pure dispatch core (path-based, unit-testable).
pub fn dispatch_at(
    data_root: &Path,
    plugin_id: &str,
    service: &str,
    action: &str,
    params: Value,
) -> Result<Value, String> {
    match (service, action) {
        // ---- storage: namespaced JSON KV, persisted on disk ----
        ("storage", "get") => {
            let key = params_str(&params, "key")?;
            let map = read_store(&store_path_at(data_root, plugin_id)?)?;
            Ok(map.get(&key).cloned().unwrap_or(Value::Null))
        }
        ("storage", "set") => {
            let key = params_str(&params, "key")?;
            let value = params.get("value").cloned().unwrap_or(Value::Null);
            let path = store_path_at(data_root, plugin_id)?;
            let mut map = read_store(&path)?;
            map.insert(key, value);
            write_store(&path, &map)?;
            Ok(Value::Bool(true))
        }
        ("storage", "remove") => {
            let key = params_str(&params, "key")?;
            let path = store_path_at(data_root, plugin_id)?;
            let mut map = read_store(&path)?;
            map.remove(&key);
            write_store(&path, &map)?;
            Ok(Value::Bool(true))
        }
        ("storage", "keys") => {
            let map = read_store(&store_path_at(data_root, plugin_id)?)?;
            Ok(Value::Array(
                map.keys().map(|k| Value::String(k.clone())).collect(),
            ))
        }

        // ---- host: paths / metadata / debug artifacts ----
        ("host", "info") => {
            let dir = plugin_data_dir_at(data_root, plugin_id)?;
            let mut obj = Map::new();
            obj.insert("dataDir".into(), Value::String(dir.to_string_lossy().into()));
            obj.insert("liveSessions".into(), Value::from(session::count() as u64));
            Ok(Value::Object(obj))
        }
        ("host", "write_debug_log") => {
            let content = params_str(&params, "content")?;
            append_debug_log_at(data_root, &content)?;
            Ok(Value::Bool(true))
        }
        _ => Err(format!("unknown action `{service}/{action}`")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("toolbox-st-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn params(list: &[(&str, Value)]) -> Value {
        let mut m = Map::new();
        for (k, v) in list {
            m.insert(k.to_string(), v.clone());
        }
        Value::Object(m)
    }

    #[test]
    fn storage_set_get_remove_roundtrip() {
        let root = temp_root("roundtrip");
        let set = dispatch_at(
            &root,
            "test.plugin",
            "storage",
            "set",
            params(&[("key", Value::from("k1")), ("value", serde_json::json!({ "n": 42, "list": [1,2] }))]),
        );
        assert_eq!(set, Ok(Value::Bool(true)));

        let get = dispatch_at(&root, "test.plugin", "storage", "get", params(&[("key", Value::from("k1"))])).unwrap();
        assert_eq!(get["n"], 42);
        assert_eq!(get["list"][1], 2);

        dispatch_at(&root, "test.plugin", "storage", "remove", params(&[("key", Value::from("k1"))])).unwrap();
        let gone = dispatch_at(&root, "test.plugin", "storage", "get", params(&[("key", Value::from("k1"))])).unwrap();
        assert_eq!(gone, Value::Null);

        let keys = dispatch_at(&root, "test.plugin", "storage", "keys", Value::Null).unwrap();
        assert_eq!(keys, Value::Array(vec![]));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn storage_is_namespaced_per_plugin() {
        let root = temp_root("namespaced");
        dispatch_at(&root, "plugin.a", "storage", "set", params(&[("key", Value::from("shared")), ("value", Value::from("A"))])).unwrap();
        let seen_by_b = dispatch_at(&root, "plugin.b", "storage", "get", params(&[("key", Value::from("shared"))])).unwrap();
        assert_eq!(seen_by_b, Value::Null, "plugin B must not see plugin A's data");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_bad_plugin_ids_and_unknown_actions() {
        let root = temp_root("guard");
        for bad in ["", "a/b", "..", "a b"] {
            let r = dispatch_at(&root, bad, "storage", "keys", Value::Null);
            assert!(r.is_err(), "expected reject for id `{bad}`");
        }
        assert!(dispatch_at(&root, "ok.id", "storage", "nope", Value::Null)
            .unwrap_err()
            .contains("unknown action"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn debug_log_appends() {
        let root = temp_root("dbglog");
        for i in 0..3 {
            dispatch_at(&root, "selftest", "host", "write_debug_log", params(&[("content", Value::from(format!("line-{i}")))]))
                .unwrap();
        }
        let text = fs::read_to_string(root.join("debug.log")).unwrap();
        assert!(text.contains("line-0") && text.contains("line-2"));
        assert!(dispatch_at(&root, "selftest", "host", "write_debug_log", Value::Null).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
