//! Real-filesystem checks for the storage service, without starting the app.
//! Run: cargo run --offline --manifest-path src-tauri/Cargo.toml --example storage-checks

use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Barrier};
use std::thread;
use toolkit_lib::protocol::codes::code;
use toolkit_lib::services::{storage::dispatch_at, ServiceError};

fn call(root: &Path, plugin: &str, action: &str, params: Value) -> Result<Value, ServiceError> {
    dispatch_at(root, plugin, "storage", action, params)
}

fn concurrent_updates(root: &Path) {
    const WORKERS: usize = 8;
    const ROUNDS: usize = 16;
    let sentinel = "original data ".repeat(1024);
    call(
        root,
        "shared.plugin",
        "set",
        json!({"key": "sentinel", "value": sentinel}),
    )
    .unwrap();
    for worker in 0..WORKERS {
        call(
            root,
            "shared.plugin",
            "set",
            json!({"key": format!("remove.{worker}"), "value": true}),
        )
        .unwrap();
    }

    #[cfg(windows)]
    assert_eq!(
        fs::canonicalize(root.join("plugin-data/shared.plugin")).unwrap(),
        fs::canonicalize(root.join("./plugin-data/Shared.Plugin")).unwrap()
    );
    let finished = Arc::new(AtomicBool::new(false));
    let reader_done = finished.clone();
    let reader_sentinel = sentinel.clone();
    let reader_root = root.to_owned();
    let reader = thread::spawn(move || {
        let mut samples = 0;
        while !reader_done.load(Ordering::SeqCst) {
            assert_eq!(
                call(
                    &reader_root,
                    "shared.plugin",
                    "get",
                    json!({"key": "sentinel"})
                )
                .unwrap(),
                reader_sentinel,
                "a storage reader observed an incomplete replacement"
            );
            samples += 1;
            thread::yield_now();
        }
        samples
    });

    let start = Arc::new(Barrier::new(WORKERS));
    let mut writers = Vec::new();
    for worker in 0..WORKERS {
        let root = if worker % 2 == 0 {
            root.join(".")
        } else {
            root.to_owned()
        };
        let start = start.clone();
        writers.push(thread::spawn(move || {
            let mut errors = Vec::new();
            for round in 0..ROUNDS {
                start.wait();
                for (action, params) in [
                    (
                        "set",
                        json!({"key": format!("{worker}.{round}"), "value": round}),
                    ),
                    ("remove", json!({"key": format!("remove.{worker}")})),
                ] {
                    let plugin = if cfg!(windows) && worker % 2 == 0 {
                        "Shared.Plugin"
                    } else {
                        "shared.plugin"
                    };
                    if let Err(error) = call(&root, plugin, action, params) {
                        errors.push(error);
                    }
                }
            }
            errors
        }));
    }
    let errors: Vec<_> = writers
        .into_iter()
        .flat_map(|t| t.join().unwrap())
        .collect();
    finished.store(true, Ordering::SeqCst);
    let reader_result = reader.join();
    assert!(
        errors.is_empty(),
        "{} concurrent operations failed; first: {:?}",
        errors.len(),
        errors.first()
    );
    assert!(
        reader_result.unwrap() > 0,
        "the storage reader must observe the workload"
    );

    let keys = call(root, "shared.plugin", "keys", Value::Null).unwrap();
    assert_eq!(
        keys.as_array().unwrap().len(),
        WORKERS * ROUNDS + 1,
        "an unrelated update was lost"
    );
    assert_eq!(
        call(root, "shared.plugin", "get", json!({"key": "sentinel"})).unwrap(),
        sentinel
    );
    for worker in 0..WORKERS {
        for round in 0..ROUNDS {
            assert_eq!(
                call(
                    root,
                    "shared.plugin",
                    "get",
                    json!({"key": format!("{worker}.{round}")})
                )
                .unwrap(),
                round
            );
        }
    }
    assert_eq!(
        fs::read_dir(root.join("plugin-data/shared.plugin"))
            .unwrap()
            .count(),
        1,
        "successful writes leave no temporary files"
    );
    println!("PASS concurrent get/set/remove: all keys retained, reads complete JSON");
}

fn read_failures_preserve_data(root: &Path) {
    let dir = root.join("plugin-data/broken.plugin");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("data.json");
    for contents in ["{broken", "[]", "null"] {
        fs::write(&path, contents).unwrap();
        for action in ["get", "keys", "set", "remove"] {
            let error = call(
                root,
                "broken.plugin",
                action,
                json!({"key": "new", "value": 1}),
            )
            .unwrap_err();
            assert_eq!(error.code, code::IO);
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                contents,
                "{action} overwrote a corrupt store"
            );
        }
    }
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    let error = call(root, "broken.plugin", "get", json!({"key": "missing"})).unwrap_err();
    assert_eq!(
        error.code,
        code::IO,
        "an unreadable store is not an empty store"
    );
    assert!(path.is_dir());
    println!("PASS read failures: malformed, non-object and unreadable stores are preserved");
}

#[cfg(windows)]
fn replacement_failure_preserves_data(root: &Path) {
    use std::os::windows::fs::OpenOptionsExt;
    call(
        root,
        "locked.plugin",
        "set",
        json!({"key": "saved", "value": 42}),
    )
    .unwrap();
    let dir = root.join("plugin-data/locked.plugin");
    let path = dir.join("data.json");
    let before = fs::read(&path).unwrap();
    // Permit reads but deny replacement, as another Windows process can do.
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&path)
        .unwrap();
    let error = call(
        root,
        "locked.plugin",
        "set",
        json!({"key": "new", "value": 1}),
    )
    .unwrap_err();
    assert_eq!(error.code, code::IO);
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(
        fs::read_dir(&dir).unwrap().count(),
        1,
        "a failed replacement leaves no temporary file"
    );
    drop(held);
    call(
        root,
        "locked.plugin",
        "set",
        json!({"key": "new", "value": 1}),
    )
    .unwrap();
    assert_eq!(
        call(root, "locked.plugin", "get", json!({"key": "saved"})).unwrap(),
        42
    );
    println!("PASS failed replacement: old file retained, temporary file cleaned, retry works");
}

fn main() {
    let root = tempfile::tempdir().unwrap();
    concurrent_updates(root.path());
    read_failures_preserve_data(root.path());
    #[cfg(windows)]
    replacement_failure_preserves_data(root.path());
    println!("--- all storage checks passed ---");
}
