//! Native PTY ownership. No synchronous IO runs in an async task.
//!
//! In particular, the reader must NOT own Session/the PTY pair: ConPTY closes
//! its output only when the pair is dropped, even after the child exits.

#[cfg(not(windows))]
use portable_pty::ChildKiller;
use portable_pty::{native_pty_system, Child, CommandBuilder, PtyPair, PtySize};
use serde::Serialize;
use std::collections::{BTreeMap, VecDeque};
use std::io::{Read, Write};
#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use tokio::sync::{watch, Mutex as AsyncMutex, Notify};

pub const MAX_QUEUED_BYTES: usize = 8 * 1024 * 1024;
static READERS: AtomicUsize = AtomicUsize::new(0);
static WAITERS: AtomicUsize = AtomicUsize::new(0);
static CONSOLES: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Serialize)]
pub struct Diagnostics {
    pub readers: usize,
    pub waiters: usize,
    pub consoles: usize,
}

pub fn diagnostics() -> Diagnostics {
    Diagnostics {
        readers: READERS.load(Ordering::SeqCst),
        waiters: WAITERS.load(Ordering::SeqCst),
        consoles: CONSOLES.load(Ordering::SeqCst),
    }
}

struct Count(&'static AtomicUsize);
impl Count {
    fn new(counter: &'static AtomicUsize) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter)
    }
}
impl Drop for Count {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Default)]
pub struct SpawnOptions {
    pub file: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

struct Killer {
    #[cfg(not(windows))]
    child: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    #[cfg(windows)]
    process: OwnedHandle,
    exited: AtomicBool,
}
impl Killer {
    fn new(child: &dyn Child) -> Result<Self, String> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Threading::{
                OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
            };
            let pid = child.process_id().ok_or("PTY child has no process id")?;
            // Keep a real process handle for the whole lifetime; a plugin
            // session number is never an OS pid. portable-pty 0.9.0's Windows
            // ChildKiller inverts the TerminateProcess success check.
            let handle = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid) };
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(Self {
                // SAFETY: OpenProcess returned a new, valid owned handle.
                process: unsafe { OwnedHandle::from_raw_handle(handle) },
                exited: AtomicBool::new(false),
            })
        }
        #[cfg(not(windows))]
        {
            Ok(Self {
                child: Mutex::new(child.clone_killer()),
                exited: AtomicBool::new(false),
            })
        }
    }

    fn kill(&self) -> Result<(), String> {
        if self.exited.load(Ordering::SeqCst) {
            return Ok(());
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
            use windows_sys::Win32::System::Threading::{TerminateProcess, WaitForSingleObject};
            let handle = self.process.as_raw_handle();
            // SAFETY: self owns this process handle throughout both calls.
            if unsafe { TerminateProcess(handle, 1) } != 0 {
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            // A process can exit between the atomic check and termination.
            if unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0 {
                Ok(())
            } else {
                Err(error.to_string())
            }
        }
        #[cfg(not(windows))]
        {
            lock(&self.child).kill().map_err(|e| e.to_string())
        }
    }
}

// If either thread cannot be created, reaping must still happen. Dropping a
// portable_pty Child by itself does not terminate its process.
struct ReapChild(Option<Box<dyn Child + Send + Sync>>);
impl Drop for ReapChild {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

type Output = Result<Vec<u8>, String>;
type Exit = Result<u32, String>;

#[derive(Default)]
struct OutputState {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    error: Option<String>,
    closed: bool,
    discard: bool,
}

struct OutputBuffer {
    state: Mutex<OutputState>,
    ready: Notify,
    drained: watch::Sender<bool>,
}
impl OutputBuffer {
    fn new() -> Self {
        let (drained, _) = watch::channel(false);
        Self {
            state: Mutex::new(OutputState::default()),
            ready: Notify::new(),
            drained,
        }
    }

    fn push(&self, bytes: Vec<u8>) -> Result<(), ()> {
        let mut state = lock(&self.state);
        if state.discard {
            return Ok(());
        }
        if state.bytes + bytes.len() > MAX_QUEUED_BYTES {
            state.error =
                Some("PTY output exceeded the 8 MiB unread buffer; process stopped".into());
            state.discard = true;
            self.ready.notify_one();
            return Err(());
        }
        state.bytes += bytes.len();
        state.chunks.push_back(bytes);
        self.ready.notify_one();
        Ok(())
    }

    fn next(&self) -> Option<Output> {
        let mut state = lock(&self.state);
        if let Some(bytes) = state.chunks.pop_front() {
            state.bytes -= bytes.len();
            return Some(Ok(bytes));
        }
        if let Some(error) = state.error.take() {
            self.drained.send_replace(true);
            return Some(Err(error));
        }
        if state.closed || state.discard {
            self.drained.send_replace(true);
            return Some(Err("EOF".into()));
        }
        None
    }

    fn close(&self, error: Option<String>) {
        let mut state = lock(&self.state);
        state.closed = true;
        if state.error.is_none() {
            state.error = error;
        }
        self.ready.notify_one();
    }

    fn discard(&self) {
        let mut state = lock(&self.state);
        state.discard = true;
        state.chunks.clear();
        state.bytes = 0;
        state.error = None;
        self.drained.send_replace(true);
        self.ready.notify_one();
    }

    async fn wait_drained(&self) -> Result<(), String> {
        let mut drained = self.drained.subscribe();
        loop {
            if *drained.borrow_and_update() {
                return Ok(());
            }
            drained
                .changed()
                .await
                .map_err(|_| "PTY output state closed".to_string())?;
        }
    }
}

pub struct Session {
    pair: Arc<Mutex<Option<PtyPair>>>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    killer: Arc<Killer>,
    output: Arc<OutputBuffer>,
    read_lock: AsyncMutex<()>,
    exit: watch::Receiver<Option<Exit>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        // A spawn response can be abandoned before it is registered. Native
        // threads deliberately do not retain Session, so its final owner can
        // always terminate/reap an otherwise unreachable child.
        let _ = self.kill();
    }
}

impl Session {
    /// Blocking: called by the spawn command's blocking task.
    pub fn spawn(options: SpawnOptions) -> Result<Self, String> {
        if options.file.is_empty() || options.cols == 0 || options.rows == 0 {
            return Err("PTY requires a program and nonzero dimensions".into());
        }
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: options.rows,
                cols: options.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let mut command = CommandBuilder::new(options.file);
        command.args(options.args);
        if let Some(cwd) = options.cwd {
            command.cwd(cwd);
        }
        for (key, value) in options.env {
            command.env(key, value);
        }
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| e.to_string())?;
        let mut child = ReapChild(Some(child));
        let killer = Arc::new(Killer::new(child.0.as_deref().unwrap())?);
        let console_count = Count::new(&CONSOLES);
        let pair = Arc::new(Mutex::new(Some(pair)));
        let writer = Arc::new(Mutex::new(Some(writer)));
        let output = Arc::new(OutputBuffer::new());
        let (exit_tx, exit_rx) = watch::channel(None);
        let read_output_buffer = output.clone();
        let read_killer = killer.clone();
        let reader_thread = thread::Builder::new()
            .name("pty-reader".into())
            .spawn(move || read_output(reader, read_output_buffer, read_killer))
            .map_err(|e| format!("spawn PTY reader: {e}"))?;
        let wait_pair = pair.clone();
        let wait_writer = writer.clone();
        let wait_killer = killer.clone();
        thread::Builder::new()
            .name("pty-waiter".into())
            .spawn(move || {
                let _waiter = Count::new(&WAITERS);
                let status = child
                    .0
                    .as_mut()
                    .unwrap()
                    .wait()
                    .map(|s| s.exit_code())
                    .map_err(|e| e.to_string());
                // On wait failure ReapChild still terminates/reaps the process.
                if status.is_ok() {
                    child.0.take();
                }
                drop(child);
                wait_killer.exited.store(true, Ordering::SeqCst);
                // Close outside the lock: ClosePseudoConsole can wait for its
                // output to drain. The independent reader keeps draining even
                // when no frontend is consuming or the buffer limit is hit.
                let pair = lock(&wait_pair).take();
                drop(pair);
                drop(console_count);
                // Closing the master first also releases a blocked writer.
                lock(&wait_writer).take();
                let reader_result = reader_thread.join();
                let status = if reader_result.is_err() {
                    Err("PTY reader thread panicked".into())
                } else {
                    status
                };
                // Published only after EOF and native resource cleanup.
                let _ = exit_tx.send(Some(status));
            })
            .map_err(|e| format!("spawn PTY waiter: {e}"))?;
        Ok(Self {
            pair,
            writer,
            killer,
            output,
            read_lock: AsyncMutex::new(()),
            exit: exit_rx,
        })
    }

    /// Only waits on an async channel; never parks an executor worker.
    pub async fn read(&self) -> Output {
        let _read = self.read_lock.lock().await;
        loop {
            if let Some(output) = self.output.next() {
                return output;
            }
            // notify_one retains a permit if output arrives between the check
            // and this await; the read mutex permits only one waiting consumer.
            self.output.ready.notified().await;
        }
    }

    pub async fn exitstatus(&self) -> Exit {
        let mut exit = self.exit.clone();
        loop {
            let status = exit.borrow_and_update().clone();
            if let Some(status) = status {
                // Do not let the command remove its registry entry while
                // unread tail chunks still need subsequent read commands.
                self.output.wait_drained().await?;
                return status;
            }
            exit.changed()
                .await
                .map_err(|_| "PTY waiter stopped without an exit status".to_string())?;
        }
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        lock(&self.writer)
            .as_mut()
            .ok_or("PTY is closed")?
            .write_all(data)
            .map_err(|e| e.to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Err("PTY dimensions must be nonzero".into());
        }
        lock(&self.pair)
            .as_ref()
            .ok_or("PTY is closed")?
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    pub fn kill(&self) -> Result<(), String> {
        // Stop/teardown can happen after JS stops requesting reads. Discarding
        // must not depend on a reader future or a live frontend.
        self.output.discard();
        self.killer.kill()
    }

    pub fn stop_callback(&self) -> Arc<dyn Fn() + Send + Sync> {
        let killer = self.killer.clone();
        let output = self.output.clone();
        Arc::new(move || {
            output.discard();
            let _ = killer.kill();
        })
    }
}

fn read_output(mut reader: Box<dyn Read + Send>, output: Arc<OutputBuffer>, killer: Arc<Killer>) {
    let _reader = Count::new(&READERS);
    loop {
        let mut bytes = vec![0u8; 4096];
        let count = match reader.read(&mut bytes) {
            Ok(0) => break,
            Ok(count) => count,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::UnexpectedEof
                ) =>
            {
                break
            }
            Err(e) => {
                output.close(Some(e.to_string()));
                let _ = killer.kill();
                break;
            }
        };
        bytes.truncate(count);
        if output.push(bytes).is_err() {
            let _ = killer.kill();
        }
    }
    output.close(None);
}
