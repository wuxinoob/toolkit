# calc.demo — sidecar backend + window frontend

Demonstrates a plugin that ships its **own native executable** and talks to it
with the same envelope the host uses.

```
main-window view ─┐
                  ├─ ctx.request / ctx.sidecar ── plugin_rpc gateway
plugin window ────┘                                └─ proc service ── calc.exe
                                                      (line-json envelopes)
```

## Why this example exists

The backend is not a special case. `ctx.sidecar(...)` is the `stdio-line`
scheme: a `line-json` stream carrying the **same** `req` / `res` / `err`
envelopes as the `rpc` scheme. So one vocabulary covers the control plane, the
push data plane and the native helper.

## Protocol

One JSON document per line, in both directions:

```
→  {"v":1,"kind":"req","id":1,"svc":"calc","act":"eval","p":{"op":"add","a":6,"b":7}}
←  {"v":1,"kind":"res","id":1,"p":{"result":13}}
←  {"v":1,"kind":"err","id":2,"code":"div_by_zero","msg":"div_by_zero"}
```

`id` correlates the reply; a `transport` failure (process gone, timeout) is
reported by the transport, a *protocol* failure comes back as an `err`
envelope. The plugin does not distinguish the two code paths beyond that.

## Build

```powershell
gcc -O2 -o calc.exe calc.c
```

Building `calc.exe` also enables the end-to-end Rust test
`services::proc::tests::real_sidecar_speaks_the_unified_envelope_protocol`
(it skips with a message when the exe is absent).

## Deploy

Copy the whole folder to the app's plugins directory and click **Rescan**:

```
%APPDATA%\com.tan18.toolbox\plugins\calc.demo\
  plugin.json  main.js  calc.exe
```

## Try it

1. Tool page **计算器** → inline quick calc (`6 × 7`), including the `÷ 0` error path
2. **打开计算器窗口** → the same backend from a separate window
3. The main view and the window each hold their own `calc.exe`
   (channels `calc-view` / `calc-win`, so their reply queues cannot cross-talk)
4. **关闭后端进程** → the next calculation respawns it automatically
5. Settings → **Refresh live sessions** shows the sidecar in the unified
   registry; closing the app leaves no `calc.exe` behind

## Notes

- `main.js` must stay a single-file ESM (it is loaded from a Blob URL), which is
  why it takes the envelope constructors from `ctx.protocol` / `bridge.protocol`
  instead of importing them.
- Permissions: `rpc:proc` (running the sidecar — see the scheme/permission table
  in `docs/PROTOCOL.md`), `rpc:host` (the unified session list) and `win:manage`
  (the plugin window). Both `plugin.json` and the in-code `manifest` must declare
  the same set; `tests/plugins.test.mjs` fails if they drift.
- Integer arithmetic only: `calc.c` parses `int64`, and the frontend converts
  with `Number`, so operands beyond 2^53 lose precision in the JSON hop.
