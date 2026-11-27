use super::{
    config::{Config, Connection},
    Host, Runtime,
};
use crate::services::{caller::Caller, ServiceError};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Manager;
use zeroize::Zeroizing;

#[tauri::command]
pub async fn host_llm_open(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("model settings can only be opened by the main window".into());
    }
    let result = async {
        let models = super::model_window::get_or_create(app.clone(), window).await?;
        tauri::async_runtime::spawn_blocking(move || {
            models
                .show()
                .and_then(|_| models.set_focus())
                .map_err(|error| super::model_window::failure("present", error))
        })
        .await
        .map_err(|_| super::model_window::failure("present", "window worker failed"))?
    }
    .await;
    if let Err(error) = &result {
        let error = error.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::services::storage::append_debug_log(&app, &format!("model settings: {error}"))
        })
        .await
        .ok();
    }
    result
}

#[tauri::command]
pub async fn host_llm_admin(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    action: String,
    mut params: Value,
) -> Result<Value, String> {
    if window.label() != "host-llm-settings" {
        return Err(
            "credential administration is restricted to the host model settings window".into(),
        );
    }
    let runtime = tauri::async_runtime::spawn_blocking(move || app.state::<Host>().get(&app))
        .await
        .map_err(|_| "model configuration worker failed")?
        .map_err(|e| e.msg)?;
    if action == "inspect_connection" {
        let connection: Connection = serde_json::from_value(params["connection"].take())
            .map_err(|_| "invalid connection settings")?;
        let key = match params["apiKey"].take() {
            Value::Null => None,
            Value::String(key) => Some(Zeroizing::new(key)),
            _ => return Err("invalid API key".into()),
        };
        return serde_json::to_value(
            runtime
                .inspect_connection(connection, key)
                .await
                .map_err(|e| e.to_string())?,
        )
        .map_err(|_| "cannot encode model catalog".into());
    }
    if action == "test" {
        let profile = params["profile"].as_str().ok_or("missing profile")?;
        return test_profile(&runtime, profile)
            .await
            .map_err(|error| error.to_string());
    }
    if action == "cancel_test" {
        return Ok(json!(runtime.cancel_caller(&Caller::admin())));
    }
    tauri::async_runtime::spawn_blocking(move || {
        match action.as_str() {
            "load" => {
                let config = runtime.configuration();
                let mut configured = serde_json::Map::new();
                for connection in &config.connections { configured.insert(connection.id.clone(),json!(runtime.credentials.read(&connection.id)?.is_some())); }
                Ok(json!({"config":config,"hasKeys":configured,"plugins":crate::host::registry::known(),"diagnostics":runtime.diagnostics()}))
            }
            "save" => {
                let config: Config = serde_json::from_value(params).map_err(|_|"invalid model configuration")?;
                runtime.save_configuration(config)?;
                Ok(json!(true))
            }
            "set_key" | "delete_key" => {
                let id = params["connectionId"].as_str().ok_or("missing connection id")?.to_string();
                if !runtime.configuration().connections.iter().any(|c|c.id==id) { return Err("model connection does not exist".into()); }
                runtime.cancel_all();
                if action == "set_key" {
                    let Value::String(key) = params["apiKey"].take() else { return Err("missing API key".into()); };
                    let key = Zeroizing::new(key);
                    runtime.credentials.write(&id,&key)?;
                } else { runtime.credentials.delete(&id)?; }
                runtime.cancel_all(); // Fence requests that read the old key during rotation.
                Ok(json!(true))
            }
            _ => Err("unknown model administration action".into()),
        }
    }).await.map_err(|_|"model settings worker failed".to_string())?
}

/// The same saved-profile diagnostic used by the settings command and native
/// checks. A complete stream without visible text is not marked text-verified.
pub async fn test_profile(runtime: &Arc<Runtime>, profile: &str) -> Result<Value, ServiceError> {
    let began = std::time::Instant::now();
    let limit = runtime
        .configuration()
        .profiles
        .iter()
        .find(|p| p.id == profile)
        .ok_or_else(|| ServiceError::not_found("model profile is not available"))?
        .max_output_tokens
        .min(256);
    let started = runtime.call(Caller::admin(),"start",json!({"profile":profile,"messages":[{"role":"user","content":[{"type":"text","text":"Reply with OK."}]}],"maxOutputTokens":limit})).await?;
    let mut text = String::new();
    let mut text_verified = false;
    let mut preview_truncated = false;
    loop {
        let event = runtime
            .call(Caller::admin(), "next", json!({"id":started["id"]}))
            .await?;
        if event["type"] == "text-delta" {
            let delta = event["text"].as_str().unwrap_or("");
            text_verified |= !delta.trim().is_empty();
            let remaining = 512 - text.chars().count().min(512);
            let mut chars = delta.chars();
            text.extend(chars.by_ref().take(remaining));
            preview_truncated |= chars.next().is_some();
        }
        if event["type"] == "completed" {
            return Ok(
                json!({"reasoningEffort":started["reasoningEffort"],"textVerified":text_verified,"text":text,"previewTruncated":preview_truncated,"finishReason":event["finishReason"],"usage":event["usage"],"elapsedMs":began.elapsed().as_millis()}),
            );
        }
    }
}
