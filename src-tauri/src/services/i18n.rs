//! Read-only language metadata over both native transports. Mutations remain
//! restricted to the host settings window, outside the plugin service table.
use super::{caller::Caller, Service, ServiceError, ServiceFuture};
use crate::sidecar_rpc::PeerService;
use serde_json::Value;
use std::sync::Arc;

pub struct I18nService;
fn read(app: tauri::AppHandle) -> ServiceFuture {
    Box::pin(async move {
        let snapshot = tauri::async_runtime::spawn_blocking(move || crate::locale::read(&app))
            .await
            .map_err(|_| ServiceError::internal("language worker failed"))?
            .map_err(ServiceError::io)?;
        serde_json::to_value(snapshot)
            .map_err(|_| ServiceError::internal("cannot encode language snapshot"))
    })
}
impl Service for I18nService {
    fn name(&self) -> &'static str {
        "i18n"
    }
    fn actions(&self) -> &'static [&'static str] {
        &["get"]
    }
    fn asynchronous(&self) -> bool {
        true
    }
    fn dispatch(
        &self,
        _: &tauri::AppHandle,
        _: &str,
        _: &str,
        _: Value,
    ) -> Result<Value, ServiceError> {
        Err(ServiceError::unsupported(
            "language reads require asynchronous dispatch",
        ))
    }
    fn dispatch_async(
        &self,
        app: tauri::AppHandle,
        _: Caller,
        _: String,
        _: Value,
    ) -> ServiceFuture {
        read(app)
    }
    fn sidecar_handler(
        &self,
        app: &tauri::AppHandle,
        _: Caller,
    ) -> Result<Option<PeerService>, ServiceError> {
        let app = app.clone();
        Ok(Some(PeerService {
            actions: self
                .actions()
                .iter()
                .map(|action| action.to_string())
                .collect(),
            handler: Arc::new(move |_, _| read(app.clone())),
            close: Arc::new(|| {}),
        }))
    }
}
