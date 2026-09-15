//! Headless checks for the host's pure logic.
//!
//! `cargo test` needs the test harness to load, which is unreliable in some
//! locked-down environments; a normal binary target is not. This runs the same
//! assertions as the unit tests through a plain executable, so the host's
//! protocol, service table, session registry and hotkey bookkeeping can still be
//! verified — and it doubles as a quick smoke check on a new machine:
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
use toolbox_lib::services::{hotkey, schema, session, stream, table};

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
    let names = table().iter().map(|s| s.name()).collect::<Vec<_>>();
    check(
        "service-table",
        names == vec!["storage", "host", "proc", "stream", "bus", "hotkey"],
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

    let passed = PASSED.load(Ordering::SeqCst);
    if FAILED.load(Ordering::SeqCst) {
        println!("--- FAILED ({passed} passed) ---");
        std::process::exit(1);
    }
    println!("--- all {passed} checks passed ---");
}
