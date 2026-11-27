use serde_json::json;
use std::sync::Arc;
use toolkit_lib::{
    llm::{self, Runtime},
    services::caller::Caller,
};

pub async fn checks(runtime: &Arc<Runtime>) {
    let caller = Caller::window("test.llm", "main");
    let profiles = runtime.profiles(&caller);
    let profile = &profiles
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "chat")
        .unwrap();
    assert_eq!(profile["reasoning"]["defaultEffort"], "medium");
    assert_eq!(
        profile["reasoning"]["allowedEfforts"],
        json!(["low", "medium", "high", "max"])
    );
    assert_eq!(profile["capabilities"]["reasoning"], true);
    assert!(profile["reasoning"].get("chatOutputTokens").is_none());
    assert!(runtime
        .profiles(&Caller::window("other.plugin", "main"))
        .as_array()
        .unwrap()
        .is_empty());
    for id in ["chat", "responses"] {
        for effort in [None, Some("low"), Some("max")] {
            let mut request = super::request(id);
            if let Some(effort) = effort {
                request["reasoningEffort"] = json!(effort);
            }
            let start = runtime
                .call(caller.clone(), "start", request)
                .await
                .unwrap();
            assert_eq!(start["reasoningEffort"], effort.unwrap_or("medium"));
            loop {
                let event = runtime
                    .call(caller.clone(), "next", json!({"id":start["id"]}))
                    .await
                    .unwrap();
                if event["type"] == "completed" {
                    break;
                }
            }
        }
    }
    let mut request = super::request("chat");
    request["reasoningEffort"] = json!("ultra");
    assert_eq!(
        runtime
            .call(caller.clone(), "start", request)
            .await
            .unwrap_err()
            .code,
        "bad_params"
    );
    let mut request = super::request("stall");
    request["reasoningEffort"] = json!("low");
    assert_eq!(
        runtime
            .call(caller.clone(), "start", request)
            .await
            .unwrap_err()
            .code,
        "unsupported"
    );
    let mut config = runtime.configuration();
    let index = config.profiles.iter().position(|p| p.id == "chat").unwrap();
    config.profiles[index]
        .reasoning
        .as_mut()
        .unwrap()
        .default_effort = Some("ultra".into());
    assert!(config.validate().is_err());
    config.profiles[index]
        .reasoning
        .as_mut()
        .unwrap()
        .default_effort = Some("medium".into());
    config.profiles[index]
        .reasoning
        .as_mut()
        .unwrap()
        .allowed_efforts
        .push("medium".into());
    assert!(config.validate().is_err());
    config.profiles[index]
        .reasoning
        .as_mut()
        .unwrap()
        .allowed_efforts
        .pop();
    config
        .connections
        .iter_mut()
        .find(|c| c.id == "chat")
        .unwrap()
        .base_url = "https://api.anthropic.com/v1".into();
    assert!(config
        .validate()
        .unwrap_err()
        .contains("ignores reasoning_effort"));
    let legacy: llm::config::Profile = serde_json::from_value(
        json!({"id":"legacy","name":"Legacy","connectionId":"chat","model":"old"}),
    )
    .unwrap();
    assert!(legacy.reasoning.is_none());
    let request:llm::Request=serde_json::from_value(json!({"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}],"reasoningEffort":"low","maxOutputTokens":32})).unwrap();
    let body = llm::vision::body(
        llm::config::Adapter::OpenaiChat,
        "compat",
        request,
        &Default::default(),
        llm::reasoning::ChatOutputTokens::MaxTokens,
    )
    .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["reasoning_effort"], "low");
    assert_eq!(body["max_tokens"], 32);
    assert!(body["max_completion_tokens"].is_null());
    println!("PASS reasoning profile metadata, inherited/overridden effort over real HTTP, two wire formats, level policy, legacy config and incompatible API rejection");
}
