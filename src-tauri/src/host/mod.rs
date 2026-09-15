//! Host-side runtime state that is not a service: today, the plugin
//! permission registry.
//!
//! The JS `ctx` gate is a *convenience* gate (it stops accidental misuse).
//! This registry is the *authoritative* one: the gateway refuses a call
//! before any service sees it. A plugin becomes known by registering its
//! manifest at load time (`plugin_register`), which keeps the trust model
//! declarative — locally installed plugins are trusted, but they only get
//! what they declared.

pub mod registry;
