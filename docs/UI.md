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
--color-brand / brand-ink                 accent + text on accent
--color-danger / success / warn           intent
--radius-sm / md / lg                     corners
--shadow-panel                            raised surfaces
```

Change a token and every surface follows — that is the entire point of having
them. **Dark only, for now**: the app has always been dark, and a light theme
that could not be opened in a window to check would have been shipped blind. The
block above is the whole surface area a light theme needs to override.

## Primitives

| class | for |
|---|---|
| `.tb-shell` `.tb-sidebar` `.tb-brand` `.tb-nav` `.tb-nav-group` `.tb-nav-item` `.tb-content` | the app frame |
| `.tb-card` `.tb-card-head` `.tb-card-body` `.tb-card-foot` | a titled surface |
| `.tb-btn` `-primary` `-danger` `-ghost` `-sm` | actions |
| `.tb-input` `.tb-select` `.tb-textarea` `.tb-field` `.tb-label` `.tb-hint` | forms |
| `.tb-table` | data |
| `.tb-badge` `-ok` `-warn` `-bad` | status |
| `.tb-toolbar` `.tb-divider` `.tb-section-title` | layout |
| `.tb-mono` `.tb-kbd` | code and shortcuts |
| `.tb-empty` | "nothing here yet" |
| `.tb-toast` `-error` `-success` `.tb-toasts` | feedback |
| `.tb-overlay` | where a plugin mounts overlay content |

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
