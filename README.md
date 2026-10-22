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
| `rpc-raw` | invoke · raw-binary | up | requestResponse, binary, ordered |
| `channel-in` | invoke (batched) · json-envelope | up | uplink, ordered |
| `channel-json` | channel · json-envelope | down | push, ordered, crossWindow |
| `channel-raw` | channel · raw-binary | down | push, binary, ordered |
| `event-bus` | event · json-envelope | down | push, crossWindow |
| `stdio-line` | stdio · line-json | both | requestResponse, push, pull |
| `pty-stream` | pty · raw-binary | both | push, binary, ordered |
| `in-process` | in-process · object | down | push |

That is all nine. `channel-in` is the odd one: Tauri's `Channel` is
one-directional (`JS` gets a receive callback and no `send`), so the plugin→host
push is carried by **batched `invoke`** rather than by a new carrier.

Adding an experiment = one descriptor + one small transport module. Nothing in
the host, the SDK or the plugins grows a branch — they all resolve a scheme by
id through `src/protocol/registry.js`.

## Quick start

```bash
npm install
npm run test          # 310 node tests: scheme conformance, host kernel, real boot, plugin + doc audits
npm run bench         # codec experiment: what each codec costs per message
npm run build         # build the frontend
npm run tauri dev     # run the app
```

Rust side:

```bash
cd src-tauri
cargo check --all-targets
cargo run --example host-checks   # 29 pure-logic assertions, no test harness
```

`cargo test` does **not** work on Windows: `tauri-build` embeds the app manifest
into bin targets only, so this crate's test binaries load without it and die at
load with `STATUS_ENTRYPOINT_NOT_FOUND`. `host-checks` is the same assertions
through a target that can actually load — see the note at the top of it.

Dev builds run an in-app conformance suite (15 checks) at boot and write the
report — plus the boot trace — to `{appData}/debug.log`, so a runtime problem is
readable from outside the webview. Re-run it any time with
`await window.__toolbox.selftest()` in the webview console.

Last verified end to end: `node --test` 310, `host-checks` 29/29, build clean,
zero code warnings.

### Closing the window puts it in the tray

The main window's ✕ **hides** it. The app keeps running, so a stray click does not
tear down live sessions (a pty, a sidecar). Quit from the tray icon: right-click
for **显示主窗口 / 重启应用 / 退出 Toolbox**, or left-click to bring the window back.

**重启应用** is the recovery path, and it is a real restart: it requests an exit,
drains every live session, then starts a new process — the tray is the only
place that can do this without orphaning a pty or a sidecar.

If the webview and the host ever stop talking (a resume from standby is the case
that has been seen), a watchdog notices within about a minute, writes the fact to
`debug.log` — including how long the frontend was suspended — and says so on
screen. It never reloads on its own: a reload reaps sessions, and a false
positive would kill whatever the user was running.

That makes the tray load-bearing, so a tray that will not build is a **fatal**
startup error rather than a warning — an app that hides on close and has no tray
cannot be quit from its own UI. To turn the behaviour off, set
`store.settings.closeToTray = false` (it persists), and ✕ quits as before.

### Releases and signing

Pushing a `v*` tag runs `.github/workflows/release.yml`: it builds the NSIS
installer and the MSI on a Windows runner and publishes them — plus `latest.json`,
the manifest the updater reads — as a GitHub Release. The tag must equal
`v` + `version` from `src-tauri/tauri.conf.json`, or the job stops on purpose: the
updater compares versions, so a drifting tag only surfaces on a user's machine.

Updates are signed with a minisign key pair:

| half | where it lives | who uses it |
| --- | --- | --- |
| public | `plugins.updater.pubkey` in `tauri.conf.json` | the app, to verify a downloaded installer |
| private | **outside the repo**: `~/.tauri/toolbox-updater.key` | the build, to sign it |

The private half must also be copied into the repository's Actions secrets as
`TAURI_SIGNING_PRIVATE_KEY` (plus `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key
has a passphrase). With `createUpdaterArtifacts` on and a pubkey in the config, the
CLI **refuses to finish a build without it** — that is a hard error, not a silent
skip, so a local `tauri build` needs the same key:

```bash
TAURI_SIGNING_PRIVATE_KEY=~/.tauri/toolbox-updater.key npm run tauri build
npm run tauri build -- --no-sign    # unsigned installers, no updater signature
```

The variable accepts the key's content or a path to it. Never commit the private
key: `.gitignore` blocks `*.key` / `*.pem` / `*.p12` / `*.pfx` / `.env*`, and a key
that reaches one commit is a key in every clone. Windows Authenticode signing is
**not** configured, so the installers are unsigned and SmartScreen warns on first
run.

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
    procman  streamlab  store
  core/logger.js  core/selftest.js
src-tauri/src/
  protocol/{envelope,codec}.rs   the same contract, native side
  services/{mod,storage,proc,stream,session,external,bus}.rs
  host/registry.rs               the authoritative permission registry
  lib.rs                         three table-driven entry points
tests/fixtures/          plugins the TESTS drive — not shipped, not deployed
  calc-plugin/              window frontend + native sidecar backend
  plugins/eyecare/          multi-window + self-drawn chrome
  plugins/fileprobe/        native dialogs and OS drag-and-drop, by hand
  plugins/gallery/          the component vocabulary, in one view
  plugins/msglog/           the broadcast bus, seen from two windows
  plugins/probe/            drives every interface in one pass (living check)
  plugins/senses/           clipboard / screen / drag-drop, on real hardware
docs/
  MESSAGE-FRAMEWORK.md      the analysis + design that led here
  PROTOCOL.md               the protocol reference
  INTERFACES.md             interface inventory + unification audit + roadmap
  INTERFACE-REVIEW-2026-09-27.md   interface classification + what is and is not verified
  UI.md                     design tokens + the .tb-* primitives plugins can use
  plugin-dev/               the plugin author's manual (start at its README)
```

## Plugins

**A built-in is code the user cannot uninstall and every boot pays for**, so the
bar is deliberately high: it has to exercise a scheme nothing else in the table
exercises. That leaves three:

| plugin | id | what it demonstrates |
|---|---|---|
| Processes | `builtin.procman` | `pty-stream` multi-process management with xterm.js |
| StreamLab | `builtin.streamlab` | the scheme table, and one experiment per scheme side by side |
| Store | `builtin.store` | the plugin & software marketplace, with download, install & hot-activation |

`notepad`, `eyecare` and `floatwin` used to be built-ins. They were working
demos rather than parts of the message plane, and they moved to `tests/fixtures/` —
where a user who wants one can install it. See `src/host/registry.js` for the
rule this table encodes.

See `docs/INTERFACES.md` for the full interface inventory, what each feature
uses, and the known gaps. `tests/fixtures/plugins/probe` is a new plugin that drives
every interface in one pass — it is both the proof that a drop-in plugin needs
no host changes and a living integration check.

External plugins need no host changes: drop a folder with `plugin.json` + a
single-file ESM entry into `{appData}/plugins/` and click **Rescan** in Settings.
See `tests/fixtures/plugins/probe` (the interface sweep) and `tests/fixtures/calc-plugin`
(a window frontend plus a native sidecar backend).

Rescan **reconciles** rather than only discovering — new folders load, changed
ones reload in place (no app restart), deleted ones unload and lose their host
grant, and unchanged ones are left alone. See `tests/fixtures/README.md`.

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
