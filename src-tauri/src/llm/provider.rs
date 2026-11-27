use super::{
    config::{Adapter, Connection, Profile},
    Request, MAX_EVENT_BYTES,
};
use crate::services::ServiceError;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::mpsc;
use zeroize::Zeroizing;

/// A complete SSE event is decoded only after its byte boundaries are known.
/// Neither a split UTF-8 codepoint nor a split CRLF can corrupt a text delta.
#[derive(Default)]
pub struct SseDecoder {
    line: Vec<u8>,
    data: Vec<u8>,
}
impl SseDecoder {
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<String>, ServiceError> {
        let mut events = Vec::new();
        for &byte in bytes {
            if byte != b'\n' {
                if self.line.len() >= 64 * 1024 {
                    return Err(ServiceError::io("provider SSE line exceeds 64 KiB"));
                }
                self.line.push(byte);
                continue;
            }
            if self.line.last() == Some(&b'\r') {
                self.line.pop();
            }
            if self.line.is_empty() {
                if !self.data.is_empty() {
                    if self.data.last() == Some(&b'\n') {
                        self.data.pop();
                    }
                    let data = String::from_utf8(std::mem::take(&mut self.data))
                        .map_err(|_| ServiceError::io("provider sent invalid SSE UTF-8"))?;
                    events.push(data);
                }
            } else if self.line.starts_with(b"data:") {
                let value = self.line[5..].strip_prefix(b" ").unwrap_or(&self.line[5..]);
                if self.data.len() + value.len() > 64 * 1024 {
                    return Err(ServiceError::io("provider SSE event exceeds 64 KiB"));
                }
                self.data.extend_from_slice(value);
                self.data.push(b'\n');
            }
            self.line.clear();
        }
        Ok(events)
    }
}

async fn send(
    tx: &mpsc::Sender<Result<Value, ServiceError>>,
    event: Value,
) -> Result<(), ServiceError> {
    if serde_json::to_vec(&event)
        .map_err(|_| ServiceError::internal("cannot encode model event"))?
        .len()
        > MAX_EVENT_BYTES
    {
        return Err(ServiceError::io("model event exceeds its IPC bound"));
    }
    tokio::time::timeout(Duration::from_secs(30), tx.send(Ok(event)))
        .await
        .map_err(|_| ServiceError::conflict("model consumer has not advanced for 30s"))?
        .map_err(|_| ServiceError::conflict("model consumer closed"))
}
async fn text(
    tx: &mpsc::Sender<Result<Value, ServiceError>>,
    mut value: &str,
) -> Result<(), ServiceError> {
    while !value.is_empty() {
        let mut end = value.len().min(2048);
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        send(
            tx,
            json!({"type":"text-delta","index":0,"text":&value[..end]}),
        )
        .await?;
        value = &value[end..];
    }
    Ok(())
}
fn usage(value: &Value, adapter: Adapter) -> Value {
    let (input, output) = if adapter == Adapter::OpenaiChat {
        (&value["prompt_tokens"], &value["completion_tokens"])
    } else {
        (&value["input_tokens"], &value["output_tokens"])
    };
    json!({"inputTokens":input.as_u64(),"outputTokens":output.as_u64(),"totalTokens":value["total_tokens"].as_u64()})
}

pub(super) fn authorize(
    mut request: reqwest::RequestBuilder,
    key: Option<&str>,
) -> Result<reqwest::RequestBuilder, ServiceError> {
    if let Some(key) = key {
        let mut header = reqwest::header::HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| ServiceError::bad_params("API key is not a valid HTTP credential"))?;
        header.set_sensitive(true);
        request = request.header(reqwest::header::AUTHORIZATION, header);
    }
    Ok(request)
}

pub(super) fn http_error(status: u16) -> ServiceError {
    let (code, message) = match status {
        401 | 403 => ("denied", "API rejected authentication or access"),
        429 => ("conflict", "API rate limit or quota was reached"),
        400 | 404 | 422 => (
            "bad_params",
            "API rejected the endpoint, model or request parameters",
        ),
        _ => ("io", "API returned an unsuccessful HTTP status"),
    };
    ServiceError::new(code, format!("{message} (HTTP {status})"))
}

pub async fn generate(
    client: &reqwest::Client,
    connection: &Connection,
    profile: &Profile,
    key: Option<Zeroizing<String>>,
    request: Request,
    images: super::vision::Images,
    image_permit: tokio::sync::OwnedSemaphorePermit,
    tx: mpsc::Sender<Result<Value, ServiceError>>,
) -> Result<(), ServiceError> {
    let adapter = connection.adapter;
    let model = profile.model.clone();
    let chat_output_tokens = profile
        .reasoning
        .as_ref()
        .map(|r| r.chat_output_tokens)
        .unwrap_or(super::reasoning::ChatOutputTokens::MaxTokens);
    let (body, _images, _image_permit) = tokio::task::spawn_blocking(move || {
        let body = super::vision::body(adapter, &model, request, &images, chat_output_tokens)?;
        Ok::<_, ServiceError>((body, images, image_permit))
    })
    .await
    .map_err(|_| ServiceError::internal("model body worker failed"))??;
    let endpoint = if adapter == Adapter::OpenaiChat {
        "chat/completions"
    } else {
        "responses"
    };
    let url = format!("{}/{endpoint}", connection.base_url.trim_end_matches('/'));
    let http = client
        .post(url)
        .header("Content-Type", "application/json")
        .body(body)
        .header("Accept", "text/event-stream");
    let http = authorize(http, key.as_ref().map(|key| key.as_str()))?;
    // HTTP diagnostics are deliberately static: provider bodies and URLs can
    // contain credentials or user content and must not enter the host log.
    let mut response = http
        .send()
        .await
        .map_err(|_| ServiceError::io("model connection failed"))?;
    if !response.status().is_success() {
        return Err(http_error(response.status().as_u16()));
    }
    if !response
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|s| s.starts_with("text/event-stream"))
    {
        return Err(ServiceError::io(
            "model provider did not return an SSE stream",
        ));
    }
    let mut decoder = SseDecoder::default();
    let mut reported_usage = json!({"inputTokens":null,"outputTokens":null,"totalTokens":null});
    let mut finish: Option<String> = None;
    let mut complete = false;
    'body: while let Some(bytes) = response
        .chunk()
        .await
        .map_err(|_| ServiceError::io("model connection interrupted"))?
    {
        for data in decoder.feed(&bytes)? {
            if data == "[DONE]" && connection.adapter == Adapter::OpenaiChat {
                complete = true;
                break 'body;
            }
            let event: Value = serde_json::from_str(&data)
                .map_err(|_| ServiceError::io("model provider sent invalid event JSON"))?;
            if !event["error"].is_null() {
                return Err(ServiceError::io("model provider reported a stream error"));
            }
            match connection.adapter {
                Adapter::OpenaiChat => {
                    if !event["usage"].is_null() {
                        reported_usage = usage(&event["usage"], connection.adapter);
                    }
                    if let Some(choice) = event["choices"].as_array().and_then(|a| a.first()) {
                        if choice["delta"]["tool_calls"]
                            .as_array()
                            .is_some_and(|a| !a.is_empty())
                        {
                            return Err(ServiceError::unsupported(
                                "model returned tool calls; tool execution is not enabled",
                            ));
                        }
                        if let Some(delta) = choice["delta"]["content"].as_str() {
                            text(&tx, delta).await?;
                        }
                        if let Some(reason) = choice["finish_reason"].as_str() {
                            if matches!(reason, "tool_calls" | "function_call") {
                                return Err(ServiceError::unsupported(
                                    "model returned tool calls; tool execution is not enabled",
                                ));
                            }
                            finish = Some(
                                match reason {
                                    "stop" => "stop",
                                    "length" => "length",
                                    "content_filter" => "content_filter",
                                    _ => "other",
                                }
                                .into(),
                            );
                        }
                    }
                }
                Adapter::OpenaiResponses => match event["type"].as_str().unwrap_or("") {
                    "response.output_item.added" | "response.output_item.done"
                        if event["item"]["type"]
                            .as_str()
                            .is_some_and(|kind| !matches!(kind, "message" | "reasoning")) =>
                    {
                        return Err(ServiceError::unsupported(
                            "model returned an unsupported output item",
                        ));
                    }
                    "response.output_text.delta" => {
                        text(
                            &tx,
                            event["delta"]
                                .as_str()
                                .ok_or_else(|| ServiceError::io("invalid text delta"))?,
                        )
                        .await?
                    }
                    "response.completed" => {
                        finish = Some("stop".into());
                        reported_usage = usage(&event["response"]["usage"], connection.adapter);
                        complete = true;
                        break 'body;
                    }
                    "response.incomplete" => {
                        finish = Some(
                            match event["response"]["incomplete_details"]["reason"].as_str() {
                                Some("max_output_tokens") => "length",
                                Some("content_filter") => "content_filter",
                                _ => "other",
                            }
                            .into(),
                        );
                        reported_usage = usage(&event["response"]["usage"], connection.adapter);
                        complete = true;
                        break 'body;
                    }
                    "response.failed" | "error" => {
                        return Err(ServiceError::io("model provider reported a stream failure"))
                    }
                    "response.refusal.delta" => {
                        return Err(ServiceError::new("denied", "model declined the request"))
                    }
                    "response.function_call_arguments.delta" => {
                        return Err(ServiceError::unsupported(
                            "model returned an unsupported tool call",
                        ))
                    }
                    _ => {}
                },
            }
        }
    }
    if !complete {
        return Err(ServiceError::io(
            "model stream ended before its completion event",
        ));
    }
    send(&tx, json!({"type":"completed","finishReason":finish.unwrap_or_else(||"stop".into()),"usage":reported_usage})).await
}
