# hello.demo — drop-in external plugin

A minimal plugin that exercises the whole message plane without any host code
changes. Copy this folder into the app's plugins directory and click **Rescan**
in Settings.

```
%APPDATA%\com.tan18.toolbox\plugins\hello.demo\
```

## What it demonstrates

| Feature | Scheme |
|---|---|
| Settings form (`contributes.settings`) | `rpc` (storage) |
| Broadcast to every window | `event-bus` |
| Structured push stream | `channel-json` |
| Binary push stream (same producer) | `channel-raw` |
| Unified session registry | `rpc` (host) |

It also demonstrates the **UI** side of a drop-in plugin, which is where the
constraints are least obvious:

| Feature | How |
|---|---|
| Looks native without shipping CSS | the global `.tb-*` classes (`docs/UI.md`) |
| Follows the light/dark theme | never hard-code a colour; use `var(--color-…)` |
| Has its own accent colour | `contributes.theme` (this plugin is violet) |

`contributes.theme` is the interesting one. `main.js` contains no CSS at all —
it declares which design tokens it wants different, per theme, and the host
injects a rule **scoped to this plugin's own subtree**:

```jsonc
"theme": {
  "dark":  { "--color-brand": "#a78bfa" },
  "light": { "--color-brand": "#6d3fc4" }
}
```

Two properties make that safe to offer: the scope means over-declaring cannot
restyle the shell or another plugin, and the value validator means a plugin
supplies a *colour*, never a declaration (a value containing `;` or `}` is
refused). Declare **both** themes — a plugin that declares only `dark` looks
right in one theme and half-styled in the other.

## Constraint: single-file ESM

The host fetches this file, wraps it in a `Blob` and dynamically `import()`s it,
so **bare and relative imports cannot resolve**. Two consequences:

- Bundle dependencies with esbuild before dropping the folder in:
  `esbuild main.js --bundle --format=esm --outfile=main.js`
- Use `ctx.protocol` (handed over by the host) rather than importing the
  protocol module — that keeps the envelope shape in one place.

## Manifest

`plugin.json` declares the id, the entry file, the contributed views/settings
and — importantly — the permissions. The host registers them at load time and
refuses anything not declared, so an unpermitted call fails with a readable
error instead of silently reaching native code.
