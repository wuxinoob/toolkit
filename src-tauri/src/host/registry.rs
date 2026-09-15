//! Plugin permission registry — the single authoritative gate.
//!
//! `plugin_register` is called once per plugin at load time with the
//! permissions its manifest declares. Every gateway call then checks
//! `rpc:<service>` against that set. Unknown plugin ids are DENIED
//! (fail-closed), so forgetting to register can never silently widen access.
//!
//! The host itself is not a plugin: [`HOST_IDENTITY`] is implicitly allowed
//! everything, which is how host-originated calls (the Settings page reading
//! a plugin's storage, the selftest probe) reach the gateway.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

/// Sentinel plugin id used by host-originated calls.
pub const HOST_IDENTITY: &str = "__host__";

fn registry() -> &'static Mutex<HashMap<String, HashSet<String>>> {
    static REG: OnceLock<Mutex<HashMap<String, HashSet<String>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, HashSet<String>>> {
    registry().lock().unwrap_or_else(|e| e.into_inner())
}

/// Register (or replace) a plugin's declared permissions.
pub fn register(plugin_id: &str, permissions: &[String]) {
    let mut map = lock();
    map.insert(
        plugin_id.to_string(),
        permissions.iter().cloned().collect(),
    );
}

/// Drop a plugin's registration (used when an external plugin disappears).
pub fn unregister(plugin_id: &str) -> bool {
    lock().remove(plugin_id).is_some()
}

/// Is `plugin_id` allowed `perm`? Fail-closed on unknown ids.
pub fn is_allowed(plugin_id: &str, perm: &str) -> Result<(), String> {
    if plugin_id == HOST_IDENTITY {
        return Ok(());
    }
    let map = lock();
    match map.get(plugin_id) {
        None => Err(format!(
            "plugin `{plugin_id}` is not registered with the host — call plugin_register first"
        )),
        Some(perms) if perms.contains(perm) => Ok(()),
        Some(_) => Err(format!("plugin `{plugin_id}` lacks permission `{perm}`")),
    }
}

/// Registered plugin ids (diagnostics + settings UI).
pub fn known() -> Vec<String> {
    let mut ids: Vec<String> = lock().keys().cloned().collect();
    ids.sort();
    ids
}

/// Permissions of one plugin, if known.
pub fn permissions_of(plugin_id: &str) -> Option<Vec<String>> {
    lock().get(plugin_id).map(|s| {
        let mut v: Vec<String> = s.iter().cloned().collect();
        v.sort();
        v
    })
}

#[cfg(test)]
pub fn clear() {
    lock().clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perms(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn unknown_plugins_are_denied_fail_closed() {
        let _g = crate::services::serial();
        clear();
        let err = is_allowed("nobody", "rpc:storage").unwrap_err();
        assert!(err.contains("not registered"), "got: {err}");
    }

    #[test]
    fn only_declared_permissions_pass() {
        let _g = crate::services::serial();
        clear();
        register("a.plugin", &perms(&["rpc:storage", "win:manage"]));
        assert!(is_allowed("a.plugin", "rpc:storage").is_ok());
        assert!(is_allowed("a.plugin", "win:manage").is_ok());
        let err = is_allowed("a.plugin", "rpc:proc").unwrap_err();
        assert!(err.contains("lacks permission"), "got: {err}");
    }

    #[test]
    fn the_host_identity_is_implicitly_allowed() {
        let _g = crate::services::serial();
        clear();
        assert!(is_allowed(HOST_IDENTITY, "rpc:anything").is_ok());
    }

    #[test]
    fn re_register_replaces_the_previous_set() {
        let _g = crate::services::serial();
        clear();
        register("b.plugin", &perms(&["rpc:storage"]));
        register("b.plugin", &perms(&["rpc:proc"]));
        assert!(is_allowed("b.plugin", "rpc:storage").is_err());
        assert!(is_allowed("b.plugin", "rpc:proc").is_ok());
        assert_eq!(permissions_of("b.plugin"), Some(perms(&["rpc:proc"])));
        assert_eq!(known(), vec!["b.plugin".to_string()]);
        assert!(unregister("b.plugin"));
        assert!(!unregister("b.plugin"));
    }
}
