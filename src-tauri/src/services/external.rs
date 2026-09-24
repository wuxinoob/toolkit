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
    /// Content digest of everything that defines this plugin (manifest + entry).
    ///
    /// The frontend compares it across rescans to tell "changed on disk" from
    /// "unchanged", so a Rescan can reload what moved without disturbing what
    /// did not. Computed here because this is where the bytes are already read.
    pub digest: String,
}

/// Stable content digest: FNV-1a, hand-rolled.
///
/// It must be deterministic ACROSS RUNS, which rules out
/// `std::collections::hash_map::DefaultHasher` (no stability guarantee). This is
/// a change detector, not a security primitive — collision resistance against
/// an adversary is not claimed or needed.
fn digest_of(manifest: &str, entry: &[u8]) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut h = OFFSET;
    for b in manifest.as_bytes().iter().chain(entry.iter()) {
        h ^= u64::from(*b);
        h = h.wrapping_mul(PRIME);
    }
    format!("{h:016x}")
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

/// One plugin's location, without the digest.
///
/// Deliberately NOT `ExternalPlugin`: that type's `digest` is computed from the
/// entry file's bytes, and a lookup that read them just to fill a field nobody
/// asked for would give back the cost this exists to avoid. A separate type
/// makes "there is no digest here" a fact of the shape rather than an empty
/// string a caller might trust.
#[derive(Serialize)]
pub struct PluginInfo {
    pub id: String,
    pub dir: String,
    pub manifest: Value,
    pub entry_file: String,
}

/// The manifest fields both the full scan and the single lookup need.
struct ManifestFacts {
    id: String,
    entry_file: String,
    manifest: Value,
    /// The raw text — the scan's digest is computed over it.
    text: String,
}

/// Read and parse one plugin directory's `plugin.json`.
///
/// Shared, so the scan and the single lookup cannot drift on what counts as a
/// plugin. `None` covers every way a directory fails to be one: no manifest,
/// unparseable JSON, or a manifest with no `id`.
fn read_manifest(dir: &Path) -> Option<ManifestFacts> {
    let text = fs::read_to_string(dir.join("plugin.json")).ok()?;
    let manifest: Value = serde_json::from_str(&text).ok()?;
    let id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return None;
    }
    let entry_file = manifest
        .get("entry")
        .and_then(|v| v.as_str())
        .unwrap_or("main.js")
        .to_string();
    Some(ManifestFacts { id, entry_file, manifest, text })
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
        let Some(facts) = read_manifest(&dir) else {
            continue; // no/invalid manifest -> not a plugin, skip silently
        };
        let Ok(entry) = fs::read(dir.join(&facts.entry_file)) else {
            continue; // unreadable entry -> not loadable, skip
        };
        let digest = digest_of(&facts.text, &entry);
        out.push(ExternalPlugin {
            id: facts.id,
            dir: dir.to_string_lossy().into_owned(),
            manifest: facts.manifest,
            entry_file: facts.entry_file,
            digest,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Look up ONE plugin by id, reading no entry files.
///
/// `scan_at` answers the same question by reading every manifest AND every entry
/// file — the digest needs the bytes. Measured on this repo that is ~900 KB of
/// I/O across 8 plugins, and `pluginwin-host.js` paid all of it to learn one
/// `dir` + `entry_file` that the main window already knew at boot. Opening a
/// window should not cost a directory's worth of reads.
///
/// The directory name is NOT the id — a folder may be called anything, and in
/// this repo several are (`eyecare.demo/`, `probe.demo/`) — so this still walks
/// the root. What it does not do is read the entry files: manifests are ~300
/// bytes each, and it stops at the match.
///
/// The entry's existence is still required, because `scan_at` skips a plugin
/// whose entry cannot be read — a lookup that did not would hand a window a
/// directory it cannot load from. Checked with metadata, not by reading it.
pub fn info_at(root: &Path, id: &str) -> Result<Option<PluginInfo>, String> {
    let entries = fs::read_dir(root).map_err(|e| format!("read plugins dir: {e}"))?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(facts) = read_manifest(&dir) else {
            continue;
        };
        if facts.id != id || !dir.join(&facts.entry_file).is_file() {
            continue;
        }
        return Ok(Some(PluginInfo {
            id: facts.id,
            dir: dir.to_string_lossy().into_owned(),
            manifest: facts.manifest,
            entry_file: facts.entry_file,
        }));
    }
    Ok(None)
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

/// Scan the plugins root.
///
/// `async` + `spawn_blocking`, not a plain `fn`: this walks the whole plugins
/// directory and, per plugin, reads `plugin.json` AND the **entire entry file**
/// (the digest needs the bytes). That is megabytes of blocking I/O, and as a
/// plain command it ran on the main thread — the window-message thread. It is
/// called at boot AND every time a plugin window opens, so the cost landed
/// exactly when the user was waiting for a window to appear.
#[tauri::command]
pub async fn plugin_scan(app: tauri::AppHandle) -> Result<Vec<ExternalPlugin>, String> {
    let root = plugins_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || scan_at(&root))
        .await
        .map_err(|e| format!("scan task failed: {e}"))?
}

/// Where one plugin lives — what a plugin window needs to load its own entry.
///
/// A plugin window used to call `plugin_scan` and `.find()` the one it wanted,
/// which made opening a window read every manifest and every entry file in the
/// plugins directory. See `info_at` for the numbers.
#[tauri::command]
pub async fn plugin_info(
    app: tauri::AppHandle,
    id: String,
) -> Result<Option<PluginInfo>, String> {
    let root = plugins_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || info_at(&root, &id))
        .await
        .map_err(|e| format!("plugin info task failed: {e}"))?
}

/// Read a plugin's entry source. Same reasoning as `plugin_scan` — it is a file
/// read, and a file read on the message thread is a stalled window.
#[tauri::command]
pub async fn plugin_read_entry(
    app: tauri::AppHandle,
    dir: String,
    entry_file: String,
) -> Result<String, String> {
    let root = plugins_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_entry_at(&root, &dir, &entry_file))
        .await
        .map_err(|e| format!("read entry task failed: {e}"))?
}

#[tauri::command]
pub async fn plugin_open_dir(app: tauri::AppHandle) -> Result<(), String> {
    let root = plugins_root(&app)?;
    // Shelling out to Explorer is a process launch; it does not belong on the
    // message thread either.
    tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_opener::open_path(root, None::<&str>)
            .map_err(|e| format!("open plugins dir: {e}"))
    })
    .await
    .map_err(|e| format!("open dir task failed: {e}"))?
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
    fn the_digest_is_stable_and_content_sensitive() {
        // Stable across calls, so a rescan can tell "unchanged" from "changed".
        let a = digest_of("{\"id\":\"x\"}", b"console.log(1)");
        assert_eq!(a, digest_of("{\"id\":\"x\"}", b"console.log(1)"));
        assert_eq!(a.len(), 16, "fixed-width hex");
        // Sensitive to both halves of the definition.
        assert_ne!(a, digest_of("{\"id\":\"x\"}", b"console.log(2)"), "entry change");
        assert_ne!(a, digest_of("{\"id\":\"y\"}", b"console.log(1)"), "manifest change");
    }

    #[test]
    fn scan_reports_a_digest_that_tracks_the_files() {
        let root = temp_root("digest");
        let d = root.join("p");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("plugin.json"), r#"{"id":"d.demo","name":"D","entry":"main.js"}"#).unwrap();
        fs::write(d.join("main.js"), "export const manifest = {id:'d.demo'}").unwrap();

        let first = scan_at(&root).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].digest.len(), 16);

        // nothing changed -> same digest (this is what makes a no-op rescan cheap)
        assert_eq!(scan_at(&root).unwrap()[0].digest, first[0].digest);

        // touching the entry changes it (this is what triggers a reload)
        fs::write(d.join("main.js"), "export const manifest = {id:'d.demo'} // touched").unwrap();
        assert_ne!(scan_at(&root).unwrap()[0].digest, first[0].digest);
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
