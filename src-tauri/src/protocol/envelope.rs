//! The envelope: one vocabulary for every direction.
//!
//! ```text
//!  uplink   (plugin -> host)  req  ->  res | err
//!  downlink (host -> plugin)  evt  (broadcast)
//!                             data | end | exit | err  (stream frames)
//! ```
//!
//! `req/res/err` carry `id` for correlation; stream frames carry `ch` (the
//! channel id) and are ordered by construction; `evt` carries `topic` and is
//! a fire-and-forget broadcast. No field is mandatory for every kind — see
//! [`Envelope::validate`], the single place that encodes those rules.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumped whenever the envelope shape changes incompatibly. Both sides
/// reject mismatched versions up front instead of failing deep in a service.
pub const PROTOCOL_VERSION: u8 = 1;

/// The event name a broadcast (`evt`) is delivered under, so a single
/// `listen()` in every window receives the whole host bus.
pub const BROADCAST_EVENT: &str = "ump://evt";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// plugin -> host: a service call
    Req,
    /// host -> plugin: successful reply to a `req`
    Res,
    /// either direction: a failure (reply to `req`, or mid-stream failure)
    Err,
    /// host -> plugin: fire-and-forget broadcast
    Evt,
    /// host -> plugin: one stream chunk
    Data,
    /// host -> plugin: stream finished successfully
    End,
    /// host -> plugin: the stream's process exited (payload carries the code)
    Exit,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Req => "req",
            Kind::Res => "res",
            Kind::Err => "err",
            Kind::Evt => "evt",
            Kind::Data => "data",
            Kind::End => "end",
            Kind::Exit => "exit",
        }
    }

    /// Initiated by the plugin side (needs `id` + `svc` + `act`).
    pub fn is_uplink(self) -> bool {
        matches!(self, Kind::Req)
    }

    /// Pushed by the host side (needs `ch`, except for broadcasts).
    pub fn is_downlink(self) -> bool {
        matches!(self, Kind::Evt | Kind::Data | Kind::End | Kind::Exit)
    }

    /// A terminal frame: after it the stream is deregistered.
    pub fn is_terminal(self) -> bool {
        matches!(self, Kind::End | Kind::Exit | Kind::Err)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    /// protocol version
    pub v: u8,
    pub kind: Kind,
    /// correlation id for req/res/err
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    /// channel / session id for stream frames
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ch: Option<String>,
    /// service name (req)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub svc: Option<String>,
    /// action name (req)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub act: Option<String>,
    /// broadcast topic (evt)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    /// machine-readable error code
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// human-readable error message
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msg: Option<String>,
    /// payload — any JSON value; binary payloads use the raw-binary codec
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub p: Value,
}

impl Envelope {
    fn base(kind: Kind) -> Self {
        Envelope {
            v: PROTOCOL_VERSION,
            kind,
            id: None,
            ch: None,
            svc: None,
            act: None,
            topic: None,
            code: None,
            msg: None,
            p: Value::Null,
        }
    }

    pub fn req(id: u64, svc: impl Into<String>, act: impl Into<String>, p: Value) -> Self {
        let mut e = Self::base(Kind::Req);
        e.id = Some(id);
        e.svc = Some(svc.into());
        e.act = Some(act.into());
        e.p = p;
        e
    }

    pub fn res(id: u64, p: Value) -> Self {
        let mut e = Self::base(Kind::Res);
        e.id = Some(id);
        e.p = p;
        e
    }

    pub fn err(id: Option<u64>, code: impl Into<String>, msg: impl Into<String>) -> Self {
        let mut e = Self::base(Kind::Err);
        e.id = id;
        e.code = Some(code.into());
        e.msg = Some(msg.into());
        e
    }

    pub fn evt(topic: impl Into<String>, p: Value) -> Self {
        let mut e = Self::base(Kind::Evt);
        e.topic = Some(topic.into());
        e.p = p;
        e
    }

    pub fn data(ch: impl Into<String>, p: Value) -> Self {
        let mut e = Self::base(Kind::Data);
        e.ch = Some(ch.into());
        e.p = p;
        e
    }

    pub fn end(ch: impl Into<String>) -> Self {
        let mut e = Self::base(Kind::End);
        e.ch = Some(ch.into());
        e
    }

    /// Exit frame; the code travels in `p` so every codec can carry it.
    pub fn exit(ch: impl Into<String>, code: i32) -> Self {
        let mut e = Self::base(Kind::Exit);
        e.ch = Some(ch.into());
        e.p = Value::from(code);
        e
    }

    pub fn stream_err(ch: impl Into<String>, code: impl Into<String>, msg: impl Into<String>) -> Self {
        let mut e = Self::base(Kind::Err);
        e.ch = Some(ch.into());
        e.code = Some(code.into());
        e.msg = Some(msg.into());
        e
    }

    pub fn is_err(&self) -> bool {
        self.kind == Kind::Err
    }

    /// The one place the "which fields does which kind need" rules live.
    pub fn validate(&self) -> Result<(), String> {
        if self.v != PROTOCOL_VERSION {
            return Err(format!(
                "unsupported protocol version {} (expected {PROTOCOL_VERSION})",
                self.v
            ));
        }
        let empty = |o: &Option<String>| o.as_deref().unwrap_or("").is_empty();
        match self.kind {
            Kind::Req => {
                if self.id.is_none() {
                    return Err("req envelope requires `id`".into());
                }
                if empty(&self.svc) {
                    return Err("req envelope requires `svc`".into());
                }
                if empty(&self.act) {
                    return Err("req envelope requires `act`".into());
                }
            }
            Kind::Res | Kind::Err => {
                // A mid-stream err carries `ch` instead of `id`.
                if self.id.is_none() && empty(&self.ch) {
                    return Err(format!("{} envelope requires `id` or `ch`", self.kind.as_str()));
                }
            }
            Kind::Data | Kind::End | Kind::Exit => {
                if empty(&self.ch) {
                    return Err(format!("{} envelope requires `ch`", self.kind.as_str()));
                }
            }
            Kind::Evt => {
                if empty(&self.topic) {
                    return Err("evt envelope requires `topic`".into());
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn constructors_produce_the_documented_shape() {
        assert_eq!(
            serde_json::to_value(Envelope::req(7, "storage", "get", json!({ "key": "k" }))).unwrap(),
            json!({ "v": 1, "kind": "req", "id": 7, "svc": "storage", "act": "get", "p": { "key": "k" } })
        );
        assert_eq!(
            serde_json::to_value(Envelope::res(7, json!(true))).unwrap(),
            json!({ "v": 1, "kind": "res", "id": 7, "p": true })
        );
        assert_eq!(
            serde_json::to_value(Envelope::data("s1", json!({ "n": 1 }))).unwrap(),
            json!({ "v": 1, "kind": "data", "ch": "s1", "p": { "n": 1 } })
        );
        // exit code travels in `p` so every codec can carry it
        assert_eq!(
            serde_json::to_value(Envelope::exit("s1", 3)).unwrap(),
            json!({ "v": 1, "kind": "exit", "ch": "s1", "p": 3 })
        );
    }

    #[test]
    fn omitted_fields_do_not_appear_on_the_wire() {
        let text = serde_json::to_string(&Envelope::end("c")).unwrap();
        assert!(!text.contains("svc") && !text.contains("id") && !text.contains("topic"));
    }

    #[test]
    fn validate_enforces_per_kind_requirements() {
        assert!(Envelope::req(1, "s", "a", Value::Null).validate().is_ok());
        assert!(Envelope::data("c", Value::Null).validate().is_ok());
        assert!(Envelope::evt("t", Value::Null).validate().is_ok());

        // missing correlation
        let mut bad = Envelope::req(1, "s", "a", Value::Null);
        bad.id = None;
        assert!(bad.validate().unwrap_err().contains("requires `id`"));

        // missing service
        let mut bad = Envelope::req(1, "s", "a", Value::Null);
        bad.svc = None;
        assert!(bad.validate().unwrap_err().contains("requires `svc`"));

        // stream frame without a channel
        let mut bad = Envelope::data("c", Value::Null);
        bad.ch = None;
        assert!(bad.validate().unwrap_err().contains("requires `ch`"));

        // broadcast without a topic
        let mut bad = Envelope::evt("t", Value::Null);
        bad.topic = None;
        assert!(bad.validate().unwrap_err().contains("requires `topic`"));

        // version gate
        let mut bad = Envelope::end("c");
        bad.v = 99;
        assert!(bad.validate().unwrap_err().contains("protocol version"));
    }

    #[test]
    fn mid_stream_error_is_valid_without_an_id() {
        let e = Envelope::stream_err("s1", "io", "boom");
        assert!(e.validate().is_ok());
        assert!(e.is_err());
        assert!(Kind::Err.is_terminal() && Kind::End.is_terminal() && Kind::Exit.is_terminal());
        assert!(!Kind::Data.is_terminal());
    }
}
