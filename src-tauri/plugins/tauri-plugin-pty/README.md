# Toolkit PTY backend

Local replacement for the Rust command surface of [Tnze/tauri-plugin-pty](https://github.com/Tnze/tauri-plugin-pty), version 0.3.1 (MIT). Command names, arguments and the `pty:default` capability remain compatible. The frontend transport and the `tauri-pty` JavaScript wrapper do not need a new protocol.

The original implementation runs synchronous `Read::read` and `Child::wait` on Tokio workers. A pending read also retains the whole session, including the ConPTY master that must close before the read can finish. See the [freeze analysis](../../../docs/FREEZE-ROOT-CAUSE.md).

`backend.rs` instead gives each session a reader thread and a waiter thread. The reader owns only the cloned output pipe. The waiter owns the child; after exit it takes and closes the PTY pair, joins the reader, then publishes the exit status. Reads await an asynchronous queue. Spawn, write, resize and kill commands use the blocking pool.

The exit-status command additionally waits for output to be consumed (or explicitly discarded by Stop), so removing the command registry entry cannot drop unread tail chunks. Closing the pseudoconsole and reading its output happen on different threads, as required by [Microsoft's shutdown guidance](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole).

On Windows the killer retains an owned process handle and checks [TerminateProcess's actual return semantics](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess). This also avoids portable-pty 0.9.0's inverted success/error check in `WinChildKiller::kill`.

Output is buffered up to 8 MiB per session. If a consumer falls behind that bound or disappears, the reader terminates the child and keeps draining until the pseudoconsole closes. Overflow is reported as an explicit read error instead of unbounded memory growth or a blocked teardown. The host registers a real stop callback using the PTY handle, never treating it as an OS pid.

Run the native lifecycle checks with:

```powershell
cargo run --offline --manifest-path src-tauri/Cargo.toml --example pty-lifecycle-checks
```
