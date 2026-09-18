//! The unified message protocol (UMP).
//!
//! Every frontend <-> backend message in toolbox — control calls, pushed
//! streams, sidecar pipes, broadcasts — speaks the SAME envelope shape.
//! What varies is only *how* the envelope is framed on the wire, which is
//! the job of [`codec`]. The two axes are deliberately orthogonal:
//!
//!   transport (invoke | channel | event | stdio | pty)
//!        x
//!   codec     (json-envelope | line-json | raw-binary)
//!
//! Adding a new scheme = adding a transport + a codec entry, never a new
//! branch in the host. See docs/MESSAGE-FRAMEWORK.md.

pub mod codec;
pub mod codes;
pub mod envelope;
