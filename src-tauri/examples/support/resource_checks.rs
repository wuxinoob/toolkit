use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use toolkit_lib::{
    binary_ipc::{Transfers, MAX_CHUNK_BYTES, MAX_TRANSFER_BYTES},
    llm::{self, Runtime},
    services::{
        caller::Caller,
        screen::{validate_region, Region},
    },
    sidecar_rpc,
};

pub fn png() -> Vec<u8> {
    let mut seed = 1u32;
    let image = image::RgbImage::from_fn(1024, 768, |_, _| {
        let mut p = [0; 3];
        for v in &mut p {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            *v = (seed >> 24) as u8;
        }
        image::Rgb(p)
    });
    let mut bytes = Vec::new();
    image
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    assert!(bytes.len() > 1024 * 1024);
    bytes
}
pub async fn checks(runtime: &Arc<Runtime>) {
    let store = Transfers::default();
    let owner = Caller::window("test.llm", "resources");
    let key = Transfers::key(&owner, "resource").unwrap();
    store.open(key.clone(), 4).unwrap();
    store.write(&key, 0, b"ab").unwrap();
    assert!(store.seal(&key).is_err());
    assert!(store.borrow(&key).is_err());
    assert_eq!(store.write(&key, 0, b"ab").unwrap(), 2);
    assert!(store.write(&key, 0, b"xx").is_err());
    store.write(&key, 2, b"cd").unwrap();
    store.seal(&key).unwrap();
    assert!(store.write(&key, 4, b"").is_err());
    let lease = store.borrow(&key).unwrap();
    store.close(&key);
    assert_eq!(lease.bytes, b"abcd");
    assert_eq!(store.diagnostics()["bytes"], 4);
    assert!(store
        .borrow(&Transfers::key(&Caller::window("test.llm", "other"), "resource").unwrap())
        .is_err());
    drop(lease);
    assert_eq!(store.diagnostics()["bytes"], 0);
    let key = Transfers::key(&owner, "budget").unwrap();
    store.open(key.clone(), MAX_TRANSFER_BYTES).unwrap();
    store.finish(&key, vec![0; MAX_TRANSFER_BYTES]).unwrap();
    let lease = store.borrow(&key).unwrap();
    store.close(&key);
    for i in 0..3 {
        store
            .open(
                Transfers::key(&owner, &format!("buffer-{i}")).unwrap(),
                MAX_TRANSFER_BYTES,
            )
            .unwrap();
    }
    assert!(store
        .open(Transfers::key(&owner, "overflow").unwrap(), 1)
        .is_err());
    store.close_caller(&owner);
    assert_eq!(store.diagnostics()["bytes"], MAX_TRANSFER_BYTES);
    drop(lease);
    assert_eq!(store.diagnostics()["bytes"], 0);
    let late = Transfers::key(&owner, "late").unwrap();
    store.open(late.clone(), 16).unwrap();
    store.close_window("resources");
    assert!(store.finish(&late, b"late".to_vec()).is_err());
    assert!(validate_region(
        1920,
        1080,
        Some(Region {
            x: 1900,
            y: 0,
            width: 30,
            height: 1
        })
    )
    .is_err());
    assert!(validate_region(
        1920,
        1080,
        Some(Region {
            x: u32::MAX,
            y: 0,
            width: 2,
            height: 1
        })
    )
    .is_err());
    assert!(validate_region(
        1920,
        1080,
        Some(Region {
            x: 0,
            y: 0,
            width: 0,
            height: 1
        })
    )
    .is_err());
    assert!(validate_region(
        16384,
        16384,
        Some(Region {
            x: 1,
            y: 1,
            width: 100,
            height: 100
        })
    )
    .is_ok());
    assert!(validate_region(16384, 16384, None).is_err());
    let bytes = png();
    let key = Transfers::key(&owner, "picture").unwrap();
    runtime.resources.open(key.clone(), bytes.len()).unwrap();
    for (i, chunk) in bytes.chunks(MAX_CHUNK_BYTES).enumerate() {
        runtime
            .resources
            .write(&key, i * MAX_CHUNK_BYTES, chunk)
            .unwrap();
    }
    runtime.resources.seal(&key).unwrap();
    let request = json!({"profile":"chat","messages":[{"role":"user","content":[{"type":"text","text":"describe"},{"type":"image","source":{"kind":"resource","id":"picture","size":bytes.len()}}]}]});
    let parsed: llm::Request = serde_json::from_value(request.clone()).unwrap();
    parsed.validate().unwrap();
    let mut wrong_size = request.clone();
    wrong_size["messages"][0]["content"][1]["source"]["size"] = json!(1);
    assert!(llm::vision::prepare(
        &runtime.resources,
        &owner,
        &serde_json::from_value(wrong_size).unwrap(),
        true
    )
    .is_err());
    let mut many = request.clone();
    many["messages"][0]["content"] = json!(vec![request["messages"][0]["content"][1].clone(); 9]);
    assert!(llm::vision::prepare(
        &runtime.resources,
        &owner,
        &serde_json::from_value(many).unwrap(),
        true
    )
    .is_err());
    for format in [image::ImageFormat::Jpeg, image::ImageFormat::WebP] {
        let image = image::RgbImage::from_pixel(2, 3, image::Rgb([11, 22, 33]));
        let mut encoded = Vec::new();
        image
            .write_to(&mut std::io::Cursor::new(&mut encoded), format)
            .unwrap();
        let format_key = Transfers::key(&owner, "format").unwrap();
        runtime
            .resources
            .open(format_key.clone(), encoded.len())
            .unwrap();
        let source = runtime.resources.finish(&format_key, encoded).unwrap();
        let image_request: llm::Request = serde_json::from_value(
            json!({"messages":[{"role":"user","content":[{"type":"image","source":source}]}]}),
        )
        .unwrap();
        assert!(llm::vision::prepare(&runtime.resources, &owner, &image_request, true).is_ok());
        runtime.resources.close(&format_key);
    }
    assert!(llm::vision::prepare(&runtime.resources, &owner, &parsed, false).is_err());
    assert!(llm::vision::prepare(
        &runtime.resources,
        &Caller::sidecar("test.llm", "foreign"),
        &parsed,
        true
    )
    .is_err());
    for adapter in [
        llm::config::Adapter::OpenaiChat,
        llm::config::Adapter::OpenaiResponses,
    ] {
        let images = llm::vision::prepare(&runtime.resources, &owner, &parsed, true).unwrap();
        let value: Value = serde_json::from_slice(
            &llm::vision::body(
                adapter,
                "vision",
                parsed.clone(),
                &images,
                llm::reasoning::ChatOutputTokens::MaxTokens,
            )
            .unwrap(),
        )
        .unwrap();
        if adapter == llm::config::Adapter::OpenaiChat {
            assert_eq!(value["messages"][0]["content"][1]["type"], "image_url");
        } else {
            assert_eq!(value["input"][0]["content"][0]["type"], "input_text");
            assert_eq!(value["input"][0]["content"][1]["type"], "input_image");
        }
    }
    let mut denied = request.clone();
    denied["profile"] = json!("stall");
    assert_eq!(
        runtime
            .call(owner.clone(), "start", denied)
            .await
            .unwrap_err()
            .code,
        "denied"
    );
    let mut stalled = request;
    stalled["profile"] = json!("vision-stall");
    let start = runtime.call(owner.clone(), "start", stalled).await.unwrap();
    runtime.resources.close(&key);
    assert!(runtime.resources.diagnostics()["bytes"].as_u64().unwrap() > 0);
    runtime
        .call(owner.clone(), "cancel", json!({"id":start["id"]}))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while runtime.resources.diagnostics()["bytes"] != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    println!("PASS: immutable resource ownership, incomplete/replayed writes, pinned budgets, cancelled producers, native ROI geometry, real PNG >1 MiB, two vision adapters and model cancellation cleanup");

    // A half-written raw frame must not block model cancellation or keep resources.
    toolkit_lib::host::registry::register("test.resources", &["rpc:binary".into()]);
    let instance = sidecar_rpc::instance_id();
    let caller = Caller::sidecar("test.resources", &instance);
    let store = Transfers::default();
    let mut services = sidecar_rpc::Services::new();
    services.insert(
        "binary".into(),
        toolkit_lib::services::binary::peer(store.clone(), caller.clone()),
    );
    let endpoint = sidecar_rpc::Prepared::new(&instance, caller.clone(), services)
        .unwrap()
        .with_resources(&instance, store.clone())
        .unwrap();
    let control = toolkit_host::Client::connect(&endpoint.path).await.unwrap();
    let mut raw = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(endpoint.resource_path().unwrap())
        .unwrap();
    let lease = endpoint.start(std::process::id());
    control
        .request("binary", "open", json!({"id":"partial","size":256}))
        .await
        .unwrap();
    toolkit_host::write_frame(
        &mut raw,
        &json!({"op":"write","id":"partial","offset":0,"length":256}),
    )
    .await
    .unwrap();
    tokio::time::timeout(
        Duration::from_secs(2),
        control.request("binary", "close", json!({"id":"partial"})),
    )
    .await
    .unwrap()
    .unwrap();
    drop(raw);
    tokio::time::timeout(Duration::from_secs(5), async {
        while control.request("host", "schema", Value::Null).await.is_ok() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(store.diagnostics()["bytes"], 0);
    lease.close();
    println!("PASS: independent raw/control lanes and truncated-upload disconnect cleanup");
}

pub async fn child(client: &toolkit_host::Client) {
    let bytes = png();
    let mut resource = client.upload_resource(&bytes).await.unwrap();
    assert_eq!(resource.stat().await.unwrap()["sealed"], true);
    let mut output = Vec::new();
    for offset in (0..bytes.len()).step_by(MAX_CHUNK_BYTES) {
        output.extend(resource.read(offset, MAX_CHUNK_BYTES).await.unwrap());
    }
    assert_eq!(output, bytes);
    assert!(resource.write(0, b"x").await.is_err());
    for profile in ["chat", "responses"] {
        let result=client.generate(json!({"profile":profile,"messages":[{"role":"user","content":[{"type":"text","text":"describe"},{"type":"image","source":resource.source()}]}]})).await.unwrap();
        assert_eq!(result["output"][0]["text"], "你好");
    }
    resource.close().await.unwrap();
    // Leave a handle open; native process exit must release it.
    let abandoned = client.upload_resource(b"cleanup-on-exit").await.unwrap();
    std::mem::forget(abandoned);
}
