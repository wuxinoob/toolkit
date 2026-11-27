//! Native Sidecar host RPC. No WebView, stdout polling, or API keys on this wire.
use crate::protocol::envelope::Envelope;
use crate::services::{caller::Caller, ServiceError, ServiceFuture};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tokio_util::sync::CancellationToken;

pub type Handler = Arc<dyn Fn(String, Value) -> ServiceFuture + Send + Sync>;
pub struct PeerService {
    pub actions: Vec<String>,
    pub handler: Handler,
    pub close: Arc<dyn Fn() + Send + Sync>,
}
pub type Services = HashMap<String, PeerService>;
pub fn schema(services: &Services, caller: &Caller) -> Value {
    let mut result = crate::services::capabilities();
    let map = result.as_object_mut().unwrap();
    map.remove("fileAccess");
    map.remove("stdio");
    map.remove("uplink");
    if !services.contains_key("binary") {
        map.remove("binaryTransfer");
    }
    if !services.contains_key("llm") {
        map.remove("llm");
    }
    if !services.contains_key("screen") {
        map.remove("screenCapture");
    }
    map.extend(json!({"protocol":1,"transport":"named-pipe","framing":"u32le-json","maxFrameBytes":toolkit_host::wire::MAX_FRAME_BYTES,"streaming":"pull","resources":{"version":1,"rawLane":services.contains_key("binary"),"maxChunkBytes":crate::binary_ipc::MAX_CHUNK_BYTES},"services":services.iter().map(|(name,service)|(name.clone(),json!(service.actions))).collect::<serde_json::Map<String,Value>>(),"contracts":crate::services::contracts::for_sidecar(services),"codes":crate::protocol::codes::ALL}).as_object().unwrap().clone());
    let allowed: std::collections::HashSet<_> = services
        .keys()
        .filter(|name| {
            crate::host::registry::is_allowed(&caller.plugin, &format!("rpc:{name}")).is_ok()
        })
        .cloned()
        .collect();
    result["services"]
        .as_object_mut()
        .unwrap()
        .retain(|name, _| allowed.contains(name));
    result["contracts"]["services"]
        .as_object_mut()
        .unwrap()
        .retain(|name, _| allowed.contains(name));
    for (service, capability) in [
        ("binary", "binaryTransfer"),
        ("llm", "llm"),
        ("screen", "screenCapture"),
    ] {
        if !allowed.contains(service) {
            result.as_object_mut().unwrap().remove(capability);
        }
    }
    result["resources"]["rawLane"] = json!(allowed.contains("binary"));
    result["maxPending"] = json!(32);
    result
}
static NEXT: AtomicU64 = AtomicU64::new(1);
pub fn instance_id() -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

pub struct Lease {
    pub owner: String,
    cancel: CancellationToken,
    services: Arc<Services>,
}
impl Lease {
    pub fn close(&self) {
        self.cancel.cancel();
        for service in self.services.values() {
            (service.close)();
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(windows)]
pub struct Prepared {
    pub path: String,
    pipe: tokio::net::windows::named_pipe::NamedPipeServer,
    caller: Caller,
    resources: Option<(
        String,
        tokio::net::windows::named_pipe::NamedPipeServer,
        crate::binary_ipc::Transfers,
    )>,
    services: Arc<Services>,
}
#[cfg(windows)]
impl Prepared {
    pub fn new(instance: &str, caller: Caller, services: Services) -> Result<Self, ServiceError> {
        let path = format!("\\\\.\\pipe\\toolkit-host-{instance}");
        Ok(Self {
            path: path.clone(),
            pipe: create_pipe(&path)?,
            caller,
            resources: None,
            services: Arc::new(services),
        })
    }
    pub fn with_resources(
        mut self,
        instance: &str,
        store: crate::binary_ipc::Transfers,
    ) -> Result<Self, ServiceError> {
        let path = format!("\\\\.\\pipe\\toolkit-resource-{instance}");
        self.resources = Some((path.clone(), create_pipe(&path)?, store));
        Ok(self)
    }
    pub fn resource_path(&self) -> Option<&str> {
        self.resources.as_ref().map(|r| r.0.as_str())
    }
    pub fn start(self, expected_pid: u32) -> Arc<Lease> {
        use std::os::windows::io::AsRawHandle;
        let cancel = CancellationToken::new();
        let lease = Arc::new(Lease {
            owner: self.caller.owner.clone(),
            cancel: cancel.clone(),
            services: self.services.clone(),
        });
        if let Some((_, pipe, store)) = self.resources {
            let caller = self.caller.clone();
            let data_cancel = cancel.clone();
            tokio::spawn(async move {
                let work = async {
                    pipe.connect()
                        .await
                        .map_err(|_| ServiceError::io("resource pipe connect failed"))?;
                    let mut pid = 0;
                    if unsafe {
                        windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId(
                            pipe.as_raw_handle(),
                            &mut pid,
                        )
                    } == 0
                        || pid != expected_pid
                    {
                        return Err(ServiceError::new(
                            "denied",
                            "resource pipe process mismatch",
                        ));
                    }
                    crate::resource_pipe::serve(pipe, &store, &caller).await
                };
                tokio::select! {_ = data_cancel.cancelled()=>{}, _ = work=>{data_cancel.cancel();}}
                store.close_caller(&caller);
            });
        }
        tokio::spawn(async move {
            let cleanup = Lease {
                owner: self.caller.owner.clone(),
                cancel: cancel.clone(),
                services: self.services.clone(),
            };
            let connected = tokio::select! {
                _ = cancel.cancelled() => false,
                result = tokio::time::timeout(std::time::Duration::from_secs(15),self.pipe.connect()) => matches!(result,Ok(Ok(()))),
            };
            if !connected {
                return;
            }
            let mut actual_pid = 0;
            if unsafe {
                windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId(
                    self.pipe.as_raw_handle(),
                    &mut actual_pid,
                )
            } == 0
                || actual_pid != expected_pid
            {
                return;
            }
            let (mut reader, mut writer) = tokio::io::split(self.pipe);
            let (tx, mut rx) = tokio::sync::mpsc::channel::<Value>(32);
            let writer_cancel = cancel.clone();
            let writer = tokio::spawn(async move {
                while let Some(value) = rx.recv().await {
                    if toolkit_host::wire::write_frame(&mut writer, &value)
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                writer_cancel.cancel();
            });
            let mut calls = tokio::task::JoinSet::new();
            let mut ids = std::collections::HashSet::new();
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    Some(result) = calls.join_next(), if !calls.is_empty() => { if let Ok(id) = result { ids.remove(&id); } },
                    frame = toolkit_host::wire::read_frame(&mut reader) => {
                        let Ok(frame) = frame else { break; };
                        let Ok(envelope) = serde_json::from_value::<Envelope>(frame) else { break; };
                        if envelope.validate().is_err() || !envelope.kind.is_uplink() { break; }
                        let id = envelope.id.unwrap();
                        if calls.len() >= 32 || !ids.insert(id) { break; }
                        let services = self.services.clone(); let caller = self.caller.clone(); let tx = tx.clone();
                        let failed_connection = cancel.clone();
                        calls.spawn(async move {
                            let name = envelope.svc.as_deref().unwrap();
                            let action = envelope.act.as_deref().unwrap();
                            let result = if name == "host" && action == "schema" {
                                Ok(schema(&services,&caller))
                            } else if let Some(service) = services.get(name) {
                                match crate::host::registry::is_allowed(&caller.plugin,&format!("rpc:{name}")) {
                                    Err(_) => Err(ServiceError::new("denied","Sidecar service permission is not granted")),
                                    Ok(()) if !service.actions.iter().any(|a|a==action) => Err(ServiceError::new("unknown_action","unsupported Sidecar host action")),
                                    Ok(()) => (service.handler)(action.to_string(),envelope.p).await,
                                }
                            } else { Err(ServiceError::new("denied","service is not exposed to this Sidecar")) };
                            let reply = match result {Ok(value)=>Envelope::res(id,value),Err(error)=>Envelope::err(Some(id),error.code,error.msg)};
                            if !matches!(tokio::time::timeout(std::time::Duration::from_secs(10),tx.send(serde_json::to_value(reply).unwrap())).await,Ok(Ok(()))) { failed_connection.cancel(); }
                            id
                        });
                    }
                }
            }
            calls.abort_all();
            // A synchronous handler already executing on another worker must
            // finish before the final owner sweep, or it could publish late.
            while calls.join_next().await.is_some() {}
            writer.abort();
            drop(cleanup);
        });
        lease
    }
}

#[cfg(not(windows))]
pub struct Prepared {
    pub path: String,
}
#[cfg(not(windows))]
impl Prepared {
    pub fn new(_: &str, _: Caller, _: Services) -> Result<Self, ServiceError> {
        Err(ServiceError::unsupported(
            "Sidecar host RPC currently requires Windows",
        ))
    }
    pub fn with_resources(
        self,
        _: &str,
        _: crate::binary_ipc::Transfers,
    ) -> Result<Self, ServiceError> {
        Ok(self)
    }
    pub fn resource_path(&self) -> Option<&str> {
        None
    }
    pub fn start(self, _: u32) -> Arc<Lease> {
        unreachable!()
    }
}

#[cfg(windows)]
fn create_pipe(
    path: &str,
) -> Result<tokio::net::windows::named_pipe::NamedPipeServer, ServiceError> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SECURITY_ATTRIBUTES,
        },
    };
    // Owner-only DACL, a unique first instance, and explicit local-only IO.
    let sddl: Vec<u16> = "D:P(A;;GA;;;OW)\0".encode_utf16().collect();
    let mut descriptor = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(ServiceError::io(
            "cannot create Sidecar pipe access control",
        ));
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let result = unsafe {
        tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(
                path,
                (&attributes as *const SECURITY_ATTRIBUTES)
                    .cast_mut()
                    .cast(),
            )
    };
    unsafe {
        LocalFree(descriptor);
    }

    result.map_err(|_| ServiceError::io("cannot create Sidecar pipe"))
}
