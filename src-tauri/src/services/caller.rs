/// Attribution is supplied by the native transport, never by request payloads.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Caller {
    pub plugin: String,
    pub owner: String,
    pub(crate) admin: bool,
}
impl Caller {
    pub fn window(plugin: &str, label: &str) -> Self {
        Self {
            plugin: plugin.into(),
            owner: format!("window:{label}"),
            admin: false,
        }
    }
    pub fn sidecar(plugin: &str, instance: &str) -> Self {
        Self {
            plugin: plugin.into(),
            owner: format!("sidecar:{instance}"),
            admin: false,
        }
    }
    pub(crate) fn admin() -> Self {
        Self {
            plugin: "__host__".into(),
            owner: "window:host-llm-settings".into(),
            admin: true,
        }
    }
}
