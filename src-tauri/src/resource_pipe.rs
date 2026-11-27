//! Optional per-instance raw lane. Control RPC remains independent of large bytes.
use crate::{
    binary_ipc::{Transfers, MAX_CHUNK_BYTES},
    services::{caller::Caller, ServiceError},
};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub async fn serve<T: AsyncRead + AsyncWrite + Unpin>(
    mut pipe: T,
    store: &Transfers,
    caller: &Caller,
) -> Result<(), ServiceError> {
    loop {
        let header = toolkit_host::wire::read_frame(&mut pipe)
            .await
            .map_err(|_| ServiceError::io("resource lane closed"))?;
        crate::host::registry::is_allowed(&caller.plugin, "rpc:binary")
            .map_err(|_| ServiceError::new("denied", "binary permission revoked"))?;
        let id = header["id"]
            .as_str()
            .ok_or_else(|| ServiceError::bad_params("missing resource id"))?;
        let offset = number(&header, "offset")?;
        let length = number(&header, "length")?;
        if length > MAX_CHUNK_BYTES {
            return Err(ServiceError::bad_params("resource chunk exceeds 256 KiB"));
        }
        let key = Transfers::key(caller, id)?;
        let mut raw = vec![0; length];
        let result = match header["op"].as_str() {
            Some("write") => {
                pipe.read_exact(&mut raw)
                    .await
                    .map_err(|_| ServiceError::io("resource upload interrupted"))?;
                store
                    .write(&key, offset, &raw)
                    .map(|ack| (json!({"ok":true,"offset":ack,"length":0}), Vec::new()))
            }
            Some("read") => store
                .read(&key, offset, length)
                .map(|bytes| (json!({"ok":true,"length":bytes.len()}), bytes)),
            _ => return Err(ServiceError::bad_params("invalid resource operation")),
        };
        let (reply, bytes) = result.unwrap_or_else(|e| {
            (
                json!({"ok":false,"code":e.code,"message":e.msg}),
                Vec::new(),
            )
        });
        toolkit_host::wire::write_frame(&mut pipe, &reply)
            .await
            .map_err(|_| ServiceError::io("resource reply interrupted"))?;
        pipe.write_all(&bytes)
            .await
            .map_err(|_| ServiceError::io("resource download interrupted"))?;
    }
}
fn number(v: &Value, key: &str) -> Result<usize, ServiceError> {
    v[key]
        .as_u64()
        .and_then(|v| usize::try_from(v).ok())
        .ok_or_else(|| ServiceError::bad_params("invalid resource range"))
}
