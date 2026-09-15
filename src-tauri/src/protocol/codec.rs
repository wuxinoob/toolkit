//! Codecs: how an [`Envelope`] is framed on a given wire.
//!
//! Three codecs cover every current need, and they are pure functions — no
//! transport knowledge leaks in here, and no codec knowledge leaks into the
//! services. Swapping a wire format never touches business logic.
//!
//! | codec         | wire                                   | used by |
//! |---------------|----------------------------------------|---------|
//! | `json_envelope` | one JSON object per message          | invoke gateway, `Channel<Envelope>` streams |
//! | `line_json`     | one JSON object per `\n`-terminated line | sidecar stdio pipes |
//! | `raw_binary`    | 1 kind byte + payload                | `Channel<InvokeResponseBody>` streams, PTY bytes |

use serde_json::Value;

use super::envelope::{Envelope, Kind};

/// One JSON object per message. Also the shape Tauri's `invoke` and
/// `Channel<T>` use, so it needs no extra framing.
pub mod json_envelope {
    use super::*;

    pub fn encode(env: &Envelope) -> Result<String, String> {
        serde_json::to_string(env).map_err(|e| format!("encode envelope: {e}"))
    }

    pub fn decode(text: &str) -> Result<Envelope, String> {
        let env: Envelope = serde_json::from_str(text).map_err(|e| format!("decode envelope: {e}"))?;
        env.validate()?;
        Ok(env)
    }
}

/// Newline-delimited JSON — the sidecar pipe format. A CRLF producer must not
/// leak `\r` into payloads, so trailing whitespace is trimmed on read.
pub mod line_json {
    use super::*;

    /// Encode one message as a single terminated line.
    pub fn encode(env: &Envelope) -> Result<String, String> {
        let mut s = json_envelope::encode(env)?;
        s.push('\n');
        Ok(s)
    }

    /// Decode one line (without or with its terminator).
    pub fn decode_line(line: &str) -> Result<Envelope, String> {
        json_envelope::decode(line.trim_end_matches(['\r', '\n']))
    }
}

/// 1-byte kind prefix + raw payload. Zero JSON parsing on the hot path, so
/// this is what high-volume byte streams (PTY output) use.
pub mod raw_binary {
    use super::*;

    pub const DATA: u8 = 0x01;
    pub const END: u8 = 0x02;
    pub const EXIT: u8 = 0x03;
    pub const ERR: u8 = 0x04;

    pub fn kind_byte(kind: Kind) -> Option<u8> {
        match kind {
            Kind::Data => Some(DATA),
            Kind::End => Some(END),
            Kind::Exit => Some(EXIT),
            Kind::Err => Some(ERR),
            _ => None, // req/res/evt never travel on a raw channel
        }
    }

    pub fn from_byte(b: u8) -> Option<Kind> {
        match b {
            DATA => Some(Kind::Data),
            END => Some(Kind::End),
            EXIT => Some(Kind::Exit),
            ERR => Some(Kind::Err),
            _ => None,
        }
    }

    pub fn encode(kind: Kind, payload: &[u8]) -> Result<Vec<u8>, String> {
        let k = kind_byte(kind).ok_or_else(|| format!("kind `{}` cannot travel raw", kind.as_str()))?;
        let mut out = Vec::with_capacity(payload.len() + 1);
        out.push(k);
        out.extend_from_slice(payload);
        Ok(out)
    }

    /// Split one frame into (kind, payload). `None` on empty input or an
    /// unknown kind byte — the caller decides whether that is fatal.
    pub fn decode(buf: &[u8]) -> Option<(Kind, &[u8])> {
        let (b, rest) = buf.split_first()?;
        from_byte(*b).map(|k| (k, rest))
    }

    /// Exit codes travel as 4 little-endian bytes.
    pub fn encode_code(code: i32) -> Vec<u8> {
        code.to_le_bytes().to_vec()
    }

    pub fn decode_code(payload: &[u8]) -> Option<i32> {
        payload
            .get(..4)
            .map(|b| i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    /// Project a JSON payload down to raw bytes, so ONE producer can serve
    /// both the JSON and the raw wire (strings -> UTF-8, numbers -> u64 LE,
    /// anything else -> compact JSON).
    pub fn payload_bytes(p: &Value) -> Vec<u8> {
        match p {
            Value::Null => Vec::new(),
            Value::String(s) => s.as_bytes().to_vec(),
            Value::Number(n) => n.as_i64().map(|v| v.to_le_bytes().to_vec()).unwrap_or_else(|| {
                n.as_f64().map(|v| v.to_le_bytes().to_vec()).unwrap_or_default()
            }),
            Value::Bool(b) => vec![u8::from(*b)],
            other => serde_json::to_vec(other).unwrap_or_default(),
        }
    }

    /// Inverse of [`payload_bytes`] for text/binary consumers.
    pub fn bytes_to_text(payload: &[u8]) -> String {
        String::from_utf8_lossy(payload).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_envelope_roundtrips_and_validates() {
        let env = Envelope::req(3, "storage", "get", json!({ "key": "k" }));
        let text = json_envelope::encode(&env).unwrap();
        assert_eq!(json_envelope::decode(&text).unwrap(), env);

        // a malformed envelope is rejected at the codec boundary
        let bad = r#"{"v":1,"kind":"req","svc":"s","act":"a"}"#; // no id
        assert!(json_envelope::decode(bad).unwrap_err().contains("requires `id`"));
        assert!(json_envelope::decode("not json").unwrap_err().contains("decode envelope"));
    }

    #[test]
    fn line_json_is_one_terminated_line_and_tolerates_crlf() {
        let env = Envelope::data("c", json!({ "n": 1 }));
        let line = line_json::encode(&env).unwrap();
        assert!(line.ends_with('\n') && line.matches('\n').count() == 1);
        assert_eq!(line_json::decode_line(&line).unwrap(), env);
        // a CRLF producer must not leak `\r` into the payload
        assert_eq!(line_json::decode_line(&format!("{}\r\n", line.trim())).unwrap(), env);
    }

    #[test]
    fn raw_binary_frames_roundtrip_and_reject_unknown_kinds() {
        assert_eq!(raw_binary::encode(Kind::Data, b"hi").unwrap(), vec![0x01, b'h', b'i']);
        assert_eq!(raw_binary::decode(&[0x01, b'h', b'i']), Some((Kind::Data, &b"hi"[..])));
        assert_eq!(raw_binary::decode(&[0x02]), Some((Kind::End, &b""[..])));
        assert_eq!(raw_binary::decode(&[]), None, "empty buffer has no kind byte");
        assert_eq!(raw_binary::decode(&[0x09, 1]), None, "unknown kind must be rejected");
        // uplink kinds have no raw representation
        assert!(raw_binary::encode(Kind::Req, b"").is_err());
    }

    #[test]
    fn raw_exit_codes_are_four_le_bytes() {
        let bytes = raw_binary::encode_code(258);
        assert_eq!(bytes, vec![2, 1, 0, 0]);
        assert_eq!(raw_binary::decode_code(&bytes), Some(258));
        assert_eq!(raw_binary::decode_code(&[1, 0]), None, "truncated code");
    }

    #[test]
    fn one_payload_serves_both_wires() {
        assert_eq!(raw_binary::payload_bytes(&json!("abc")), b"abc".to_vec());
        assert_eq!(raw_binary::payload_bytes(&json!(7i64)), 7i64.to_le_bytes().to_vec());
        assert_eq!(raw_binary::payload_bytes(&Value::Null), Vec::<u8>::new());
        assert_eq!(raw_binary::bytes_to_text(b"abc"), "abc".to_string());
    }
}
