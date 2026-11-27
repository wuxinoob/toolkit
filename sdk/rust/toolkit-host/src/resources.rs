//! Generic resources use JSON control and an independent bounded raw lane.
use super::{Client, Error};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
pub const MAX_CHUNK_BYTES: usize = 256 * 1024;
#[cfg(windows)]
pub(crate) struct Lane {
    path: String,
    pipe: tokio::sync::Mutex<Option<tokio::net::windows::named_pipe::NamedPipeClient>>,
    failed: std::sync::atomic::AtomicBool,
}
#[cfg(windows)]
impl Lane {
    pub fn new(path: String) -> Self {
        Self {
            path,
            pipe: tokio::sync::Mutex::new(None),
            failed: false.into(),
        }
    }
    async fn exchange(&self, header: Value, bytes: &[u8]) -> Result<(Value, Vec<u8>), Error> {
        use std::sync::atomic::Ordering;
        let mut slot = self.pipe.lock().await;
        if self.failed.load(Ordering::SeqCst) {
            return Err(failure(
                "transport",
                "resource lane closed; restart the Sidecar host RPC instance",
            ));
        }
        // Cancellation at any await after framing starts discards the pipe.
        // An incomplete operation cannot be retried on a desynchronised stream.
        struct Guard<'a>(&'a std::sync::atomic::AtomicBool, bool);
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                if !self.1 {
                    self.0.store(true, Ordering::SeqCst);
                }
            }
        }
        let mut guard = Guard(&self.failed, false);
        let mut pipe = match slot.take() {
            Some(p) => p,
            None => tokio::net::windows::named_pipe::ClientOptions::new().open(&self.path)?,
        };
        let work = async {
            super::write_frame(&mut pipe, &header).await?;
            pipe.write_all(bytes).await?;
            let reply = super::read_frame(&mut pipe).await?;
            if reply["ok"] != true {
                return Ok((reply, Vec::new()));
            }
            let length = reply["length"]
                .as_u64()
                .filter(|n| *n <= MAX_CHUNK_BYTES as u64)
                .ok_or_else(|| failure("protocol", "invalid resource reply length"))?
                as usize;
            let mut raw = vec![0; length];
            pipe.read_exact(&mut raw).await?;
            Ok::<_, Error>((reply, raw))
        };
        let result = tokio::time::timeout(std::time::Duration::from_secs(45), work)
            .await
            .map_err(|_| failure("timeout", "resource lane timed out"))??;
        *slot = Some(pipe);
        guard.1 = true;
        if result.0["ok"] != true {
            return Err(failure(
                result.0["code"].as_str().unwrap_or("protocol"),
                result.0["message"]
                    .as_str()
                    .unwrap_or("resource request failed"),
            ));
        }
        Ok(result)
    }
}
fn failure(code: &str, message: &str) -> Error {
    Error {
        code: code.into(),
        message: message.into(),
    }
}
impl Client {
    pub async fn resource_identity(&self) -> Result<Value, Error> {
        self.request("binary", "identity", serde_json::json!({}))
            .await
    }
    pub async fn import_resource(&self, ticket: Value) -> Result<Resource, Error> {
        let client = self.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let result = client
                .request(
                    "binary",
                    "import",
                    serde_json::json!({"token":ticket["token"]}),
                )
                .await
                .and_then(|result| {
                    result["source"]["id"]
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| failure("protocol", "invalid imported resource"))
                })
                .map(|id| Resource {
                    client,
                    id,
                    closed: false,
                });
            let _ = tx.send(result);
        });
        rx.await
            .map_err(|_| failure("transport", "resource import interrupted"))?
    }
    #[cfg(windows)]
    pub async fn connect_with_resources(control: &str, data: &str) -> Result<Self, Error> {
        let mut client = Self::connect(control).await?;
        std::sync::Arc::get_mut(&mut client.0).unwrap().resources = Some(Lane::new(data.into()));
        Ok(client)
    }
    pub async fn open_resource(&self, size: usize) -> Result<Resource, Error> {
        let client = self.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let id = format!(
                "sdk-{}-{}",
                std::process::id(),
                client
                    .0
                    .next
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            );
            let result = client
                .request("binary", "open", json!({"id":id,"size":size}))
                .await
                .map(|_| Resource {
                    client,
                    id,
                    closed: false,
                });
            let _ = tx.send(result);
        });
        rx.await
            .map_err(|_| failure("transport", "resource open interrupted"))?
    }
    pub async fn upload_resource(&self, bytes: &[u8]) -> Result<Resource, Error> {
        let mut resource = self.open_resource(bytes.len()).await?;
        for (index, chunk) in bytes.chunks(MAX_CHUNK_BYTES).enumerate() {
            resource.write(index * MAX_CHUNK_BYTES, chunk).await?;
        }
        resource.seal().await?;
        Ok(resource)
    }
}
pub struct Resource {
    client: Client,
    pub id: String,
    closed: bool,
}
impl Resource {
    pub async fn export(&self, to: &str) -> Result<Value, Error> {
        self.client
            .request(
                "binary",
                "export",
                serde_json::json!({"id":self.id,"to":to}),
            )
            .await
    }
    pub fn source(&self) -> Value {
        json!({"kind":"resource","id":self.id})
    }
    pub async fn seal(&mut self) -> Result<Value, Error> {
        self.client
            .request("binary", "seal", json!({"id":self.id}))
            .await
    }
    pub async fn stat(&self) -> Result<Value, Error> {
        self.client
            .request("binary", "stat", json!({"id":self.id}))
            .await
    }
    #[cfg(windows)]
    pub async fn write(&mut self, offset: usize, bytes: &[u8]) -> Result<usize, Error> {
        if bytes.len() > MAX_CHUNK_BYTES {
            return Err(failure("bad_params", "chunk exceeds 256 KiB"));
        }
        let lane = self.client.0.resources.as_ref().ok_or_else(|| {
            failure(
                "unsupported",
                "Sidecar has no resource lane; declare rpc:binary and enable hostRpc",
            )
        })?;
        let (reply, _) = lane
            .exchange(
                json!({"op":"write","id":self.id,"offset":offset,"length":bytes.len()}),
                bytes,
            )
            .await?;
        reply["offset"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| failure("protocol", "invalid resource acknowledgement"))
    }
    #[cfg(not(windows))]
    pub async fn write(&mut self, _: usize, _: &[u8]) -> Result<usize, Error> {
        Err(failure(
            "unsupported",
            "resource lane currently requires Windows",
        ))
    }
    #[cfg(windows)]
    pub async fn read(&self, offset: usize, length: usize) -> Result<Vec<u8>, Error> {
        if length > MAX_CHUNK_BYTES {
            return Err(failure("bad_params", "chunk exceeds 256 KiB"));
        }
        let lane = self
            .client
            .0
            .resources
            .as_ref()
            .ok_or_else(|| failure("unsupported", "Sidecar has no resource lane"))?;
        let (_, bytes) = lane
            .exchange(
                json!({"op":"read","id":self.id,"offset":offset,"length":length}),
                &[],
            )
            .await?;
        Ok(bytes)
    }
    pub async fn close(mut self) -> Result<(), Error> {
        self.client
            .request("binary", "close", json!({"id":self.id}))
            .await?;
        self.closed = true;
        Ok(())
    }
}
impl Drop for Resource {
    fn drop(&mut self) {
        if !self.closed {
            let client = self.client.clone();
            let id = self.id.clone();
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                rt.spawn(async move {
                    let _ = client.request("binary", "close", json!({"id":id})).await;
                });
            }
        }
    }
}
