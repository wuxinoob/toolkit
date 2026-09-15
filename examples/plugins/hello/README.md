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
