//! Bounded byte buffers owned by a plugin in one WebView window.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Mutex;

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

struct Transfer {
    size: usize,
    bytes: Vec<u8>,
}

#[derive(Default)]
pub struct Transfers(Mutex<HashMap<TransferKey, Transfer>>);

impl Transfers {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<TransferKey, Transfer>> {
        self.0.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub fn open(&self, key: TransferKey, size: usize) -> Result<(), ServiceError> {
        if size > MAX_TRANSFER_BYTES {
            return Err(ServiceError::bad_params("binary transfer exceeds 16 MiB"));
        }
        let mut transfers = self.lock();
        if let Some(existing) = transfers.get(&key) {
            return if size == existing.size {
                Ok(())
            } else {
                Err(ServiceError::conflict(
                    "transfer is already open with a different size",
                ))
            };
        }
        let reserved: usize = transfers.values().map(|transfer| transfer.size).sum();
        if transfers.len() >= MAX_TRANSFERS || reserved + size > MAX_TOTAL_BYTES {
            return Err(ServiceError::conflict("binary transfer budget exhausted"));
        }
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(size)
            .map_err(|error| ServiceError::internal(format!("reserve binary buffer: {error}")))?;
        transfers.insert(key, Transfer { size, bytes });
        Ok(())
    }

    pub fn write(
        &self,
        key: &TransferKey,
        offset: usize,
        bytes: &[u8],
    ) -> Result<usize, ServiceError> {
        check_chunk_size(bytes.len())?;
        let mut transfers = self.lock();
        let transfer = transfers.get_mut(key).ok_or_else(missing_transfer)?;
        let end = offset
            .checked_add(bytes.len())
            .filter(|end| *end <= transfer.size)
            .ok_or_else(|| ServiceError::bad_params("write exceeds the declared transfer size"))?;
        if offset == transfer.bytes.len() {
            transfer.bytes.extend_from_slice(bytes);
        } else if transfer.bytes.get(offset..end) != Some(bytes) {
            return Err(ServiceError::conflict(
                "write must continue at the acknowledged offset or repeat existing bytes",
            ));
        }
        Ok(transfer.bytes.len())
    }

    pub fn read(
        &self,
        key: &TransferKey,
        offset: usize,
        max_bytes: usize,
    ) -> Result<Vec<u8>, ServiceError> {
        check_chunk_size(max_bytes)?;
        let transfers = self.lock();
        let transfer = transfers.get(key).ok_or_else(missing_transfer)?;
        let remaining = transfer
            .bytes
            .get(offset..)
            .ok_or_else(|| ServiceError::bad_params("read offset exceeds acknowledged bytes"))?;
        Ok(remaining[..remaining.len().min(max_bytes)].to_vec())
    }

    pub fn close(&self, key: &TransferKey) -> bool {
        self.lock().remove(key).is_some()
    }

    pub fn close_window(&self, window: &str) {
        self.lock().retain(|key, _| key.window != window);
    }
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
        "version": 1,
        "permission": "rpc:binary",
        "maxChunkBytes": MAX_CHUNK_BYTES,
        "maxTransferBytes": MAX_TRANSFER_BYTES,
        "maxTotalBytes": MAX_TOTAL_BYTES,
        "maxTransfers": MAX_TRANSFERS,
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
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(ServiceError::bad_params("invalid resource id"));
    }
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
