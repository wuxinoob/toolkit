use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Write;
use std::path::Path;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub adapter: Adapter,
    pub base_url: String,
}
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Adapter {
    OpenaiChat,
    OpenaiResponses,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub connection_id: String,
    pub model: String,
    #[serde(default = "default_tokens")]
    pub max_output_tokens: u32,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub allowed_plugins: Vec<String>,
    #[serde(default)]
    pub allow_images: bool,
    #[serde(default)]
    pub reasoning: Option<super::reasoning::Config>,
}
fn default_tokens() -> u32 {
    4096
}
fn default_timeout() -> u64 {
    180_000
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub connections: Vec<Connection>,
    #[serde(default)]
    pub profiles: Vec<Profile>,
    pub default_profile: Option<String>,
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}
impl Connection {
    pub fn validate(&self) -> Result<(), String> {
        if !valid_id(&self.id) {
            return Err("invalid connection id".into());
        }
        let url = reqwest::Url::parse(&self.base_url).map_err(|_| "invalid API base URL")?;
        let local = matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        );
        if !(url.scheme() == "https" || (url.scheme() == "http" && local))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("base URL must be HTTPS (HTTP is allowed for loopback), without credentials, query or fragment".into());
        }
        Ok(())
    }
}
impl Config {
    pub fn validate(&self) -> Result<(), String> {
        if self.connections.len() > 32 || self.profiles.len() > 128 {
            return Err("too many model connections or profiles".into());
        }
        let mut ids = HashSet::new();
        for connection in &self.connections {
            connection.validate()?;
            if !ids.insert(&connection.id) {
                return Err("connection ids must be unique and contain only letters, digits, dot, dash or underscore".into());
            }
        }
        let mut profiles = HashSet::new();
        for profile in &self.profiles {
            if !valid_id(&profile.id)
                || !profiles.insert(&profile.id)
                || !ids.contains(&profile.connection_id)
                || profile.model.trim().is_empty()
                || profile.model.len() > 256
            {
                return Err("invalid model profile or connection reference".into());
            }
            if !(1..=32768).contains(&profile.max_output_tokens)
                || !(1000..=600_000).contains(&profile.timeout_ms)
            {
                return Err(
                    "output limit must be 1..32768 tokens and timeout 1000..600000 ms".into(),
                );
            }
            if let Some(reasoning) = &profile.reasoning {
                let connection = self
                    .connections
                    .iter()
                    .find(|c| c.id == profile.connection_id)
                    .unwrap();
                reasoning.validate(connection)?;
            }
            for plugin in &profile.allowed_plugins {
                crate::services::storage::validate_plugin_id(plugin)
                    .map_err(|_| "invalid allowed plugin id")?;
                if plugin == "__host__" {
                    return Err("reserved host identity cannot be granted".into());
                }
            }
        }
        if self
            .default_profile
            .as_ref()
            .is_some_and(|id| !profiles.contains(id))
        {
            return Err("default profile does not exist".into());
        }
        Ok(())
    }
    pub fn load(path: &Path) -> Result<Self, String> {
        match std::fs::read(path) {
            Ok(bytes) => {
                let config: Self = serde_json::from_slice(&bytes)
                    .map_err(|_| "LLM configuration is invalid JSON")?;
                config.validate()?;
                Ok(config)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => Err("cannot read LLM configuration".into()),
        }
    }
    pub fn save(&self, path: &Path) -> Result<(), String> {
        self.validate()?;
        let parent = path.parent().ok_or("invalid configuration path")?;
        std::fs::create_dir_all(parent).map_err(|_| "cannot create LLM configuration directory")?;
        let mut file = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "cannot stage LLM configuration")?;
        file.write_all(
            &serde_json::to_vec_pretty(self).map_err(|_| "cannot encode configuration")?,
        )
        .map_err(|_| "cannot write LLM configuration")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "cannot sync LLM configuration")?;
        file.persist(path)
            .map_err(|_| "cannot replace LLM configuration")?;
        Ok(())
    }
}
