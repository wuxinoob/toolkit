//! Headless checks for the host's pure logic.
//!
//! Why this is an EXAMPLE and not `#[cfg(test)]` unit tests: on Windows,
//! tauri-build embeds the app manifest into **bin** targets only, so this
//! crate's test binaries have no manifest and Windows binds them to comctl32 v5
//! while the linked code imports v6 symbols — `cargo test` dies at load with
//! `STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)`. Cargo has no `-tests` link-arg
//! kind, and the generic one also applies to bins (which already link the
//! manifest, so a second copy fails with LNK1123), so `build.rs` forwards the
//! resource to `-examples` instead. Hence: the same assertions, run through a
//! target that can actually load.
//!
//! ```text
//! cargo run --manifest-path src-tauri/Cargo.toml --example host-checks
//! ```
//!
//! Exits non-zero if anything fails, so it is usable from a script or CI.

use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use toolbox_lib::protocol::codec::{json_envelope, line_json, raw_binary};
use toolbox_lib::protocol::envelope::{Envelope, Kind};
use toolbox_lib::protocol::codes;
use toolbox_lib::services::{external, hotkey, schema, session, stream, table, ServiceError};

static FAILED: AtomicBool = AtomicBool::new(false);
static PASSED: AtomicU64 = AtomicU64::new(0);

fn check(name: &str, ok: bool, detail: &str) {
    if ok {
        PASSED.fetch_add(1, Ordering::SeqCst);
        println!("PASS {name}: {detail}");
    } else {
        FAILED.store(true, Ordering::SeqCst);
        println!("FAIL {name}: {detail}");
    }
}

fn main() {
    println!("--- host-checks ---");

    // ---- protocol: envelope rules ----
    check(
        "envelope-shape",
        serde_json::to_value(Envelope::req(7, "storage", "get", json!({ "key": "k" }))).unwrap()
            == json!({ "v": 1, "kind": "req", "id": 7, "svc": "storage", "act": "get", "p": { "key": "k" } }),
        "req serialises to the documented shape",
    );
    check(
        "envelope-omits-empty",
        !json_envelope::encode(&Envelope::end("c")).unwrap().contains("svc"),
        "optional fields stay off the wire",
    );
    let mut bad = Envelope::data("c", json!(null));
    bad.ch = None;
    check(
        "envelope-validate",
        bad.validate().is_err() && Envelope::req(1, "s", "a", json!(null)).validate().is_ok(),
        "per-kind requirements enforced",
    );

    // ---- codecs ----
    let env = Envelope::data("c", json!({ "n": 1 }));
    check(
        "codec-json-line",
        json_envelope::decode(&json_envelope::encode(&env).unwrap()).unwrap() == env
            && line_json::decode_line(&line_json::encode(&env).unwrap()).unwrap() == env,
        "json-envelope and line-json round trip",
    );
    check(
        "codec-raw",
        raw_binary::decode(&raw_binary::encode(Kind::Data, b"hi").unwrap())
            == Some((Kind::Data, &b"hi"[..]))
            && raw_binary::decode(&[0x09, 1]).is_none()
            && raw_binary::decode_code(&raw_binary::encode_code(258)) == Some(258),
        "raw frames round trip, unknown kinds rejected, LE exit codes",
    );

    // ---- service table + schema ----
    //
    // Pinned on purpose, not derived from `table()` — a check that reads the
    // thing it checks cannot notice a service appearing. The intent is "adding
    // or removing a service is a deliberate, reviewable change", so when this
    // fails the answer is to confirm the new entry and update the list, NOT to
    // delete the check. (`notify` was added and this was left stale, which made
    // the whole harness red — and a red harness is one nobody reads.)
    let names = table().iter().map(|s| s.name()).collect::<Vec<_>>();
    check(
        "service-table",
        names == vec!["storage", "host", "proc", "stream", "bus", "hotkey", "notify"],
        &format!("{names:?}"),
    );
    let all_declare = table().iter().all(|s| !s.actions().is_empty());
    check("actions-declared", all_declare, "every service declares its actions");

    let sch = schema();
    let agrees = table()
        .iter()
        .all(|s| sch["services"][s.name()] == json!(s.actions()));
    check(
        "schema-agrees-with-table",
        agrees && sch["protocol"] == json!(1) && sch["providers"] == json!(["ticker", "blob"]),
        &format!(
            "protocol={} services={} providers={}",
            sch["protocol"],
            sch["services"].as_object().map(|m| m.len()).unwrap_or(0),
            sch["providers"]
        ),
    );
    check(
        "schema-lists-hotkey-actions",
        sch["services"]["hotkey"] == json!(["register", "unregister", "unregister_all", "list"]),
        "the new service is discoverable",
    );

    // ---- stream providers ----
    let providers = stream::providers().iter().map(|p| p.name()).collect::<Vec<_>>();
    check("stream-providers", providers == vec!["ticker", "blob"], &format!("{providers:?}"));

    // ---- session registry ----
    session::kill_all();
    let hit = Arc::new(AtomicBool::new(false));
    let h = Arc::clone(&hit);
    session::open(
        "check.plugin",
        "ch1",
        session::SessionKind::Stream,
        None,
        Arc::new(move || h.store(true, Ordering::SeqCst)),
    )
    .unwrap();
    check(
        "session-register",
        session::list(Some("check.plugin")).len() == 1,
        "a session is visible in the unified registry",
    );
    check(
        "session-stop-invokes-closure",
        session::stop_one("check.plugin", "ch1") && hit.load(Ordering::SeqCst),
        "stop runs the closure exactly once",
    );
    check(
        "session-close-without-stop",
        {
            let hit2 = Arc::new(AtomicBool::new(false));
            let h2 = Arc::clone(&hit2);
            session::open(
                "check.plugin",
                "ch2",
                session::SessionKind::Pty,
                Some(4242),
                Arc::new(move || h2.store(true, Ordering::SeqCst)),
            )
            .unwrap();
            session::close("check.plugin", "ch2") && !hit2.load(Ordering::SeqCst)
        },
        "close deregisters without stopping",
    );

    // ---- hotkeys ----
    check(
        "hotkey-parse",
        hotkey::parse_shortcut("ctrl+alt+shift+p").is_ok()
            && hotkey::parse_shortcut("not+a+key").is_err()
            && hotkey::parse_shortcut("").is_err(),
        "shortcut strings validated without touching the OS",
    );
    check(
        "hotkey-topic",
        hotkey::topic_for("greet") == "hotkey:greet",
        "the delivery topic is part of the contract",
    );
    check(
        "hotkey-owner-delegation",
        hotkey::resolve_owner("a.plugin", &json!({})).unwrap() == "a.plugin"
            && hotkey::resolve_owner("__host__", &json!({ "owner": "a.plugin" })).unwrap() == "a.plugin"
            && hotkey::resolve_owner("a.plugin", &json!({ "owner": "b.plugin" })).is_err(),
        "only the host may register on behalf of a plugin",
    );

    // ---- the kill_all ordering trap ----
    session::kill_all();
    let fired = Arc::new(AtomicBool::new(false));
    let f = Arc::clone(&fired);
    session::open(
        "kill.plugin",
        "s1",
        session::SessionKind::Sidecar,
        None,
        Arc::new(move || f.store(true, Ordering::SeqCst)),
    )
    .unwrap();
    let stop = session::take_stop("kill.plugin", "s1");
    check(
        "session-take-stop-returns-the-closure",
        stop.is_some(),
        "the caller receives the stop closure",
    );
    if let Some(stop) = stop {
        stop();
    }
    check(
        "session-take-stop-runs-the-closure",
        fired.load(Ordering::SeqCst),
        "taking then running actually stops it",
    );

    // The WRONG order, which is what proc/kill_all used to do: close() drops the
    // closure, so the subsequent stop_one finds nothing and kills nothing while
    // still reporting success.
    session::open(
        "kill.plugin",
        "s2",
        session::SessionKind::Sidecar,
        None,
        Arc::new(|| {}),
    )
    .unwrap();
    let closed = session::close("kill.plugin", "s2");
    let stopped_after_close = session::stop_one("kill.plugin", "s2");
    check(
        "session-close-then-stop-loses-the-closure",
        closed && !stopped_after_close,
        "why callers that mean to STOP must take, not close",
    );
    session::kill_all();

    // ---- the error vocabulary ----
    let declared = codes::ALL;
    check(
        "codes-declared",
        declared.len() >= 10 && declared.iter().all(|c| codes::is_known(c)),
        &format!("{} codes, all self-consistent", declared.len()),
    );
    check(
        "codes-reject-the-old-svc-act-form",
        !codes::is_known("storage/get") && !codes::is_known("proc/spawn"),
        "a service failure no longer masquerades as a `svc/act` code",
    );
    let produced = [
        ServiceError::bad_params("x"),
        ServiceError::not_found("x"),
        ServiceError::conflict("x"),
        ServiceError::unsupported("x"),
        ServiceError::io("x"),
        ServiceError::spawn_failed("x"),
        ServiceError::internal("x"),
    ];
    check(
        "every-constructor-produces-a-declared-code",
        produced.iter().all(|e| codes::is_known(e.code)),
        "so a caller can branch on any code the host hands out",
    );
    check(
        "schema-advertises-the-uplink-sinks",
        sch["sinks"] == json!(["proc"]),
        "a plugin is told where it may push, instead of guessing",
    );
    check(
        "schema-advertises-the-vocabulary",
        sch["codes"] == json!(codes::ALL),
        "a caller is told the codes instead of guessing at strings",
    );

    // ---- external plugin lookup ----
    //
    // `plugin_info` exists so opening a plugin window does not read every
    // manifest AND every entry file in the plugins directory (see `info_at`).
    // The cost is the reason it exists, so what has to hold is that it answers
    // the SAME question as the scan — a cheaper answer that disagrees would just
    // be a faster bug.
    {
        use std::fs;
        let root = std::env::temp_dir().join(format!("tb-checks-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        // The directory name deliberately differs from the id, which is the case
        // in this repo too (`eyecare.demo/`, `probe.demo/`) and the reason the
        // lookup has to walk the root rather than derive a path from the id.
        let good = root.join("folder-name-is-not-the-id");
        fs::create_dir_all(&good).unwrap();
        fs::write(good.join("plugin.json"), r#"{"id":"a.demo","entry":"main.js"}"#).unwrap();
        fs::write(good.join("main.js"), "export const manifest={id:'a.demo'}").unwrap();

        let scan = external::scan_at(&root).unwrap();
        let info = external::info_at(&root, "a.demo").unwrap();
        check(
            "plugin-info-agrees-with-scan",
            info.as_ref().map(|i| (i.id.as_str(), i.dir.as_str(), i.entry_file.as_str()))
                == scan.first().map(|p| (p.id.as_str(), p.dir.as_str(), p.entry_file.as_str())),
            "one lookup resolves the same plugin to the same place as a full scan",
        );
        check(
            "plugin-info-misses-are-none-not-an-error",
            external::info_at(&root, "nope.demo").unwrap().is_none(),
            "an unknown id is a plain miss, so a window can report it instead of failing",
        );

        // An entry that cannot be READ is not a plugin `scan_at` reports, so the
        // lookup must not hand one out either — a window given that directory
        // could not load anything from it. A directory is the portable way to
        // make `fs::read` fail while the path still exists.
        fs::remove_file(good.join("main.js")).unwrap();
        fs::create_dir(good.join("main.js")).unwrap();
        check(
            "plugin-info-honours-the-loadability-rule",
            external::info_at(&root, "a.demo").unwrap().is_none()
                && external::scan_at(&root).unwrap().is_empty(),
            "a plugin whose entry cannot be read is invisible to both",
        );

        let _ = fs::remove_dir_all(&root);
    }

    let passed = PASSED.load(Ordering::SeqCst);
    if FAILED.load(Ordering::SeqCst) {
        println!("--- FAILED ({passed} passed) ---");
        std::process::exit(1);
    }
    println!("--- all {passed} checks passed ---");
}
