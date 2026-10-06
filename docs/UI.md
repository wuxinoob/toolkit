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

## Where each half of the app gets its styles

There are two halves, and the dividing line is the window, not the plugin.
One of them is styled by the host; the other is **not styled by the host at all**.

| | main window | a plugin's own window |
|---|---|---|
| which PAGE | `index.html` | `pluginwin.html` |
| which stylesheet | `assets/app.css` | **none** — the page links nothing |
| who renders it | the host, for the plugin | the plugin, in its own document |
| how a plugin styles it | `ctx.ui` (the component factory) + `.tb-*` + tokens | **its own `<style>`, entirely** |
| Tailwind utilities | **yes** | **no** — there is no stylesheet to put them in |
| `.tb-*` / tokens / reset | yes | **no** — see below |
| follows the app theme | yes, automatically | `color-scheme` + whatever its own `contributes.theme` declares; the rest is the plugin's |
| can it break the app | no — scoped to `[data-plugin]` | no — **it is a different document** |

### ⚠️ A plugin window ships **no CSS at all**

This is the one thing to know before writing a window page. There is no
stylesheet, so there is **no reset, no tokens and no `.tb-*` vocabulary** — the
plugin's own `<style>` is the only CSS in the document. Three things that are
consequences rather than trivia, because their absence is silent:

- **no `box-sizing: border-box`** — `width: 100%` plus padding overflows;
- **no `body { margin: 0 }`** — the browser's 8px margin is back;
- **no focus ring** — `:focus-visible` has to be yours, or the window is unusable
  from the keyboard.

**History, because the reasoning still applies**: the window used to link
`assets/plugin.css` (theme + preflight + `.tb-*`, ~19 KB after the utilities were
split out of a 166 KB stylesheet). It went away for two reasons:

- its preflight landed **unlayered** while the design system's rules are in
  `@layer base` / `@layer components`, and unlayered declarations outrank every
  layer — so the reset silently beat the very `.tb-*` rules shipped beside it;
- nothing wanted it. Both shipped window examples bring their own reset and
  palette, so the host was paying 19 KB per window to fight them.

One style does survive, and it is not part of a stylesheet: the inline theme
script sets **`color-scheme`**, which decides how the OS draws the parts CSS
cannot reach — scrollbars, the `<select>` popup, date pickers. Drop it and a
dark-themed window gets light native widgets.

### The design system has exactly one entry

`assets/design-system.css` holds the tokens and the `.tb-*` vocabulary, and one
entry imports it: `app.css`, for the shell. A test asserts that import and
asserts that the entry does not define tokens itself, because two copies of a
token are two answers to the same question.

**If a window ever needs the design system again**, add a THIRD page that links
a stylesheet importing `design-system.css` — and put the preflight in a layer
(`@import 'tailwindcss/preflight.css' layer(base);`). That one word is what the
old `plugin.css` was missing, and what made it behave differently from `app.css`
despite sharing a source.

### Why the split had to happen at the page level

A window's stylesheet is a `<link>` in its HTML, and a `<link>` applies **before
any module runs**. That is why `index.html` carries an inline theme script — and
it is also why no branch in `main.js` could ever have kept the shell's CSS out of
a plugin window. The only place to choose is the page, so there are two pages.

The second row is the interesting one. A plugin window is a separate
`WebviewWindow`, so it is a separate `document`: a `<style>` injected there
**cannot reach the main window at all**. That is a structural guarantee, not a
policy — which is why this path needs no sandbox, no shadow DOM, and no review.

It also means the two mechanisms do not compete. A plugin window gets the tokens
and `.tb-*` for free; a plugin that wants a completely different look simply
writes its own CSS and wins, because **unlayered CSS beats anything in `@layer`**
regardless of order — verified, not assumed:

```
design-system.css  body { background: var(--color-canvas) }   /* @layer base */
plugin <style>     body { background: rgb(1, 2, 3) }          /* unlayered   */
-> computed body background is rgb(1, 2, 3)
```

`tests/fixtures/calc-plugin` is the working demonstration: it injects a stylesheet
with its own hardcoded palette and looks nothing like the app, and that is a
legitimate choice for a window that belongs entirely to it.

The trade-off to be aware of: a plugin that hardcodes its window palette does
not follow the light/dark theme. Use `var(--color-*)` instead of literals if the
window should follow the app; use literals if it should not. Both are supported,
and neither requires host changes.

## Who draws the window frame

Three windows, two mechanisms, and one rule that keeps it honest.

| window | label | frame | capability file |
|---|---|---|---|
| main | `main` | **native** (OS) | `capabilities/default.json` |
| plugin windows | `plugin-*` | **self-drawn** | `capabilities/pluginwin.json` |

A self-drawn window is a plugin calling `ctx.windows.create(label, { decorations: false, … })`
and then drawing its own bar, dragging it with `bridge.drag()` (`startDragging`).

### The rule: capabilities are matched by window LABEL, so the label is the boundary

Tauri's capability system scopes permissions per window, and it matches on the
**label** — which is why the three files above exist rather than one. The plugin
windows get three permissions each:

```
core:default, core:window:allow-start-dragging, core:window:allow-close
```

That is exactly what a self-drawn titlebar needs and nothing more. Window-level
operations — size, position, always-on-top, click-through — deliberately stay
with the **creating** window (`main`), because a plugin that can resize itself is
a different proposition from one that can be dragged. `pluginwin.json` says this
in its own description, which is the closest thing to a contract.

**None of the three declares `remote`.** Tauri's default is that the API is only
reachable from bundled code, so a window pointed at a remote origin gets no IPC
at all. That is the safety net under the next point.

### The gap that was closed: `options` had no allow-list

`ctx.windows.create(label, options)` forwarded `options` straight into
`new WebviewWindow(label, options)`. Every other surface in this host is an
explicit, fail-closed list — service actions, capabilities, the component
vocabulary — and this was the exception.

The blast radius was small: capabilities match on label, and the only labels a
plugin can reach grant three permissions each, so **no option could escalate**.
What it could do is surprise. `url` in particular would replace the host page
with arbitrary content and skip `pluginwin-host.js` — the documented loader that
hands the plugin its `bridge`.

So options are now validated against an allow-list, and `url` must be the
plugin-window PAGE — `pluginwin.html`, not the shell's `index.html`, because a
window on the shell page never mounts the plugin:

```js
ctx.windows.create('mywin', { url: 'pluginwin.html?plugin=…' })  // ok
ctx.windows.create('mywin', { url: 'index.html' })          // throws — that is the shell
ctx.windows.create('mywin', { url: 'https://example.com' })  // throws
ctx.windows.create('mywin', { someFutureOption: true })      // throws
```

The two pages are two applications, not two modes of one: the shell links its
stylesheet, the plugin window links none, and each loads its own entry. The page
is the only place that can decide this — a `<link>` applies before any module
runs, so no branch in JS could have kept the shell's CSS out of a plugin window
(or added a stylesheet back to it). See the note in `src/main.js` for what the
old shared page cost.

Validation runs **before** the async window lookup, so a bad option fails the
same way whether or not that window already exists.

### If the main window is to be self-drawn too

Two additions, both small:

1. `"decorations": false` on the main window in `tauri.conf.json`
2. `core:window:allow-{minimize,toggle-maximize,start-dragging}` in
   `capabilities/default.json` — none are there today

And one thing to decide first, because it is not a styling question: **who draws
a plugin window's bar?** Today the plugin does, and it works — the floating
widget has done so since it was written. The alternative is the host handing
plugins a titlebar component, which takes a piece of freedom away from a window
that is otherwise entirely theirs. `docs/UI.md` → "Where each half of the app
gets its styles" is the same trade in the styling dimension.

### What is lost on Windows

Self-drawing means giving up **Snap Layouts** — the split-screen picker on hover
over the maximize button. It hangs off the native caption, so it cannot be
reproduced from the webview. Double-click-to-maximize has to be reimplemented
(a few lines, and easy to forget). Window shadow and Windows 11 rounded corners
may need `transparent: true` plus CSS.

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
- **A transparent window** needs alpha, which tokens do not carry. It
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

`tests/fixtures/plugins/fileprobe` uses it — that plugin is green, and its `main.js` has no
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
full-screen takeover) and is handed to the host with `ctx.ui.mountOverlay(el)` —
see `tests/fixtures/plugins/eyecare/` for a working example.

### Native form props are translated — and then **deleted**

A plugin writes `value` / `checked` / `oninput`; the components only speak
`modelValue` / `defaultValue` / `onUpdate:modelValue`. `FORM_PROP_RULES` in
`src/host/ui.js` is the seam, and the load-bearing half of it is the `delete`.

`value` is a real DOM property of `<input>` and `Input.vue` does not declare it,
so Vue passes it through as a fallthrough attr onto the root element. The
component re-renders on every keystroke (its internal `v-model` proxy changes),
and each of those re-renders writes that attr's value — captured at the last
`kit.render` — back into the box. Measured in the dev probe with the real
components under headless Edge: the box read `""` 5 ms after a keystroke while
the plugin's own state was already `"a"`. The data was right and only the
**display** rolled back, which is why this reads as "the plugin never receives
input" when in fact it receives everything.

Two constraints matter if a control is ever added to that table:

- **Event delivery stays single-path.** For the text controls the native
  listener is attached to the real `<input>`, so it is kept and no bridge is
  added — a bridged `{ target: { value } }` cannot answer `preventDefault`,
  `selectionStart` or `e.target.files`. For everything else the native key is
  consumed and bridged onto `onUpdate:modelValue`, because a reka root renders a
  button/div where `input` / `change` never fire. Doing both would call the
  plugin twice per keystroke, which double-applies anything that is not a plain
  assignment.
- **Never translate a key the component declares.** reka's Switch/Checkbox have
  a legitimate `value` prop (the value submitted with a form); only `checked` is
  a native spelling there. Likewise `el('input', { type: 'checkbox' })` asks for
  the browser's own control and is left completely alone.

`tests/ui-form-props.test.mjs` iterates the table itself, so adding a control
without consuming its native key fails the suite instead of shipping the bug
again.

## The render pipeline: descriptors in, patches out

`ctx.ui.el()` returns plain descriptors; `ctx.ui.render(container, tree)` turns
that tree into VNodes and paints it. Each container owns ONE Vue app, kept alive
and patched in place — it is **not** rebuilt per render.

Why the app boundary sits at the container rather than the plugin: a plugin
paints several independent fragments (a view, an overlay, detached content from
`node()`), and the per-container split is what gives each fragment its own
`provide` stack (`ROOT_PROVIDERS`) and its own portal target.

Measured on the dev probe with the real components under headless Edge —
old (rebuild per render) vs now (patch in place):

| scenario | before | now |
|---|---|---|
| keystroke triggers a whole-tree re-render | box wiped to `""` 5 ms later, focus lost | `"abc"` kept, `sameNode: true`, focus kept |
| DOM readable on the line after `render()` | yes | yes |
| portalled dialog content across a re-render | re-created | same node |
| unkeyed list, middle row deleted | — | surviving row **reuses** the deleted row's node |
| keyed list, middle row deleted | — | each row keeps its own node |

Three constraints that are easy to break:

- **`render()` must stay synchronous.** Plugins read their own container on the
  next line — `procman` does `renderProfiles(root); renderDetail();` and then
  `document.querySelector('.pm-term-area')`. A `shallowRef` would defer the
  patch to the next microtask and those call sites would see an empty container,
  so the update calls the component instance's effect runner
  (`app._instance.update()`). That runner is internal API, and it is *guarded*:
  if it is ever unavailable `render()` falls back to the old rebuild, which is
  always correct, just slower.
- **Keys are the plugin's job.** Children without a `key` are patched by
  position, so removing a row hands its DOM — including typed text and open
  dropdowns — to the row below it. `el(tag, { key: id, … })` is all it takes;
  Vue already reads `key` out of props.
- **`defaultValue` is initial-only** once nodes are reused: a field the user has
  edited ignores later `defaultValue` changes. Live values belong in `value`
  (native spelling) or `modelValue`.

Containers that leave the document are released on the next render
(`pruneDisconnected`): `ViewHost` hands a plugin a **new** element on every view
switch, and a retained app would otherwise keep its component instances,
watchers and portal targets alive until the plugin deactivates. Only containers
that were once in the document are eligible, so a plugin may still render into
an element it has not attached yet.

## Adding a primitive

Add it to `@layer components` in `src/assets/app.css`, using tokens rather than
literal colours, and list it in the table above. If it is a *variant* of an
existing primitive, prefer `.tb-x-<variant>` so the base class keeps working.

If it is a **colour**, add it to `@theme` **and** to the
`:root[data-theme='light']` block. Forgetting the second half is a silent bug —
the token keeps its dark value in the light theme, and only that one element looks
wrong. `tests/plugins.test.mjs` fails on it.
