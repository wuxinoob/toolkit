//! Explicit, read-only model discovery. Provider declarations are not proof that
//! a particular inference request, modality or reasoning parameter will work.
use super::{config::Connection, provider};
use crate::services::ServiceError;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_MODELS: usize = 2048;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: Option<String>,
    pub owner: Option<String>,
    pub kind: Option<String>,
    pub input_modalities: Option<Vec<String>>,
    pub output_modalities: Option<Vec<String>>,
    pub context_window: Option<u64>,
    pub max_input_tokens: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub declared_capabilities: Option<BTreeMap<String, bool>>,
    pub reasoning_efforts: Option<Vec<String>>,
    pub default_reasoning_effort: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub status: &'static str,
    pub http_status: u16,
    pub elapsed_ms: u128,
    pub models: Vec<Model>,
    pub has_more: bool,
}

fn string(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 512)
        .map(str::to_owned)
}
fn strings(value: &Value) -> Option<Vec<String>> {
    let values = value.as_array()?;
    if values.len() > 64 {
        return None;
    }
    values.iter().map(string).collect()
}
fn positive(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| *n > 0)
}

fn supported_flags(value: &Value) -> Option<BTreeMap<String, bool>> {
    let flags: BTreeMap<_, _> = value
        .as_object()?
        .iter()
        .take(64)
        .filter_map(|(name, value)| {
            if name.len() > 128 {
                return None;
            }
            value
                .as_bool()
                .or_else(|| value["supported"].as_bool())
                .map(|supported| (name.clone(), supported))
        })
        .collect();
    if flags.is_empty() {
        None
    } else {
        Some(flags)
    }
}

fn parse_models(body: &Value) -> Result<(Vec<Model>, bool), ServiceError> {
    let entries = body["data"]
        .as_array()
        .ok_or_else(|| ServiceError::io("API returned JSON without a model data array"))?;
    let mut models = BTreeMap::new();
    for entry in entries.iter().take(MAX_MODELS) {
        let id = entry["id"]
            .as_str()
            .filter(|id| !id.trim().is_empty() && id.len() <= 256)
            .ok_or_else(|| ServiceError::io("API returned an invalid model id"))?;
        models.entry(id.to_string()).or_insert_with(|| Model {
            id: id.into(),
            name: string(&entry["display_name"]).or_else(|| string(&entry["name"])),
            owner: string(&entry["owned_by"]),
            kind: string(&entry["sub_type"])
                .or_else(|| string(&entry["type"]).filter(|kind| kind != "model")),
            input_modalities: strings(&entry["input_modalities"])
                .or_else(|| strings(&entry["capabilities"]["input_modalities"])),
            output_modalities: strings(&entry["output_modalities"])
                .or_else(|| strings(&entry["capabilities"]["output_modalities"])),
            context_window: positive(&entry["context_window"]),
            max_input_tokens: positive(&entry["max_input_tokens"]),
            max_output_tokens: positive(&entry["max_output_tokens"])
                .or_else(|| positive(&entry["max_tokens"])),
            declared_capabilities: supported_flags(&entry["capabilities"]),
            reasoning_efforts: strings(&entry["effort"]["supported_levels"]).or_else(|| {
                let mut flags = supported_flags(&entry["capabilities"]["effort"])?;
                flags.remove("supported");
                if flags.is_empty() {
                    None
                } else {
                    Some(
                        flags
                            .into_iter()
                            .filter(|(_, supported)| *supported)
                            .map(|(name, _)| name)
                            .collect(),
                    )
                }
            }),
            default_reasoning_effort: string(&entry["effort"]["default_level"]),
        });
    }
    Ok((
        models.into_values().collect(),
        entries.len() > MAX_MODELS || body["has_more"] == true,
    ))
}

pub(super) async fn inspect(
    client: &reqwest::Client,
    connection: &Connection,
    key: Option<Zeroizing<String>>,
) -> Result<Catalog, ServiceError> {
    let started = Instant::now();
    let url = format!("{}/models", connection.base_url.trim_end_matches('/'));
    let request = provider::authorize(
        client
            .get(url)
            .header("Accept", "application/json")
            .timeout(Duration::from_secs(15)),
        key.as_ref().map(|key| key.as_str()),
    )?;
    let mut response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            ServiceError::new("timeout", "model catalog request timed out")
        } else {
            ServiceError::io(
                "cannot connect to the model API; check the base URL, network and proxy",
            )
        }
    })?;
    let status = response.status().as_u16();
    if matches!(status, 404 | 405 | 501) {
        return Ok(Catalog {
            status: "unsupported",
            http_status: status,
            elapsed_ms: started.elapsed().as_millis(),
            models: Vec::new(),
            has_more: false,
        });
    }
    if !response.status().is_success() {
        return Err(provider::http_error(status));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        if error.is_timeout() {
            ServiceError::new("timeout", "model catalog response timed out")
        } else {
            ServiceError::io("model catalog connection was interrupted")
        }
    })? {
        if body.len() + chunk.len() > MAX_BODY_BYTES {
            return Err(ServiceError::io(
                "model catalog exceeds the 1 MiB response limit",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let body: Value = serde_json::from_slice(&body)
        .map_err(|_| ServiceError::io("model API did not return valid JSON; check the base URL"))?;
    let (models, has_more) = parse_models(&body)?;
    Ok(Catalog {
        status: "available",
        http_status: status,
        elapsed_ms: started.elapsed().as_millis(),
        models,
        has_more,
    })
}
