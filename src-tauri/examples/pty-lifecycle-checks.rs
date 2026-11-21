//! Native regression checks for the exact PTY backend used by the app.
//! Run: cargo run --offline --manifest-path src-tauri/Cargo.toml --example pty-lifecycle-checks
//! A plain-thread deadline detects executor starvation instead of timing out on
//! the same executor being tested. No GUI or user-configured jobs are started.

use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};
use tauri::async_runtime::TokioRuntime;
use tauri_plugin_pty::backend::{diagnostics, Session, SpawnOptions, MAX_QUEUED_BYTES};

fn spawn(runtime: &TokioRuntime, command: &str) -> Arc<Session> {
    spawn_program(
        runtime,
        "cmd.exe".into(),
        vec!["/D".into(), "/C".into(), command.into()],
    )
}

fn spawn_program(runtime: &TokioRuntime, file: String, args: Vec<String>) -> Arc<Session> {
    let (tx, rx) = mpsc::channel();
    runtime.spawn_blocking(move || {
        let result = Session::spawn(SpawnOptions {
            file,
            args,
            cols: 80,
            rows: 24,
            ..Default::default()
        });
        let _ = tx.send(result);
    });
    Arc::new(
        rx.recv_timeout(Duration::from_secs(10))
            .expect("PTY spawn stalled")
            .unwrap(),
    )
}

fn read_all(
    runtime: &TokioRuntime,
    session: Arc<Session>,
) -> mpsc::Receiver<Result<Vec<u8>, String>> {
    read_until(runtime, session, None)
}

fn read_until(
    runtime: &TokioRuntime,
    session: Arc<Session>,
    marker: Option<&'static str>,
) -> mpsc::Receiver<Result<Vec<u8>, String>> {
    let (tx, rx) = mpsc::channel();
    let handle = runtime.handle().clone();
    runtime.spawn(async move {
        let mut output = Vec::new();
        let mut answered = false;
        loop {
            match session.read().await {
                Ok(bytes) => {
                    // Scan new bytes plus a possible split query, not the whole
                    // growing output on every 4 KiB read (quadratic at 8 MiB).
                    let query_start = output.len().saturating_sub(3);
                    output.extend_from_slice(&bytes);
                    if !answered && output[query_start..].windows(4).any(|s| s == b"\x1b[6n") {
                        answered = true;
                        let writer = session.clone();
                        // A buffered startup query may be observed after an
                        // overflow already closed the process. Like the JS
                        // transport, tolerate a late cursor-response write.
                        let _ = handle
                            .spawn_blocking(move || writer.write(b"\x1b[1;1R"))
                            .await
                            .unwrap();
                    }
                    if marker.is_some_and(|marker| contains(&output, marker)) {
                        let _ = tx.send(Ok(output));
                        return;
                    }
                }
                Err(e) if e == "EOF" || e.contains("Input/output error") => {
                    let _ = tx.send(Ok(output));
                    return;
                }
                Err(e) => {
                    let _ = tx.send(Err(e));
                    return;
                }
            }
        }
    });
    rx
}

fn status(runtime: &TokioRuntime, session: Arc<Session>) -> mpsc::Receiver<Result<u32, String>> {
    let (tx, rx) = mpsc::channel();
    runtime.spawn(async move {
        let _ = tx.send(session.exitstatus().await);
    });
    rx
}

fn receive<T>(receiver: mpsc::Receiver<T>, session: &Session) -> T {
    match receiver.recv_timeout(Duration::from_secs(10)) {
        Ok(value) => value,
        Err(e) => fail(session, &format!("PTY lifecycle stalled: {e}")),
    }
}

fn fail(session: &Session, reason: &str) -> ! {
    // Capture before stop clears the unread queue and wakes native cleanup.
    let state = session.diagnostics();
    let native = diagnostics();
    let stopped = session.kill();
    panic!("{reason}; session: {state:?}; native: {native:?}; stop: {stopped:?}");
}

fn idle() {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let state = diagnostics();
        if state.readers == 0 && state.waiters == 0 && state.consoles == 0 {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "native resources leaked: {state:?}"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn contains(output: &[u8], marker: &str) -> bool {
    output.windows(marker.len()).any(|s| s == marker.as_bytes())
}

// The same executable is a finite, bulk-writing producer. A ready/go exchange
// lets the parent service the actual ConPTY cursor query before abandoning reads.
fn produce_overflow(delay: Duration) -> io::Result<()> {
    let mut output = io::stdout().lock();
    writeln!(output, "PTY_PRODUCER_READY")?;
    output.flush()?;
    let mut go = String::new();
    io::stdin().read_line(&mut go)?;
    assert_eq!(go.trim(), "go");
    thread::sleep(delay);
    let block =
        b"PTY_OVERFLOW_012345678901234567890123456789012345678901234567890123\r\n".repeat(1024);
    for _ in 0..256 {
        output.write_all(&block)?;
    }
    output.flush()
}

fn check_overflow(runtime: &TokioRuntime, delay: Duration) {
    let session = spawn_program(
        runtime,
        std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        vec![
            "--pty-overflow-producer".into(),
            delay.as_millis().to_string(),
        ],
    );
    let ready = read_until(runtime, session.clone(), Some("PTY_PRODUCER_READY"));
    assert!(contains(
        &receive(ready, &session).unwrap(),
        "PTY_PRODUCER_READY"
    ));
    let writer = session.clone();
    runtime
        .block_on(runtime.spawn_blocking(move || writer.write(b"go\r")))
        .unwrap()
        .unwrap();

    // Generation speed belongs to the producer budget, not the cleanup budget.
    // No consumer reads after ready, so this exercises the real 8 MiB limit.
    let started = Instant::now();
    let produce_deadline = started + Duration::from_secs(60);
    loop {
        let state = session.diagnostics();
        assert!(
            state.queued_bytes <= MAX_QUEUED_BYTES,
            "queue exceeded its bound: {state:?}"
        );
        if state.overflowed {
            println!(
                "INFO: unread overflow after {:?}; {state:?}",
                started.elapsed()
            );
            break;
        }
        if state.process_exited || state.output_closed {
            fail(&session, "producer ended before unread output overflowed");
        }
        if Instant::now() >= produce_deadline {
            fail(
                &session,
                "producer did not reach the unread output limit within 60s",
            );
        }
        thread::sleep(Duration::from_millis(10));
    }
    let cleanup_started = Instant::now();
    let cleanup_deadline = cleanup_started + Duration::from_secs(10);
    loop {
        let state = diagnostics();
        if state.readers == 0 && state.waiters == 0 && state.consoles == 0 {
            break;
        }
        if Instant::now() >= cleanup_deadline {
            fail(
                &session,
                "overflow triggered but native cleanup stalled for 10s",
            );
        }
        thread::sleep(Duration::from_millis(10));
    }
    let state = session.diagnostics();
    assert!(
        state.output_closed && state.process_exited,
        "incomplete native cleanup: {state:?}"
    );
    assert!(
        state.termination_error.is_none(),
        "native termination failed: {state:?}"
    );
    println!(
        "INFO: overflow cleanup completed in {:?}",
        cleanup_started.elapsed()
    );
    let reading = read_all(runtime, session.clone());
    let waiting = status(runtime, session.clone());
    let error = match receive(reading, &session) {
        Err(error) => error,
        Ok(output) => panic!("expected overflow, got {} output bytes", output.len()),
    };
    assert!(
        error.contains("8 MiB unread buffer"),
        "unexpected overflow result: {error}"
    );
    let _ = receive(waiting, &session).unwrap();
    idle();
    println!("PASS: unread output is bounded; overflow reports an error and reaps the producer");
}

fn main() {
    if !cfg!(windows) {
        println!("SKIP: Windows ConPTY regression checks");
        return;
    }
    let mut args = std::env::args().skip(1);
    let mode = args.next();
    let delay = Duration::from_millis(args.next().map(|s| s.parse().unwrap()).unwrap_or(0));
    if mode.as_deref() == Some("--pty-overflow-producer") {
        produce_overflow(delay).unwrap();
        return;
    }
    // Set before creating any threads. Four workers make the original defect
    // fail quickly; 40 rounds also exceed this machine's 20 logical processors.
    std::env::set_var("TOKIO_WORKER_THREADS", "4");
    let runtime = TokioRuntime::new().unwrap();
    if mode.as_deref() == Some("--overflow-only") {
        check_overflow(&runtime, delay);
        return;
    }
    assert!(mode.is_none(), "unknown check mode: {mode:?}");
    let beat = Arc::new(AtomicUsize::new(0));
    let done = Arc::new(AtomicBool::new(false));
    let poke_handle = runtime.handle().clone();
    let poke_beat = beat.clone();
    let poke_done = done.clone();
    let poker = thread::spawn(move || {
        while !poke_done.load(Ordering::SeqCst) {
            let beat = poke_beat.clone();
            poke_handle.spawn(async move {
                beat.fetch_add(1, Ordering::SeqCst);
            });
            thread::sleep(Duration::from_millis(10));
        }
    });

    for round in 0..40 {
        let session = spawn(&runtime, "echo PTY_SHORT_MARKER");
        let reading = read_all(&runtime, session.clone());
        let waiting = status(&runtime, session.clone());
        let output = receive(reading, &session).unwrap();
        assert_eq!(receive(waiting, &session).unwrap(), 0);
        assert!(
            contains(&output, "PTY_SHORT_MARKER"),
            "missing output on round {round}"
        );
        idle();
    }
    println!(
        "PASS: 40 short processes; readers/waiters/consoles returned to zero after every round"
    );

    let mut concurrent = Vec::new();
    for _ in 0..12 {
        let session = spawn(&runtime, "set /p PTY_INPUT= & echo PTY_INPUT_DONE");
        let reading = read_all(&runtime, session.clone());
        let waiting = status(&runtime, session.clone());
        concurrent.push((session, reading, waiting));
    }
    let before = beat.load(Ordering::SeqCst);
    thread::sleep(Duration::from_millis(250));
    assert!(
        beat.load(Ordering::SeqCst) > before + 5,
        "idle PTYs starved the runtime"
    );
    for (session, reading, waiting) in concurrent {
        let writer = session.clone();
        runtime
            .block_on(runtime.spawn_blocking(move || {
                writer.resize(120, 40)?;
                writer.write(b"hello\r")
            }))
            .unwrap()
            .unwrap();
        assert!(contains(
            &receive(reading, &session).unwrap(),
            "PTY_INPUT_DONE"
        ));
        assert_eq!(receive(waiting, &session).unwrap(), 0);
    }
    idle();
    println!("PASS: 12 concurrent interactive PTYs on 4 workers; heartbeat, input and resize work");

    let session = spawn(
        &runtime,
        "(for /L %i in (1,1,4000) do @echo PTY_ROW_%i) & echo PTY_TAIL_MARKER",
    );
    let reading = read_all(&runtime, session.clone());
    let waiting = status(&runtime, session.clone());
    let output = receive(reading, &session).unwrap();
    assert_eq!(receive(waiting, &session).unwrap(), 0);
    assert!(
        output.len() > 4096
            && contains(&output, "PTY_ROW_4000")
            && contains(&output, "PTY_TAIL_MARKER")
    );
    idle();
    println!("PASS: output larger than one read retains its final row and tail marker");

    // Recreate the page-gone case: a read future is cancelled, no frontend
    // drives further reads, then the host's plain-thread stop callback runs.
    let session = spawn(&runtime, "set /p PTY_INPUT=");
    let reading = session.clone();
    let abandoned = runtime.spawn(async move {
        let _ = reading.read().await;
    });
    abandoned.abort();
    let waiting = status(&runtime, session.clone());
    session.stop_callback()();
    let _ = receive(waiting, &session).unwrap();
    idle();
    println!("PASS: cancelled read and absent frontend do not prevent stop or native cleanup");

    // Termination must also work if the output consumer is absent entirely.
    let session = spawn(&runtime, "set /p PTY_INPUT=");
    let waiting = status(&runtime, session.clone());
    session.kill().unwrap();
    let _ = receive(waiting, &session).unwrap();
    session.kill().unwrap();
    idle();
    println!("PASS: stopping without any read is idempotent and reaps the native session");

    let session = spawn(&runtime, "set /p PTY_INPUT=");
    drop(session);
    idle();
    println!("PASS: abandoning a spawn response reaps its otherwise unreachable process");

    // A vanished output consumer must not turn continuous native reads into
    // an unbounded queue, or block ClosePseudoConsole behind backpressure.
    check_overflow(&runtime, Duration::ZERO);

    done.store(true, Ordering::SeqCst);
    poker.join().unwrap();
    assert!(beat.load(Ordering::SeqCst) > 0);
    runtime.shutdown_timeout(Duration::from_secs(2));
    println!("PASS: final native state {:?}", diagnostics());
}
