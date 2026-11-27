//! Typed effort policy; adapters own wire spelling, plugins use neutral fields.
use super::config::{Adapter, Connection, Profile};
use crate::services::ServiceError;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatOutputTokens {
    MaxTokens,
    #[default]
    MaxCompletionTokens,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub default_effort: Option<String>,
    pub allowed_efforts: Vec<String>,
    #[serde(default)]
    pub chat_output_tokens: ChatOutputTokens,
}
fn valid_level(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_".contains(&b))
}
impl Config {
    pub fn validate(&self, connection: &Connection) -> Result<(), String> {
        let mut seen = HashSet::new();
        if self.allowed_efforts.is_empty()
            || self.allowed_efforts.len() > 16
            || self
                .allowed_efforts
                .iter()
                .any(|s| !valid_level(s) || !seen.insert(s))
        {
            return Err("reasoning allowedEfforts must contain 1..16 unique lowercase level names (maximum 32 characters)".into());
        }
        if self
            .default_effort
            .as_ref()
            .is_some_and(|effort| !self.allowed_efforts.contains(effort))
        {
            return Err("default reasoning effort must be included in allowedEfforts".into());
        }
        let official_claude = reqwest::Url::parse(&connection.base_url)
            .ok()
            .is_some_and(|url| url.host_str() == Some("api.anthropic.com"));
        if connection.adapter == Adapter::OpenaiChat && official_claude {
            return Err("Claude's official OpenAI-compatible API ignores reasoning_effort; keep effort control disabled for this connection".into());
        }
        Ok(())
    }
}
pub fn resolve(
    profile: &Profile,
    requested: Option<String>,
) -> Result<Option<String>, ServiceError> {
    match (&profile.reasoning, requested) {
        (None, None) => Ok(None),
        (None, Some(_)) => Err(ServiceError::unsupported(
            "reasoning effort is not enabled for this profile",
        )),
        (Some(config), Some(level)) if config.allowed_efforts.contains(&level) => Ok(Some(level)),
        (Some(_), Some(_)) => Err(ServiceError::bad_params(
            "reasoning effort is outside the profile's allowedEfforts",
        )),
        (Some(config), None) => Ok(config.default_effort.clone()),
    }
}
