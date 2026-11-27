//! Sidecar host RPC. The host injects TOOLKIT_HOST_PIPE when hostRpc is enabled.
pub mod resources;
pub mod wire;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tokio::sync::{mpsc, oneshot};
pub use wire::{read_frame, write_frame, MAX_FRAME_BYTES};

#[derive(Debug, Clone)]
pub struct Error {
    pub code: String,
    pub message: String,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}
impl From<io::Error> for Error {
    fn from(_: io::Error) -> Self {
        Self {
            code: "transport".into(),
            message: "host RPC connection closed".into(),
        }
    }
}
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, Error>>>>>;

struct Inner {
    outgoing: mpsc::Sender<Value>,
    pending: Pending,
    next: AtomicU64,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    closed: Arc<AtomicBool>,
    #[cfg(windows)]
    resources: Option<resources::Lane>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}
#[derive(Clone)]
pub struct Client(Arc<Inner>);

impl Client {
    #[cfg(windows)]
    pub async fn connect_from_env() -> Result<Self, Error> {
        let path = std::env::var("TOOLKIT_HOST_PIPE").map_err(|_| Error {
            code: "not_found".into(),
            message: "Sidecar was not started with hostRpc".into(),
        })?;
        match std::env::var("TOOLKIT_RESOURCE_PIPE") {
            Ok(data) => Self::connect_with_resources(&path, &data).await,
            Err(_) => Self::connect(&path).await,
        }
    }
    #[cfg(windows)]
    pub async fn connect(path: &str) -> Result<Self, Error> {
        let pipe = tokio::net::windows::named_pipe::ClientOptions::new().open(path)?;
        let (mut reader, mut writer) = tokio::io::split(pipe);
        let (outgoing, mut input) = mpsc::channel::<Value>(32);
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let read_closed = closed.clone();
        let awaiting = pending.clone();
        let read = tokio::spawn(async move {
            while let Ok(env) = read_frame(&mut reader).await {
                if env["v"] != 1 || !matches!(env["kind"].as_str(), Some("res" | "err")) {
                    break;
                }
                if let Some(id) = env["id"].as_u64() {
                    let tx = awaiting.lock().unwrap().remove(&id);
                    if let Some(tx) = tx {
                        let result = if env["kind"] == "res" {
                            Ok(env["p"].clone())
                        } else {
                            Err(Error {
                                code: env["code"].as_str().unwrap_or("protocol").into(),
                                message: env["msg"].as_str().unwrap_or("host RPC error").into(),
                            })
                        };
                        let _ = tx.send(result);
                    }
                }
            }
            read_closed.store(true, Ordering::SeqCst);
            for (_, tx) in awaiting.lock().unwrap().drain() {
                let _ = tx.send(Err(io::Error::from(io::ErrorKind::BrokenPipe).into()));
            }
        });
        let awaiting = pending.clone();
        let write_closed = closed.clone();
        let write = tokio::spawn(async move {
            while let Some(env) = input.recv().await {
                if write_frame(&mut writer, &env).await.is_err() {
                    break;
                }
            }
            write_closed.store(true, Ordering::SeqCst);
            for (_, tx) in awaiting.lock().unwrap().drain() {
                let _ = tx.send(Err(io::Error::from(io::ErrorKind::BrokenPipe).into()));
            }
        });
        Ok(Self(Arc::new(Inner {
            outgoing,
            pending,
            next: AtomicU64::new(1),
            tasks: vec![read, write],
            closed,
            resources: None,
        })))
    }

    pub async fn request(
        &self,
        service: &str,
        action: &str,
        params: Value,
    ) -> Result<Value, Error> {
        if self.0.closed.load(Ordering::SeqCst) {
            return Err(io::Error::from(io::ErrorKind::BrokenPipe).into());
        }
        let id = self.0.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.0.pending.lock().unwrap();
            if self.0.closed.load(Ordering::SeqCst) {
                return Err(io::Error::from(io::ErrorKind::BrokenPipe).into());
            }
            if pending.len() >= 32 {
                return Err(Error {
                    code: "conflict".into(),
                    message: "too many pending host RPC calls".into(),
                });
            }
            pending.insert(id, tx);
        }
        // Dropping a timed-out or cancelled call must remove its correlation entry.
        struct Guard(Pending, u64);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.lock().unwrap().remove(&self.1);
            }
        }
        let _guard = Guard(self.0.pending.clone(), id);
        let exchange = async {
            self.0
                .outgoing
                .send(json!({"v":1,"kind":"req","id":id,"svc":service,"act":action,"p":params}))
                .await
                .map_err(|_| Error::from(io::Error::from(io::ErrorKind::BrokenPipe)))?;
            rx.await
                .map_err(|_| Error::from(io::Error::from(io::ErrorKind::BrokenPipe)))?
        };
        match tokio::time::timeout(std::time::Duration::from_secs(45), exchange).await {
            Ok(result) => result,
            Err(_) => Err(Error {
                code: "timeout".into(),
                message: "host RPC did not answer".into(),
            }),
        }
    }
    pub async fn profiles(&self) -> Result<Value, Error> {
        self.request("llm", "profiles", Value::Null).await
    }
    pub async fn stream(&self, request: Value) -> Result<Generation, Error> {
        // Keep the start response alive if this future is dropped. Sending a
        // Generation to a closed receiver drops it and cancels the late job.
        let client = self.clone();
        let (tx, rx) = oneshot::channel();
        tokio::spawn(async move {
            let result = async {
                let started = client.request("llm", "start", request).await?;
                let id = started["id"]
                    .as_str()
                    .ok_or_else(|| Error {
                        code: "protocol".into(),
                        message: "missing generation id".into(),
                    })?
                    .to_string();
                Ok(Generation {
                    client,
                    id,
                    ended: false,
                })
            }
            .await;
            let _ = tx.send(result);
        });
        rx.await
            .map_err(|_| Error::from(io::Error::from(io::ErrorKind::BrokenPipe)))?
    }
    pub async fn generate(&self, request: Value) -> Result<Value, Error> {
        let mut stream = self.stream(request).await?;
        let mut text = String::new();
        while let Some(event) = stream.next().await? {
            if event["type"] == "text-delta" {
                text.push_str(event["text"].as_str().unwrap_or(""));
            }
            if text.len() > 4 * 1024 * 1024 {
                stream.cancel().await?;
                return Err(Error {
                    code: "bad_params".into(),
                    message: "complete result exceeds 4 MiB; use streaming".into(),
                });
            }
            if event["type"] == "completed" {
                return Ok(
                    json!({"output":[{"type":"text","text":text}],"finishReason":event["finishReason"],"usage":event["usage"]}),
                );
            }
        }
        Err(Error {
            code: "transport".into(),
            message: "generation ended without completion".into(),
        })
    }
}

pub struct Generation {
    client: Client,
    pub id: String,
    ended: bool,
}
impl Generation {
    pub async fn next(&mut self) -> Result<Option<Value>, Error> {
        if self.ended {
            return Ok(None);
        }
        loop {
            let event = self
                .client
                .request("llm", "next", json!({"id":self.id}))
                .await?;
            if event["type"] == "waiting" {
                continue;
            }
            if !matches!(event["type"].as_str(), Some("text-delta" | "completed")) {
                return Err(Error {
                    code: "protocol".into(),
                    message: "invalid model event".into(),
                });
            }
            self.ended = event["type"] == "completed";
            return Ok(Some(event));
        }
    }
    pub async fn cancel(&mut self) -> Result<(), Error> {
        if !self.ended {
            self.client
                .request("llm", "cancel", json!({"id":self.id}))
                .await?;
            self.ended = true;
        }
        Ok(())
    }
}
impl Drop for Generation {
    fn drop(&mut self) {
        if !self.ended {
            let client = self.client.clone();
            let id = self.id.clone();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = client.request("llm", "cancel", json!({"id":id})).await;
                });
            }
        }
    }
}
