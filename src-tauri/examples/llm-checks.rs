#[path = "support/exchange_checks.rs"]
mod exchange_checks;
#[cfg(windows)]
#[path = "support/reasoning_checks.rs"]
mod reasoning_checks;
#[cfg(windows)]
#[path = "support/resource_checks.rs"]
mod resource_checks;
// Real HTTP + native named-pipe checks. No WebView or user API key is used.
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use toolkit_lib::{
    llm::{
        self,
        config::{Adapter, Config, Connection, Profile},
        credentials::Credentials,
        Runtime,
    },
    services::{caller::Caller, proc, session},
    sidecar_rpc,
};
use zeroize::Zeroizing;

struct TestCredentials;
impl Credentials for TestCredentials {
    fn read(&self, _: &str) -> Result<Option<Zeroizing<String>>, String> {
        Ok(Some(Zeroizing::new("TOOLKIT_SELFTEST_FAKE_KEY".into())))
    }
    fn write(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}
fn request(profile: &str) -> Value {
    json!({"profile":profile,"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}],"maxOutputTokens":32})
}
async fn collect(
    runtime: &Arc<Runtime>,
    caller: Caller,
    profile: &str,
) -> Result<String, toolkit_lib::services::ServiceError> {
    let start = runtime
        .call(caller.clone(), "start", request(profile))
        .await?;
    let mut text = String::new();
    loop {
        let event = runtime
            .call(caller.clone(), "next", json!({"id":start["id"]}))
            .await?;
        if event["type"] == "text-delta" {
            text.push_str(event["text"].as_str().unwrap());
        }
        if event["type"] == "completed" {
            if profile == "no-usage" {
                assert!(event["usage"]["inputTokens"].is_null());
            }
            return Ok(text);
        }
    }
}
async fn until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(8), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("native cleanup deadline");
}

async fn mock_server(
    reasoning_configured: bool,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let active = Arc::new(AtomicUsize::new(0));
    let count = active.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let count = count.clone();
            tokio::spawn(async move {
                count.fetch_add(1, Ordering::SeqCst);
                struct Active(Arc<AtomicUsize>);
                impl Drop for Active {
                    fn drop(&mut self) {
                        self.0.fetch_sub(1, Ordering::SeqCst);
                    }
                }
                let _active = Active(count);
                let mut incoming = Vec::new();
                let mut chunk = [0u8; 4096];
                let (headers, body) = loop {
                    let n = socket.read(&mut chunk).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    incoming.extend_from_slice(&chunk[..n]);
                    if let Some(end) = incoming.windows(4).position(|b| b == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&incoming[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if incoming.len() >= end + 4 + length {
                            break (
                                headers.to_string(),
                                if length == 0 {
                                    Value::Null
                                } else {
                                    serde_json::from_slice::<Value>(
                                        &incoming[end + 4..end + 4 + length],
                                    )
                                    .unwrap()
                                },
                            );
                        }
                    }
                };
                if body["messages"][0]["content"].is_array()
                    || body["input"][0]["content"].is_array()
                {
                    let responses = headers.starts_with("POST /v1/responses ");
                    let parts = if responses {
                        &body["input"][0]["content"]
                    } else {
                        &body["messages"][0]["content"]
                    };
                    assert_eq!(
                        parts[0]["type"],
                        if responses { "input_text" } else { "text" }
                    );
                    let uri = if responses {
                        assert_eq!(parts[1]["type"], "input_image");
                        parts[1]["image_url"].as_str().unwrap()
                    } else {
                        assert_eq!(parts[1]["type"], "image_url");
                        parts[1]["image_url"]["url"].as_str().unwrap()
                    };
                    use base64::Engine;
                    let raw = base64::engine::general_purpose::STANDARD
                        .decode(uri.strip_prefix("data:image/png;base64,").unwrap())
                        .unwrap();
                    assert!(raw.len() > 1024 * 1024);
                    assert_eq!(image::load_from_memory(&raw).unwrap().width(), 1024);
                }
                if headers.starts_with("GET ") {
                    let draft = headers.starts_with("GET /v1/draft/models ");
                    assert!(headers.contains(if draft {
                        "TOOLKIT_UNSAVED_FAKE_KEY"
                    } else {
                        "TOOLKIT_SELFTEST_FAKE_KEY"
                    }));
                    let (status, data) = if headers.starts_with("GET /v1/denied/models ") {
                        (
                            "401 Unauthorized",
                            json!({"error":"TOOLKIT_SELFTEST_FAKE_KEY provider diagnostic"})
                                .to_string(),
                        )
                    } else if headers.starts_with("GET /v1/unsupported/models ") {
                        ("404 Not Found", "missing".into())
                    } else if headers.starts_with("GET /v1/redirect/models ") {
                        ("302 Found\r\nLocation: /v1/models", "".into())
                    } else if headers.starts_with("GET /v1/invalid/models ") {
                        ("200 OK", "<html>not a model API</html>".into())
                    } else if headers.starts_with("GET /v1/oversize/models ") {
                        ("200 OK", " ".repeat(1024 * 1024 + 1))
                    } else if headers.starts_with("GET /v1/partial/models ") {
                        (
                            "200 OK",
                            json!({"data":[{"id":"partial"}],"has_more":true}).to_string(),
                        )
                    } else if headers.starts_with("GET /v1/catalog-timeout/models ") {
                        let _ = socket.read(&mut chunk).await;
                        return;
                    } else {
                        ("200 OK", json!({"data":[
                            {"id":"chat","name":"Mock text model","owned_by":"selftest","input_modalities":["text","image"],"output_modalities":["text"],"context_window":131072,"max_output_tokens":8192,"effort":{"supported_levels":["low","high"],"default_level":"high"}},
                            {"id":"name-contains-reasoner-embedding","object":"model","capabilities":{"effort":{"supported":true}}},
                            {"id":"embed","sub_type":"embedding","max_input_tokens":8192,"max_tokens":1024,"capabilities":{"vision":{"supported":false},"thinking":{"supported":true},"effort":{"low":{"supported":true},"high":{"supported":false}}}},
                            {"id":"chat"}
                        ]}).to_string())
                    };
                    let reply = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}",data.len());
                    let _ = socket.write_all(reply.as_bytes()).await;
                    return;
                }
                assert!(headers.contains("TOOLKIT_SELFTEST_FAKE_KEY"));
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                let model = body["model"].as_str().unwrap();
                if reasoning_configured && matches!(model, "chat" | "responses") {
                    let responses = headers.starts_with("POST /v1/responses ");
                    let effort = if responses {
                        &body["reasoning"]["effort"]
                    } else {
                        &body["reasoning_effort"]
                    };
                    assert!(matches!(effort.as_str(), Some("medium" | "low" | "max")));
                    assert!(if responses {
                        body["reasoning_effort"].is_null() && body["max_output_tokens"].is_u64()
                    } else {
                        body["reasoning"].is_null()
                            && body["max_completion_tokens"].is_u64()
                            && body["max_tokens"].is_null()
                    });
                } else if reasoning_configured {
                    assert!(body["reasoning_effort"].is_null() && body["reasoning"].is_null());
                }

                if model == "stall" || model == "deadline" {
                    let _ = socket.read(&mut chunk).await;
                    return;
                }
                let responses = headers.starts_with("POST /v1/responses ");
                let content = match model {
                    "empty" => " ".to_string(),
                    "late-text" => format!("{}OK", " ".repeat(600)),
                    _ => "你好".to_string(),
                };
                let delta = if responses {
                    json!({"type":"response.output_text.delta","delta":"你好"})
                } else {
                    json!({"choices":[{"delta":{"content":content}}]})
                };
                let encoded = format!("data: {delta}\r\n\r\n");
                if model == "bulk" {
                    let event = format!(
                        "data: {}\n\n",
                        json!({"choices":[{"delta":{"content":"x".repeat(2048)}}]})
                    );
                    for _ in 0..5000 {
                        if socket.write_all(event.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                } else {
                    // Split every byte, including UTF-8 and SSE framing boundaries.
                    for byte in encoded.bytes() {
                        if socket.write_all(&[byte]).await.is_err() {
                            return;
                        }
                    }
                }
                if model == "broken" {
                    return;
                }
                let tail = if responses {
                    format!(
                        "data: {}\n\n",
                        json!({"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}})
                    )
                } else if model == "no-usage" {
                    "data: [DONE]\n\n".into()
                } else {
                    format!(
                        "data: {}\n\ndata: [DONE]\n\n",
                        json!({"choices":[{"delta":{},"finish_reason":if model=="empty" { "length" } else { "stop" }}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}})
                    )
                };
                let _ = socket.write_all(tail.as_bytes()).await;
            });
        }
    });
    (url, active, task)
}

#[cfg(windows)]
async fn child_check() {
    let client = toolkit_host::Client::connect_from_env().await.unwrap();
    let schema = client.request("host", "schema", Value::Null).await.unwrap();
    assert_eq!(schema["protocol"], 1);
    assert_eq!(
        schema["llm"]["version"],
        toolkit_lib::services::schema()["llm"]["version"]
    );
    assert_eq!(schema["llm"]["reasoningEffort"], true);
    assert!(schema["contracts"].get("webview").is_none());
    assert!(schema["contracts"]["services"]["screen"].is_null());
    assert!(schema["contracts"]["services"]["binary"]["import"].is_object());
    assert!(!schema.to_string().contains("FAKE_KEY"));
    let gate = client.request("test", "gate", Value::Null).await.unwrap();
    let imported = client
        .import_resource(gate["ticket"].clone())
        .await
        .unwrap();
    assert_eq!(imported.read(0, 256).await.unwrap(), b"cross-process");
    let ticket = imported.export("window:exchange-return").await.unwrap();
    client
        .request("test", "exchange", json!({"ticket":ticket}))
        .await
        .unwrap();
    imported.close().await.unwrap();
    assert_eq!(
        client.profiles().await.unwrap().as_array().unwrap().len(),
        10
    );
    let profiles = client.profiles().await.unwrap();
    assert_eq!(
        profiles
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "chat")
            .unwrap()["reasoning"]["defaultEffort"],
        "medium"
    );
    for profile in ["chat", "responses"] {
        let mut generation = request(profile);
        generation["reasoningEffort"] = json!("low");
        let result = client.generate(generation).await.unwrap();
        assert_eq!(result["output"][0]["text"], "你好");
        assert_eq!(result["usage"]["inputTokens"], 3);
    }
    let start = client
        .request("llm", "start", request("stall"))
        .await
        .unwrap();
    let waiting_client = client.clone();
    let id = start["id"].clone();
    let waiting = tokio::spawn(async move {
        waiting_client
            .request("llm", "next", json!({"id":id}))
            .await
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    // Cancellation and another RPC must pass while next is waiting.
    tokio::time::timeout(Duration::from_secs(5), client.profiles())
        .await
        .unwrap()
        .unwrap();
    client
        .request("llm", "cancel", json!({"id":start["id"]}))
        .await
        .unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert_eq!(
        client
            .request("storage", "keys", Value::Null)
            .await
            .unwrap_err()
            .code,
        "denied"
    );
    let mut forged = request("chat");
    forged["pluginId"] = json!("__host__");
    assert_eq!(
        client
            .request("llm", "start", forged)
            .await
            .unwrap_err()
            .code,
        "bad_params"
    );
    resource_checks::child(&client).await;
    client.request("test", "done", Value::Null).await.unwrap();
}

#[cfg(windows)]
async fn checks() {
    let temp = tempfile::tempdir().unwrap();
    let (url, active, server) = mock_server(true).await;
    let config = Config {
        connections: vec![
            Connection {
                id: "chat".into(),
                name: "Mock chat".into(),
                adapter: Adapter::OpenaiChat,
                base_url: url.clone(),
            },
            Connection {
                id: "responses".into(),
                name: "Mock responses".into(),
                adapter: Adapter::OpenaiResponses,
                base_url: url,
            },
        ],
        profiles: [
            "chat",
            "responses",
            "broken",
            "stall",
            "vision-stall",
            "bulk",
            "no-usage",
            "deadline",
            "empty",
            "late-text",
        ]
        .iter()
        .map(|id| Profile {
            id: (*id).into(),
            name: (*id).into(),
            connection_id: if *id == "responses" {
                "responses"
            } else {
                "chat"
            }
            .into(),
            model: if *id == "vision-stall" { "stall" } else { *id }.into(),
            max_output_tokens: 64,
            timeout_ms: if *id == "deadline" { 1000 } else { 120000 },
            allowed_plugins: vec!["test.llm".into()],
            allow_images: matches!(*id, "chat" | "responses" | "vision-stall"),
            reasoning: if matches!(*id, "chat" | "responses") {
                Some(llm::reasoning::Config {
                    default_effort: Some("medium".into()),
                    allowed_efforts: vec![
                        "low".into(),
                        "medium".into(),
                        "high".into(),
                        "max".into(),
                    ],
                    chat_output_tokens: llm::reasoning::ChatOutputTokens::MaxCompletionTokens,
                })
            } else {
                None
            },
        })
        .collect(),
        default_profile: Some("chat".into()),
    };
    let path = temp.path().join("llm.json");
    config.save(&path).unwrap();
    assert!(!std::fs::read_to_string(&path).unwrap().contains("FAKE_KEY"));
    let runtime = Runtime::new(path, Arc::new(TestCredentials)).unwrap();
    struct Cleanup(Arc<Runtime>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            self.0.cancel_all();
            session::kill_all();
        }
    }
    let _cleanup = Cleanup(runtime.clone());
    let connection = runtime.configuration().connections[0].clone();
    let catalog = serde_json::to_value(
        runtime
            .inspect_connection(connection.clone(), None)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(catalog["status"], "available");
    assert_eq!(catalog["models"].as_array().unwrap().len(), 3);
    assert_eq!(catalog["models"][0]["id"], "chat");
    assert_eq!(
        catalog["models"][0]["inputModalities"],
        json!(["text", "image"])
    );
    assert_eq!(
        catalog["models"][0]["reasoningEfforts"],
        json!(["low", "high"])
    );
    assert_eq!(catalog["models"][1]["kind"], "embedding");
    assert_eq!(
        catalog["models"][1]["declaredCapabilities"]["vision"],
        false
    );
    assert_eq!(catalog["models"][1]["reasoningEfforts"], json!(["low"]));
    assert_eq!(catalog["models"][1]["maxInputTokens"], 8192);
    assert!(catalog["models"][2]["kind"].is_null());
    assert!(catalog["models"][2]["reasoningEfforts"].is_null());
    assert!(!catalog.to_string().contains("FAKE_KEY"));
    for suffix in [
        "denied",
        "unsupported",
        "redirect",
        "invalid",
        "oversize",
        "partial",
        "draft",
        "catalog-timeout",
    ] {
        let mut draft = connection.clone();
        draft.base_url = format!("{}/{suffix}", connection.base_url);
        let key = if suffix == "draft" {
            Some(Zeroizing::new("TOOLKIT_UNSAVED_FAKE_KEY".into()))
        } else {
            None
        };
        let result = runtime.inspect_connection(draft, key).await;
        match suffix {
            "draft" => assert_eq!(result.unwrap().models.len(), 3),
            "partial" => assert!(result.unwrap().has_more),
            "unsupported" => assert_eq!(result.unwrap().status, "unsupported"),
            "denied" => {
                let error = result.unwrap_err();
                assert_eq!(error.code, "denied");
                assert!(!error.msg.contains("FAKE_KEY"));
            }
            "catalog-timeout" => assert_eq!(result.unwrap_err().code, "timeout"),
            _ => assert_eq!(result.unwrap_err().code, "io"),
        }
    }
    assert_eq!(
        runtime.configuration().connections[0].base_url,
        connection.base_url
    );
    let verified = llm::settings::test_profile(&runtime, "chat").await.unwrap();
    assert_eq!(verified["textVerified"], true);
    let empty = llm::settings::test_profile(&runtime, "empty")
        .await
        .unwrap();
    assert_eq!(empty["textVerified"], false);
    assert_eq!(empty["finishReason"], "length");
    let late_text = llm::settings::test_profile(&runtime, "late-text")
        .await
        .unwrap();
    assert_eq!(late_text["textVerified"], true);
    assert_eq!(late_text["previewTruncated"], true);
    assert_eq!(late_text["text"].as_str().unwrap().chars().count(), 512);
    println!("PASS: real catalog HTTP, unsaved key override, declared metadata, no name guessing, auth redaction, unsupported endpoint, redirect/JSON/size/deadline checks and honest generation diagnostics");
    reasoning_checks::checks(&runtime).await;
    let caller = Caller::window("test.llm", "main");
    assert_eq!(
        collect(&runtime, caller.clone(), "chat").await.unwrap(),
        "你好"
    );
    assert_eq!(
        collect(&runtime, caller.clone(), "responses")
            .await
            .unwrap(),
        "你好"
    );
    assert_eq!(
        collect(&runtime, caller.clone(), "no-usage").await.unwrap(),
        "你好"
    );
    assert!(collect(&runtime, caller.clone(), "broken").await.is_err());
    assert_eq!(
        collect(&runtime, caller.clone(), "deadline")
            .await
            .unwrap_err()
            .code,
        "timeout"
    );
    let stranger = Caller::window("other.plugin", "main");
    // Cancel a scope while its credential read is still preparing the request.
    struct SlowCredentials {
        entered: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl Credentials for SlowCredentials {
        fn read(&self, _: &str) -> Result<Option<Zeroizing<String>>, String> {
            if let Some(entered) = self.entered.lock().unwrap().take() {
                let _ = entered.send(());
            }
            self.release.lock().unwrap().recv().unwrap();
            Ok(Some(Zeroizing::new("TOOLKIT_SELFTEST_FAKE_KEY".into())))
        }
        fn write(&self, _: &str, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
    }
    let (entered_tx, entered) = tokio::sync::oneshot::channel();
    let (release, release_rx) = std::sync::mpsc::channel();
    let preparing = Runtime::new(
        temp.path().join("llm.json"),
        Arc::new(SlowCredentials {
            entered: std::sync::Mutex::new(Some(entered_tx)),
            release: std::sync::Mutex::new(release_rx),
        }),
    )
    .unwrap();
    let pending_runtime = preparing.clone();
    let pending_caller = caller.clone();
    let start = tokio::spawn(async move {
        pending_runtime
            .call(pending_caller, "start", request("chat"))
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), entered)
        .await
        .unwrap()
        .unwrap();
    preparing.cancel_caller(&caller);
    release.send(()).unwrap();
    assert_eq!(start.await.unwrap().unwrap_err().code, "conflict");
    assert_eq!(preparing.diagnostics()["jobs"], 0);
    assert_eq!(preparing.diagnostics()["running"], 0);
    resource_checks::checks(&runtime).await;
    exchange_checks::checks().await;
    println!("PASS: scope cancellation fences a generation still reading credentials");
    assert!(runtime.profiles(&stranger).as_array().unwrap().is_empty());
    assert_eq!(
        runtime
            .call(stranger.clone(), "start", request("chat"))
            .await
            .unwrap_err()
            .code,
        "denied"
    );
    let start = runtime
        .call(caller.clone(), "start", request("stall"))
        .await
        .unwrap();
    assert_eq!(
        runtime
            .call(stranger, "next", json!({"id":start["id"]}))
            .await
            .unwrap_err()
            .code,
        "denied"
    );
    runtime
        .call(caller.clone(), "cancel", json!({"id":start["id"]}))
        .await
        .unwrap();
    until(|| runtime.diagnostics()["running"] == 0 && active.load(Ordering::SeqCst) == 0).await;
    println!("PASS: chat and Responses, split UTF-8, missing usage, premature EOF, grants and cancellation");

    let mut decoder = llm::provider::SseDecoder::default();
    assert!(decoder.feed(&vec![b'x'; 65537]).is_err());
    let mut pipe = tokio::io::duplex(8);
    pipe.0
        .write_u32_le((toolkit_host::wire::MAX_FRAME_BYTES + 1) as u32)
        .await
        .unwrap();
    assert!(toolkit_host::wire::read_frame(&mut pipe.1).await.is_err());
    let bulk = runtime
        .call(caller.clone(), "start", request("bulk"))
        .await
        .unwrap();
    until(|| {
        runtime.diagnostics()["queuedEvents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n == 16)
    })
    .await;
    assert_eq!(runtime.diagnostics()["queueBytesPerJob"], 262144);
    runtime
        .call(caller.clone(), "cancel", json!({"id":bulk["id"]}))
        .await
        .unwrap();
    until(|| runtime.diagnostics()["running"] == 0).await;
    println!("PASS: bounded SSE/frame decoding and slow-consumer queue; cancelling releases the HTTP producer");

    // Exercise only our own temporary credential target; never read real keys.
    let credentials = llm::credentials::SystemCredentials;
    let credential_id = format!("selftest-{}", sidecar_rpc::instance_id());
    credentials
        .write(&credential_id, "TOOLKIT_SELFTEST_FAKE_KEY")
        .unwrap();
    struct CredentialCleanup(String);
    impl Drop for CredentialCleanup {
        fn drop(&mut self) {
            let _ = llm::credentials::SystemCredentials.delete(&self.0);
        }
    }
    let credential_cleanup = CredentialCleanup(credential_id.clone());
    assert_eq!(
        credentials
            .read(&credential_id)
            .unwrap()
            .as_deref()
            .map(|s| s.as_str()),
        Some("TOOLKIT_SELFTEST_FAKE_KEY")
    );
    drop(credential_cleanup);
    assert!(credentials.read(&credential_id).unwrap().is_none());
    println!(
        "PASS: Windows Credential Manager write/read/delete using an isolated test credential"
    );

    toolkit_lib::host::registry::register(
        "test.llm",
        &["rpc:llm".into(), "rpc:test".into(), "rpc:binary".into()],
    );
    let gate = Arc::new(tokio::sync::Notify::new());
    let done = Arc::new(tokio::sync::Notify::new());
    let instance = sidecar_rpc::instance_id();
    let peer = Caller::sidecar("test.llm", &instance);
    let recipient = peer.clone();
    let exchange_store = runtime.resources.clone();
    let exchange_donor = Caller::window("test.llm", "exchange-source");
    let exchange_key =
        toolkit_lib::binary_ipc::Transfers::key(&exchange_donor, "native-exchange").unwrap();
    exchange_store.open(exchange_key.clone(), 13).unwrap();
    exchange_store
        .write(&exchange_key, 0, b"cross-process")
        .unwrap();
    exchange_store.seal(&exchange_key).unwrap();
    let mut services = sidecar_rpc::Services::new();
    services.insert("llm".into(), llm::handler(runtime.clone(), peer.clone()));
    services.insert(
        "binary".into(),
        toolkit_lib::services::binary::peer(runtime.resources.clone(), peer),
    );
    let gate_handler = gate.clone();
    let done_handler = done.clone();
    services.insert(
        "test".into(),
        sidecar_rpc::PeerService {
            actions: vec!["gate".into(), "done".into(), "exchange".into()],
            handler: Arc::new(move |action, params| {
                let gate = gate_handler.clone();
                let done = done_handler.clone();
                let store = exchange_store.clone();
                let donor = exchange_donor.clone();
                let source = exchange_key.clone();
                let to = recipient.owner.clone();
                Box::pin(async move {
                    if action == "gate" {
                        gate.notified().await;
                        return Ok(json!({"ticket":store.offer(&donor,&source.id,&to)?}));
                    } else if action == "exchange" {
                        let receiver = Caller::window("test.llm", "exchange-return");
                        let received =
                            store.import(&receiver, params["ticket"]["token"].as_str().unwrap())?;
                        let key = toolkit_lib::binary_ipc::Transfers::key(
                            &receiver,
                            received["source"]["id"].as_str().unwrap(),
                        )?;
                        assert!(Arc::ptr_eq(&store.borrow(&source)?, &store.borrow(&key)?));
                        assert_eq!(store.read(&key, 0, 256)?, b"cross-process");
                        store.close(&key);
                        store.close(&source);
                    } else {
                        done.notify_one();
                    }
                    Ok(json!(true))
                })
            }),
            close: Arc::new(|| {}),
        },
    );
    let endpoint =
        sidecar_rpc::Prepared::new(&instance, Caller::sidecar("test.llm", &instance), services)
            .unwrap()
            .with_resources(&instance, runtime.resources.clone())
            .unwrap();
    let plugins = temp.path().join("plugins");
    let plugin = plugins.join("test-llm");
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(
        plugin.join("plugin.json"),
        r#"{"id":"test.llm","entry":"main.js"}"#,
    )
    .unwrap();
    std::fs::write(plugin.join("main.js"), "export default {};").unwrap();
    std::fs::copy(std::env::current_exe().unwrap(), plugin.join("check.exe")).unwrap();
    let root = plugins.clone();
    let spawned=tokio::task::spawn_blocking(move ||proc::spawn_at(&root,"test.llm",&json!({"key":"native","exe":"check.exe","args":["--sidecar-check"],"background":true,"hostRpc":true}),Some(endpoint))).await.unwrap().unwrap();
    assert!(spawned["pid"].as_u64().unwrap() > 0);
    assert_eq!(session::list(Some("test.llm")).len(), 1);
    assert_eq!(session::reap_orphans(), 0);
    gate.notify_one();
    tokio::time::timeout(Duration::from_secs(30), done.notified())
        .await
        .unwrap_or_else(|_| {
            panic!(
                "real Sidecar did not finish its host RPC checks: {}",
                std::fs::read_to_string(plugin.join("check-failure.txt"))
                    .unwrap_or_else(|_| "no child panic recorded".into())
            )
        });
    until(|| {
        session::list(Some("test.llm")).is_empty()
            && runtime.diagnostics()["jobs"] == 0
            && runtime.diagnostics()["running"] == 0
            && runtime.resources.diagnostics()["bytes"] == 0
    })
    .await;
    println!("PASS: real background Sidecar completes LLM calls without any WebView; frontend orphan cleanup preserves it; native exit reaps it");

    // A dead connection cancels its jobs; a replacement instance cannot use an old id.
    let instance = sidecar_rpc::instance_id();
    let owner = Caller::sidecar("test.llm", &instance);
    let mut services = sidecar_rpc::Services::new();
    services.insert("llm".into(), llm::handler(runtime.clone(), owner));
    let endpoint =
        sidecar_rpc::Prepared::new(&instance, Caller::sidecar("test.llm", &instance), services)
            .unwrap();
    let client = toolkit_host::Client::connect(&endpoint.path).await.unwrap();
    let lease = endpoint.start(std::process::id());
    let old = client
        .request("llm", "start", request("stall"))
        .await
        .unwrap();
    runtime.cancel_owner("window:main");
    assert_eq!(runtime.diagnostics()["jobs"], 1); // Closing a renderer does not own this job.
    drop(client);
    until(|| runtime.diagnostics()["jobs"] == 0 && runtime.diagnostics()["running"] == 0).await;
    lease.close();
    let replacement = Caller::sidecar("test.llm", &sidecar_rpc::instance_id());
    assert!(runtime
        .call(replacement.clone(), "next", json!({"id":old["id"]}))
        .await
        .is_err());
    assert_eq!(
        collect(&runtime, replacement, "chat").await.unwrap(),
        "你好"
    );
    println!("PASS: simultaneous next/cancel RPC, renderer-owner cleanup isolation, connection loss and replacement instance");

    let instance = sidecar_rpc::instance_id();
    let endpoint = sidecar_rpc::Prepared::new(
        &instance,
        Caller::sidecar("test.llm", &instance),
        sidecar_rpc::Services::new(),
    )
    .unwrap();
    let client = toolkit_host::Client::connect(&endpoint.path).await.unwrap();
    let lease = endpoint.start(std::process::id().wrapping_add(1));
    assert!(tokio::time::timeout(
        Duration::from_secs(3),
        client.request("host", "schema", Value::Null)
    )
    .await
    .unwrap()
    .is_err());
    lease.close();
    println!(
        "PASS: named pipe rejects a client whose OS process does not match the spawned instance"
    );
    server.abort();
    println!("PASS: final model state {}", runtime.diagnostics());
}

fn main() {
    #[cfg(windows)]
    {
        if std::env::args().nth(1).as_deref() == Some("--ui") {
            ui_check();
            return;
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .unwrap();
        if std::env::args().nth(1).as_deref() == Some("--sidecar-check") {
            std::panic::set_hook(Box::new(|info| {
                let _ = std::fs::write("check-failure.txt", info.to_string());
            }));
            runtime.block_on(child_check());
        } else {
            runtime.block_on(checks());
        }
    }
    #[cfg(not(windows))]
    println!("SKIP: Windows Sidecar host RPC checks");
}

/// Manual settings smoke test: production commands and UI, isolated configuration
/// and in-memory fake credentials. Requires Vite on port 1429; no plugin boot.
#[cfg(windows)]
fn ui_check() {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use tauri::Manager;
    #[derive(Default)]
    struct MemoryCredentials(Mutex<HashMap<String, String>>);
    impl Credentials for MemoryCredentials {
        fn read(&self, id: &str) -> Result<Option<Zeroizing<String>>, String> {
            Ok(self.0.lock().unwrap().get(id).cloned().map(Zeroizing::new))
        }
        fn write(&self, id: &str, key: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), key.into());
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let (url, _, server) = tauri::async_runtime::block_on(mock_server(false));
    let config = Config {
        connections: vec![Connection {
            id: "mock".into(),
            name: "Isolated mock API".into(),
            adapter: Adapter::OpenaiChat,
            base_url: url,
        }],
        profiles: vec![Profile {
            id: "mock".into(),
            name: "Isolated text model".into(),
            connection_id: "mock".into(),
            model: "chat".into(),
            max_output_tokens: 64,
            timeout_ms: 10000,
            allowed_plugins: vec!["test.llm".into()],
            allow_images: false,
            reasoning: None,
        }],
        default_profile: Some("mock".into()),
    };
    let path = temp.path().join("llm.json");
    config.save(&path).unwrap();
    let credentials = Arc::new(MemoryCredentials::default());
    credentials
        .write("mock", "TOOLKIT_SELFTEST_FAKE_KEY")
        .unwrap();
    let runtime = Runtime::new(path, credentials).unwrap();
    toolkit_lib::host::registry::register("test.llm", &["rpc:llm".into()]);
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!("com.tan18.toolkit.llm-check-{}", std::process::id());
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = Some("http://127.0.0.1:1429".parse().unwrap());
    let app = tauri::Builder::default()
        .manage(llm::Host::from_runtime(runtime.clone()))
        .invoke_handler(tauri::generate_handler![
            llm::settings::host_llm_open,
            llm::settings::host_llm_admin
        ])
        .setup(|app| {
            let main = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("llmsettings.html".into()),
            )
            .visible(false)
            .build()?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                llm::settings::host_llm_open(handle.clone(), main)
                    .await
                    .unwrap();
                handle
                    .get_webview_window("host-llm-settings")
                    .unwrap()
                    .set_title("Toolkit Model settings · isolated check")
                    .unwrap();
                tokio::time::sleep(Duration::from_secs(180)).await;
                handle.exit(0);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "host-llm-settings"
                && matches!(event, tauri::WindowEvent::Destroyed)
            {
                window.app_handle().exit(0);
            }
        })
        .build(context)
        .unwrap();
    app.run(|_, _| {});
    runtime.cancel_all();
    server.abort();
}
