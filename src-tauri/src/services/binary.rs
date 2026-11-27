//! Generic immutable resources; payload bytes use the raw data transport.
use super::{caller::Caller, Service, ServiceError, ServiceFuture};
use crate::{binary_ipc::Transfers, sidecar_rpc::PeerService};
use serde_json::Value;
use std::sync::Arc;
use tauri::Manager;
pub struct BinaryService;
impl Service for BinaryService {
    fn name(&self) -> &'static str {
        "binary"
    }
    fn actions(&self) -> &'static [&'static str] {
        &["open", "seal", "stat", "close", "close_all", "identity", "export", "import", "revoke"]
    }
    fn dispatch(
        &self,
        _: &tauri::AppHandle,
        _: &str,
        _: &str,
        _: Value,
    ) -> Result<Value, ServiceError> {
        Err(ServiceError::unsupported(
            "binary control requires native caller attribution",
        ))
    }
    fn asynchronous(&self) -> bool {
        true
    }
    fn dispatch_async(
        &self,
        app: tauri::AppHandle,
        caller: Caller,
        action: String,
        params: Value,
    ) -> ServiceFuture {
        Box::pin(async move {
            if action == "close_all" && params["scope"] == "plugin" && caller.owner == "window:main"
            {
                app.state::<Transfers>().close_plugin(&caller.plugin);
                Ok(Value::Null)
            } else {
                app.state::<Transfers>().control(&caller, &action, params)
            }
        })
    }
    fn sidecar_handler(
        &self,
        app: &tauri::AppHandle,
        caller: Caller,
    ) -> Result<Option<PeerService>, ServiceError> {
        Ok(Some(peer(app.state::<Transfers>().inner().clone(), caller)))
    }
}
pub fn peer(store: Transfers, caller: Caller) -> PeerService {
    let cleanup = store.clone();
    let owner = caller.clone();
    PeerService {
        actions: BinaryService
            .actions()
            .iter()
            .map(|a| a.to_string())
            .collect(),
        handler: Arc::new(move |action, params| {
            let store = store.clone();
            let caller = caller.clone();
            Box::pin(async move { store.control(&caller, &action, params) })
        }),
        close: Arc::new(move || cleanup.close_caller(&owner)),
    }
}
