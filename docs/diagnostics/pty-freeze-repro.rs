//! Windows-only diagnostic for tauri-plugin-pty 0.3.1 / portable-pty 0.9.0.
//!
//! Reproduces the plugin's Arc<Session> ownership and synchronous read/wait
//! inside async tasks, without launching the GUI or the user's scheduled job.
//! Run with `inline` (original behavior) or `offload` (blocking pool control).
//! The optional PtyPair is ONLY for deterministic cleanup after measurement;
//! the published plugin cannot take/drop it while a read holds Arc<Session>.

use portable_pty::{native_pty_system, Child, CommandBuilder, PtyPair, PtySize};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex as StdMutex, Weak};
use std::time::Duration;
use tokio::sync::{Mutex, RwLock};

struct Session {
    pair: StdMutex<Option<PtyPair>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    reader: Mutex<Box<dyn Read + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
}

async fn read_loop(session: Arc<Session>, active: Arc<AtomicUsize>) {
    active.fetch_add(1, Ordering::SeqCst);
    loop {
        let mut buf = [0u8; 4096];
        // Exactly the problematic command body: async lock, synchronous read.
        let result = session.reader.lock().await.read(&mut buf);
        match result {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                // Answer ConPTY's cursor-position query just as the transport
                // does. This keeps startup independent of a terminal widget.
                if buf[..n].windows(4).any(|w| w == b"\x1b[6n") {
                    let _ = session.writer.lock().await.write_all(b"\x1b[1;1R");
                }
            }
        }
        tokio::task::yield_now().await;
    }
    active.fetch_sub(1, Ordering::SeqCst);
}

fn main() {
    let offload = std::env::args().nth(1).as_deref() == Some("offload");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap();
    let sessions = Arc::new(RwLock::new(BTreeMap::<usize, Arc<Session>>::new()));
    let active = Arc::new(AtomicUsize::new(0));
    let beat = Arc::new(AtomicUsize::new(0));
    let beat_task = beat.clone();
    runtime.spawn(async move {
        loop {
            beat_task.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    });
    let mut cleanup: Vec<Weak<Session>> = Vec::new();
    println!(
        "mode={} workers={} logical_cpus={}",
        if offload { "offload" } else { "inline" },
        runtime.metrics().num_workers(),
        std::thread::available_parallelism().unwrap()
    );
    for round in 0..8 {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        let mut command = CommandBuilder::new("cmd.exe");
        command.args(["/D", "/C", "echo PTY_FREEZE_REPRO"]);
        let child = pair.slave.spawn_command(command).unwrap();
        let session = Arc::new(Session {
            pair: StdMutex::new(Some(pair)),
            child: Mutex::new(child),
            reader: Mutex::new(reader),
            writer: Mutex::new(writer),
        });
        cleanup.push(Arc::downgrade(&session));
        runtime
            .block_on(sessions.write())
            .insert(round, session.clone());
        let reading = session.clone();
        let reading_active = active.clone();
        if offload {
            let handle = runtime.handle().clone();
            runtime.spawn_blocking(move || handle.block_on(read_loop(reading, reading_active)));
        } else {
            runtime.spawn(read_loop(reading, reading_active));
        }
        let registry = sessions.clone();
        let (tx, rx) = mpsc::channel();
        let wait_task = async move {
            // Exactly the plugin's exitstatus ownership: remove from registry
            // after wait, but an already pending read still owns the Session.
            let status = session.child.lock().await.wait().unwrap();
            registry.write().await.remove(&round);
            let _ = tx.send(status.exit_code());
        };
        if offload {
            let handle = runtime.handle().clone();
            runtime.spawn_blocking(move || handle.block_on(wait_task));
        } else {
            runtime.spawn(wait_task);
        }
        let exited = rx.recv_timeout(Duration::from_secs(3)).ok();
        let before = beat.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(300));
        let after = beat.load(Ordering::SeqCst);
        let retained = cleanup.iter().filter(|s| s.strong_count() > 0).count();
        println!(
            "round={} exit={:?} retained_sessions={} active_reads={} beat_delta={}",
            round + 1,
            exited,
            retained,
            active.load(Ordering::SeqCst),
            after - before
        );
        if before == after {
            println!("STARVED: trivial async heartbeat stopped; main thread still running");
            break;
        }
    }
    let blocking_returned = Arc::new(AtomicBool::new(false));
    let async_resumed = Arc::new(AtomicBool::new(false));
    let trivial_ran = Arc::new(AtomicBool::new(false));
    let returned = blocking_returned.clone();
    let blocking = runtime.spawn_blocking(move || returned.store(true, Ordering::SeqCst));
    let resumed = async_resumed.clone();
    runtime.spawn(async move {
        let _ = blocking.await;
        resumed.store(true, Ordering::SeqCst);
    });
    let trivial = trivial_ran.clone();
    runtime.spawn(async move {
        trivial.store(true, Ordering::SeqCst);
    });
    std::thread::sleep(Duration::from_millis(300));
    println!(
        "blocking_returned={} async_resumed={} trivial_ran={}",
        blocking_returned.load(Ordering::SeqCst),
        async_resumed.load(Ordering::SeqCst),
        trivial_ran.load(Ordering::SeqCst)
    );
    // A plain thread can explicitly close the pseudoconsole when ownership is
    // separable. This is not available in the original plugin's Session API.
    for weak in &cleanup {
        if let Some(session) = weak.upgrade() {
            let pair = session.pair.lock().unwrap().take();
            drop(pair);
        }
    }
    std::thread::sleep(Duration::from_millis(300));
    println!(
        "after_explicit_master_close active_reads={}",
        active.load(Ordering::SeqCst)
    );
    runtime.shutdown_timeout(Duration::from_secs(2));
}
