# Toolbox

Tauri 2 + Vue 3 desktop toolbox with a **plugin host** and a **unified message
protocol**. Every frontend ↔ backend message — control calls, pushed streams,
sidecar pipes, broadcasts — speaks one envelope shape; only the wire framing
differs, and that is a declared choice rather than an accident of which feature
happened to need it.

## The idea in one table

A scheme is the combination of two independent axes:

| | codec |
|---|---|
| **transport** | `json-envelope` · `line-json` · `raw-binary` · `object` |

| scheme id | transport · codec | direction | capabilities |
|---|---|---|---|
| `rpc` | invoke · json-envelope | up | requestResponse, ordered |
| `channel-json` | channel · json-envelope | down | push, ordered, crossWindow |
| `channel-raw` | channel · raw-binary | down | push, binary, ordered |
| `event-bus` | event · json-envelope | down | push, crossWindow |
| `stdio-line` | stdio · line-json | both | requestResponse, push, pull |
| `pty-stream` | pty · raw-binary | both | push, binary, ordered |
| `in-process` | in-process · object | down | push |

Adding an experiment = one descriptor + one small transport module. Nothing in
the host, the SDK or the plugins grows a branch — they all resolve a scheme by
id through `src/protocol/registry.js`.

## Quick start

```bash
npm install
npm run test          # 62 node tests: scheme conformance, host kernel, real boot, plugin audit
npm run bench         # codec experiment: what each codec costs per message
npm run build         # build the frontend
npm run tauri dev     # run the app
```

Rust side:

```bash
cd src-tauri
cargo check --all-targets
cargo run --example host-checks   # 27 pure-logic assertions, no test harness
```

`cargo test` does **not** work on Windows: `tauri-build` embeds the app manifest
into bin targets only, so this crate's test binaries load without it and die at
load with `STATUS_ENTRYPOINT_NOT_FOUND`. `host-checks` is the same assertions
through a target that can actually load — see the note at the top of it.

Dev builds run an in-app conformance suite (15 checks) at boot and write the
report — plus the boot trace — to `{appData}/debug.log`, so a runtime problem is
readable from outside the webview. Re-run it any time with
`await window.__toolbox.selftest()` in the webview console.

Last verified end to end: `node --test` 221, `host-checks` 27/27, build clean,
zero code warnings.

### Closing the window puts it in the tray

The main window's ✕ **hides** it. The app keeps running, so a stray click does not
tear down live sessions (a pty, a sidecar). Quit from the tray icon: right-click
for **显示主窗口 / 退出 Toolbox**, or left-click to bring the window back.

That makes the tray load-bearing, so a tray that will not build is a **fatal**
startup error rather than a warning — an app that hides on close and has no tray
cannot be quit from its own UI. To turn the behaviour off, set
`store.settings.closeToTray = false` (it persists), and ✕ quits as before.

## Layout

```
src/
  protocol/                 the message plane
    envelope.js             kinds + constructors + validate (mirror of envelope.rs)
    codec.js                json-envelope / line-json / raw-binary / object
    registry.js             the scheme table + capability negotiation
    hub.js                  MessageHub: request / stream / sidecar / pty / bus
    transports/             one module per scheme
  host/                     plugin kernel
    boot.js  lifecycle.js  ctx.js  store.js  registry.js  external.js
    events.js               the window-local bus (the `in-process` scheme)
    pluginwin-host.js       secondary plugin windows
  plugins/                  first-party plugins
    notepad  eyecare  procman  streamlab  floatwin
  core/logger.js  core/selftest.js
src-tauri/src/
  protocol/{envelope,codec}.rs   the same contract, native side
  services/{mod,storage,proc,stream,session,external,bus}.rs
  host/registry.rs               the authoritative permission registry
  lib.rs                         three table-driven entry points
examples/
  plugins/hello/            drop-in external plugin
  plugins/probe/            drives every interface in one pass (living check)
  calc-plugin/              window frontend + native sidecar backend
docs/
  MESSAGE-FRAMEWORK.md      the analysis + design that led here
  PROTOCOL.md               the protocol reference
  INTERFACES.md             interface inventory + unification audit + roadmap
  UI.md                     design tokens + the .tb-* primitives plugins can use
```

## Plugins

Built-ins each exercise a different part of the plane:

| plugin | what it demonstrates |
|---|---|
| Notepad | `rpc` storage + `event-bus` notify |
| Eyecare | timers, overlay layer, `in-process` events |
| Processes | `pty-stream` multi-process management with xterm.js |
| StreamLab | the scheme table, and one experiment per scheme side by side |
| FloatWin | multi-window control + broadcast instead of polling |

See `docs/INTERFACES.md` for the full interface inventory, what each feature
uses, and the known gaps. `examples/plugins/probe` is a new plugin that drives
every interface in one pass — it is both the proof that a drop-in plugin needs
no host changes and a living integration check.

External plugins need no host changes: drop a folder with `plugin.json` + a
single-file ESM entry into `{appData}/plugins/` and click **Rescan** in Settings.
See `examples/plugins/hello` and `examples/calc-plugin`.

Rescan **reconciles** rather than only discovering — new folders load, changed
ones reload in place (no app restart), deleted ones unload and lose their host
grant, and unchanged ones are left alone. See `examples/README.md`.

## Trust model

Locally installed plugins are trusted code (the same model as Raycast / Quicker).
Two gates apply, and both must pass:

1. **JS gate** (`ctx`) — fails fast with a readable message.
2. **Native gate** (`host/registry.rs`) — authoritative and fail-closed. A plugin
   registers its declared permissions at load time; an unregistered id can reach
   nothing, so bypassing `ctx` and calling `invoke` directly still gets denied.

The Settings page shows each plugin's declared permissions and the live session
registry.

## Recommended IDE setup

VS Code + [Vue - Official](https://marketplace.visualstudio.com/items?itemName=Vue.volar)
+ [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
+ [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
