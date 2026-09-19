/**
 * Generate `docs/theme-preview.html` — a self-contained reference for the design
 * system in BOTH themes, side by side.
 *
 * Why this exists: the light theme is the kind of change that is easy to ship
 * broken, because nothing errors — one element just looks wrong. Opening two app
 * windows and switching back and forth is a slow way to check that. This renders
 * the real compiled stylesheet into two iframes (separate documents, so
 * `:root[data-theme]` applies to each) and shows the same gallery in both.
 *
 * It uses the BUILT css, not the source, so it also catches a token that
 * Tailwind dropped or a `.tb-*` rule that never made it into the bundle.
 *
 *   node scripts/build-theme-preview.mjs        (after `npm run build`)
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeThemeContribution, serializeThemeCss } from '../src/host/pluginTheme.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const distAssets = path.join(root, 'dist', 'assets');

const cssFile = readdirSync(distAssets).find((f) => f.endsWith('.css'));
if (!cssFile) {
  console.error('No built CSS found. Run `npm run build` first.');
  process.exit(1);
}
const css = readFileSync(path.join(distAssets, cssFile), 'utf8');

// A guard, because a preview built from the wrong stylesheet would look fine and
// prove nothing.
for (const needle of ['.tb-card', '.tb-row', '.tb-markdown', '.tb-screen', 'data-theme']) {
  if (!css.includes(needle)) {
    console.error(`Built CSS is missing "${needle}" — refusing to write a misleading preview.`);
    process.exit(1);
  }
}

/**
 * The plugin-scope demo rules. Built by the REAL serializer from the REAL
 * validator, so the preview cannot show a scoping behaviour the host does not
 * actually implement — and a contribution the validator would reject would show
 * up here as a missing rule rather than as a working example.
 */
const DEMO_PLUGIN = 'demo.plugin';
const demoContribution = normalizeThemeContribution({
  dark: { '--color-brand': '#a78bfa', '--color-brand-hover': '#bda4ff' },
  light: { '--color-brand': '#6d3fc4', '--color-brand-hover': '#5c33ac' },
});
if (demoContribution.rejected.length) {
  console.error('demo contribution is invalid:', demoContribution.rejected);
  process.exit(1);
}
const pluginThemeCss = serializeThemeCss([[DEMO_PLUGIN, demoContribution]]);

/** The gallery. One copy, rendered into a dark document and a light one. */
const GALLERY = `
<div class="tb-shell" style="height:auto;min-height:100%">
  <aside class="tb-sidebar">
    <div class="tb-brand">Toolbox</div>
    <nav class="tb-nav">
      <div class="tb-nav-group">Tools</div>
      <button class="tb-nav-item" aria-current="true"><span class="tb-icon">📝</span><span>Notepad</span></button>
      <button class="tb-nav-item"><span class="tb-icon">⚙</span><span>Process Manager</span></button>
      <button class="tb-nav-item"><span class="tb-icon">🧪</span><span>StreamLab</span></button>
      <div class="tb-nav-group">Panels</div>
      <button class="tb-nav-item"><span class="tb-icon">👁</span><span>Eyecare</span></button>
    </nav>
  </aside>

  <main class="tb-content">
    <div style="display:flex;flex-direction:column;gap:14px;max-width:880px">

      <header style="display:flex;align-items:baseline;gap:10px">
        <h1 style="margin:0;font-size:17px;font-weight:600">Design system</h1>
        <span class="tb-hint">tokens + .tb-* primitives</span>
      </header>

      <!-- actions -->
      <section class="tb-card">
        <div class="tb-card-head">Actions<span class="tb-badge ml-auto">.tb-btn</span></div>
        <div class="tb-card-body" style="display:flex;flex-direction:column;gap:12px">
          <div class="tb-toolbar">
            <button class="tb-btn tb-btn-primary">Primary</button>
            <button class="tb-btn">Default</button>
            <button class="tb-btn tb-btn-danger">Danger</button>
            <button class="tb-btn tb-btn-ghost">Ghost</button>
            <button class="tb-btn" disabled>Disabled</button>
          </div>
          <div class="tb-toolbar">
            <button class="tb-btn tb-btn-sm">Small</button>
            <button class="tb-btn tb-btn-sm tb-btn-primary">Small primary</button>
            <button class="tb-icon-btn" title="Edit">✎</button>
            <button class="tb-icon-btn" title="Stop">■</button>
            <button class="tb-icon-btn tb-icon-btn-danger" title="Delete">✕</button>
            <span class="tb-kbd">Ctrl</span><span class="tb-kbd">Alt</span><span class="tb-kbd">T</span>
          </div>
        </div>
      </section>

      <!-- forms -->
      <section class="tb-card">
        <div class="tb-card-head">Forms<span class="tb-badge ml-auto">.tb-input</span></div>
        <div class="tb-card-body" style="display:flex;flex-wrap:wrap;gap:14px">
          <label class="tb-field" style="flex:1 1 200px">
            <span class="tb-label">Title</span>
            <input class="tb-input" value="Release notes" />
          </label>
          <label class="tb-field" style="flex:1 1 160px">
            <span class="tb-label">Scheme</span>
            <select class="tb-select"><option>pty-stream</option><option>channel-raw</option></select>
            <span class="tb-hint">the popup itself is drawn by the OS — see docs/UI.md</span>
          </label>
          <label class="tb-field" style="flex:1 1 100%">
            <span class="tb-label">Body</span>
            <textarea class="tb-textarea" rows="2">Markdown supported.</textarea>
          </label>
          <div class="tb-toolbar" style="flex:1 1 100%">
            <label class="tb-label" style="display:flex;gap:6px;align-items:center">
              <input type="checkbox" checked /> native checkbox
            </label>
            <label class="tb-label" style="display:flex;gap:6px;align-items:center">
              <input type="checkbox" /> unchecked
            </label>
            <label class="tb-label" style="display:flex;gap:6px;align-items:center">
              <input type="radio" name="r" checked /> radio
            </label>
            <label class="tb-label" style="display:flex;gap:6px;align-items:center;flex:1 1 140px">
              range <input type="range" style="flex:1" />
            </label>
          </div>
        </div>
      </section>

      <!-- rows / list -->
      <section class="tb-card">
        <div class="tb-card-head">Rows<span class="tb-badge ml-auto">.tb-row</span></div>
        <div class="tb-card-body">
          <div class="tb-list">
            <div class="tb-row" aria-selected="true">
              <span class="tb-dot tb-dot-ok"></span>
              <span class="tb-row-label">powershell.exe — running</span>
              <span class="tb-row-actions">
                <button class="tb-icon-btn tb-icon-btn-danger">✕</button>
              </span>
            </div>
            <div class="tb-row">
              <span class="tb-dot"></span>
              <span class="tb-row-label">node --version — exited</span>
            </div>
            <div class="tb-row">
              <span class="tb-dot tb-dot-bad"></span>
              <span class="tb-row-label">spawn failed</span>
            </div>
          </div>
        </div>
      </section>

      <!-- tabs + panes -->
      <section class="tb-card" style="overflow:hidden">
        <div class="tb-tabs">
          <div class="tb-tab" aria-selected="true"><span class="tb-dot tb-dot-ok"></span>powershell<span class="tb-icon-btn">×</span></div>
          <div class="tb-tab"><span class="tb-dot"></span>node<span class="tb-icon-btn">×</span></div>
        </div>
        <div style="padding:12px">
          <div class="tb-pane tb-pane-pad tb-mono" style="height:104px">
            <div class="tb-t-brand">tx 10:31:02.114 rpc  → host/info</div>
            <div class="tb-t-ok">rx 10:31:02.117 rpc  ← res  {"schemes":7}</div>
            <div class="tb-t-bad">err 10:31:04.002 channel-raw ← timeout: no frame</div>
            <div class="tb-t-dim">   10:31:04.010 channel-raw terminal: end</div>
          </div>
        </div>
      </section>

      <!-- badges + text intents -->
      <section class="tb-card">
        <div class="tb-card-head">Status</div>
        <div class="tb-card-body" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <span class="tb-badge tb-badge-ok">active</span>
          <span class="tb-badge tb-badge-warn">degraded</span>
          <span class="tb-badge tb-badge-bad">error</span>
          <span class="tb-badge">plain</span>
          <span class="tb-t-brand">brand text</span>
          <span class="tb-t-ok">ok text</span>
          <span class="tb-t-warn">warn text</span>
          <span class="tb-t-bad">bad text</span>
          <span class="tb-t-dim">dim text</span>
          <span class="tb-t-muted">muted text</span>
        </div>
      </section>

      <!-- table -->
      <section class="tb-card">
        <div class="tb-card-head">Table</div>
        <div class="tb-card-body">
          <table class="tb-table">
            <thead><tr><th>id</th><th>transport · codec</th><th>direction</th></tr></thead>
            <tbody>
              <tr><td><code class="tb-mono tb-t-brand">rpc</code></td><td>invoke · json-envelope</td><td class="tb-hint">bidirectional</td></tr>
              <tr><td><code class="tb-mono tb-t-brand">channel-raw</code></td><td>channel · raw-binary</td><td class="tb-hint">downlink</td></tr>
              <tr><td><code class="tb-mono tb-t-brand">event-bus</code></td><td>event · json-envelope</td><td class="tb-hint">broadcast</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- markdown -->
      <section class="tb-card">
        <div class="tb-card-head">Markdown<span class="tb-badge ml-auto">.tb-markdown</span></div>
        <div class="tb-card-body">
          <div class="tb-markdown">
            <h2>Release notes</h2>
            <p>A paragraph with <a href="#">a link</a> and <code>inline code</code>.</p>
            <blockquote>Quoted text, for emphasis.</blockquote>
            <pre><code>const env = Envelope.req(1, 'host', 'info');</code></pre>
            <ul><li>first item</li><li>second item</li></ul>
          </div>
        </div>
      </section>

      <!-- empty + overlay -->
      <section class="tb-card">
        <div class="tb-card-head">Empty state</div>
        <div class="tb-card-body">
          <div class="tb-empty" style="height:110px">
            <div style="font-size:22px;opacity:.5">🧩</div>
            <div>No plugin views yet</div>
            <div class="tb-hint">Drop a plugin folder into the plugins directory.</div>
          </div>
        </div>
      </section>

      <!-- full-screen takeover, shown inline -->
      <section class="tb-card" style="overflow:hidden">
        <div class="tb-card-head">Full-screen takeover<span class="tb-badge ml-auto">.tb-screen</span></div>
        <div class="tb-screen" style="position:relative;inset:auto;height:200px;backdrop-filter:none">
          <div class="tb-screen-title" style="font-size:19px">Please look at something 20 feet away</div>
          <div class="tb-screen-count" style="font-size:52px">20</div>
          <button class="tb-btn">Skip</button>
        </div>
      </section>

      <!-- contributes.theme: a plugin restyling only its own subtree -->
      <section class="tb-card">
        <div class="tb-card-head">
          Plugin theme scope
          <span class="tb-badge ml-auto">contributes.theme</span>
        </div>
        <div class="tb-card-body" style="display:flex;flex-direction:column;gap:12px">
          <p class="tb-hint" style="margin:0">
            Same markup twice. The left copy is untouched; the right one is inside
            <code>[data-plugin='demo.plugin']</code>, which the host gave its own
            <code>--color-brand</code>. Nothing else on this page changed — that is what
            "scoped" buys.
          </p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="tb-pane tb-pane-pad" style="display:flex;flex-direction:column;gap:8px">
              <span class="tb-section-title" style="margin:0">host default</span>
              <div class="tb-toolbar">
                <button class="tb-btn tb-btn-primary">Primary</button>
                <span class="tb-badge tb-badge-ok">ok</span>
                <span class="tb-t-brand">brand text</span>
              </div>
            </div>
            <div class="tb-pane tb-pane-pad" data-plugin="demo.plugin" style="display:flex;flex-direction:column;gap:8px">
              <span class="tb-section-title" style="margin:0">inside the plugin scope</span>
              <div class="tb-toolbar">
                <button class="tb-btn tb-btn-primary">Primary</button>
                <span class="tb-badge tb-badge-ok">ok</span>
                <span class="tb-t-brand">brand text</span>
              </div>
            </div>
          </div>
        </div>
      </section>

    </div>
  </main>
</div>`;

const frame = (theme) => `<!doctype html>
<html lang="en" data-theme="${theme}">
<head><meta charset="utf-8"><style>${css}</style>
<style>${pluginThemeCss}</style>
<style>
  /* iframe-only: the real app fills the viewport, this preview scrolls. */
  html,body{height:auto}
  body{padding:0}
</style></head>
<body>${GALLERY}</body>
</html>`;

const doc = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<title>Toolbox · 设计系统 / 主题预览</title>
<style id="appcss">${css}</style>
<style>
  html,body{height:100%}
  body{display:flex;flex-direction:column;gap:0;margin:0}
  .bar{display:flex;align-items:center;gap:10px;padding:10px 14px;
       border-bottom:1px solid var(--color-line);background:var(--color-surface);flex:0 0 auto}
  .bar h1{margin:0;font-size:14px;font-weight:600}
  .panes{flex:1;display:grid;grid-template-columns:1fr 1fr;min-height:0}
  .pane{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--color-line)}
  .pane:last-child{border-right:none}
  .pane > .label{padding:7px 12px;font-size:11px;letter-spacing:.5px;text-transform:uppercase;
       color:var(--color-ink-subtle);border-bottom:1px solid var(--color-line);flex:0 0 auto}
  iframe{border:0;flex:1;width:100%;min-height:0;background:var(--color-canvas)}
</style>
</head>
<body>
  <div class="bar">
    <h1>Toolbox 设计系统 · 两套主题并排</h1>
    <span class="tb-hint">内容来自 <code class="tb-mono">npm run build</code> 产出的真实样式表，不是手写副本。</span>
    <span class="tb-badge tb-badge-ok" style="margin-left:auto">${cssFile}</span>
  </div>
  <div class="panes">
    <div class="pane"><div class="label">dark</div><iframe id="f-dark"></iframe></div>
    <div class="pane"><div class="label">light</div><iframe id="f-light"></iframe></div>
  </div>
  <script>
    // Two separate documents, because the theme selector is :root[data-theme].
    const src = { dark: ${JSON.stringify(frame('dark'))}, light: ${JSON.stringify(frame('light'))} };
    document.getElementById('f-dark').srcdoc = src.dark;
    document.getElementById('f-light').srcdoc = src.light;
  </script>
</body>
</html>`;

const out = path.join(root, 'docs', 'theme-preview.html');
writeFileSync(out, doc, 'utf8');
console.log(`wrote ${path.relative(root, out)} (${(doc.length / 1024).toFixed(0)} KB) from ${cssFile}`);
