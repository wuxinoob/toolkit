pub mod catalog;
pub mod config;
pub mod credentials;
pub mod model_window;
pub mod provider;
pub mod reasoning;
pub mod settings;
pub mod vision;

use crate::services::{caller::Caller, ServiceError};
use config::{Config, Connection, Profile};
use credentials::{Credentials, SystemCredentials};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::Manager;
use tokio::sync::{mpsc, Mutex as AsyncMutex, Semaphore};
use tokio_util::sync::CancellationToken;

pub const MAX_INPUT_BYTES: usize = 256 * 1024;
pub const MAX_EVENT_BYTES: usize = 16 * 1024;
pub const QUEUED_EVENTS: usize = 16;
static NEXT: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ContentPart {
    Text {
        text: String,
    },
    Image {
        source: ResourceSource,
        #[serde(default)]
        detail: ImageDetail,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ResourceSource {
    Resource {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<usize>,
    },
}
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageDetail {
    #[default]
    Auto,
    Low,
    High,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub role: String,
    pub content: Vec<ContentPart>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub profile: Option<String>,
    pub messages: Vec<Message>,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f64>,
    pub reasoning_effort: Option<String>,
}
impl Request {
    pub fn validate(&self) -> Result<(), ServiceError> {
        let bytes: usize = self
            .messages
            .iter()
            .flat_map(|message| &message.content)
            .map(|part| match part {
                ContentPart::Text { text } => text.len(),
                ContentPart::Image { .. } => 0,
            })
            .sum();
        if bytes > MAX_INPUT_BYTES {
            return Err(ServiceError::bad_params(
                "model input exceeds the 256 KiB text limit",
            ));
        }
        if self.messages.is_empty() || self.messages.len() > 512 {
            return Err(ServiceError::bad_params(
                "messages must contain 1..512 entries",
            ));
        }
        if serde_json::to_vec(&self.messages)
            .map_err(|_| ServiceError::bad_params("invalid messages"))?
            .len()
            > MAX_INPUT_BYTES
        {
            return Err(ServiceError::bad_params(
                "messages exceed the 256 KiB request limit",
            ));
        }
        for message in &self.messages {
            if !matches!(message.role.as_str(), "system" | "user" | "assistant")
                || message.content.is_empty()
                || (message.role != "user"
                    && message
                        .content
                        .iter()
                        .any(|p| matches!(p, ContentPart::Image { .. })))
            {
                return Err(ServiceError::unsupported(
                    "supported roles are system/user/assistant; images are allowed only in user messages",
                ));
            }
        }
        if self
            .temperature
            .is_some_and(|t| !t.is_finite() || !(0.0..=2.0).contains(&t))
        {
            return Err(ServiceError::bad_params("temperature must be 0..2"));
        }
        Ok(())
    }
}

struct Job {
    caller: Caller,
    cancel: CancellationToken,
    receiver: AsyncMutex<mpsc::Receiver<Result<Value, ServiceError>>>,
}
pub struct Runtime {
    path: PathBuf,
    config: Mutex<Config>,
    pub(crate) credentials: Arc<dyn Credentials>,
    pub(crate) client: reqwest::Client,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    pending: Mutex<HashMap<Caller, std::sync::Weak<AtomicU64>>>,
    permits: Arc<Semaphore>,
    pub resources: crate::binary_ipc::Transfers,
    image_budget: Arc<Semaphore>,
}
impl Runtime {
    pub fn new(path: PathBuf, credentials: Arc<dyn Credentials>) -> Result<Arc<Self>, String> {
        Self::with_resources(path, credentials, crate::binary_ipc::Transfers::default())
    }
    pub fn with_resources(
        path: PathBuf,
        credentials: Arc<dyn Credentials>,
        resources: crate::binary_ipc::Transfers,
    ) -> Result<Arc<Self>, String> {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let config = Config::load(&path)?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| "cannot initialize model HTTP client")?;
        Ok(Arc::new(Self {
            path,
            config: Mutex::new(config),
            credentials,
            client,
            jobs: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            permits: Arc::new(Semaphore::new(8)),
            resources,
            image_budget: Arc::new(Semaphore::new(64 * 1024 * 1024)),
        }))
    }
    pub fn configuration(&self) -> Config {
        self.config.lock().unwrap().clone()
    }
    async fn credential(
        &self,
        connection: &Connection,
    ) -> Result<Option<zeroize::Zeroizing<String>>, ServiceError> {
        let store = self.credentials.clone();
        let id = connection.id.clone();
        let key = tokio::task::spawn_blocking(move || store.read(&id))
            .await
            .map_err(|_| ServiceError::internal("credential worker failed"))?
            .map_err(ServiceError::io)?;
        if key.is_none() && !connection.base_url.starts_with("http://") {
            return Err(ServiceError::not_found(
                "no API key is configured for this connection",
            ));
        }
        Ok(key)
    }
    pub async fn inspect_connection(
        &self,
        connection: Connection,
        key: Option<zeroize::Zeroizing<String>>,
    ) -> Result<catalog::Catalog, ServiceError> {
        connection.validate().map_err(ServiceError::bad_params)?;
        let key = match key {
            Some(key) => Some(key),
            None => self.credential(&connection).await?,
        };
        catalog::inspect(&self.client, &connection, key).await
    }
    pub fn save_configuration(&self, config: Config) -> Result<(), String> {
        let mut stored = self.config.lock().unwrap();
        config.save(&self.path)?;
        let removed: Vec<_> = stored
            .connections
            .iter()
            .filter(|old| !config.connections.iter().any(|new| new.id == old.id))
            .map(|old| old.id.clone())
            .collect();
        *stored = config;
        drop(stored);
        self.cancel_all(); // New grants/keys cannot silently apply to an old request.
        for id in removed {
            self.credentials.delete(&id)?;
        }
        Ok(())
    }
    pub fn profiles(&self, caller: &Caller) -> Value {
        let config = self.config.lock().unwrap();
        json!(config.profiles.iter().filter(|p| caller.admin || p.allowed_plugins.contains(&caller.plugin)).map(|p| json!({"id":p.id,"name":p.name,"default":config.default_profile.as_ref()==Some(&p.id),"capabilities":{"text":true,"stream":true,"images":p.allow_images,"tools":false,"reasoning":p.reasoning.is_some()},"maxOutputTokens":p.max_output_tokens,"reasoning":p.reasoning.as_ref().map(|r|json!({"defaultEffort":r.default_effort,"allowedEfforts":r.allowed_efforts}))})).collect::<Vec<_>>())
    }
    fn resolve(
        &self,
        caller: &Caller,
        request: &Request,
    ) -> Result<(Connection, Profile), ServiceError> {
        let config = self.config.lock().unwrap();
        let id = request
            .profile
            .as_ref()
            .or(config.default_profile.as_ref())
            .ok_or_else(|| ServiceError::not_found("no default model profile is configured"))?;
        let profile = config
            .profiles
            .iter()
            .find(|p| &p.id == id)
            .ok_or_else(|| ServiceError::not_found("model profile is not available"))?;
        if !caller.admin
            && (!profile.allowed_plugins.contains(&caller.plugin) || caller.plugin == "__host__")
        {
            return Err(ServiceError::new(
                "denied",
                "this plugin has not been granted the model profile",
            ));
        }
        let connection = config
            .connections
            .iter()
            .find(|c| c.id == profile.connection_id)
            .ok_or_else(|| ServiceError::not_found("model connection is missing"))?;
        Ok((connection.clone(), profile.clone()))
    }
    pub async fn call(
        self: &Arc<Self>,
        caller: Caller,
        action: &str,
        params: Value,
    ) -> Result<Value, ServiceError> {
        match action {
            "profiles" => Ok(self.profiles(&caller)),
            "start" => {
                let request: Request = serde_json::from_value(params)
                    .map_err(|_| ServiceError::bad_params("invalid generation request"))?;
                request.validate()?;
                self.start(caller, request).await
            }
            "next" => {
                let id = job_id(&params)?;
                let job = self.owned(&caller, id)?;
                // Only one next call may advance this generation at a time.
                let mut receiver = job
                    .receiver
                    .try_lock()
                    .map_err(|_| ServiceError::conflict("a next request is already pending"))?;
                let event = tokio::select! {
                    _ = job.cancel.cancelled() => Err(ServiceError::new("conflict", "generation cancelled or expired")),
                    _ = tokio::time::sleep(Duration::from_secs(20)) => Ok(json!({"type":"waiting"})),
                    event = receiver.recv() => event.unwrap_or_else(|| Err(ServiceError::io("model stream ended without completion"))),
                };
                if event
                    .as_ref()
                    .map_or(true, |value| value["type"] == "completed")
                {
                    self.remove(id);
                }
                event
            }
            "cancel" => {
                let id = job_id(&params)?;
                let present = self.jobs.lock().unwrap().get(id).cloned();
                if let Some(job) = present {
                    if job.caller != caller {
                        return Err(ServiceError::new(
                            "denied",
                            "generation belongs to another caller",
                        ));
                    }
                    self.remove(id);
                    return Ok(json!(true));
                }
                Ok(json!(false))
            }
            "cancel_all" if params["scope"] == "plugin" && caller.owner == "window:main" => {
                Ok(json!(self.cancel_plugin(&caller.plugin)))
            }
            "cancel_all" => Ok(json!(self.cancel_caller(&caller))),
            _ => Err(ServiceError::new("unknown_action", "unknown model action")),
        }
    }
    async fn start(
        self: &Arc<Self>,
        caller: Caller,
        mut request: Request,
    ) -> Result<Value, ServiceError> {
        let (epoch, revision) = {
            let mut pending = self.pending.lock().unwrap();
            pending.retain(|_, value| value.strong_count() > 0);
            let epoch = pending
                .get(&caller)
                .and_then(|value| value.upgrade())
                .unwrap_or_else(|| Arc::new(AtomicU64::new(0)));
            pending.insert(caller.clone(), Arc::downgrade(&epoch));
            let revision = epoch.load(Ordering::SeqCst);
            (epoch, revision)
        };
        let permit = self.permits.clone().try_acquire_owned().map_err(|_| {
            ServiceError::conflict(
                "model concurrency limit reached; try again when a request completes",
            )
        })?;
        let (connection, profile) = self.resolve(&caller, &request)?;
        let limit = request
            .max_output_tokens
            .unwrap_or(profile.max_output_tokens);
        if limit == 0 || limit > profile.max_output_tokens {
            return Err(ServiceError::bad_params(
                "requested output exceeds the profile token limit",
            ));
        }
        request.max_output_tokens = Some(limit);
        request.reasoning_effort = reasoning::resolve(&profile, request.reasoning_effort.take())?;
        let images = vision::prepare(&self.resources, &caller, &request, profile.allow_images)?;
        let image_bytes: usize = request
            .messages
            .iter()
            .flat_map(|m| &m.content)
            .filter_map(|p| match p {
                ContentPart::Image {
                    source: ResourceSource::Resource { id, .. },
                    ..
                } => images.get(id).map(|i| i.data.bytes.len()),
                _ => None,
            })
            .sum();
        let image_permit = self
            .image_budget
            .clone()
            .try_acquire_many_owned(image_bytes as u32)
            .map_err(|_| ServiceError::conflict("in-flight model image budget exhausted"))?;
        let key = self.credential(&connection).await?;
        let (tx, rx) = mpsc::channel(QUEUED_EVENTS);
        let cancel = CancellationToken::new();
        let job = Arc::new(Job {
            caller: caller.clone(),
            cancel: cancel.clone(),
            receiver: AsyncMutex::new(rx),
        });
        let id = NEXT.fetch_add(1, Ordering::Relaxed).to_string();
        {
            let _pending = self.pending.lock().unwrap();
            if epoch.load(Ordering::SeqCst) != revision {
                return Err(ServiceError::conflict(
                    "caller closed while preparing the model request",
                ));
            }
            let mut jobs = self.jobs.lock().unwrap();
            if jobs.len() >= 32
                || jobs
                    .values()
                    .filter(|j| j.caller.plugin == caller.plugin)
                    .count()
                    >= 4
            {
                return Err(ServiceError::conflict(
                    "too many model requests for this caller",
                ));
            }
            jobs.insert(id.clone(), job);
        }
        let runtime = self.clone();
        let job_id = id.clone();
        let profile_id = profile.id.clone();
        let requested_effort = request.reasoning_effort.clone();
        let timeout = Duration::from_millis(profile.timeout_ms);
        tokio::spawn(async move {
            let generation = provider::generate(
                &runtime.client,
                &connection,
                &profile,
                key,
                request,
                images,
                image_permit,
                tx.clone(),
            );
            let result = tokio::select! {
                _ = cancel.cancelled() => return,
                result = tokio::time::timeout(timeout, generation) => result.unwrap_or_else(|_| Err(ServiceError::new("timeout", "model request reached its native deadline"))),
            };
            if let Err(error) = result {
                tokio::select! { _ = cancel.cancelled() => {}, _ = tokio::time::timeout(Duration::from_secs(30),tx.send(Err(error))) => {} }
            }
            drop(permit);
            drop(tx);
            // A caller that abandons its response cannot retain a registry slot forever.
            tokio::select! { _ = cancel.cancelled() => {}, _ = tokio::time::sleep(Duration::from_secs(60)) => { runtime.remove(&job_id); } }
        });
        Ok(
            json!({"id":id,"profile":profile_id,"reasoningEffort":requested_effort,"maxEventBytes":MAX_EVENT_BYTES,"queueBytes":MAX_EVENT_BYTES*QUEUED_EVENTS}),
        )
    }
    fn owned(&self, caller: &Caller, id: &str) -> Result<Arc<Job>, ServiceError> {
        let job = self
            .jobs
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| ServiceError::not_found("generation is closed"))?;
        if &job.caller != caller {
            return Err(ServiceError::new(
                "denied",
                "generation belongs to another caller",
            ));
        }
        Ok(job)
    }
    fn remove(&self, id: &str) {
        if let Some(job) = self.jobs.lock().unwrap().remove(id) {
            job.cancel.cancel();
        }
    }
    pub fn cancel_caller(&self, caller: &Caller) -> usize {
        self.cancel_where(|owner| owner == caller)
    }
    pub fn cancel_owner(&self, owner: &str) -> usize {
        self.cancel_where(|caller| caller.owner == owner)
    }
    pub fn cancel_plugin(&self, plugin: &str) -> usize {
        self.cancel_where(|caller| caller.plugin == plugin)
    }
    pub fn cancel_all(&self) -> usize {
        self.cancel_where(|_| true)
    }
    fn cancel_where(&self, predicate: impl Fn(&Caller) -> bool) -> usize {
        let pending = self.pending.lock().unwrap();
        for (_, epoch) in pending.iter().filter(|(caller, _)| predicate(caller)) {
            if let Some(epoch) = epoch.upgrade() {
                epoch.fetch_add(1, Ordering::SeqCst);
            }
        }
        let mut jobs = self.jobs.lock().unwrap();
        let ids: Vec<_> = jobs
            .iter()
            .filter(|(_, j)| predicate(&j.caller))
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            if let Some(job) = jobs.remove(id) {
                job.cancel.cancel();
            }
        }
        ids.len()
    }
    pub fn diagnostics(&self) -> Value {
        let jobs = self.jobs.lock().unwrap();
        let queues: Vec<_> = jobs
            .values()
            .map(|job| job.receiver.try_lock().ok().map(|receiver| receiver.len()))
            .collect();
        json!({"jobs":jobs.len(),"running":8-self.permits.available_permits(),"queueBytesPerJob":MAX_EVENT_BYTES*QUEUED_EVENTS,"queuedEvents":queues})
    }
}
fn job_id(params: &Value) -> Result<&str, ServiceError> {
    params["id"]
        .as_str()
        .ok_or_else(|| ServiceError::bad_params("missing generation id"))
}

#[derive(Default)]
pub struct Host(Mutex<Option<Arc<Runtime>>>);
impl Host {
    /// Inject an isolated runtime for native integration harnesses.
    pub fn from_runtime(runtime: Arc<Runtime>) -> Self {
        Self(Mutex::new(Some(runtime)))
    }
    pub fn get(&self, app: &tauri::AppHandle) -> Result<Arc<Runtime>, ServiceError> {
        let mut stored = self.0.lock().unwrap();
        if let Some(runtime) = stored.as_ref() {
            return Ok(runtime.clone());
        }
        let path = app
            .path()
            .app_data_dir()
            .map_err(|_| ServiceError::io("cannot locate application data"))?
            .join("llm.json");
        let runtime = Runtime::with_resources(
            path,
            Arc::new(SystemCredentials),
            app.state::<crate::binary_ipc::Transfers>().inner().clone(),
        )
        .map_err(ServiceError::io)?;
        *stored = Some(runtime.clone());
        Ok(runtime)
    }
    pub fn initialized(&self) -> Option<Arc<Runtime>> {
        self.0.lock().unwrap().clone()
    }
}

pub use crate::services::llm::{peer as handler, LlmService};
