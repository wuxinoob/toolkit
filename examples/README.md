# Example plugins

Two complete drop-in plugins. Neither requires a single change to the host —
that is the whole point of the plugin contract.

## `plugins/hello` — the minimal drop-in

Storage, a settings form, a cross-window broadcast, and both stream codecs
(`channel-json` and `channel-raw`) from one panel.

Install: copy the folder to the app's plugins directory, then **Rescan plugins**
in Settings.

```
%APPDATA%\com.tan18.toolbox\plugins\hello.demo\
```

## `calc-plugin` — a native sidecar backend

A window frontend plus a `calc.exe` backend that speaks the **same envelope** as
the host, framed with the `line-json` codec. Shows that a plugin's own native
helper is not a special case: it is a `stdio-line` stream.

```powershell
cd examples/calc-plugin
gcc -O2 -o calc.exe calc.c        # calc.exe is committed; rebuild if you edit calc.c
```

Install the whole folder as `calc.demo` and rescan. Building `calc.exe` also
enables the Rust end-to-end test
`services::proc::tests::real_sidecar_speaks_the_unified_envelope_protocol`.

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
