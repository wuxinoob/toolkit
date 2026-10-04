/**
 * `ctx.windows.create` validates its options.
 *
 * The point of this file: window options were the one surface in the host with
 * no allow-list — they went straight into `new WebviewWindow(label, options)`.
 * Everything else here is fail-closed (service actions, capabilities, the
 * component vocabulary), so this is the exception worth pinning.
 *
 * The validation runs BEFORE the async window lookup, so it can be tested with
 * no Tauri at all: the rejection happens before anything touches the native API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// A window/localStorage shim, installed before any host module is imported —
// ctx.js reads localStorage at import time.
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) {
    return this._m.has(k) ? this._m.get(k) : null;
  },
  setItem(k, v) {
    this._m.set(k, String(v));
  },
  removeItem(k) {
    this._m.delete(k);
  },
  clear() {
    this._m.clear();
  },
};

register('./browser-stubs-loader.mjs', import.meta.url);
const { buildCtx, normalizePluginWindowUrl } = await import('../src/host/ctx.js');

const disposer = { track() {}, dispose() {} };
const ctx = buildCtx({ manifest: { id: 'test.winopts', permissions: ['win:manage'] } }, disposer);

/** The rejection message, or null if it resolved (it should not). */
async function reason(promise) {
  try {
    await promise;
    return null;
  } catch (e) {
    return e.message;
  }
}

test('windows.create: the plugin-window page is allowed', async () => {
  // The shapes the windowed plugins actually pass. They must get PAST
  // validation; where they fail afterwards (no Tauri in Node) is not what this
  // test is about, so the assertion is only that the failure is not a
  // validation one.
  for (const url of [
    'pluginwin.html?plugin=x&label=plugin-y',
    'pluginwin.html?label=plugin-y&plugin=x', // parameter order is not fixed
    'pluginwin.html?plugin=x#anything', // nor is a fragment
  ]) {
    const msg = await reason(ctx.windows.create('plugin-probe-a', { url, width: 200, height: 200 }));
    assert.ok(
      msg === null || !msg.includes('must be the'),
      `"${url}" should pass validation, got: ${msg}`,
    );
  }
});

test('windows.create: anything that is not the plugin-window page is rejected', async () => {
  for (const url of [
    // Not the app's own page at all.
    'https://example.com',
    'http://127.0.0.1/x',
    'file:///etc/passwd',
    'pluginwin.htmlx',
    // Root-relative and traversal paths. The page has to resolve against the
    // window's OWN origin; a caller must not be able to name somewhere else.
    '/pluginwin.html',
    '../pluginwin.html',
    'x/pluginwin.html',
    // The SHELL page. Handing it to a plugin window is what used to boot a whole
    // second plugin host inside it — a second set of auto-started processes,
    // every drop-in plugin activated twice, and a window rendering the app shell
    // instead of the plugin's UI. Refused at the call site now, where the author
    // is looking, with the correct shape in the message.
    //
    // Note `index.html?mode=pluginwin` is NOT here: that is the LEGACY shape and
    // it is accepted, translated rather than rejected — see the test below.
    'index.html',
    'index.html?mode=floatwin',
    'index.html?mode=plugin',
  ]) {
    const msg = await reason(ctx.windows.create('plugin-probe-b', { url }));
    assert.ok(
      msg && msg.includes('must be the'),
      `"${url}" should have been rejected, got: ${msg}`,
    );
  }
});

test('windows.create: an unknown option is rejected', async () => {
  // `url` is the dangerous one, but the rule is an allow-list: anything not
  // named is refused rather than forwarded and hoped about.
  const msg = await reason(ctx.windows.create('plugin-probe-c', { someFutureOption: true }));
  assert.ok(msg && msg.includes('not allowed'), `expected a rejection, got: ${msg}`);
  assert.ok(msg.includes('someFutureOption'), 'the message should name the offending option');
});

test('windows.create: the documented options still pass', async () => {
  // Everything the windowed plugins pass today, plus the neighbours a plugin
  // might reasonably want. A regression here would break every windowed plugin.
  const ok = {
    url: 'pluginwin.html?plugin=x&label=plugin-y',
    title: 'x',
    width: 300,
    height: 400,
    x: 10,
    y: 10,
    center: true,
    transparent: true,
    decorations: false,
    shadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    closable: true,
    focus: true,
    visible: true,
  };
  const msg = await reason(ctx.windows.create('plugin-probe-d', ok));
  // Assert on the whole validation surface, not just the option check: with only
  // `!msg.includes('not allowed')` a URL that the validator REFUSES passes this
  // test, because a refusal says something else. It did exactly that.
  assert.ok(
    msg === null || !/not allowed|must be the/.test(msg),
    `a documented option or url was refused: ${msg}`,
  );
});

test('windows.create: the allow-list covers every option the built-ins pass', () => {
  // The allow-list is only safe if it does not silently break the windows that
  // already exist. Reading the real call sites beats a hand-written list: the
  // hand-written one drifts the moment someone adds an option to a plugin.
  const WINDOW_OPTIONS = new Set([
    'url', 'title', 'width', 'height', 'x', 'y', 'center', 'transparent',
    'decorations', 'shadow', 'alwaysOnTop', 'skipTaskbar', 'resizable',
    'maximizable', 'minimizable', 'closable', 'focus', 'visible',
  ]);

  // The call sites are DISCOVERED, not listed. The literal that used to be here
  // named `src/plugins/floatwin.js`; when that plugin was deleted the loop kept
  // passing, because it only complained about files it could read and the one
  // left was fine — so the test silently dropped to one file. A glob cannot
  // forget to include a plugin.
  const files = [
    ...readdirSync(new URL('../src/plugins/', import.meta.url)).map((f) => `src/plugins/${f}`),
    ...readdirSync(new URL('../tests/fixtures/plugins/', import.meta.url)).map(
      (d) => `tests/fixtures/plugins/${d}/main.js`,
    ),
    'tests/fixtures/calc-plugin/main.js',
  ].filter((f) => f.endsWith('.js') && existsSync(new URL(`../${f}`, import.meta.url)));

  const problems = [];
  const audited = [];
  let seen = 0;
  for (const file of files) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    // A `create` call that hands in a helper's return value has no literal to
    // read; that is not a failure, it is simply not statically auditable.
    const call = src.match(/ctx\.windows\.create\([^,]+,\s*\{([\s\S]*?)\n\s*\}\)/);
    if (!call) continue;
    const keys = [...call[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:/gm)].map((m) => m[1]);
    if (keys.length === 0) continue;
    audited.push(file);
    seen += keys.length;
    for (const k of keys) {
      if (!WINDOW_OPTIONS.has(k)) problems.push(`${file}: passes "${k}", which the allow-list refuses`);
    }
  }
  assert.ok(
    seen >= 6,
    `only ${seen} option(s) extracted from ${audited.join(', ') || 'nothing'} — the extractor stopped working`,
  );
  assert.deepEqual(problems, [], `the allow-list would break a plugin window:\n  ${problems.join('\n  ')}`);
});

test('startup: the hidden-window handshake is intact on all three sides', () => {
  // Three files have to agree or the app misbehaves in a way that is easy to
  // ship and hard to notice:
  //
  //   tauri.conf.json  visible:false  — no unpainted frame is ever shown
  //   src/main.js      show()         — the frontend reveals it after first paint
  //   src-tauri/lib.rs show()         — the backstop if the frontend never does
  //
  // Drop the config and the white flash returns (worst on a FIRST run, where
  // WebView2 has no caches). Drop either show() and the window never appears at
  // all — the app looks like it failed to start.
  const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const main = conf.app.windows.find((w) => w.title === 'Toolkit');
  assert.ok(main, 'no main window in tauri.conf.json');
  assert.equal(main.visible, false, 'the main window must start hidden, or the white flash comes back');

  const mainJs = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.ok(
    /getCurrentWindow\(\)[\s\S]{0,120}?\.show\(\)/.test(mainJs),
    'src/main.js must reveal the window — nothing else does',
  );

  const libRs = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.ok(libRs.includes('is_visible'), 'lib.rs must have the backstop that shows a window the frontend never revealed');

  // And the frontend is only ALLOWED to show it because the capability says so.
  const cap = JSON.parse(
    readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'),
  );
  assert.ok(
    cap.permissions.includes('core:window:allow-show'),
    'the main-window capability must allow `show`',
  );
});

test('windows.create: a label the ACL cannot match is refused', async () => {
  // Tauri matches capabilities by window LABEL. Only `plugin-*` is granted
  // anything, so any other label yields a window with NO permissions —
  // undraggable, and its close button fails with an ACL denial. Reported by a
  // plugin author who lost an afternoon to exactly that.
  const bad = ['my-win', 'moment-notes-main', 'calc', 'widget', 'plugin', ''];
  for (const label of bad) {
    // Deliberately a URL the new check would ALSO reject: the label is validated
    // first, so a bad label is reported as a bad label rather than as a bad URL.
    // Otherwise the author fixes the URL and gets the same window back.
    const msg = await reason(ctx.windows.create(label, { url: 'index.html' }));
    assert.ok(msg, `label "${label}" should have been refused`);
    assert.ok(
      /matches no capability|non-empty label/.test(msg),
      `unexpected message for "${label}": ${msg}`,
    );
  }
});

test('windows.create: the one label shape the ACL matches is accepted', async () => {
  // It used to be two: `builtin.floatwin` owned a bespoke `floatwin.json`
  // capability, so `floatwin` was a second accepted label. Both are gone, and
  // the host's check now recognises exactly one pattern — which is the state
  // worth pinning, because a second arm is how the list rots.
  const url = 'pluginwin.html?plugin=x&label=plugin-y';
  for (const label of ['plugin-anything', 'plugin-my.plugin-main']) {
    const msg = await reason(ctx.windows.create(label, { url }));
    assert.ok(
      msg === null || !/matches no capability|must be the/.test(msg),
      `"${label}" should pass both the label and url checks, got: ${msg}`,
    );
  }
  // `floatwin` is now just another label that matches nothing.
  const msg = await reason(ctx.windows.create('floatwin', { url }));
  assert.match(msg ?? '', /matches no capability/, 'the retired bespoke label must no longer be special');
});

test('the shell is not statically imported by the entry', () => {
  // The invariant behind a ~19x difference in what opening a window costs.
  //
  // `main.js` used to import `App.vue` STATICALLY, and a static import is
  // fetched, parsed and evaluated by every window — including a plugin window,
  // which never mounts the shell. It paid for the whole graph anyway (the shell,
  // ViewHost, SettingsView, the entire `components/ui/` set, the toaster, the
  // tooltips). Measured by walking the BUILT chunks: 782.3 KB over 24 chunks per
  // plugin window, against 40.8 KB over 4 once the import became dynamic.
  //
  // The regression vector is a static import, so that is what this checks — and
  // it has to be checked in the SOURCE. Walking the import graph from
  // `pluginwin-host.js` would not see it: that file never imported `App.vue`,
  // the two got linked together by the BUNDLER, because a module the entry pulls
  // in statically lands in a chunk the dynamic plugin-window chunk then shares.
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.doesNotMatch(
    code,
    /^\s*import\s+App\s+from\s*['"]\.\/App\.vue['"]/m,
    'a static `import App from "./App.vue"` makes every window load the whole shell — use `await import(...)`',
  );
  assert.match(
    code,
    /await import\(['"]\.\/App\.vue['"]\)/,
    'and the shell must still be reachable, dynamically, from the main-window branch',
  );
});

test('the plugin-window entry does not pull the boot path or the built-ins', () => {
  // The other half: a plugin window is its own page with its own entry, and that
  // entry must stay a thin loader. It needs the protocol hub and the theme scope;
  // it does NOT need the boot path, the plugin registry, or a built-in plugin —
  // and it must not reach the shell, or the stylesheet split's JS half is undone.
  //
  // The walk starts at `src/pluginwin.js` (what `pluginwin.html` loads), not at
  // `pluginwin-host.js`, so it covers the page's own imports too.
  const root = fileURLToPath(new URL('..', import.meta.url));

  /** Static import/export specifiers only — `import('x')` is dynamic and excluded. */
  const specifiers = (src) => {
    const out = [];
    for (const m of src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
    for (const m of src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) out.push(m[1]);
    return out;
  };

  const reachable = (entry) => {
    const seen = new Set();
    const stack = [entry];
    while (stack.length) {
      const file = stack.pop();
      if (seen.has(file) || !existsSync(file)) continue;
      seen.add(file);
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        // A bare specifier is a package, not our source.
        if (spec.startsWith('.')) stack.push(resolve(dirname(file), spec));
      }
    }
    return [...seen].map((f) => f.slice(root.length).replace(/\\/g, '/'));
  };

  const graph = reachable(join(root, 'src/pluginwin.js'));
  assert.ok(graph.length > 1, `the graph walk found nothing — did the import shape change? (${graph})`);

  const forbidden = [
    'src/App.vue',
    'src/host/boot.js',
    'src/host/registry.js',
    'src/host/lifecycle.js',
    'src/host/external.js',
  ];
  const leaked = forbidden.filter((f) => graph.includes(f));
  assert.deepEqual(
    leaked,
    [],
    `a plugin window would load ${leaked.join(', ')} — these belong to the main window.`,
  );
  const builtins = graph.filter((f) => f.startsWith('src/plugins/'));
  assert.deepEqual(builtins, [], `a plugin window would load a built-in plugin: ${builtins}`);
});

test('both pages set the theme before first paint, identically', () => {
  // The bundled stylesheet is a <link>, and a <link> applies before any module
  // runs — so without an inline script a light-theme user sees one dark frame on
  // every window open. That script has to be duplicated per page (it must run
  // before the module graph, so it cannot live in a module), which makes it
  // exactly the kind of thing that drifts silently: a divergence shows up as a
  // flash nobody can reproduce on demand.
  const scriptOf = (file) => {
    const html = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, `${file} has no inline theme script`);
    return m[1].replace(/\s+/g, ' ').trim();
  };

  assert.equal(
    scriptOf('index.html'),
    scriptOf('pluginwin.html'),
    'the two inline theme scripts must be identical — see the note in pluginwin.html',
  );

  // And they must read the key `src/host/theme.js` writes, or the whole thing is
  // a no-op that still looks correct.
  const theme = readFileSync(new URL('../src/host/theme.js', import.meta.url), 'utf8');
  const key = theme.match(/'(toolbox\.theme)'/)?.[1];
  assert.ok(key, 'theme.js must name its storage key');
  assert.ok(
    scriptOf('index.html').includes(key),
    `the inline script must read ${key}, the key theme.js writes`,
  );
});

test('the plugin-window host uses no class names at all', () => {
  // A plugin window links NO stylesheet, so a class name in host code here is
  // inert by construction — there is nothing to define it. That fails SILENTLY
  // (the element renders unstyled) and reads as the plugin's fault, so the host's
  // own plugin-window UI has to be styled inline.
  //
  // This used to say "restricted to the `.tb-*` vocabulary", when the window
  // linked a 19 KB stylesheet for it. Removing the stylesheet made the rule
  // simpler AND stricter: any class is now a bug.
  //
  // (A plugin's own window code is unaffected — it may define classes in its own
  // `<style>`. That is a separate document, so it cannot reach the main window,
  // and this check does not read plugin code.)
  for (const rel of ['src/pluginwin.js', 'src/host/pluginwin-host.js']) {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const classes = new Set();
    for (const m of src.matchAll(/class(?:Name)?\s*[=:]\s*['"`]([^'"`]*)['"`]/g)) {
      for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
    }
    assert.deepEqual(
      [...classes],
      [],
      `${rel} sets a class (${[...classes].join(', ')}) — a plugin window ships no stylesheet, ` +
        'so it would render unstyled with no error anywhere. Style it inline instead.',
    );
  }
});

test('closing the main window hides it, and the tray is the only way out', () => {
  // The behaviour spans three files and every one of them can be edited away
  // without an error anywhere: the window would just start quitting on ✕, or the
  // tray would lose its quit item and the app would become unquittable.
  const boot = readFileSync(new URL('../src/host/boot.js', import.meta.url), 'utf8');
  assert.match(boot, /installCloseToTray/, 'boot.js must install the close handler');
  assert.match(
    boot,
    /onCloseRequested\(async \(event\) => \{\s*event\.preventDefault\(\)/,
    'and it must preventDefault — without that Tauri destroys the window anyway',
  );
  assert.match(boot, /\.hide\(\)/, 'and hide rather than close');

  // The plugin-facing handler must stand DOWN on the main window while this is
  // in effect: the window did not close, so a plugin that tore its windows down
  // would have no signal on the way back to rebuild them.
  const ctx = readFileSync(new URL('../src/host/ctx.js', import.meta.url), 'utf8');
  assert.match(
    ctx,
    /if \(closeToTray\(\) && currentWindowLabel\(\) === 'main'\) return;/,
    'ctx.js must skip a plugin close handler while the main window only hides',
  );

  // Rust: a tray, a quit item, and a GRACEFUL exit. `app.exit(0)` runs
  // `RunEvent::Exit` → `kill_all()`, so sidecars and ptys are drained; a process
  // kill would leave them orphaned.
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(lib, /TrayIconBuilder::new\(\)/, 'lib.rs must build a tray icon');
  assert.match(lib, /MenuItem::with_id\(app, "quit"/, 'the tray menu must have a quit item');
  assert.match(lib, /"quit" => app\.exit\(0\)/, 'and quit must go through app.exit, not a kill');
  assert.match(
    lib,
    /tray\.build\(app\)\?;/,
    'a tray that will not build must be FATAL — hiding on close with no tray means the app cannot be quit',
  );
});

test('the legacy plugin-window URL is translated, not rejected', () => {
  // A plugin window's URL used to be `index.html?mode=pluginwin&…` and it was
  // documented that way. When the two windows became two pages that shape was
  // refused — and that broke every plugin already installed, with a symptom of
  // NOTHING AT ALL: `create` rejected the URL, every caller had a `catch` around
  // it, so the plugin loaded, activated, showed up in Settings, and its windows
  // simply never appeared. A third-party plugin cannot be edited, and the copy in
  // the plugins directory is a COPY, so fixing `tests/fixtures/` does not fix what is
  // installed.
  //
  // So the old shape is translated at the boundary. Translating there is what
  // makes it free: the window is CREATED with the canonical URL, so it never
  // loads the shell's 166 KB stylesheet only to navigate away from it.
  const cases = [
    ['index.html?mode=pluginwin&plugin=x&label=plugin-y', 'pluginwin.html?plugin=x&label=plugin-y'],
    ['index.html?plugin=x&label=plugin-y&mode=pluginwin', 'pluginwin.html?plugin=x&label=plugin-y'],
    ['index.html?mode=pluginwin&plugin=x#frag', 'pluginwin.html?plugin=x'],
    ['index.html?mode=pluginwin', 'pluginwin.html'],
  ];
  for (const [legacy, canonical] of cases) {
    assert.equal(normalizePluginWindowUrl(legacy), canonical, `${legacy} should translate`);
  }

  // The canonical shape passes through untouched, so a plugin that already
  // updated is not rewritten into something else.
  for (const url of ['pluginwin.html?plugin=x&label=plugin-y', 'pluginwin.html']) {
    assert.equal(normalizePluginWindowUrl(url), url);
  }

  // `index.html` WITHOUT the mode is still refused — that is the shell page, and
  // handing it to a plugin window is the thing that used to boot a second host.
  for (const url of [
    'index.html',
    'index.html?plugin=x',
    'index.html?mode=floatwin',
    'https://example.com',
    '/pluginwin.html',
    '../pluginwin.html',
  ]) {
    assert.equal(normalizePluginWindowUrl(url), null, `${url} should be refused`);
  }
});

test('the two windows are two pages, and the shell asserts it is the shell', () => {
  // The structural half, and the half that cannot be bypassed. `ctx.windows.create`
  // refuses a URL that is not `pluginwin.html`, but a window can also come from
  // `tauri.conf.json` or a future native path — so `index.html` must not be able
  // to boot the host anywhere but the main window.
  //
  // There are two independent guarantees and both are checked:
  //
  //   1. a plugin window never loads `src/main.js` at all — `pluginwin.html`
  //      points at `src/pluginwin.js`, a page of its own. That is also what lets
  //      the two pages link different stylesheets, which no JS branch could do.
  //   2. if something DOES point a window at `index.html`, this entry checks its
  //      own label and refuses rather than starting a second host.
  const shellHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const pluginHtml = readFileSync(new URL('../pluginwin.html', import.meta.url), 'utf8');
  assert.match(shellHtml, /src="\/src\/main\.js"/, 'index.html is the shell entry');
  assert.match(pluginHtml, /src="\/src\/pluginwin\.js"/, 'pluginwin.html is its own entry');

  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.match(code, /getCurrentWindow\(\)\.label/, 'main.js must read the window label');
  assert.match(code, /=== 'main'/, 'and assert it IS the main window');

  // The old shape is the bug: a `mode === 'pluginwin'` selector whose `else`
  // boots the whole host. Anything that looks like it again must fail here.
  assert.doesNotMatch(
    code,
    /mode === 'pluginwin'/,
    'the dispatch must not be selected by a ?mode= parameter — that is what booted a second host',
  );
  assert.doesNotMatch(
    code,
    /pluginwin-host/,
    'the shell entry must not know about the plugin-window host at all — that page is pluginwin.html',
  );
});
