//! Headless checks for native protocol and service behavior.
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

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use toolkit_lib::protocol::codec::{json_envelope, line_json, raw_binary};
use toolkit_lib::protocol::envelope::{Envelope, Kind};
use toolkit_lib::protocol::codes;
use toolkit_lib::services::{external, hotkey, schema, session, storage, stream, table, ServiceError};

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

fn binary_checks() {
    use toolkit_lib::binary_ipc::{decode_fallback, TransferKey, Transfers, MAX_CHUNK_BYTES, MAX_TRANSFER_BYTES};

    let store = Transfers::default();
    let key = TransferKey { window: "main".into(), plugin: "test.bytes".into(), id: "transfer".into() };
    let payload: Vec<u8> = (0..2 * 1024 * 1024 + 17).map(|i| (i % 251) as u8).collect();
    store.open(key.clone(), payload.len()).unwrap();
    for (index, chunk) in payload.chunks(MAX_CHUNK_BYTES).enumerate() {
        let offset = index * MAX_CHUNK_BYTES;
        assert_eq!(store.write(&key, offset, chunk).unwrap(), offset + chunk.len());
    }
    let mut read = Vec::new();
    while read.len() < payload.len() {
        let chunk = store.read(&key, read.len(), MAX_CHUNK_BYTES).unwrap();
        assert!(!chunk.is_empty());
        read.extend(chunk);
    }
    check("binary-roundtrip", read == payload, "2 MiB and a partial final chunk arrive intact");
    check(
        "binary-offset-and-replay",
        store.open(key.clone(), payload.len()).is_ok()
            && store.write(&key, 0, &payload[..MAX_CHUNK_BYTES]).ok() == Some(payload.len())
            && store.write(&key, 0, &[255]).unwrap_err().code == "conflict"
            && store.read(&key, payload.len(), MAX_CHUNK_BYTES).unwrap().is_empty(),
        "reopening preserves bytes and replay does not append or overwrite",
    );
    let other_window = TransferKey { window: "plugin-other".into(), ..key.clone() };
    let other_plugin = TransferKey { plugin: "test.other".into(), ..key.clone() };
    store.open(other_window.clone(), 10).unwrap();
    check(
        "binary-owner-and-close",
        store.write(&other_window, 2, &[1]).unwrap_err().code == "conflict"
            && store.read(&other_plugin, 0, 1).unwrap_err().code == "not_found"
            && store.read(&other_window, 0, MAX_CHUNK_BYTES + 1).unwrap_err().code == "bad_params"
            && store.write(&other_window, 9, &[1, 2]).unwrap_err().code == "bad_params"
            && !store.close(&other_plugin),
        "owner, offset and size checks prevent cross-talk and out-of-range access",
    );
    store.close_window("main");
    check(
        "binary-window-cleanup",
        store.read(&key, 0, 1).unwrap_err().code == "not_found"
            && store.read(&other_window, 0, 1).is_ok()
            && store.close(&other_window) && !store.close(&other_window),
        "a destroyed window releases its own buffers and close is idempotent",
    );
    for i in 0..4 {
        store.open(TransferKey { id: i.to_string(), ..key.clone() }, MAX_TRANSFER_BYTES).unwrap();
    }
    check(
        "binary-reservation-budget",
        store.open(key.clone(), 1).unwrap_err().code == "conflict"
            && store.open(key.clone(), MAX_TRANSFER_BYTES + 1).unwrap_err().code == "bad_params",
        "global budget accounts for declared size before data arrives",
    );
    store.close_window("main");
    check("binary-budget-released", store.open(key, MAX_TRANSFER_BYTES).is_ok(), "cleanup releases reserved capacity");
    check(
        "binary-fallback-validation",
        decode_fallback(&json!([0, 128, 255])).unwrap() == [0, 128, 255]
            && decode_fallback(&json!([256])).is_err()
            && decode_fallback(&json!(["7"])).is_err()
            && decode_fallback(&json!([7.5])).is_err()
            && decode_fallback(&json!(vec![0; MAX_CHUNK_BYTES + 1])).is_err(),
        "postMessage payloads accept only bounded integer byte arrays",
    );
    check("schema-binary-transfer", schema()["binaryTransfer"]["maxChunkBytes"] == MAX_CHUNK_BYTES,
        "schema publishes the native block limit");
}

#[cfg(windows)]
fn sidecar_output_check() {
    use std::{fs, path::PathBuf, time::{Duration, Instant}};
    use toolkit_lib::services::proc::dispatch_at;

    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("fixture");
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("plugin.json"), r#"{"id":"test.stdout","entry":"main.js"}"#).unwrap();
    fs::write(dir.join("main.js"), "export default {};").unwrap();
    let cmd = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/cmd.exe");
    fs::copy(cmd, dir.join("cmd.exe")).unwrap();
    fs::write(dir.join("lines.txt"), "\r\n".repeat(20_000)).unwrap();
    fs::write(dir.join("oversize.txt"), vec![b'x'; (1 << 20) + 1]).unwrap();
    let call = |action, params| dispatch_at(root.path(), "test.stdout", action, params);
    call("spawn", json!({"key":"test", "exe":"cmd.exe", "args":["/d", "/q", "/c",
        "type lines.txt & echo ready>ready.txt & type oversize.txt & pause >nul"]})).unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    while !dir.join("ready.txt").exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let first = call("recv", json!({"key":"test", "timeoutMs":100}));
    let bounded = first.as_ref().is_ok_and(|reply| reply["dropped"].as_u64().unwrap_or(0) > 0);
    let mut terminal = first.err();
    while terminal.is_none() && Instant::now() < deadline {
        terminal = call("recv", json!({"key":"test", "timeoutMs":100})).err();
    }
    let retired = session::list(Some("test.stdout")).is_empty();
    let _ = call("kill_all", json!({}));
    check("sidecar-empty-lines-are-bounded", bounded, "a burst of blank lines hits the queue limit");
    check(
        "sidecar-oversize-is-terminal",
        terminal.is_some_and(|error| error.code == "io" && error.msg.contains("line too long")) && retired,
        "oversized stdout reports an error and reaps the failed process",
    );
}

fn clipboard_and_checksum_checks() {
    use std::io::Write;
    use toolkit_lib::services::{checksum, clipboard};

    let rgba = [255, 0, 0, 255, 0, 255, 0, 128];
    let input = arboard::ImageData { width: 2, height: 1, bytes: rgba.as_slice().into() };
    let png = clipboard::encode_image(&input).unwrap();
    let decoded = image::load_from_memory_with_format(&png, image::ImageFormat::Png).unwrap().to_rgba8();
    check("clipboard-image-png", decoded.dimensions() == (2, 1) && decoded.as_raw() == &rgba,
        "PNG bytes preserve color and alpha");

    let mut file = tempfile::NamedTempFile::new().unwrap();
    let mut block = vec![0; 1024 * 1024];
    for byte in 0..17 {
        block.fill(byte);
        file.write_all(&block).unwrap();
    }
    file.write_all(&[42, 128, 255]).unwrap();
    file.flush().unwrap();
    let checksum = checksum::sha256(file.path()).unwrap();
    check(
        "checksum-over-memory-session-limit",
        checksum.size == 17 * 1024 * 1024 + 3
            && checksum.sha256 == "de7dd9d102dd7ce7b9e52ea7a6c840d89287b0699315e65b56ef98d808936bbb",
        "native streaming SHA-256 includes the partial final block of a 17 MiB file",
    );
}

fn file_checks() {
    use std::{fs, io::{Seek, SeekFrom, Write}};
    use toolkit_lib::{binary_ipc::{TransferKey, MAX_CHUNK_BYTES}, file_ipc::FileHandles};

    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("result.bin");
    let handles = FileHandles::default();
    let key = |window: &str, id: &str| TransferKey { window: window.into(), plugin: "test.files".into(), id: id.into() };
    let output = key("main", "writer");
    let input = key("main", "reader");
    let source = root.path().join("source.bin");
    let tail = 17 * 1024 * 1024 + 9;
    {
        let mut file = fs::File::create(&source).unwrap();
        file.write_all(b"begin").unwrap();
        file.seek(SeekFrom::Start(tail)).unwrap();
        file.write_all(b"tail").unwrap();
    }
    handles.reserve(input.clone()).unwrap().reader(&source).unwrap();
    check("fs-large-random-read",
        handles.read_at(&input, tail, 8).unwrap() == b"tail"
            && handles.read_at(&input, 0, 5).unwrap() == b"begin"
            && handles.read_at(&input, tail + 4, 8).unwrap().is_empty()
            && handles.read_at(&input, 0, MAX_CHUNK_BYTES + 1).is_err()
            && handles.read_at(&key("plugin-other", "reader"), 0, 8).unwrap_err().code == "not_found",
        "bounded random reads and EOF over a file larger than 16 MiB, scoped to its window");

    handles.reserve(output.clone()).unwrap().writer(&target).unwrap();
    let mut offset = 0;
    loop {
        let chunk = handles.read_at(&input, offset, MAX_CHUNK_BYTES).unwrap();
        if chunk.is_empty() {
            break;
        }
        offset = handles.write(&output, offset, &chunk).unwrap();
    }
    handles.commit(&output).unwrap();
    check(
        "fs-large-copy",
        offset == tail + 4
            && toolkit_lib::services::checksum::sha256(&source).unwrap().sha256
                == toolkit_lib::services::checksum::sha256(&target).unwrap().sha256,
        "sequential reads and writes copy a file larger than 16 MiB without a byte session",
    );
    handles.close(&output);
    assert!(handles.close(&input));
    assert!(!handles.close(&input));

    fs::write(&target, b"original").unwrap();
    handles.reserve(output.clone()).unwrap().writer(&target).unwrap();
    handles.write(&output, 0, b"discard").unwrap();
    handles.close(&output);
    check("fs-close-discards-staging", fs::read(&target).unwrap() == b"original"
        && fs::read_dir(root.path()).unwrap().count() == 2, "closing leaves the original and removes the temporary file");

    handles.reserve(output.clone()).unwrap().writer(&target).unwrap();
    handles.write(&output, 0, b"edited").unwrap();
    check("fs-write-replay",
        handles.write(&output, 0, b"edited").unwrap() == 6
            && handles.write(&output, 0, b"bad").unwrap_err().code == "conflict"
            && fs::read(&target).unwrap() == b"original", "replay preserves offset and writes stay staged");
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let held = fs::OpenOptions::new().read(true).share_mode(1).open(&target).unwrap();
        check("fs-blocked-replacement", handles.commit(&output).unwrap_err().code == "io"
            && fs::read(&target).unwrap() == b"original", "Windows file sharing failure preserves target");
        drop(held);
    }
    handles.commit(&output).unwrap();
    handles.commit(&output).unwrap();
    check("fs-commit-retry", fs::read(&target).unwrap() == b"edited", "commit can be retried and acknowledged again");
    handles.close(&output);

    let new = root.path().join("new.bin");
    handles.reserve(output.clone()).unwrap().writer(&new).unwrap();
    handles.write(&output, 0, b"staged").unwrap();
    fs::write(&new, b"external").unwrap();
    check("fs-target-conflict", handles.commit(&output).unwrap_err().code == "conflict"
        && fs::read(&new).unwrap() == b"external", "a file created after selection is not overwritten");
    handles.close(&output);

    let pending = handles.reserve(input.clone()).unwrap();
    handles.close(&input);
    handles.reserve(input.clone()).unwrap().reader(&source).unwrap();
    check("fs-late-selection", pending.reader(&source).unwrap_err().code == "not_found"
        && handles.read_at(&input, tail, 4).unwrap() == b"tail", "a closed reservation cannot publish or remove a later reference");
    handles.close(&input);

    let max = schema()["fileAccess"]["maxHandles"].as_u64().unwrap();
    let reservations: Vec<_> = (0..max).map(|i| {
        let key = key("main", &format!("pending-{i}"));
        let pending = handles.reserve(key.clone()).unwrap();
        handles.close(&key);
        pending
    }).collect();
    check("fs-handle-budget", handles.reserve(input.clone()).is_err(), "cancelled but pending dialogs still count against the budget");
    drop(reservations);
    check("fs-budget-released", handles.reserve(input).is_ok(), "completed dialog cleanup releases the budget");
}

fn main() {
    println!("--- host-checks ---");
    binary_checks();
    clipboard_and_checksum_checks();
    file_checks();
    #[cfg(windows)]
    sidecar_output_check();

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
        names == vec![
            "storage",
            "host",
            "proc",
            "stream",
            "bus",
            "hotkey",
            "notify",
            "clipboard",
            "screen",
        ],
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
        agrees && sch["protocol"] == json!(1) && sch["providers"] == json!(["ticker", "blob", "clipboard"]),
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

    // Byte actions are a SECOND list, and the two must stay disjoint: an action
    // that answered both ways would make "which encoding is this?" depend on how
    // the caller asked — the ambiguity that got the base64 capture removed.
    let both: Vec<(&str, &str)> = table()
        .iter()
        .flat_map(|s| {
            s.binary_actions()
                .iter()
                .filter(|a| s.actions().contains(a))
                .map(move |a| (s.name(), *a))
        })
        .collect();
    check(
        "byte-actions-are-disjoint",
        both.is_empty(),
        &format!("declared as both JSON and bytes: {both:?}"),
    );
    check(
        "schema-publishes-byte-actions",
        sch["binaryActions"] == json!({ "screen": ["capture"], "clipboard": ["readImage"] })
            && !sch["services"]["screen"]
                .as_array()
                .map(|a| a.contains(&json!("capture")))
                .unwrap_or(true),
        &format!("binaryActions={}", sch["binaryActions"]),
    );

    // ---- stream providers ----
    let providers = stream::providers().iter().map(|p| p.name()).collect::<Vec<_>>();
    check(
        "stream-providers",
        providers == vec!["ticker", "blob", "clipboard"],
        &format!("{providers:?}"),
    );
    // A provider that reads something more sensitive than "a stream" declares
    // its own permission, and the schema has to say so — otherwise a plugin
    // discovers it by being denied.
    check(
        "provider-permissions-are-published",
        sch["providerPermissions"]["clipboard"] == json!("rpc:clipboard")
            && sch["providerPermissions"].get("ticker").is_none(),
        "only providers that need one appear, and they name it",
    );

    // ---- gateway bookkeeping (the "why is the UI dead" diagnostic) ----
    //
    // The numbers only mean something if they are accurate: `inFlight == 0`
    // while every call times out is the signature of "the request never
    // arrived", which is a completely different bug from a stuck service.
    {
        let (before, oldest_before) = toolkit_lib::gateway_stats::snapshot();
        let ticket = toolkit_lib::gateway_stats::enter("check/diag");
        let (during, oldest_during) = toolkit_lib::gateway_stats::snapshot();
        drop(ticket);
        let (after, oldest_after) = toolkit_lib::gateway_stats::snapshot();

        check(
            "gateway-stats-count-in-flight",
            during == before + 1 && after == before,
            &format!("{before} -> {during} -> {after}"),
        );
        let during_what = oldest_during.as_ref().map(|(_, w)| w.clone());
        let during_ms = oldest_during.as_ref().map(|(ms, _)| *ms);
        check(
            "gateway-stats-name-the-oldest",
            during_what.as_deref() == Some("check/diag"),
            &format!("{:?}", oldest_during),
        );
        check(
            "gateway-stats-clear-when-idle",
            after == 0 || oldest_after.is_some(),
            &format!("{after} in flight, oldest {:?}", oldest_after),
        );
        // Age is the number that says "this one has been stuck for hours".
        // Measured with a real sleep, because a just-started call is legitimately
        // 0ms old — asserting `> 0` there tests the clock's resolution, not us.
        let slow = toolkit_lib::gateway_stats::enter("check/slow");
        std::thread::sleep(std::time::Duration::from_millis(30));
        let aged = toolkit_lib::gateway_stats::snapshot().1.map(|(ms, _)| ms).unwrap_or(0);
        drop(slow);
        check(
            "gateway-stats-age-is-measured",
            aged >= 25,
            &format!("after a 30ms call the oldest reports {aged}ms"),
        );
        let _ = (oldest_before, during_ms);
    }

    // Overlapping calls can complete out of order. The oldest live request
    // must advance even when the gateway never becomes completely idle.
    {
        let first = toolkit_lib::gateway_stats::enter("check/first");
        let second = toolkit_lib::gateway_stats::enter("check/second");
        drop(first);
        let (count, oldest) = toolkit_lib::gateway_stats::snapshot();
        check(
            "gateway-stats-advance-past-a-completed-request",
            count == 1 && oldest.as_ref().map(|(_, name)| name.as_str()) == Some("check/second"),
            &format!("{count} live, oldest={oldest:?}"),
        );
        drop(second);
    }

    {
        let first = toolkit_lib::gateway_stats::enter("check/same");
        let second = toolkit_lib::gateway_stats::enter("check/same");
        second.mark("returned");
        let first_name = toolkit_lib::gateway_stats::snapshot().1.map(|(_, name)| name);
        first.mark("running");
        let first_phase = toolkit_lib::gateway_stats::snapshot().1.map(|(_, name)| name);
        drop(first);
        let second_phase = toolkit_lib::gateway_stats::snapshot().1.map(|(_, name)| name);
        drop(second);
        check(
            "gateway-stats-phases-belong-to-request-tickets",
            first_name.as_deref() == Some("check/same")
                && first_phase.as_deref() == Some("check/same[running]")
                && second_phase.as_deref() == Some("check/same[returned]"),
            &format!("first={first_name:?} -> {first_phase:?}, then second={second_phase:?}"),
        );
    }
    {
        let caller = Arc::new(toolkit_lib::gateway_stats::enter("check/cancelled"));
        let native_task = caller.clone();
        drop(caller);
        native_task.mark("returned");
        let during = toolkit_lib::gateway_stats::snapshot();
        drop(native_task);
        let after = toolkit_lib::gateway_stats::snapshot();
        check(
            "gateway-stats-native-work-outlives-a-cancelled-caller",
            during.0 == 1
                && during.1.as_ref().map(|(_, name)| name.as_str()) == Some("check/cancelled[returned]")
                && after == (0, None),
            &format!("during={during:?}, after={after:?}"),
        );
    }
    {
        const WORKERS: usize = 8;
        let entered = Arc::new(std::sync::Barrier::new(WORKERS + 1));
        let release = Arc::new(std::sync::Barrier::new(WORKERS + 1));
        let mut workers = Vec::new();
        for worker in 0..WORKERS {
            let entered = entered.clone();
            let release = release.clone();
            workers.push(std::thread::spawn(move || {
                let ticket = toolkit_lib::gateway_stats::enter(format!("check/worker.{worker}"));
                ticket.mark("running");
                entered.wait();
                release.wait();
            }));
        }
        entered.wait();
        let during = toolkit_lib::gateway_stats::snapshot();
        release.wait();
        for worker in workers {
            worker.join().unwrap();
        }
        let after = toolkit_lib::gateway_stats::snapshot();
        check(
            "gateway-stats-concurrent-tickets-are-reaped",
            during.0 == WORKERS
                && during.1.as_ref().is_some_and(|(_, name)| name.ends_with("[running]"))
                && after == (0, None),
            &format!("during={during:?}, after={after:?}"),
        );
    }

    // ---- UI heartbeat (what makes a wedged UI visible in the log) ----
    //
    // The host writes the evidence itself when the UI stops calling, so the
    // numbers have to be real: `silent_ms` must grow with wall clock and reset
    // on the next call.
    {
        toolkit_lib::ui_heartbeat::touch();
        let just_touched = toolkit_lib::ui_heartbeat::silent_ms();
        std::thread::sleep(std::time::Duration::from_millis(30));
        let after = toolkit_lib::ui_heartbeat::silent_ms();
        toolkit_lib::ui_heartbeat::touch();
        let reset = toolkit_lib::ui_heartbeat::silent_ms();
        check(
            "ui-heartbeat-counts-silence",
            just_touched <= 5 && after >= 25,
            &format!("touch->{just_touched}ms, +30ms->{after}ms"),
        );
        check(
            "ui-heartbeat-resets-on-a-call",
            reset <= 5,
            &format!("after a call it reads {reset}ms"),
        );
    }

    // ---- proc locks have a deadline ----
    //
    // Every proc call runs on the async gateway, and a call that waits on a
    // mutex has no deadline of its own: the caller gives up at 45 s, the worker
    // stays parked, and `inFlight` keeps the stuck call forever. The host logged
    // exactly that (`inFlight=2, oldest=Some((188610, "proc/recv"))`) while the
    // UI was dead. So the rule is: a lock is waited for with a budget, and
    // "busy" is a valid answer.
    {
        use std::sync::Mutex;
        use std::time::{Duration, Instant};

        let m = Mutex::new(0u8);
        let held = m.lock().unwrap();
        let t0 = Instant::now();
        let blocked = toolkit_lib::services::proc::lock_within(&m, Duration::from_millis(30));
        let waited = t0.elapsed();
        check(
            "proc-lock-gives-up-instead-of-blocking",
            blocked.is_none() && waited >= Duration::from_millis(25) && waited < Duration::from_millis(600),
            &format!("held lock: got={} after {:?}", blocked.is_some(), waited),
        );
        drop(held);
        check(
            "proc-lock-succeeds-when-free",
            toolkit_lib::services::proc::lock_within(&m, Duration::from_millis(30)).is_some(),
            "a free lock must be taken immediately",
        );
    }

    // ---- the UI recovery ladder ----
    //
    // This is the code that decides to reload or rebuild the window, so its
    // ordering matters more than its thresholds: a rung that fires too early
    // reloads a page that was merely idle, and a rung that fires twice in a row
    // turns a dead bridge into a reload loop. Both are pinned here.
    {
        use toolkit_lib::ui_heartbeat::{action_for, Action};

        check(
            "watchdog-waits-before-acting",
            action_for(0, 0) == Action::None && action_for(59_000, 0) == Action::None,
            "a page that has been quiet for less than a minute is just idle",
        );
        check(
            "watchdog-reloads-first",
            action_for(61_000, 0) == Action::Reload,
            "the cheapest repair comes first",
        );
        check(
            "watchdog-needs-more-silence-for-each-rung",
            // Same silence, later attempt: nothing fires until its own threshold.
            action_for(61_000, 1) == Action::None
                && action_for(181_000, 1) == Action::Recreate
                && action_for(181_000, 2) == Action::None
                && action_for(361_000, 2) == Action::Notify
                && action_for(361_000, 3) == Action::None
                && action_for(601_000, 3) == Action::Restart,
            "each rung waits longer than the previous one",
        );
        check(
            "watchdog-restarts-before-giving-up",
            // 2026-10-29: reload and recreate both failed, and the old ladder
            // went straight to "give up" — which left a healthy host with six
            // dead renderers until someone noticed. A wedged WebView2 browser
            // process is shared by every window, so only a new process clears
            // it, and that has to be a rung.
            action_for(601_000, 3) == Action::Restart && action_for(901_000, 4) == Action::GiveUp,
            "restart is tried after the rebuild fails, before giving up",
        );
        check(
            "watchdog-stops-instead-of-looping",
            action_for(24 * 3_600_000, 5) == Action::None,
            "after giving up it must stay quiet until the UI talks again",
        );
        check(
            "reload-keeps-sessions",
            toolkit_lib::ui_heartbeat::UI_RELOAD_JS.contains("toolbox.keepSessions"),
            "a reload without the flag would reap every live pty and sidecar",
        );
    }

    // ---- window browser args (the 0x8007139F bug) ----
    //
    // WebView2 allows one browser process per user-data folder, and its command
    // line is fixed by the first window. Every window this app creates must
    // therefore inherit the SAME `additionalBrowserArgs`; a window built without
    // them fails with ERROR_INVALID_STATE. The inheritance is one function, so it
    // is pinned here: copying, and a no-op when there is nothing to copy (which
    // is the uniform-defaults case and therefore safe).
    {
        use tauri::utils::config::WindowConfig;

        let mut w = WindowConfig::default();
        toolkit_lib::inherit_browser_args(&mut w, Some("--disable-renderer-backgrounding"));
        check(
            "window-args-are-inherited",
            w.additional_browser_args.as_deref() == Some("--disable-renderer-backgrounding"),
            &format!("{:?}", w.additional_browser_args),
        );

        let mut untouched = WindowConfig::default();
        toolkit_lib::inherit_browser_args(&mut untouched, None);
        check(
            "window-args-stay-none-when-unconfigured",
            untouched.additional_browser_args.is_none(),
            "no configured args means wry's defaults for every window — uniform",
        );
    }

    // ---- provider limits ----
    //
    // Both are "one call wedges the window" limits, and both used to be wide
    // open: a 1 ms ticker is 1000 frames a second forever (every frame costs the
    // host main thread a round trip), and `blob`'s own maxima multiply to 10 GiB
    // emitted with no delay and no backpressure. Pinned here because `cargo
    // test` cannot load in this project — see the file header.
    check(
        "ticker-floor-is-a-display-frame",
        stream::ticker_interval(&json!({ "intervalMs": 1 })) == 16
            && stream::ticker_interval(&json!({ "intervalMs": 300 })) == 300
            && stream::ticker_interval(&Value::Null) == 500,
        &format!(
            "1ms->{} 300ms->{} default->{}",
            stream::ticker_interval(&json!({ "intervalMs": 1 })),
            stream::ticker_interval(&json!({ "intervalMs": 300 })),
            stream::ticker_interval(&Value::Null)
        ),
    );
    check(
        "blob-refuses-a-ten-gigabyte-stream",
        stream::blob_plan(&json!({ "chunks": 8, "chunkBytes": 4096 })).is_ok()
            && stream::blob_plan(&json!({ "chunks": 16, "chunkBytes": 1 << 20 })).is_ok()
            && stream::blob_plan(&json!({ "chunks": 10_000, "chunkBytes": 1 << 20 })).is_err(),
        "8x4KiB ok, 16x1MiB ok, 10000x1MiB refused",
    );

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

    // ---- host/paths: the layout a plugin is told it may rely on ----
    //
    // This is the one place a plugin learns where things are, so what matters is
    // not that three keys exist but that the folders they name are the folders
    // the host itself uses — a path that merely LOOKS right fails silently: the
    // plugin writes, or drops a folder, somewhere nobody reads.
    {
        use std::fs;
        use std::path::Path;
        let root = std::env::temp_dir().join(format!("tb-paths-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let p = storage::paths_at(&root, "a.demo").unwrap();
        check(
            "paths-name-the-documented-layout",
            p["dataDir"] == json!(root.to_string_lossy())
                && p["pluginDataDir"] == json!(root.join("plugin-data").join("a.demo").to_string_lossy())
                && p["pluginsDir"] == json!(root.join("plugins").to_string_lossy()),
            &format!("{p:?}"),
        );

        // The property, checked by BEHAVIOUR rather than by a shared constant:
        // drop a plugin exactly where `paths` said to and the scanner must find
        // it. Two spellings of "plugins" would pass the check above and still
        // never load anything.
        let plugins_dir = Path::new(p["pluginsDir"].as_str().unwrap());
        let dir = plugins_dir.join("a.demo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("plugin.json"), r#"{"id":"a.demo","entry":"main.js"}"#).unwrap();
        fs::write(dir.join("main.js"), "export const manifest={id:'a.demo'}").unwrap();
        check(
            "paths-point-at-the-folder-the-scanner-reads",
            external::scan_at(plugins_dir).unwrap().iter().any(|x| x.id == "a.demo"),
            "a plugin dropped where host/paths says is a plugin the host finds",
        );

        check(
            "paths-go-through-the-plugin-id-guard",
            storage::paths_at(&root, "..").is_err() && storage::paths_at(&root, "").is_err(),
            "the same id guard `storage/*` uses, so no id can escape the data root",
        );

        // Asking is not doing: `storage/*` creates these, a question must not.
        check(
            "paths-create-nothing",
            !root.join("plugin-data").exists(),
            "a question about where files go must not create anything",
        );

        let _ = fs::remove_dir_all(&root);
    }

    // ------------------------------- forensics -------------------------------
    //
    // These checks cover the beacon string parser and classifier only. They do
    // not exercise WebView DOM-to-native title forwarding, which is not yet
    // installed. Missing native markers cannot establish renderer liveness.
    {
        use toolkit_lib::forensics::{classify, parse_beacon};

        check(
            "beacon-parses-through-a-plugin-title",
            // The eye-care plugin retitles its own window, so the marker has to
            // be found wherever the plugin put its text.
            parse_beacon("护眼助手 · 桥接异常 42s #hb:42") == Some(42),
            "a retitled window still yields the counter",
        );
        check(
            "beacon-absent-is-none",
            parse_beacon("Toolkit").is_none() && parse_beacon("#hb:").is_none(),
            "no marker, or a marker with no digits, is not a beacon",
        );
        check(
            "beacon-classify-separates-the-four-cases",
            classify(Some(7), Some(8), 0) == "alive"
                && classify(Some(8), Some(8), 2) == "frozen"
                && classify(None, None, 0) == "no-beacon"
                && classify(None, Some(1), 0) == "unknown",
            "alive / frozen / no-beacon / unknown are four different repairs",
        );

        // The ladder must be able to say "that rung did not work". Without the
        // deadline, a rebuild that produces a page that never boots is logged
        // as a success — which is exactly what happened at 00:24.
        toolkit_lib::forensics::expect_recovery(2, std::time::Duration::from_millis(50));
        let armed = toolkit_lib::forensics::recovery_state();
        std::thread::sleep(std::time::Duration::from_millis(60));
        let expired = toolkit_lib::forensics::recovery_state();
        toolkit_lib::forensics::clear_recovery();
        check(
            "recovery-verification-expires",
            matches!(armed, Some((2, false))) && matches!(expired, Some((2, true))),
            "a rung that is issued and never answered is reported as failed, not as done",
        );
        check(
            "recovery-verification-clears",
            toolkit_lib::forensics::recovery_state().is_none(),
            "clearing stops the next tick from re-reporting an old rung",
        );
    }

    let passed = PASSED.load(Ordering::SeqCst);
    if FAILED.load(Ordering::SeqCst) {
        println!("--- FAILED ({passed} passed) ---");
        std::process::exit(1);
    }
    println!("--- all {passed} checks passed ---");
}
