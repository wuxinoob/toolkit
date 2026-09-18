//! The closed set of error codes.
//!
//! Every `err` envelope the HOST produces carries one of these. Before this
//! existed, a service failure used `{svc}/{act}` as its code (e.g. `storage/get`)
//! and everything else was a bare string, so a caller could only branch on the
//! four protocol-level codes and had to pattern-match messages for the rest —
//! including matching a dependency's wording, which is how the pty transport
//! ended up testing for `"EOF"` and `"Unavailable pid"`.
//!
//! Two rules:
//!
//!   1. The code describes the KIND of failure. Where it happened is already in
//!      the envelope (`svc`/`act`), so it does not belong in the code.
//!   2. A code is a contract: callers branch on it, so it is declared here,
//!      advertised by `host/schema`, and mirrored in `src/protocol/codes.js`.
//!      `tests/codes.test.mjs` fails if the two lists drift.
//!
//! A plugin's OWN backend may still return its own codes (the calc example
//! answers `div_by_zero`) — those never pass through here. This set is the
//! host's vocabulary, and a plugin is free to define its own on top.

/// The vocabulary. Grouped by who normally produces it, not by severity.
pub mod code {
    // --- the gate ---
    /// The caller lacks a permission its manifest declares it needs.
    pub const DENIED: &str = "denied";

    // --- addressing ---
    /// No service by that name.
    pub const UNKNOWN_SERVICE: &str = "unknown_service";
    /// The service exists but has no such action.
    pub const UNKNOWN_ACTION: &str = "unknown_action";
    /// A required parameter is missing or malformed.
    pub const BAD_PARAMS: &str = "bad_params";
    /// The addressed thing does not exist (key, window, session, process).
    pub const NOT_FOUND: &str = "not_found";
    /// The request contradicts current state (duplicate id, already open).
    pub const CONFLICT: &str = "conflict";

    // --- capability ---
    /// The scheme, provider or codec cannot do what was asked.
    pub const UNSUPPORTED: &str = "unsupported";

    // --- the environment ---
    /// A filesystem or OS operation failed.
    pub const IO: &str = "io";
    /// A child process could not be started.
    pub const SPAWN_FAILED: &str = "spawn_failed";
    /// The caller stopped waiting. Never means the host was cancelled.
    pub const TIMEOUT: &str = "timeout";

    // --- the plumbing ---
    /// The IPC layer itself failed.
    pub const TRANSPORT: &str = "transport";
    /// A malformed envelope, or a violation of the contract.
    pub const PROTOCOL: &str = "protocol";
    /// A frame could not be decoded.
    pub const CODEC: &str = "codec";

    // --- the catch-all ---
    /// An unexpected host-side failure. If this shows up where a specific code
    /// would be more useful, that is a bug in the host, not in the caller.
    pub const INTERNAL: &str = "internal";
}

/// Every code, for `host/schema` and for the drift test against the JS mirror.
pub const ALL: &[&str] = &[
    code::DENIED,
    code::UNKNOWN_SERVICE,
    code::UNKNOWN_ACTION,
    code::BAD_PARAMS,
    code::NOT_FOUND,
    code::CONFLICT,
    code::UNSUPPORTED,
    code::IO,
    code::SPAWN_FAILED,
    code::TIMEOUT,
    code::TRANSPORT,
    code::PROTOCOL,
    code::CODEC,
    code::INTERNAL,
];

/// Is this one of the declared codes? Used to keep the host honest: a service
/// cannot invent a code at runtime.
pub fn is_known(code: &str) -> bool {
    ALL.contains(&code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn the_code_set_is_unique_and_well_formed() {
        let unique: HashSet<_> = ALL.iter().collect();
        assert_eq!(unique.len(), ALL.len(), "duplicate code in ALL");
        for c in ALL {
            assert!(!c.is_empty());
            assert!(
                c.chars().all(|ch| ch.is_ascii_lowercase() || ch == '_'),
                "code `{c}` must be lower_snake_case"
            );
        }
    }

    #[test]
    fn is_known_matches_the_declared_set() {
        for c in ALL {
            assert!(is_known(c), "`{c}` is declared but not known");
        }
        assert!(!is_known("storage/get"), "the old svc/act code must be gone");
        assert!(!is_known(""));
    }
}
