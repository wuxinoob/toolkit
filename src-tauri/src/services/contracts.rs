//! Public parameter/result schemas; the same JSON generates SDK declarations.
use serde_json::Value;
use std::sync::OnceLock;
pub fn schema() -> Value {
    static CONTRACTS: OnceLock<Value> = OnceLock::new();
    CONTRACTS
        .get_or_init(|| {
            serde_json::from_str(include_str!("../../../sdk/contracts.json"))
                .expect("valid bundled API contracts")
        })
        .clone()
}
pub fn for_sidecar(services: &crate::sidecar_rpc::Services) -> Value {
    let mut result = schema();
    result.as_object_mut().unwrap().remove("webview");
    result["services"]
        .as_object_mut()
        .unwrap()
        .retain(|name, _| services.contains_key(name));
    for (name, actions) in result["services"].as_object_mut().unwrap().iter_mut() {
        actions.as_object_mut().unwrap().retain(|action, spec| {
            services[name].actions.contains(action) && spec["transport"] != "rpc-raw"
        });
    }
    result
}
