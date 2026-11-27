//! Bounded resources owned by a plugin and native window or Sidecar instance.

use crate::services::caller::Caller;
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{State, WebviewWindow};

use crate::protocol::codes::code;
use crate::services::{storage, ServiceError};
use crate::{host, observe_rpc, RpcRejection};

pub const MAX_CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_TRANSFER_BYTES: usize = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const MAX_TRANSFERS: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TransferKey {
    pub window: String,
    pub plugin: String,
    pub id: String,
}

#[derive(Default)]
struct Budget(Mutex<(usize, usize)>);
pub struct Allocation {
    pub bytes: Vec<u8>,
    size: usize,
    budget: Arc<Budget>,
}
impl Drop for Allocation {
    fn drop(&mut self) {
        let mut b = self.budget.0.lock().unwrap();
        b.0 -= self.size;
        b.1 -= 1;
    }
}
struct Transfer {
    allocation: Arc<Allocation>,
    sealed: bool,
}
pub const MAX_RESOURCE_REFS: usize = 64;
pub const MAX_EXPORTS: usize = 32;
pub const EXPORT_TTL_MS: u64 = 30_000;
struct Offer {
    source: TransferKey,
    to: String,
    expires: std::time::Instant,
    allocation: Arc<Allocation>,
}
#[derive(Clone, Default)]
pub struct Transfers {
    entries: Arc<Mutex<HashMap<TransferKey, Transfer>>>,
    budget: Arc<Budget>,
    exports: Arc<Mutex<HashMap<String, Offer>>>,
    expiry_running: Arc<std::sync::atomic::AtomicBool>,
}
impl Transfers {
    /// Complete a native producer's pre-reserved buffer. A closed owner cannot
    /// publish a late result, and the budget follows outstanding reader leases.
    pub fn finish(&self, key: &TransferKey, mut bytes: Vec<u8>) -> Result<Value, ServiceError> {
        bytes.shrink_to_fit();
        let mut entries = self.lock();
        let t = entries.get_mut(key).ok_or_else(missing_transfer)?;
        if t.sealed || bytes.len() > t.allocation.size {
            return Err(ServiceError::conflict(
                "native resource exceeds its reservation or is sealed",
            ));
        }
        let a = Arc::get_mut(&mut t.allocation)
            .ok_or_else(|| ServiceError::conflict("resource is borrowed"))?;
        self.budget.0.lock().unwrap().0 -= a.size - bytes.len();
        a.size = bytes.len();
        a.bytes = bytes;
        t.sealed = true;
        Ok(json!({"kind":"resource","id":key.id,"size":a.size}))
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<TransferKey, Transfer>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn key(caller: &Caller, id: &str) -> Result<TransferKey, ServiceError> {
        validate_id(id)?;
        Ok(TransferKey {
            window: caller
                .owner
                .strip_prefix("window:")
                .unwrap_or(&caller.owner)
                .into(),
            plugin: caller.plugin.clone(),
            id: id.into(),
        })
    }
    pub fn open(&self, key: TransferKey, size: usize) -> Result<(), ServiceError> {
        if size > MAX_TRANSFER_BYTES {
            return Err(ServiceError::bad_params("binary transfer exceeds 16 MiB"));
        }
        let mut entries = self.lock();
        if let Some(t) = entries.get(&key) {
            return if t.allocation.size == size {
                Ok(())
            } else {
                Err(ServiceError::conflict(
                    "transfer is already open with a different size",
                ))
            };
        }
        if entries.len() >= MAX_RESOURCE_REFS {
            return Err(ServiceError::conflict(
                "resource reference budget exhausted",
            ));
        }
        let mut budget = self.budget.0.lock().unwrap();
        if budget.1 >= MAX_TRANSFERS || budget.0 + size > MAX_TOTAL_BYTES {
            return Err(ServiceError::conflict("binary transfer budget exhausted"));
        }
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(size)
            .map_err(|_| ServiceError::internal("cannot reserve binary buffer"))?;
        budget.0 += size;
        budget.1 += 1;
        drop(budget);
        entries.insert(
            key,
            Transfer {
                allocation: Arc::new(Allocation {
                    bytes,
                    size,
                    budget: self.budget.clone(),
                }),
                sealed: false,
            },
        );
        Ok(())
    }
    pub fn write(
        &self,
        key: &TransferKey,
        offset: usize,
        bytes: &[u8],
    ) -> Result<usize, ServiceError> {
        check_chunk_size(bytes.len())?;
        let mut entries = self.lock();
        let t = entries.get_mut(key).ok_or_else(missing_transfer)?;
        let end = offset
            .checked_add(bytes.len())
            .filter(|end| *end <= t.allocation.size)
            .ok_or_else(|| ServiceError::bad_params("write exceeds the declared transfer size"))?;
        if t.sealed {
            return Err(ServiceError::conflict("resource is sealed"));
        }
        let a = Arc::get_mut(&mut t.allocation)
            .ok_or_else(|| ServiceError::conflict("resource is borrowed"))?;
        if offset == a.bytes.len() {
            a.bytes.extend_from_slice(bytes);
        } else if a.bytes.get(offset..end) != Some(bytes) {
            return Err(ServiceError::conflict(
                "write must continue at the acknowledged offset or repeat existing bytes",
            ));
        }
        Ok(a.bytes.len())
    }
    pub fn read(
        &self,
        key: &TransferKey,
        offset: usize,
        max_bytes: usize,
    ) -> Result<Vec<u8>, ServiceError> {
        check_chunk_size(max_bytes)?;
        let entries = self.lock();
        let t = entries.get(key).ok_or_else(missing_transfer)?;
        let remaining =
            t.allocation.bytes.get(offset..).ok_or_else(|| {
                ServiceError::bad_params("read offset exceeds acknowledged bytes")
            })?;
        Ok(remaining[..remaining.len().min(max_bytes)].to_vec())
    }
    pub fn seal(&self, key: &TransferKey) -> Result<Value, ServiceError> {
        let mut entries = self.lock();
        let t = entries.get_mut(key).ok_or_else(missing_transfer)?;
        if t.allocation.bytes.len() != t.allocation.size {
            return Err(ServiceError::conflict("resource upload is incomplete"));
        }
        t.sealed = true;
        Ok(json!({"kind":"resource","id":key.id,"size":t.allocation.size}))
    }
    pub fn borrow(&self, key: &TransferKey) -> Result<Arc<Allocation>, ServiceError> {
        let entries = self.lock();
        let t = entries.get(key).ok_or_else(missing_transfer)?;
        if !t.sealed {
            return Err(ServiceError::conflict("resource must be sealed before use"));
        }
        Ok(t.allocation.clone())
    }
    pub fn stat(&self, key: &TransferKey) -> Result<Value, ServiceError> {
        let entries = self.lock();
        let t = entries.get(key).ok_or_else(missing_transfer)?;
        Ok(json!({"size":t.allocation.size,"written":t.allocation.bytes.len(),"sealed":t.sealed}))
    }
    pub fn diagnostics(&self) -> Value {
        let b = self.budget.0.lock().unwrap();
        json!({"bytes":b.0,"allocations":b.1})
    }
    pub fn offer(&self, caller: &Caller, id: &str, to: &str) -> Result<Value, ServiceError> {
        if to.len() > 256 || !(to.starts_with("window:") || to.starts_with("sidecar:")) {
            return Err(ServiceError::bad_params(
                "recipient must be a native window or Sidecar owner",
            ));
        }
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| ServiceError::unsupported("resource export requires the host runtime"))?;
        let key = Self::key(caller, id)?;
        let entries = self.lock();
        let resource = entries.get(&key).ok_or_else(missing_transfer)?;
        if !resource.sealed {
            return Err(ServiceError::conflict(
                "only sealed resources can be exported",
            ));
        }
        let mut offers = self.exports.lock().unwrap();
        offers.retain(|_, offer| offer.expires > std::time::Instant::now());
        if offers.len() >= MAX_EXPORTS {
            return Err(ServiceError::conflict("resource export budget exhausted"));
        }
        let token = crate::sidecar_rpc::instance_id();
        offers.insert(
            token.clone(),
            Offer {
                source: key,
                to: to.into(),
                expires: std::time::Instant::now()
                    + std::time::Duration::from_millis(EXPORT_TTL_MS),
                allocation: resource.allocation.clone(),
            },
        );
        if !self
            .expiry_running
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            let pending = self.exports.clone();
            let running = self.expiry_running.clone();
            runtime.spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    let mut offers = pending.lock().unwrap();
                    offers.retain(|_, offer| offer.expires > std::time::Instant::now());
                    if offers.is_empty() {
                        running.store(false, std::sync::atomic::Ordering::SeqCst);
                        break;
                    }
                }
            });
        }
        Ok(json!({"token":token,"to":to,"expiresInMs":EXPORT_TTL_MS}))
    }
    pub fn import(&self, caller: &Caller, token: &str) -> Result<Value, ServiceError> {
        let mut entries = self.lock();
        let mut offers = self.exports.lock().unwrap();
        let offer = offers.get(token).ok_or_else(|| {
            ServiceError::not_found("resource ticket was claimed, revoked or expired")
        })?;
        if offer.source.plugin != caller.plugin || offer.to != caller.owner {
            return Err(ServiceError::new(
                "denied",
                "resource ticket belongs to another recipient",
            ));
        }
        if offer.expires <= std::time::Instant::now() {
            offers.remove(token);
            return Err(ServiceError::not_found("resource ticket expired"));
        }
        if entries.len() >= MAX_RESOURCE_REFS {
            return Err(ServiceError::conflict(
                "resource reference budget exhausted",
            ));
        }
        let allocation = offers.remove(token).unwrap().allocation;
        let id = format!("shared-{}", crate::sidecar_rpc::instance_id());
        let size = allocation.bytes.len();
        entries.insert(
            Self::key(caller, &id)?,
            Transfer {
                allocation,
                sealed: true,
            },
        );
        Ok(
            json!({"source":{"kind":"resource","id":id,"size":size},"maxChunkBytes":MAX_CHUNK_BYTES}),
        )
    }
    pub fn revoke(&self, caller: &Caller, token: &str) -> Result<Value, ServiceError> {
        let mut offers = self.exports.lock().unwrap();
        if let Some(offer) = offers.get(token) {
            if Self::key(caller, &offer.source.id)? != offer.source {
                return Err(ServiceError::new(
                    "denied",
                    "only the exporter can revoke a resource ticket",
                ));
            }
        }
        Ok(json!(offers.remove(token).is_some()))
    }
    pub fn close(&self, key: &TransferKey) -> bool {
        let mut entries = self.lock();
        let removed = entries.remove(key).is_some();
        self.exports
            .lock()
            .unwrap()
            .retain(|_, offer| &offer.source != key);
        removed
    }
    pub fn close_window(&self, window: &str) {
        let mut entries = self.lock();
        entries.retain(|key, _| key.window != window);
        self.exports.lock().unwrap().retain(|_, offer| {
            offer.source.window != window && offer.to != format!("window:{window}")
        });
    }
    pub fn close_caller(&self, caller: &Caller) {
        let owner = caller
            .owner
            .strip_prefix("window:")
            .unwrap_or(&caller.owner);
        let mut entries = self.lock();
        entries.retain(|k, _| k.window != owner || k.plugin != caller.plugin);
        self.exports.lock().unwrap().retain(|_, offer| {
            !(offer.source.window == owner && offer.source.plugin == caller.plugin)
                && !(offer.to == caller.owner && offer.source.plugin == caller.plugin)
        });
    }
    pub fn close_plugin(&self, plugin: &str) {
        let mut entries = self.lock();
        entries.retain(|k, _| k.plugin != plugin);
        self.exports
            .lock()
            .unwrap()
            .retain(|_, offer| offer.source.plugin != plugin);
    }
    pub fn close_all(&self) {
        let mut entries = self.lock();
        entries.clear();
        self.exports.lock().unwrap().clear();
    }
    pub fn control(
        &self,
        caller: &Caller,
        action: &str,
        params: Value,
    ) -> Result<Value, ServiceError> {
        if action == "identity" {
            return Ok(json!({"owner":caller.owner}));
        }
        if matches!(action, "import" | "revoke") {
            let token = params["token"]
                .as_str()
                .ok_or_else(|| ServiceError::bad_params("missing resource ticket token"))?;
            return if action == "import" {
                self.import(caller, token)
            } else {
                self.revoke(caller, token)
            };
        }
        if action == "close_all" {
            self.close_caller(caller);
            return Ok(Value::Null);
        }
        let id = params["id"]
            .as_str()
            .ok_or_else(|| ServiceError::bad_params("missing resource id"))?;
        let key = Self::key(caller, id)?;
        match action {
            "export" => self.offer(
                caller,
                id,
                params["to"]
                    .as_str()
                    .ok_or_else(|| ServiceError::bad_params("missing recipient owner"))?,
            ),
            "open" => {
                let size = params["size"]
                    .as_u64()
                    .and_then(|n| usize::try_from(n).ok())
                    .ok_or_else(|| ServiceError::bad_params("invalid resource size"))?;
                self.open(key, size)?;
                Ok(json!({"maxChunkBytes":MAX_CHUNK_BYTES}))
            }
            "seal" => self.seal(&key),
            "stat" => self.stat(&key),
            "close" => Ok(json!(self.close(&key))),
            _ => Err(ServiceError::new("unknown_action", "unknown binary action")),
        }
    }
}
fn validate_id(id: &str) -> Result<(), ServiceError> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(ServiceError::bad_params("invalid resource id"));
    }
    Ok(())
}

fn missing_transfer() -> ServiceError {
    ServiceError::not_found("binary transfer is closed or belongs to another caller")
}

fn check_chunk_size(size: usize) -> Result<(), ServiceError> {
    if size > MAX_CHUNK_BYTES {
        return Err(ServiceError::bad_params("binary chunk exceeds 256 KiB"));
    }
    Ok(())
}

pub fn capabilities() -> Value {
    json!({
        "version": 2,
        "permission": "rpc:binary",
        "maxChunkBytes": MAX_CHUNK_BYTES,
        "maxTransferBytes": MAX_TRANSFER_BYTES,
        "maxTotalBytes": MAX_TOTAL_BYTES,
        "maxTransfers": MAX_TRANSFERS,
        "immutableResources":true,
        "sidecarRawLane":true,
        "exchange":{"version":1,"maxReferences":MAX_RESOURCE_REFS,"maxPending":MAX_EXPORTS,"ticketTtlMs":EXPORT_TTL_MS},
    })
}

pub(crate) fn caller_key(
    window: &WebviewWindow,
    plugin: String,
    id: String,
    permission: &str,
) -> Result<TransferKey, ServiceError> {
    storage::validate_plugin_id(&plugin)?;
    host::registry::is_allowed(&plugin, permission)
        .map_err(|error| ServiceError::new(code::DENIED, error))?;
    validate_id(&id)?;
    Ok(TransferKey {
        window: window.label().to_owned(),
        plugin,
        id,
    })
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Control {
    Open { size: usize },
    Close,
    Seal,
    Stat,
}

#[tauri::command]
pub(crate) async fn plugin_binary_control(
    window: WebviewWindow,
    transfers: State<'_, Transfers>,
    plugin_id: String,
    id: String,
    action: Control,
) -> Result<Value, RpcRejection> {
    let key = caller_key(&window, plugin_id, id, "rpc:binary")?;
    match action {
        Control::Open { size } => {
            let _ticket = observe_rpc(window.label(), "binary", "open");
            transfers.open(key, size)?;
            Ok(json!({ "maxChunkBytes": MAX_CHUNK_BYTES }))
        }
        Control::Seal => Ok(transfers.seal(&key)?),
        Control::Stat => Ok(transfers.stat(&key)?),
        Control::Close => {
            let _ticket = observe_rpc(window.label(), "binary", "close");
            Ok(json!(transfers.close(&key)))
        }
    }
}

#[tauri::command]
pub(crate) async fn plugin_binary_write(
    window: WebviewWindow,
    transfers: State<'_, Transfers>,
    request: Request<'_>,
) -> Result<usize, RpcRejection> {
    let (plugin, id, offset) = chunk_headers(&request)?;
    let key = caller_key(&window, plugin.into(), id.into(), "rpc:binary")?;
    let offset = usize::try_from(offset)
        .map_err(|_| ServiceError::bad_params("invalid binary write offset"))?;
    let _ticket = observe_rpc(window.label(), "binary", "write");
    Ok(transfers.write(&key, offset, &chunk_body(&request)?)?)
}

pub(crate) fn chunk_headers<'a>(
    request: &'a Request<'_>,
) -> Result<(&'a str, &'a str, u64), ServiceError> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| ServiceError::bad_params(format!("missing or invalid {name} header")))
    };
    let offset = header("x-toolkit-offset")?
        .parse()
        .map_err(|_| ServiceError::bad_params("invalid binary write offset"))?;
    Ok((
        header("x-toolkit-plugin")?,
        header("x-toolkit-transfer")?,
        offset,
    ))
}

pub(crate) fn chunk_body<'a>(request: &'a Request<'_>) -> Result<Cow<'a, [u8]>, ServiceError> {
    match request.body() {
        InvokeBody::Raw(bytes) => {
            check_chunk_size(bytes.len())?;
            Ok(Cow::Borrowed(bytes))
        }
        InvokeBody::Json(value) => decode_fallback(value).map(Cow::Owned),
    }
}

/// Tauri's postMessage fallback can carry a byte buffer as a JSON number array.
pub fn decode_fallback(value: &Value) -> Result<Vec<u8>, ServiceError> {
    let values = value
        .as_array()
        .ok_or_else(|| ServiceError::bad_params("expected a binary request body"))?;
    check_chunk_size(values.len())?;
    values
        .iter()
        .map(|value| {
            value
                .as_u64()
                .and_then(|byte| u8::try_from(byte).ok())
                .ok_or_else(|| ServiceError::bad_params("invalid byte in IPC fallback array"))
        })
        .collect()
}

#[tauri::command]
pub(crate) async fn plugin_binary_read(
    window: WebviewWindow,
    transfers: State<'_, Transfers>,
    plugin_id: String,
    id: String,
    offset: usize,
    max_bytes: usize,
) -> Result<Response, RpcRejection> {
    let key = caller_key(&window, plugin_id, id, "rpc:binary")?;
    let _ticket = observe_rpc(window.label(), "binary", "read");
    Ok(Response::new(transfers.read(&key, offset, max_bytes)?))
}
