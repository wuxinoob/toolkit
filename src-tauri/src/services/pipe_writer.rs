//! A bounded, ordered stdin writer. Gateway workers never wait on a pipe lock.
use super::ServiceError;
use std::io::Write;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc, Arc,
};
use std::time::Duration;

pub const MAX_LINE_BYTES: usize = 1 << 20;
pub const MAX_QUEUED_BYTES: usize = 4 << 20;
pub const MAX_QUEUED_WRITES: usize = 8;
pub const WRITE_DEADLINE_MS: u64 = 5_000;

struct Reservation {
    bytes: usize,
    total: Arc<AtomicUsize>,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.total.fetch_sub(self.bytes, Ordering::SeqCst);
    }
}
struct Job {
    line: String,
    reply: mpsc::SyncSender<Result<(), String>>,
    _reservation: Reservation,
}
#[derive(Clone)]
pub struct Writer {
    tx: mpsc::SyncSender<Job>,
    bytes: Arc<AtomicUsize>,
    failed: Arc<AtomicBool>,
}
impl Writer {
    pub fn new(mut stdin: impl Write + Send + 'static, pid: u32) -> std::io::Result<Self> {
        let (tx, rx) = mpsc::sync_channel::<Job>(MAX_QUEUED_WRITES);
        let failed = Arc::new(AtomicBool::new(false));
        let stopped = failed.clone();
        std::thread::Builder::new()
            .name(format!("proc-writer-{pid}"))
            .spawn(move || {
                while let Ok(job) = rx.recv() {
                    if stopped.load(Ordering::SeqCst) {
                        break;
                    }
                    let result = writeln!(stdin, "{}", job.line)
                        .and_then(|_| stdin.flush())
                        .map_err(|e| e.to_string());
                    let broken = result.is_err();
                    let _ = job.reply.send(result);
                    if broken {
                        stopped.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            })?;
        Ok(Self {
            tx,
            bytes: Arc::new(AtomicUsize::new(0)),
            failed,
        })
    }
    pub fn send(&self, line: &str) -> Result<(), ServiceError> {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.contains(['\r', '\n']) {
            return Err(ServiceError::bad_params(
                "stdin send requires one text line",
            ));
        }
        if line.len() > MAX_LINE_BYTES {
            return Err(ServiceError::bad_params("stdin line exceeds 1 MiB"));
        }
        if self.failed.load(Ordering::SeqCst) {
            return Err(ServiceError::io("Sidecar stdin is closed"));
        }
        let bytes = line.len() + 1;
        self.bytes
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |total| {
                total.checked_add(bytes).filter(|n| *n <= MAX_QUEUED_BYTES)
            })
            .map_err(|_| ServiceError::conflict("Sidecar stdin queue byte budget exhausted"))?;
        let reservation = Reservation {
            bytes,
            total: self.bytes.clone(),
        };
        let (tx, rx) = mpsc::sync_channel(1);
        self.tx
            .try_send(Job {
                line: line.into(),
                reply: tx,
                _reservation: reservation,
            })
            .map_err(|e| match e {
                mpsc::TrySendError::Full(_) => {
                    ServiceError::conflict("Sidecar stdin queue is full")
                }
                mpsc::TrySendError::Disconnected(_) => ServiceError::io("Sidecar stdin is closed"),
            })?;
        match rx.recv_timeout(Duration::from_millis(WRITE_DEADLINE_MS)) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(ServiceError::io(format!("write Sidecar stdin: {error}"))),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(ServiceError::io("Sidecar stdin is closed"))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.failed.store(true, Ordering::SeqCst);
                Err(ServiceError::new("timeout", "Sidecar stdin deadline expired; process is being stopped; write outcome is unknown"))
            }
        }
    }
}
