# The toolbox message protocol

One envelope, 8 schemes, a table-driven gateway. This document is the contract;
`src/protocol/` (JS) and `src-tauri/src/protocol/` (Rust) are its two mirrors,
and both validate the same rules.

---

## 1. The envelope

```jsonc
{
  "v": 1,                 // protocol version — mismatches are rejected up front
  "kind": "req",          // see the kind table
  "id": 7,                // req/res/err correlation
  "ch": "calc-view",      // stream / session channel id
  "svc": "storage",       // service name (req)
  "act": "get",           // action name (req)
  "topic": "eyecare.state", // broadcast topic (evt)
  "code": "div_by_zero",  // machine-readable failure
  "msg": "…",             // human-readable failure
  "p": { }                // payload: any JSON value, or raw bytes on a binary wire
}
```

Fields are **omitted** rather than set to null, so the wire form is stable and a
round trip is lossless.

### Kinds and their requirements

| kind | direction | requires | meaning |
|---|---|---|---|
| `req` | plugin → host | `id`, `svc`, `act` | a service call |
| `res` | host → plugin | `id` | successful reply |
| `err` | both | `id` **or** `ch` | failure (reply, or mid-stream) |
| `evt` | host → plugin | `topic` | fire-and-forget broadcast |
| `data` | host → plugin | `ch` | one stream chunk |
| `end` | host → plugin | `ch` | stream finished successfully |
| `exit` | host → plugin | `ch` | the stream's process exited (code in `p`) |

`end`, `exit` and `err` are **terminal**: after one the stream is deregistered
host-side and the consumer's `onEnd` fires exactly once.

Validation lives in exactly one place per side — `Envelope::validate` and
`validate()` — so both reject the same malformed shapes. Neither the transports
nor the services re-implement these rules.

---

## 2. The two axes

```
transport (how bytes move)  ×  codec (how a message is framed)
```

| codec | wire | used by |
|---|---|---|
| `json-envelope` | one JSON object per message | `invoke`, `Channel<Envelope>` |
| `line-json` | one JSON object per `\n` line | sidecar stdio pipes |
| `raw-binary` | 1 kind byte + payload (`0x01` data, `0x02` end, `0x03` exit, `0x04` err) | `Channel<InvokeResponseBody>`, PTY bytes |
| `object` | by reference, no serialization | the window-local bus |

Keeping these apart is what makes the schemes interchangeable: the same
producer serves `channel-json` and `channel-raw` unchanged, because only the
sink changes.

### Measured: what the codec choice actually costs

`npm run bench` runs the codecs directly (pure JavaScript, identical in the app
and in Node) and reports median ns/op. It is deliberately **not** part of
`npm test`: it is timing-dependent, and a flaky benchmark in CI is worse than no
benchmark. It measures the codec only — `invoke` / `Channel` / `emit` cost needs
a live webview and is excluded.

On a 4 KiB PTY-shaped chunk (node v22, x64):

| path | ns/op | wire size |
|---|---|---|
| `json-envelope` (byte array as JSON numbers) | 178 982 | 14 660 B |
| `raw-binary` | 1 415 | 4 097 B |
| `rawToEnvelope` (consumer decode path) | **41** | — |

Three things worth knowing:

- **Byte streams must go raw.** JSON is ~126× slower and inflates the frame
  3.6× for a 4 KiB chunk. This is why `pty-stream` is `raw-binary`.
- **Raw decoding is nearly free** (41 ns) because it hands back a `subarray`
  *view*, not a copy. The cost is on the producing side, where the frame is
  allocated and copied. So a raw consumer is cheap even at high frame rates.
- **`line-json` is not free**: +25 % over `json-envelope` for a small frame and
  +60 % for a 1 KB document (the same codec plus a newline and a trailing-newline
  trim). It exists because a sidecar pipe needs a delimiter, not because it is
  cheap.

For tiny control frames, `raw-binary` is ~20 % *costlier* than `json-envelope`
(more per-field work, no JSON fast path) — but it cannot carry a nested object
at all, so for control messages that is a capability limit rather than a
trade-off. The scheme table encodes exactly this split.

---

## 3. The scheme table

Declared in `src/protocol/registry.js`, one implementation per scheme in
`src/protocol/transports/`.

| id | transport · codec | dir | capabilities |
|---|---|---|---|
| `rpc` | invoke · json-envelope | up | `requestResponse`, `ordered` |
| `channel-in` | invoke (batched) · json-envelope | **up** | `uplink`, `ordered` |
| `channel-json` | channel · json-envelope | down | `push`, `ordered`, `crossWindow` |
| `channel-raw` | channel · raw-binary | down | `push`, `binary`, `ordered`, `crossWindow` |
| `event-bus` | event · json-envelope | down | `push`, `crossWindow` |
| `stdio-line` | stdio · line-json | both | `requestResponse`, `push`, `pull`, `ordered` |
| `pty-stream` | pty · raw-binary | both | `push`, `binary`, `ordered`, `requestResponse` |
| `in-process` | in-process · object | down | `push` |

Every scheme but one moves data **host → plugin**. `channel-in` is the exception.

### Uplink streams

A plugin that produces data for the host used to have one option: call `rpc` per
frame — feeding a backend meant `proc/send` once per line, so a 1000-frame burst
cost 1000 round trips.

`ctx.uplink(ch, { sink })` opens a stream in the other direction:

```js
const up = await ctx.uplink('feed', { sink: 'proc', params: { key: 'backend' } });
await up.sendBatch(frames);      // ONE round trip for the whole batch
await up.close();
```

The handle has the same shape as every other stream (`send` / `close`), so a
caller does not learn a second model — `send` is simply a batch of one, and
`sendBatch` is the point. Frames are validated like any other and handed to a
**sink**: a host-side consumer looked up by name, advertised in `host/schema`
(`sinks`). The first sink is `proc`, which writes each frame as one `line-json`
line to a sidecar's stdin — the case that motivated this.

**Why the carrier is batched `invoke`, not a `Channel`.** Tauri's `Channel` is
one-directional: the JS side has only a receive callback and no `send` at all, so
the framework offers no push carrier from plugin to host. Rather than pretend
otherwise, the uplink is carried by batched invoke and says so. The API shape is
still a stream; what is missing is a true push carrier, and that is a framework
constraint rather than a design choice.

A batch is capped at 256 frames, because a batch is a single IPC payload —
without a cap, batching would just relocate the memory problem.

### Capability negotiation

Capabilities are **declared**, and checked at setup:

```js
assertSupports('event-bus', Capability.CROSS_WINDOW);   // ok
assertSupports('in-process', Capability.CROSS_WINDOW);  // throws, immediately
```

A scheme that cannot do the job fails when the stream is opened, with a precise
message — not later, on the wire.

### Choosing a scheme

Ask what the traffic *is*, not which API is convenient:

| need | scheme |
|---|---|
| a call that returns a value | `rpc` |
| the host keeps sending after the call returns | `channel-json` |
| the same, but the payload is bytes (terminal output, images) | `channel-raw` |
| every window must hear it | `event-bus` |
| a plugin-shipped native helper | `stdio-line` |
| a command-line program in a pseudo-terminal | `pty-stream` |
| a same-window subscriber that must pay nothing | `in-process` |

---

## 4. The plugin-facing API

Plugins never pick a wire format and never import a Tauri API. They declare
what they need and the hub resolves the scheme:

```js
ctx.rpc(svc, act, params, { timeoutMs })  // rpc
ctx.storage.get / set / remove / keys     // rpc
ctx.subscribe / once / publish            // event-bus by default
ctx.events.on / once / emit               // in-process
ctx.bus.subscribe / once / publish        // event-bus
ctx.stream(provider, ch, handlers)        // channel-json
ctx.streamRaw(provider, ch, handlers)     // channel-raw
ctx.sidecar(ch, { exe, args })            // stdio-line
ctx.pty(ch, { program, args })            // pty-stream
ctx.uplink(ch, { sink })                  // channel-in — push frames TO the host
ctx.sessions()                            // rpc (host) — the unified registry
ctx.schemes()                             // the scheme table (local, no IPC)
ctx.schema()                              // what this host supports
ctx.onHotkey(action, fn)                  // a declared global hotkey
ctx.protocol                              // the envelope constructors + constants
ctx.files.pick / save / message           // native dialogs (raw command, gated)
ctx.clipboard.read / write / watch        // rpc + channel-json (watch is a stream)
ctx.screen.monitors / capture             // rpc
ctx.ui.el / render / notify / notifyOS    // the component factory and toasts
ctx.registerView(viewId, render)          // a view in the main window
ctx.focusView(viewId)                     // bring one of YOUR views forward
ctx.onDrop(fn)                            // files dropped on YOUR active view
                                          //   (a plugin window uses bridge.onDrop, same shape)
ctx.windows.create / control / exists     // multi-window (the one non-envelope corner)
ctx.closeStream(ch) / ctx.log.*           // teardown and diagnostics
```

### The scheme never changes the shape of a call

`subscribe` / `once` / `publish` are **async on every scheme** — including the
synchronous in-process one — and `ctx.events` / `ctx.bus` differ only in their
default scheme. That is deliberate: a caller can move a subscription between
schemes, or be pointed at a different one entirely, without rewriting the call
site. If one scheme were sync and another async, the scheme would be leaking
into every caller.

`ctx.events` and `ctx.bus` are conveniences over the same three methods; the
underlying pair is `hub.subscribe(pluginId, topic, fn, { scheme })` and
`hub.publish(pluginId, topic, payload, { scheme })`.

`ctx.protocol` exists because external plugins are loaded from a Blob URL as a
single-file ESM and **cannot import** the protocol module. Handing over the
constructors keeps a drop-in plugin building envelopes with the same code the
host uses, instead of hard-coding the shape. It comes from one module
(`protocol/contract.js`) and is frozen, so the two window surfaces cannot drift
apart.

### Two version numbers

| version | what it covers | where |
|---|---|---|
| `protocol.version` | the **envelope shape on the wire** | `protocol/envelope.rs` / `envelope.js` |
| `protocol.api` | the **JavaScript surface** a plugin codes against (`ctx` / `bridge`) | `protocol/contract.js` |

They move independently, so they are tracked separately. A plugin declares the
host API it was built for in its manifest:

```jsonc
{ "id": "probe.demo", "version": "0.1.0", "api": 2, … }
```

If the declaration does not match, the host records it on the plugin row and the
boot trace says so:

```
  plugin probe.demo: active [built for host API 1, this host provides 2 — re-deploy the plugin if it misbehaves]
```

A mismatch is a **warning, not a failure** — a plugin built for an older shape
may work fine for what it uses. The point is that it is diagnosable. This was
added after a real incident: `ctx.events.on` became async (api 2), and an
already-deployed plugin calling the returned value directly failed with the
cryptic `off is not a function`. **API 2 is a breaking change** — any plugin
built for api 1 that calls the result of `subscribe`/`on` synchronously must be
re-deployed. Built-in plugins ship with the host and cannot go stale, which is
why only external examples declare `api`.

A secondary window gets **almost** the same surface through `bridge`
(`src/host/pluginwin-host.js`): 26 capabilities on both sides, and exactly 8
one-sided — `ui` / `windows` / `registerView` / `focusView` exist only
on `ctx`, while `label` / `close` / `drag` / `dispose` exist only on `bridge`.
The differences are deliberate except for `ui.notifyOS`, which is collateral.
Full matrix and the substitute for each:
[`plugin-dev/bridge.md`](./plugin-dev/bridge.md).

### Timeouts

`ctx.rpc(..., { timeoutMs })` bounds how long the **caller** waits; the default
is 45 s and `0` waits indefinitely. It is enforced in the transport, not in the
envelope, because the gateway is synchronous: the host cannot be told to abandon
a call, so a `deadline` field would promise something the host cannot deliver. A
timeout raises `ProtocolError` with code `timeout`, worded so it cannot be
mistaken for a cancellation.

### Hotkeys

A plugin declares global shortcuts in its manifest and the **host registers them
on its behalf** — a plugin may not import the shortcut API:

```jsonc
"contributes": { "hotkeys": [{ "key": "ctrl+alt+shift+p", "action": "probe" }] }
```

```js
await ctx.onHotkey('probe', (env) => { /* env.p.key */ });
```

The manifest entry IS the declaration, so no extra permission is needed. The
press arrives as an ordinary `evt` envelope on `hotkey:<action>` — the same
downlink as everything else — carrying the owner in `svc` so a plugin can ignore
another plugin's hotkey that happens to share an action name. Registration is
released on deactivate, and a taken shortcut is reported rather than fatal.

The host passes an explicit `owner` to the `hotkey` service; only the host
identity may do that, so a plugin cannot register shortcuts for another plugin.

### Negotiation

`ctx.schema()` returns what this host supports — protocol version, every service
with its actions, the stream providers, and the scheme table. A plugin asks
instead of discovering the surface by failing.

```jsonc
{ "protocol": 1,
  "services": { "storage": ["get","set","remove","keys"], "hotkey": ["register", …], … },
  "providers": ["ticker", "blob", "clipboard"],
  "providerPermissions": { "clipboard": "rpc:clipboard" },
  "sinks": ["proc"],
  "codes": ["denied", "unknown_service", …],
  "schemes": [ … ], "transports": [ … ] }
```

The service/action half is authoritative: it is generated from the same
`Service::actions()` lists the gateway validates against, so it cannot drift
from what actually works.

`providerPermissions` is the additive half of the same idea: a stream provider
whose DATA is more sensitive than `rpc:stream` declares its own permission here
(`clipboard` does), so a plugin can *ask* what a provider needs instead of
discovering it by being denied.

---

## 5. Entry points (native)

Every native entry point is one of a small table-driven family, and the gateway
contains no per-service and no per-transport branching.

```rust
plugin_rpc(plugin_id, msg: Envelope) -> Result<Envelope, String>
```
The uplink. Returns `Ok(Envelope)` for **every service-level outcome** — a `res`
or an `err` — so callers have one shape to switch on. `Err(String)` is reserved
for protocol breakage (malformed envelope, unknown service).

```rust
plugin_stream_open(plugin_id, provider, ch, params, on_frame: Channel<Envelope>)
plugin_stream_open_raw(plugin_id, provider, ch, params, on_frame: Channel<InvokeResponseBody>)
plugin_stream_close(plugin_id, ch)
```
The downlink. Streams are a separate command family because opening one hands
the host an IPC `Channel` handle, which cannot travel inside a JSON
request/response — but they are registered in a table exactly like services.

```rust
plugin_register(plugin_id, permissions)
```
Declares a plugin's permissions. Called once per plugin at load time.

### Routing

```rust
match table().iter().find(|s| s.name() == service) {
    None => Err(format!("unknown service `{service}` (known: {})", names)),
    Some(s) if !s.actions().contains(&action) =>
        Err(format!("unknown action `{service}/{action}` (known: {})", s.actions().join(", "))),
    Some(s) => s.dispatch(app, plugin_id, action, params),
}
```

Adding a capability is a new table entry. `lib.rs` does not change.

The nine services: `storage`, `host`, `proc`, `stream`, `bus`, `hotkey`,
`notify`, `clipboard`, `screen`.

The five above are the whole **data plane**. The rest of the invoke handler is
host-side management that a plugin cannot reach — plugin discovery
(`plugin_scan` / `plugin_info` / `plugin_read_entry` / `plugin_open_dir`),
autostart (`host_autostart_get` / `host_autostart_set`), orphan reaping
(`plugin_reap_orphans`) and `plugin_dialog`, which is a raw command because a
modal dialog needs the main thread's message loop and the gateway is
synchronous. **Every command is `async fn`** — a non-async Tauri command runs on
the message thread and blocks every window, and the symptom is "the UI is
laggy", not "a command blocked". `tests/main-thread.test.mjs` enforces it. The
full inventory of 13 is in [`INTERFACES.md`](./INTERFACES.md) §1.

---

## 6. Permissions

Two gates, both must pass:

1. **JS** (`ctx`) — fails fast, before any IPC.
2. **Native** (`host/registry.rs`) — authoritative and fail-closed.

The native registry is populated by `plugin_register`. An unregistered plugin id
is **denied**, so bypassing `ctx` and calling `invoke` directly still gets a
`denied` envelope. The host identity `__host__` is implicitly allowed, which is
how host-originated calls (Settings reading a plugin's storage, the selftest)
reach the gateway.

> ⚠️ **Known gap: identity is claimed, not proven.** `plugin_rpc` takes the
> plugin id as a caller-supplied argument, and `__host__` is allowed everything —
> so a plugin sharing the main window's JS context can reach every service by
> naming itself `__host__`. The fix is "token is identity" (Rust mints a token at
> `plugin_register`, the gateway takes the token instead of an id). Analysis and
> work estimate: [`COMMS-AUDIT-2026-09-23.md`](./COMMS-AUDIT-2026-09-23.md) §1;
> classification and priority: [`INTERFACE-REVIEW-2026-09-27.md`](./INTERFACE-REVIEW-2026-09-27.md) §3.

### One capability, one permission

Each scheme is gated by the permission of the service that backs it, so a
capability never requires two declarations:

| scheme | permission | why |
|---|---|---|
| `rpc` (service `X`) | `rpc:X` | one permission per service |
| `channel-json`, `channel-raw` | `rpc:stream` | the push data plane |
| `pty-stream` | `rpc:stream` | same data plane (a terminal stream) |
| `stdio-line` | `rpc:proc` | running a binary the plugin shipped is its own, stronger capability |
| `event-bus` **publish** | `rpc:bus` | publishing reaches every window |
| `event-bus` **subscribe** | — | a passive listener costs nothing and cannot affect another window |
| `in-process` | — | no IPC, nothing to gate |
| window control (`ctx.windows`) | `win:manage` | |
| `ctx.sessions()` / `ctx.schema()` | `rpc:host` | host-wide queries |
| `ctx.closeStream(ch)` | — | see below |
| declared hotkeys | — | the manifest entry is the declaration |

Two rules make the set easy to reason about:

- **Observation is not a capability.** Subscribing to a topic, reading your own
  hotkey, and closing a stream you opened are all ungated. Only acts that reach
  beyond the plugin — publishing to every window, running a binary, controlling
  windows — carry a permission.
- **`ctx.closeStream` is ungated** because opening a stream already required the
  capability and it can only touch streams the plugin itself registered (the hub
  keys them by plugin id). Closing is strictly weaker than opening.

Session *lifecycle* (`stream/session_open`, `stream/session_close`) lives on the
`stream` service rather than `host`, so `rpc:stream` alone covers opening a
stream end to end — including a PTY, whose process the host does not own.

### Action validation

Each service declares its actions (`Service::actions`), and the gateway rejects
anything not listed **before** dispatching:

```json
{"v":1,"kind":"err","id":3,"code":"unknown_action",
 "msg":"unknown action `storage/nope` (known: get, set, remove, keys)"}
```

The declaration is authoritative rather than documentation: the same list backs
`host/schema`, so what a plugin is told exists is exactly what the gateway
accepts.

### Error codes

Every `err` envelope the host produces carries one of a **closed set of 14
codes**, declared in `protocol/codes.rs` and mirrored in `protocol/codes.js`:

| code | means |
|---|---|
| `denied` | the caller lacks a permission its manifest declares |
| `unknown_service` / `unknown_action` | no such service / no such action on it |
| `bad_params` | a required parameter is missing or malformed |
| `not_found` | the addressed key, window, session or process does not exist |
| `conflict` | contradicts current state (duplicate id, already open) |
| `unsupported` | the scheme, provider or codec cannot do what was asked |
| `io` | a filesystem or OS operation failed |
| `spawn_failed` | a child process could not be started |
| `timeout` | the caller stopped waiting (never means the host was cancelled) |
| `transport` / `protocol` / `codec` | the plumbing: IPC failure, contract violation, undecodable frame |
| `internal` | an unexpected host-side failure |

Three properties make it usable:

- **The code describes the KIND of failure.** Where it happened is already in the
  envelope (`svc`/`act`), so it is not repeated in the code. Service failures used
  to report `{svc}/{act}` (e.g. `storage/get`), which told a caller nothing it
  could branch on.
- **It is advertised.** `host/schema` returns `codes`, so a caller is told the
  vocabulary instead of guessing at strings. `ctx.protocol.Code` exposes the same
  names to plugin code.
- **It cannot drift.** A Rust unit test keeps `ALL` and the declarations in step;
  `tests/codes.test.mjs` parses *both* files and fails if the two languages
  disagree. A duplicated declaration is acceptable only when something checks it.

Two boundaries worth knowing:

- A plugin's **own backend** may define its own codes on top (the calc example
  answers `div_by_zero`). This set is the host's vocabulary, not a cap on a
  plugin's.
- The **stream commands** (`plugin_stream_open*`) report failures as invoke
  rejections rather than `err` envelopes, so their messages stay plain strings.
  Only what flows through `plugin_rpc` is coded.

A denial is a normal protocol outcome, not a transport failure:

```json
{"v":1,"kind":"err","id":3,"code":"denied",
 "msg":"plugin `x.y` lacks permission `rpc:proc`"}
```

### Manifests

An external plugin describes itself twice: `plugin.json` (the file the native
scanner must read to find it) and the `manifest` object its entry module
exports. **`plugin.json` is authoritative** — it is the artifact a user inspects
and edits — and the in-code manifest supplies whatever the file omits
(`mergeManifest` in `host/lifecycle.js`). `tests/plugins.test.mjs` asserts the
two agree, so drift fails a test instead of surfacing as a mysterious
"lacks permission" at runtime.

---

## 7. Sessions

One registry (`services/session.rs`) owns every live endpoint, whatever created
it — sidecar, stream, or PTY. Each entry carries a `stop` closure, so shutdown
is a single `kill_all()`:

```rust
if let tauri::RunEvent::Exit = event {
    services::session::kill_all();
}
```

This closed a real gap: previously only sidecars were tracked, so PTY children
were orphaned when the host exited. Endpoints whose process belongs to a
third-party plugin register a **pid** instead (`host/session_open`), and the
registry kills the tree by pid.

The same registry backs `ctx.sessions()` and the Settings page, so there is one
list regardless of transport:

```json
[{"id":"calc.demo/calc-view","plugin":"calc.demo","ch":"calc-view",
  "kind":"sidecar","pid":12345,"openedAt":1757851234567,"bytesOut":0}]
```

---

## 8. Adding a scheme

1. Add a descriptor to `DESCRIPTORS` in `registry.js` (id, transport, codec,
   direction, capabilities, note).
2. Add a transport module exporting `{ descriptor, request?, open?, publish?,
   subscribe? }` and register it in `transports/index.js`.
3. Run the tests — `transports/index.js` asserts that every declared scheme has
   an implementation, and `tests/protocol.test.mjs` asserts the shared contract
   (envelope shapes, terminal-frame handling, error typing).

Nothing in `host/`, `ctx.js` or the plugins changes.

If the scheme needs a native producer, add a `StreamProvider` to
`services/stream.rs` (override only the codecs it supports — the defaults are
the capability declaration) or a `Service` to `services/mod.rs`. A `Service`
must declare `name()` and `actions()`; the gateway validates the action against
that list and `host/schema` advertises it, so there is nothing else to register
or document separately.

---

## 9. Worked example: one request, two codecs

The `ticker` provider sends a counter. Nothing in it knows which wire is in use.

```js
// channel-json: frames arrive as objects
await ctx.stream('ticker', 'a', { params: { intervalMs: 300, count: 2 },
  onFrame: (f) => console.log(f.kind, f.p) });
// data  { n: 0, t: 1757851234567 }
// data  { n: 1, t: 1757851234791 }
// end

// channel-raw: the same producer, 1 kind byte + 8 LE bytes
await ctx.streamRaw('ticker', 'b', { params: { intervalMs: 300, count: 2 },
  onFrame: (f) => console.log(f.kind, decodeCode(f.p)) });
// data  0
// data  1
// end
```

And a sidecar answers in the same vocabulary:

```
→  {"v":1,"kind":"req","id":1,"svc":"calc","act":"eval","p":{"op":"mul","a":6,"b":7}}
←  {"v":1,"kind":"res","id":1,"p":{"result":42}}
←  {"v":1,"kind":"err","id":2,"code":"div_by_zero","msg":"div_by_zero"}
```
