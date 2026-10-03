# Test fixtures: the plugins the tests drive

这些是 **`node --test` 的输入**，不是给人安装的样例。它们原先是 `examples/`，
于是每个读者（以及每次发布）都会把它们当成 demo —— 它们在这里，是因为有五个测试文件
加载它们来检查宿主契约：接口扫描、窗口选项白名单、主题贡献、清单词汇表，
以及一个插件的整套多窗口行为。

它们**不会被部署、也不会进包**。想亲眼看其中一个，用 `npm run deploy:fixtures`
把它复制到应用的插件目录里即可。

共同点是：**没有一个需要改动宿主** —— 这正是插件契约要证明的事。

## `plugins/probe` — the interface prober

Drives every frontend↔backend interface in one pass and reports the result. It
imports nothing and touches no Tauri API, so a clean run is the proof that a new
plugin can call the existing interfaces with no host changes. It also doubles as
a living integration check: every step runs inside `activate()`, so if any
interface is broken the plugin shows up as `error` in the boot trace instead of
`active` — no clicking needed.

## `calc-plugin` — a native sidecar backend

A window frontend plus a `calc.exe` backend that speaks the **same envelope** as
the host, framed with the `line-json` codec. Shows that a plugin's own native
helper is not a special case: it is a `stdio-line` stream.

```powershell
cd tests/fixtures/calc-plugin
gcc -O2 -o calc.exe calc.c        # calc.exe is committed; rebuild if you edit calc.c
```

Install the whole folder as `calc.demo` and rescan. Building `calc.exe` also
enables the Rust end-to-end test
`services::proc::tests::real_sidecar_speaks_the_unified_envelope_protocol`.

## Rescanning is a reconciliation, not just a discovery

Iterating on a plugin does not need an app restart:

| on disk | what happens |
|---|---|
| new folder | loaded and activated |
| entry or `plugin.json` changed | the old instance is deactivated, the new one loaded |
| unchanged | left completely alone — no reload, no re-toast |
| folder deleted | deactivated, unloaded, and its host grant revoked |
| fails to load | reported once, retried when the content changes |

Change detection is a content digest computed by the native scanner, so a no-op
rescan costs one call. A deliberately **disabled** plugin stays disabled across
a reload — dropping new bytes in does not switch it back on.

## The single-file ESM constraint

Both entries are loaded from a `Blob` URL and dynamically imported, so **bare and
relative imports cannot resolve**. If you need dependencies, bundle first:

```bash
npx esbuild main.js --bundle --format=esm --outfile=main.js
```

Two consequences visible in both examples:

- They take the envelope constructors from `ctx.protocol` / `bridge.protocol`
  rather than importing the protocol module, so the wire shape stays in one place.
- Any UI is plain DOM, not Vue SFCs (an SFC would need the compiler at runtime).

## Verifying them without clicking

`tests/plugins.test.mjs` audits both examples statically: manifest/entry
agreement, the no-bare-import rule, and that every capability the source uses is
declared in `plugin.json`. Run `npm run test`.
