use super::{caller::Caller, Service, ServiceError, ServiceFuture};
use crate::llm::{Host, Runtime};
use crate::sidecar_rpc::PeerService;
use serde_json::Value;
use std::sync::Arc;
use tauri::Manager;

pub struct LlmService;
impl Service for LlmService {
    fn name(&self) -> &'static str {
        "llm"
    }
    fn actions(&self) -> &'static [&'static str] {
        &["profiles", "start", "next", "cancel", "cancel_all"]
    }
    fn dispatch(
        &self,
        _: &tauri::AppHandle,
        _: &str,
        _: &str,
        _: Value,
    ) -> Result<Value, ServiceError> {
        Err(ServiceError::unsupported(
            "model requests require asynchronous dispatch",
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
            let runtime = tokio::task::spawn_blocking(move || app.state::<Host>().get(&app))
                .await
                .map_err(|_| ServiceError::internal("model initialization worker failed"))??;
            runtime.call(caller, &action, params).await
        })
    }
    fn sidecar_handler(
        &self,
        app: &tauri::AppHandle,
        caller: Caller,
    ) -> Result<Option<PeerService>, ServiceError> {
        Ok(Some(peer(app.state::<Host>().get(app)?, caller)))
    }
}
pub fn peer(runtime: Arc<Runtime>, caller: Caller) -> PeerService {
    let close_runtime = runtime.clone();
    let close_caller = caller.clone();
    PeerService {
        actions: LlmService.actions().iter().map(|s| s.to_string()).collect(),
        handler: Arc::new(move |action, params| {
            let runtime = runtime.clone();
            let caller = caller.clone();
            Box::pin(async move { runtime.call(caller, &action, params).await })
        }),
        close: Arc::new(move || {
            close_runtime.cancel_caller(&close_caller);
        }),
    }
}
