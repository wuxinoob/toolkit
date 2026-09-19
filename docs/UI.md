# UI: tokens, primitives, and why there is no component library

## The constraint that shapes everything

Plugins are loaded from a **Blob URL as a single-file ESM** (`host/external.js`), so
an external plugin cannot `import` anything — including a UI component library.
That rules out the obvious approach:

| option | reaches the shell? | reaches builtin plugins? | reaches **external** plugins? |
|---|---|---|---|
| a Vue component library (shadcn-vue, HeroUI, …) | yes | yes (bundled) | **no** |
| Tailwind utilities | yes | yes (bundled) | **no** (see below) |
| **plain CSS classes in the global stylesheet** | yes | yes | **yes** |

So the design system is **CSS**: tokens plus `.tb-*` primitives in
`src/assets/app.css`. A drop-in plugin gets the app's look by using class names,
with no import, no build step and no stylesheet of its own.

Two footnotes worth knowing:

- **HeroUI is React-only** (its docs are `/docs/react/`); Vue ports exist but are
  community projects with uncertain maintenance. **shadcn-vue** is the mature Vue
  option — and note that shadcn's *look* is its token layer, which is the part
  reproduced here.
- **Tailwind utilities cannot reach an external plugin.** Tailwind only emits the
  utilities it finds in scanned files, and a plugin's source lives outside the
  project and is loaded at runtime. The `.tb-*` classes are hand-written CSS, so
  they are always emitted. Tailwind is therefore for the shell and builtin
  plugins; `.tb-*` is for everyone.

## Tokens

One `@theme` block in `src/assets/app.css` decides what the app looks like:

```
--color-canvas / surface / surface-2      backgrounds, back to front
--color-line / line-strong                borders
--color-ink / ink-muted / ink-subtle      text, by emphasis
--color-brand / brand-ink / brand-hover   accent, text on accent, accent hover
--color-danger / success / warn           intent
--radius-sm / md / lg                     corners
--shadow-panel                            raised surfaces
```

Change a token and every surface follows — that is the entire point of having
them.

## Themes

A theme is **one attribute on `<html>`**, not a stylesheet swap:

```css
@theme                     { --color-canvas: #0e1015; /* … */ }
:root[data-theme='light']  { --color-canvas: #f4f6fa; /* … */ }
```

`src/host/theme.js` owns the preference (`system` / `light` / `dark`), persists it
in `localStorage`, follows `prefers-color-scheme` live while on `system`, and
pushes changes to the other windows through the browser's `storage` event (a push,
not the storage polling this project forbids). `index.html` carries a tiny inline
script that sets the attribute *before the first paint* — in a production build
the stylesheet is a separate `<link>` that applies before any module runs, so
without it a light-theme user would see one dark frame per window.

The important consequence: because a theme is just custom properties on `:root`,
**a plugin written against the tokens is themed for free** — no plugin code, no
reload, nothing to opt into. That is the whole reason the design system is
token-based rather than component-based. A plugin that wants its *own* accent on
top of that declares `contributes.theme` (see "Giving external plugins more
freedom" below); it is still just custom properties, scoped to the plugin.

Two things do not inherit, and each needs its own handling:

- **xterm** paints to a canvas, so it needs a concrete object. `procman.js` reads
  the tokens off the document (`readTermTheme()`) and re-applies them when the
  theme changes. This is the only place a token is copied into JS, and the copy is
  refreshed rather than frozen.
- **A transparent window** (floatwin) needs alpha, which tokens do not carry. It
  uses `color-mix(in srgb, var(--color-surface) 97%, transparent)` — same hue,
  plus the alpha the window needs. Still zero JS.

## Can CSS restyle native controls?

Partly, and the boundary is worth knowing precisely. There are three tiers:

**1. Fully restylable** — anything you are willing to re-implement. `appearance:
none` removes the platform drawing and you supply your own:

```css
.tb-input { appearance: none; background: var(--color-canvas); /* … */ }
.tb-input[type='checkbox']::before { content: '✓'; /* … */ }
input[type='range']::-webkit-slider-thumb { /* … */ }
input[type='file']::file-selector-button { /* … */ }
```

This is what `.tb-btn`, `.tb-input`, `.tb-select` and `.tb-textarea` already do.
Cost: you also inherit the platform behaviours you removed (focus ring, keyboard
handling, high-contrast mode), so re-implement sparingly.

**2. Re-tintable only** — `accent-color` re-colours the part the browser draws for
you: checkbox ticks, radio dots, range track/thumb, progress bars. One colour, no
shape. The base layer sets it from `--color-brand`, which is why a plain
`<input type="checkbox">` now matches both themes without a class.

**3. Not reachable at all.** Be honest about these:

| control part | why CSS cannot touch it |
|---|---|
| the `<select>` **dropdown popup** | drawn by the OS/WebView compositor, not the page |
| `<input type="date">` calendar popup | same |
| `<input type="color">` picker | same |
| window titlebar / frame | belongs to the OS; the app draws its own chrome instead |
| scrollbars | reachable — but only via `scrollbar-color` / `::-webkit-scrollbar`, not general CSS |

For all of tier 3 the only lever is `color-scheme`, which flips light/dark and
nothing else. `theme.js` sets it, so a dropdown opened over the light theme is at
least light. **The practical rule this project follows: style the *closed* control
completely, and let `color-scheme` cover the popup.** Replacing a `<select>` with a
custom listbox is the only way to style the popup, and it is rarely worth it.

## Giving external plugins more freedom

Today a plugin gets the app's look by using `.tb-*` and `var(--color-*)`. That is
the free tier. If you want more, these are the options in increasing order of
power — and of cost:

**Level 0 — use the tokens.** Already works, zero host support. The plugin is
themed in both modes automatically.

**Level 1 — a private palette built on the tokens.** Also already works, still
zero host support:

```js
el.innerHTML = `<div class="myplugin">…</div>`;
// the plugin's own CSS, in a <style> it injects itself:
// .myplugin { --accent: var(--color-brand); --accent-soft: color-mix(in srgb, var(--accent) 18%, transparent); }
```

The plugin gets an internal palette that still tracks the app theme. This is the
right answer for most "I want it to look *mine*" requests, and it costs nothing.

**Level 2 — plugin-declared token overrides (implemented).** A manifest
contribution the host injects:

```jsonc
"contributes": {
  "theme": {
    "dark":  { "--color-brand": "#a78bfa", "--color-brand-hover": "#bda4ff" },
    "light": { "--color-brand": "#6d3fc4", "--color-brand-hover": "#5c33ac" }
  }
}
```

The host (`src/host/pluginTheme.js`) turns that into one scoped rule per theme:

```css
:root[data-theme='dark']  [data-plugin='x'] { --color-brand: #a78bfa; }
:root[data-theme='light'] [data-plugin='x'] { --color-brand: #6d3fc4; }
```

`examples/plugins/hello` uses it — that plugin is violet, and its `main.js` has no
CSS in it at all. Five properties make this worth having rather than just letting
a plugin ship a stylesheet:

- **Scoped.** The rule targets the plugin's own container (`[data-plugin]`, set by
  `ViewHost` on the view mount, by `ctx.ui.mountOverlay` on overlay content, and
  on `<html>` in a plugin window). A plugin cannot restyle the shell, another
  plugin, or the settings page. Over-declaring is not a way to break out.
- **No JS at runtime.** Both themes are emitted up front and the `data-theme`
  attribute picks between them — exactly how the app's own tokens work. No
  re-injection when the theme changes, nothing to keep in sync.
- **It composes.** A plugin sets only the tokens it cares about; everything else
  keeps inheriting, so it still follows the app for the rest.
- **Validated, not sanitised.** A plugin supplies a *colour*, never CSS. Values
  are accepted only if they cannot escape a declaration — see below.
- **Declared in one place.** The same manifest the host already reads for views,
  hotkeys and permissions, so there is no second registration path.

### Why the value validator looks the way it does

A CSS declaration ends at `;` or `}`, and a `<style>` element ends at `<`.
`validValue` therefore rejects `; { } < > \ @` and newlines outright — with those
characters gone there is no way to terminate the declaration and start writing
rules, so the value can only ever be a value. Everything else (hex, `rgb()`,
`oklch()`, `color-mix()`, `var()`) is then fine to allow.

On top of that, `url(`, `image-set(`, `expression(` and `-moz-binding(` are
refused even though their syntax passes the character check. `url()` is the one
that matters: it turns a colour token into a request to an arbitrary host, which
is a tracking beacon with extra steps, and no theme needs it.

Bad contributions are **reported, never fatal** — they go to the plugin's log
(`theme: ignored — …`, which lands in `debug.log`). That matters because the
failure mode is silent: a typo'd token name means the plugin simply renders
normally. `tests/plugin-theme.test.mjs` covers the accepted syntaxes, every
rejection case above, and asserts every shipped contribution declares **both**
themes — a plugin that declares only `dark` looks right in one theme and
half-styled in the other, which is the exact mistake this feature invites.

**Level 3 — a stylesheet contract.** `contributes.styles: ["theme.css"]`, with the
host reading the file and injecting it. Unlimited freedom, but it needs a new
native read command and a trust decision, and unscoped plugin CSS can restyle the
entire app. **Do not ship this without Level 4.**

**Level 4 — shadow DOM isolation.** Mount each plugin view into a shadow root. The
plugin's CSS cannot leak out; the app's CSS cannot leak in. The usual objection is
that `.tb-*` would then not apply either — which is solved by constructing the
design system **once** as a `CSSStyleSheet` and adopting it everywhere:

```js
import cssText from './assets/app.css?inline';
const sheet = new CSSStyleSheet();
sheet.replaceSync(cssText);          // built once
shadowRoot.adoptedStyleSheets = [sheet, pluginSheet];   // O(1) per view
```

One sheet object, shared by every shadow root, no duplication and no parsing per
plugin. Custom properties inherit through shadow boundaries, so Level 2 keeps
working inside a shadow root unchanged. This is the correct long-term answer if
third-party CSS becomes a real thing; it is also the only option that makes
Level 3 safe.

**Where it stands:** Level 1 and Level 2 are implemented. Level 4 is the next step
if a plugin ever needs to ship its own CSS — and Level 3 should be skipped unless
Level 4 lands first.


## Primitives

| class | for |
|---|---|
| `.tb-shell` `.tb-sidebar` `.tb-brand` `.tb-nav` `.tb-nav-group` `.tb-nav-item` `.tb-content` | the app frame |
| `.tb-card` `.tb-card-head` `.tb-card-body` `.tb-card-foot` | a titled surface |
| `.tb-btn` `-primary` `-danger` `-ghost` `-sm` | actions |
| `.tb-icon-btn` `-danger` | a square button holding one glyph (row actions, tab close) |
| `.tb-input` `.tb-select` `.tb-textarea` `.tb-input-inline` `.tb-field` `.tb-label` `.tb-hint` | forms |
| `.tb-list` `.tb-row` `.tb-row-label` `.tb-row-actions` | selectable rows (state is `aria-selected`) |
| `.tb-pane` `-pad` | an inset surface: terminal, log, rendered document |
| `.tb-tabs` `.tb-tab` | a tab strip (state is `aria-selected`) |
| `.tb-table` | data |
| `.tb-badge` `-ok` `-warn` `-bad` | status pills |
| `.tb-dot` `-ok` `-warn` `-bad` | status dots |
| `.tb-t-brand` `-ok` `-warn` `-bad` `-dim` `-muted` | intent-coloured text with no pill |
| `.tb-toolbar` `.tb-divider` `.tb-section-title` | layout |
| `.tb-mono` `.tb-kbd` | code and shortcuts |
| `.tb-markdown` | rendered Markdown (no classes to hang styles on, so scoped element selectors) |
| `.tb-empty` | "nothing here yet" |
| `.tb-toast` `-error` `-success` `.tb-toasts` | feedback |
| `.tb-overlay` | where a plugin mounts overlay content |
| `.tb-screen` `-title` `-count` | a full-window takeover (break reminder, blocking prompt) |

Two conventions in the list above are deliberate:

- **State lives in ARIA, not in a modifier class.** A selected row is
  `aria-selected="true"`, a tab is `aria-selected`, a toggle is `aria-pressed`.
  The stylesheet keys off the attribute, so the markup is correct for a screen
  reader and for the theme at the same time, and the two cannot drift.
- **Nothing hard-codes a colour.** Every rule above reads a token, which is what
  makes the light theme work with no extra code. `tests/plugins.test.mjs` enforces
  this for plugins and checks that every `.tb-*` class a plugin names actually
  exists.


A plugin view using them looks native with no stylesheet of its own:

```js
function render(el) {
  el.innerHTML = `
    <div class="tb-card">
      <div class="tb-card-head">
        Notes
        <span class="tb-badge tb-badge-ok ml-auto">synced</span>
      </div>
      <div class="tb-card-body flex flex-col gap-2">
        <label class="tb-field">
          <span class="tb-label">Title</span>
          <input class="tb-input" />
        </label>
        <div class="tb-toolbar">
          <button class="tb-btn tb-btn-primary">Save</button>
          <button class="tb-btn tb-btn-ghost">Cancel</button>
        </div>
      </div>
    </div>`;
}
```

(`flex flex-col gap-2` are Tailwind utilities — fine in a builtin plugin, and
harmless in an external one, where they simply do nothing. Use them for layout
if you are bundled; rely on `.tb-*` for anything that must look right
everywhere.)

## The overlay layer

`ctx.ui.mountOverlay(el)` appends into `.tb-overlay`. The container is
deliberately **not** `position:absolute` and does **not** set
`pointer-events:none`:

- an absolutely-positioned empty container would swallow every click in the app;
- `pointer-events:none` is inherited, so an overlay button could never be clicked.

Your overlay element positions *itself* (`position:fixed; inset:0` for a
full-screen break screen) — see `src/plugins/eyecare.js` for a working example.

## Adding a primitive

Add it to `@layer components` in `src/assets/app.css`, using tokens rather than
literal colours, and list it in the table above. If it is a *variant* of an
existing primitive, prefer `.tb-x-<variant>` so the base class keeps working.

If it is a **colour**, add it to `@theme` **and** to the
`:root[data-theme='light']` block. Forgetting the second half is a silent bug —
the token keeps its dark value in the light theme, and only that one element looks
wrong. `tests/plugins.test.mjs` fails on it.

