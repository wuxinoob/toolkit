//! External plugin discovery: scan `{app_data_dir}/plugins/*/` for
//! `plugin.json` manifests + entry JS files. The frontend turns entry code
//! into a Blob URL and dynamically imports it — no host code changes needed
//! to add a new plugin (drop a folder, click Rescan, done).
//!
//! Security notes:
//! - dirs/files are canonicalized and verified to stay under the plugins root
//! - trust model v1: locally installed plugins are trusted code (docs §4.7)

use serde::Serialize;
use serde_json::Value;
use std::{fs, path::Path, path::PathBuf};
use tauri::Manager;

#[derive(Serialize)]
pub struct ExternalPlugin {
    pub id: String,
    pub dir: String,
    pub manifest: Value,
    pub entry_file: String,
}

pub(crate) fn plugins_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let dir = base.join("plugins");
    fs::create_dir_all(&dir).map_err(|e| format!("create plugins dir: {e}"))?;
    Ok(dir)
}

/// Pure scan core (path-based, unit-testable).
pub fn scan_at(root: &Path) -> Result<Vec<ExternalPlugin>, String> {
    let mut out = Vec::new();
    let entries = fs::read_dir(root).map_err(|e| format!("read plugins dir: {e}"))?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let manifest_path = dir.join("plugin.json");
        let Ok(text) = fs::read_to_string(&manifest_path) else {
            continue; // no manifest -> not a plugin, skip silently
        };
        let Ok(manifest) = serde_json::from_str::<Value>(&text) else {
            continue; // invalid JSON -> skip
        };
        let id = manifest
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let entry_file = manifest
            .get("entry")
            .and_then(|v| v.as_str())
            .unwrap_or("main.js")
            .to_string();
        if !dir.join(&entry_file).is_file() {
            continue;
        }
        out.push(ExternalPlugin {
            id,
            dir: dir.to_string_lossy().into_owned(),
            manifest,
            entry_file,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Pure entry-reader core (path-based, unit-testable).
pub fn read_entry_at(root: &Path, dir: &str, entry_file: &str) -> Result<String, String> {
    let root_canon = root.canonicalize().map_err(|e| e.to_string())?;
    let dir_canon = PathBuf::from(dir)
        .canonicalize()
        .map_err(|e| format!("resolve plugin dir: {e}"))?;
    if !dir_canon.starts_with(&root_canon) {
        return Err("plugin dir is outside the plugins root".into());
    }
    // Canonicalize the JOINED path: lexical starts_with() alone does not fold
    // `..` components, so `dir/../x` would otherwise pass the prefix check.
    // Resolving through the OS first (also follows symlinks) closes that hole.
    let file = dir_canon
        .join(entry_file)
        .canonicalize()
        .map_err(|e| format!("resolve entry file: {e}"))?;
    if !file.starts_with(&dir_canon) {
        return Err("entry file escapes plugin dir".into()); // traversal guard
    }
    fs::read_to_string(&file).map_err(|e| format!("read entry: {e}"))
}

#[tauri::command]
pub fn plugin_scan(app: tauri::AppHandle) -> Result<Vec<ExternalPlugin>, String> {
    let root = plugins_root(&app)?;
    scan_at(&root)
}

#[tauri::command]
pub fn plugin_read_entry(
    app: tauri::AppHandle,
    dir: String,
    entry_file: String,
) -> Result<String, String> {
    let root = plugins_root(&app)?;
    read_entry_at(&root, &dir, &entry_file)
}

#[tauri::command]
pub fn plugin_open_dir(app: tauri::AppHandle) -> Result<(), String> {
    let root = plugins_root(&app)?;
    tauri_plugin_opener::open_path(root, None::<&str>)
        .map_err(|e| format!("open plugins dir: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("toolbox-ext-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scan_finds_valid_plugin_and_skips_invalid() {
        let root = temp_root("scan");

        let good = root.join("a-good");
        fs::create_dir_all(&good).unwrap();
        fs::write(good.join("plugin.json"), r#"{"id":"test.good","entry":"main.js"}"#).unwrap();
        fs::write(good.join("main.js"), "export default {};").unwrap();

        let bad_json = root.join("b-badjson");
        fs::create_dir_all(&bad_json).unwrap();
        fs::write(bad_json.join("plugin.json"), "{not json").unwrap();

        let missing = root.join("c-missing-entry");
        fs::create_dir_all(&missing).unwrap();
        fs::write(missing.join("plugin.json"), r#"{"id":"test.missing"}"#).unwrap();

        fs::write(root.join("d-plainfile.txt"), "x").unwrap();

        let found = scan_at(&root).unwrap();
        assert_eq!(found.len(), 1, "only the valid plugin must be found");
        assert_eq!(found[0].id, "test.good");
        assert_eq!(found[0].entry_file, "main.js");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_entry_rejects_dir_outside_root() {
        let root = temp_root("outside");
        let outside = temp_root("outside-src");
        fs::write(outside.join("secret.txt"), "nope").unwrap();
        let err = read_entry_at(&root, &outside.to_string_lossy(), "secret.txt").unwrap_err();
        assert!(err.contains("outside the plugins root"), "got: {err}");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn read_entry_rejects_traversal() {
        let root = temp_root("traversal");
        let plugin = root.join("p");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(plugin.join("main.js"), "export {};").unwrap();
        fs::write(root.join("secret.txt"), "nope").unwrap();

        let ok = read_entry_at(&root, &plugin.to_string_lossy(), "main.js").unwrap();
        assert_eq!(ok, "export {};");

        let err = read_entry_at(&root, &plugin.to_string_lossy(), "../secret.txt").unwrap_err();
        assert!(err.contains("escapes plugin dir"), "got: {err}");
        let _ = fs::remove_dir_all(&root);
    }
}
