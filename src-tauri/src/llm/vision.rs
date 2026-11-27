//! Model-neutral resource references. No file paths, remote URLs, or base64 on IPC.
use super::{config::Adapter, ContentPart, Request, ResourceSource};
use crate::{
    binary_ipc::{Allocation, Transfers},
    services::{caller::Caller, ServiceError},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
pub struct Image {
    pub data: Arc<Allocation>,
    mime: &'static str,
}
pub type Images = HashMap<String, Image>;
pub fn prepare(
    store: &Transfers,
    caller: &Caller,
    request: &Request,
    allowed: bool,
) -> Result<Images, ServiceError> {
    let mut images = Images::new();
    let mut count = 0;
    let mut bytes = 0;
    let mut pixels = 0u64;
    for part in request.messages.iter().flat_map(|m| &m.content) {
        if let ContentPart::Image {
            source: ResourceSource::Resource { id, size },
            ..
        } = part
        {
            if !allowed {
                return Err(ServiceError::new(
                    "denied",
                    "image input is disabled for this model profile",
                ));
            }
            count += 1;
            if count > 8 {
                return Err(ServiceError::bad_params(
                    "at most 8 images per model request",
                ));
            }
            let data = store.borrow(&Transfers::key(caller, id)?)?;
            if size.is_some_and(|size| size != data.bytes.len()) {
                return Err(ServiceError::bad_params(
                    "resource size metadata does not match its sealed contents",
                ));
            }
            let reader = image::ImageReader::new(std::io::Cursor::new(&data.bytes))
                .with_guessed_format()
                .map_err(|_| ServiceError::bad_params("invalid image header"))?;
            let mime = match reader.format() {
                Some(image::ImageFormat::Png) => "image/png",
                Some(image::ImageFormat::Jpeg) => "image/jpeg",
                Some(image::ImageFormat::WebP) => "image/webp",
                _ => {
                    return Err(ServiceError::unsupported(
                        "image input supports PNG, JPEG and WebP",
                    ))
                }
            };
            let (w, h) = reader
                .into_dimensions()
                .map_err(|_| ServiceError::bad_params("invalid image dimensions"))?;
            let area = u64::from(w) * u64::from(h);
            pixels += area;
            bytes += data.bytes.len();
            if area == 0 || area > 16_000_000 || pixels > 32_000_000 || bytes > 16 * 1024 * 1024 {
                return Err(ServiceError::bad_params(
                    "image budget exceeded: 16 MP/image, 32 MP and 16 MiB/request",
                ));
            }
            images.entry(id.clone()).or_insert(Image { data, mime });
        }
    }
    Ok(images)
}
pub fn body(
    adapter: Adapter,
    model: &str,
    request: Request,
    images: &Images,
    chat_output_tokens: super::reasoning::ChatOutputTokens,
) -> Result<Vec<u8>, ServiceError> {
    let mut messages = Vec::new();
    for message in request.messages {
        let has_images = message
            .content
            .iter()
            .any(|p| matches!(p, ContentPart::Image { .. }));
        let content = if !has_images {
            json!(message
                .content
                .into_iter()
                .filter_map(|p| match p {
                    ContentPart::Text { text } => Some(text),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(""))
        } else {
            let mut parts = Vec::new();
            for part in message.content {
                parts.push(match part {
                    ContentPart::Text { text } => {
                        if adapter == Adapter::OpenaiChat {
                            json!({"type":"text","text":text})
                        } else {
                            json!({"type":"input_text","text":text})
                        }
                    }
                    ContentPart::Image {
                        source: ResourceSource::Resource { id, .. },
                        detail,
                    } => {
                        let image = images
                            .get(&id)
                            .ok_or_else(|| ServiceError::not_found("image lease missing"))?;
                        let mut url = format!("data:{};base64,", image.mime);
                        STANDARD.encode_string(&image.data.bytes, &mut url);
                        if adapter == Adapter::OpenaiChat {
                            json!({"type":"image_url","image_url":{"url":url,"detail":detail}})
                        } else {
                            json!({"type":"input_image","image_url":url,"detail":detail})
                        }
                    }
                });
            }
            Value::Array(parts)
        };
        messages.push(json!({"role":message.role,"content":content}));
    }
    let mut body = if adapter == Adapter::OpenaiChat {
        json!({"model":model,"messages":messages,"stream":true,"max_tokens":request.max_output_tokens,"stream_options":{"include_usage":true}})
    } else {
        json!({"model":model,"input":messages,"stream":true,"max_output_tokens":request.max_output_tokens,"store":false})
    };
    if adapter == Adapter::OpenaiChat
        && matches!(
            chat_output_tokens,
            super::reasoning::ChatOutputTokens::MaxCompletionTokens
        )
    {
        let max_tokens = body.as_object_mut().unwrap().remove("max_tokens").unwrap();
        body["max_completion_tokens"] = max_tokens;
    }
    if let Some(effort) = request.reasoning_effort {
        if adapter == Adapter::OpenaiChat {
            body["reasoning_effort"] = json!(effort);
        } else {
            body["reasoning"] = json!({"effort":effort});
        }
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature);
    }
    serde_json::to_vec(&body).map_err(|_| ServiceError::internal("cannot encode model request"))
}
