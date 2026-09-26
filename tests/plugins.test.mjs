/**
 * Plugin manifest audit (node --test, static).
 *
 * The old project shipped a real defect of this exact class: a plugin called a
 * service it had not declared, so the call was denied at runtime with a
 * confusing message. It is a static property, so it can be tested statically —
 * no webview, no CSS import, no Tauri.
 *
 * For every built-in plugin and every bundled example this asserts:
 *   1. the manifest parses and has an id + activate()
 *   2. plugin ids are unique
 *   3. every capability the source actually uses is DECLARED in permissions
 *   4. every view it registers is declared in contributes.views
 *   5. the declared permissions are all recognised by the host
 *
 * It reads the sources as text and extracts the manifest literal, because the
 * plugin modules import CSS and xterm and therefore cannot be imported here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readdirSync, existsSync } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * The built-ins, DERIVED from the registry rather than listed here.
 *
 * `src/host/registry.js` IS the list — it is what the app ships — so reading it
 * means this audit cannot silently stop covering a plugin that was added, nor
 * keep auditing one that was deleted. The literal that used to sit here had the
 * second failure mode for real: it named `notepad` (and `eyecare`, and
 * `floatwin`) long after those were removed, so several tests below passed
 * vacuously on an empty set of files they could no longer read.
 */
const BUILTIN = [
  ...readFileSync(path.join(root, 'src/host/registry.js'), 'utf8').matchAll(
    /from '\.\.\/plugins\/([a-z0-9-]+)\.js'/g,
  ),
].map((m) => m[1]);
const EXAMPLES = [
  // The two live-check plugins. They are here because they exercise the parts
  // of the surface nothing else does — native dialogs, OS drops, OS
  // notifications, and the communication trace.
  { id: 'fileprobe.demo', dir: 'examples/plugins/fileprobe' },
  { id: 'msglog.demo', dir: 'examples/plugins/msglog' },
  { id: 'calc.demo', dir: 'examples/calc-plugin' },
  { id: 'probe.demo', dir: 'examples/plugins/probe' },
  { id: 'gallery.demo', dir: 'examples/plugins/gallery' },
  // The three interfaces that reach OUT of the app: clipboard, screen capture
  // and OS file drops. Audited here like any other plugin, and the reason it
  // exists is that none of them can be covered by the in-app selftest.
  { id: 'senses.demo', dir: 'examples/plugins/senses' },
  // The widest example: five of its own windows, a shipped sidecar, and a
  // main-window view — so it is the one most worth auditing statically.
  { id: 'eyecare.demo', dir: 'examples/plugins/eyecare' },
];

/** The permission vocabulary the host understands. */
/**
 * The permission vocabulary, DERIVED from the services rather than listed.
 *
 * It was a hand-written set, and it went stale the moment two services were
 * added: `rpc:dialog` and `rpc:notify` were refused as "unknown permission",
 * which is a confusing way to learn that the TEST is out of date. A list that
 * mirrors another file will drift; read the other file.
 *
 * The authoritative source is each service's own `fn name()`, which is also
 * what the gateway uses to build `rpc:<svc>`.
 */
function serviceNames() {
  const dir = path.join(root, 'src-tauri/src/services');
  const names = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.rs')) continue;
    const src = readFileSync(path.join(dir, file), 'utf8');
    // Only a SERVICE has `actions()` — the stream providers (ticker, blob) also
    // have a `name()` and would otherwise be mistaken for services, quietly
    // widening the vocabulary and weakening this check.
    if (!/fn\s+actions\(&self\)/.test(src)) continue;
    // `fn name(&self) -> &'static str { "storage" }`
    for (const m of src.matchAll(/fn\s+name\(&self\)\s*->\s*&'static str\s*\{\s*"([a-z_]+)"/g)) {
      names.push(m[1]);
    }
  }
  return names;
}

const KNOWN_PERMISSIONS = new Set([
  ...serviceNames().map((n) => `rpc:${n}`),

  // Not service-backed, and cannot be derived — listed with the reason:
  //
  // `rpc:dialog` is a RAW command, not a gateway action. The gateway is
  // synchronous (main thread) and a native modal dialog would deadlock there,
  // so `plugin_dialog` is `async` and gates itself with the same
  // `host::registry::is_allowed` call. See `plugin_dialog` in lib.rs.
  'rpc:dialog',

  // Window control is its own capability rather than a service.
  'win:manage',
]);

const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

/**
 * Extract the `export const manifest = { ... };` literal by brace counting
 * (string- and comment-aware) and evaluate it. Deterministic because the
 * manifest is a plain literal in every plugin.
 */
function extractManifest(src, label) {
  const start = src.indexOf('export const manifest');
  assert.ok(start >= 0, `${label}: no \`export const manifest\` found`);
  const open = src.indexOf('{', start);
  assert.ok(open > start, `${label}: manifest has no object literal`);

  let depth = 0;
  let quote = null;
  let i = open;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const literal = src.slice(open, i + 1);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${literal});`)();
}

/**
 * Which permissions does this source need?
 *
 * Maps each capability access to the permission the native gate will check for.
 * `ctx.` (main window) and `bridge.` (plugin window) are both covered — a
 * window-scoped plugin hits the same gateway and the same registry.
 */
/**
 * Read a plugin entry AND everything it imports, relative to the repo root.
 *
 * The audit used to read one file. A plugin split across modules would then have
 * its capability usage half-invisible — the check would still pass, just on less
 * code, which is the worst kind of green. Following the relative imports keeps
 * the audit as strong as the entry point is.
 */
function collectSource(entryRel, seen = new Set()) {
  if (seen.has(entryRel)) return '';
  seen.add(entryRel);
  const source = read(entryRel);
  const dir = path.posix.dirname(entryRel);
  let out = source;
  for (const m of source.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
    const next = path.posix.normalize(path.posix.join(dir, m[1]));
    out += `\n${collectSource(next, seen)}`;
  }
  return out;
}

function requiredPermissions(source) {
  // A plugin may contain a DELIBERATE negative test (calling something it has
  // not declared, to prove the gate rejects it). Put
  //   // audit-ignore-next-line
  // on the line before it and it is excluded here, so the audit stays a strict
  // capability-declaration check without forbidding that pattern.
  const MARKER = 'audit-ignore-next-line';
  const kept = [];
  let skipNext = false;
  for (const line of source.split('\n')) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (line.includes(MARKER)) {
      skipNext = true;
      continue;
    }
    kept.push(line);
  }
  const src = kept.join('\n');
  const needed = new Set();
  const add = (p) => needed.add(p);
  const recv = (re, make) => {
    for (const m of src.matchAll(re)) add(make(m));
  };

  recv(/\b(?:ctx|bridge)\.rpc\(\s*['"]([a-z]+)['"]/g, (m) => `rpc:${m[1]}`);
  recv(/\b(?:ctx|bridge)\.request\(\s*['"]([a-z]+)['"]/g, (m) => `rpc:${m[1]}`);
  recv(/\b(?:ctx|bridge)\.storage\./g, () => 'rpc:storage');
  recv(/\b(?:ctx|bridge)\.bus\./g, () => 'rpc:bus');
  recv(/\bctx\.stream(Raw)?\(/g, () => 'rpc:stream');
  recv(/\b(?:ctx|bridge)\.sidecar\(/g, () => 'rpc:proc');
  recv(/\b(?:ctx|bridge)\.pty\(/g, () => 'rpc:stream');
  recv(/\b(?:ctx|bridge)\.sessions\(/g, () => 'rpc:host');
  recv(/\bctx\.windows\./g, () => 'win:manage');

  // The sensing surface. These were missing here for exactly one release, and
  // the gap was not theoretical: `examples/plugins/senses` used `ctx.screen.*`
  // without declaring `rpc:screen`, passed this audit, and then failed its own
  // activation with `missing permission "rpc:screen"`. The audit's whole promise
  // is "every capability the source uses is declared" — a namespace it does not
  // look at breaks that promise silently, which is worse than not checking.
  recv(/\b(?:ctx|bridge)\.clipboard\./g, () => 'rpc:clipboard');
  recv(/\b(?:ctx|bridge)\.screen\./g, () => 'rpc:screen');
  // `watch` is a stream as well as a read: the `clipboard` provider requires
  // `rpc:clipboard` ON TOP of `rpc:stream`, so a caller must declare both.
  recv(/\b(?:ctx|bridge)\.clipboard\.watch\(/g, () => 'rpc:stream');

  // NOTE: `ctx.closeStream` is intentionally absent — it is ungated because it
  // can only close streams the plugin itself opened.
  // `hub.pty(...)` / `hub.sidecar(...)` in window pages go through the same gate
  recv(/\bhub\.pty\(/g, () => 'rpc:stream');
  recv(/\bhub\.sidecar\(/g, () => 'rpc:proc');
  recv(/\bhub\.request\(\s*[A-Za-z_.]+,\s*['"]([a-z]+)['"]/g, (m) => `rpc:${m[1]}`);

  return needed;
}

function registeredViews(src) {
  const ids = new Set();
  for (const m of src.matchAll(/ctx\.registerView\(\s*['"]([^'"]+)['"]/g)) ids.add(m[1]);
  return ids;
}

// ------------------------------- built-in plugins ------------------------------

test('the built-in list is read from the registry, and is not empty', () => {
  // Guards the derivation above. Every test in this section loops over BUILTIN,
  // so an empty or mis-parsed list would make them all pass while auditing
  // nothing — the exact failure the derivation exists to prevent.
  assert.ok(
    BUILTIN.length > 0,
    'no built-in modules found in src/host/registry.js — the import shape changed, ' +
      'so this whole section is now vacuous',
  );
  for (const name of BUILTIN) {
    assert.ok(existsSync(path.join(root, `src/plugins/${name}.js`)), `registry names a missing file: ${name}.js`);
  }
});

test('builtin plugins: manifests parse, ids are unique, views are declared', () => {
  const seen = new Set();
  for (const name of BUILTIN) {
    const src = collectSource(`src/plugins/${name}.js`);
    const manifest = extractManifest(read(`src/plugins/${name}.js`), name);

    assert.ok(manifest.id, `${name}: manifest.id missing`);
    assert.ok(!seen.has(manifest.id), `duplicate plugin id: ${manifest.id}`);
    seen.add(manifest.id);
    assert.match(manifest.id, /^[a-z0-9._-]+$/i, `${name}: id must pass validate_plugin_id`);
    assert.ok(manifest.name && manifest.version, `${name}: name/version missing`);
    assert.match(src, /export (async )?function activate/, `${name}: no activate() export`);
    assert.match(src, /export default/, `${name}: no default export (loader contract)`);

    const declaredViews = new Set((manifest.contributes?.views ?? []).map((v) => v.id));
    const registered = registeredViews(src);
    for (const v of registered) {
      assert.ok(
        declaredViews.has(v),
        `${name}: registers view "${v}" but contributes.views declares [${[...declaredViews].join(', ')}]`,
      );
    }
    for (const v of declaredViews) {
      assert.ok(
        registered.has(v),
        `${name}: declares view "${v}" but never calls ctx.registerView("${v}") — it would render empty`,
      );
    }
  }
});

test('builtin plugins: every capability used is declared, and declared permissions are known', () => {
  const problems = [];
  for (const name of BUILTIN) {
    const src = collectSource(`src/plugins/${name}.js`);
    const manifest = extractManifest(read(`src/plugins/${name}.js`), name);
    const declared = new Set(manifest.permissions ?? []);
    const needed = requiredPermissions(src);

    for (const perm of needed) {
      if (!declared.has(perm)) {
        problems.push(`${name}: uses ${perm} but does not declare it`);
      }
    }
    for (const perm of declared) {
      if (!KNOWN_PERMISSIONS.has(perm)) {
        problems.push(`${name}: declares unknown permission "${perm}"`);
      }
    }
  }
  assert.deepEqual(problems, [], `permission mismatches:\n  ${problems.join('\n  ')}`);
});

test('builtin plugins: the declared permission set is not silently over-broad', () => {
  // A plugin should not hold a capability it never uses: over-declaring is how
  // a permission model rots. This pins the exact set per plugin so widening it
  // is a deliberate, reviewable change.
  const expected = {
    procman: ['rpc:storage', 'rpc:stream', 'rpc:host'],
    streamlab: ['rpc:host', 'rpc:stream', 'rpc:bus', 'rpc:storage'],
  };
  for (const name of BUILTIN) {
    const manifest = extractManifest(read(`src/plugins/${name}.js`), name);
    assert.deepEqual(
      [...(manifest.permissions ?? [])].sort(),
      [...expected[name]].sort(),
      `${name}: permission set changed`,
    );
  }
});

// -------------------------------- bundled examples -----------------------------

test('example plugins: plugin.json and entry agree, and permissions cover the code', () => {
  for (const { id, dir } of EXAMPLES) {
    const manifest = JSON.parse(read(`${dir}/plugin.json`));
    assert.equal(manifest.id, id, `${dir}: plugin.json id mismatch`);
    assert.ok(manifest.entry, `${dir}: plugin.json needs an entry file`);

    const entrySrc = read(`${dir}/${manifest.entry}`);
    // the entry must exist and be a single-file ESM (no bare imports)
    assert.doesNotMatch(
      entrySrc,
      /^\s*import\s+[^'"]*from\s*['"][^./]/m,
      `${dir}: entry has a bare import, which cannot resolve from a Blob URL`,
    );
    assert.match(entrySrc, /export (async )?function activate/, `${dir}: no activate() export`);
    assert.match(entrySrc, /export default/, `${dir}: no default export`);

    const declared = new Set(manifest.permissions ?? []);
    const needed = requiredPermissions(entrySrc);
    for (const perm of needed) {
      assert.ok(declared.has(perm), `${id}: entry uses ${perm} but plugin.json does not declare it`);
    }
    for (const perm of declared) {
      assert.ok(KNOWN_PERMISSIONS.has(perm), `${id}: unknown permission "${perm}"`);
    }
  }
});

test('example plugins: plugin.json and the in-code manifest agree', () => {
  // An external plugin describes itself twice: the file the host scans and the
  // object its code exports. plugin.json is authoritative (see mergeManifest),
  // so a disagreement here would surface as a confusing "lacks permission" at
  // runtime instead of a clear failure here.
  for (const { id, dir } of EXAMPLES) {
    const declared = JSON.parse(read(`${dir}/plugin.json`));
    const inCode = extractManifest(read(`${dir}/main.js`), dir);
    assert.equal(inCode.id, declared.id, `${dir}: id differs between plugin.json and the module`);
    assert.equal(
      inCode.api,
      declared.api,
      `${dir}: host API version differs between plugin.json and the module`,
    );
    assert.deepEqual(
      [...(inCode.permissions ?? [])].sort(),
      [...(declared.permissions ?? [])].sort(),
      `${dir}: permissions differ between plugin.json and the module`,
    );
  }
});

test('example plugins: the window entry exports mountWindow, as the window host requires', () => {
  const calc = read('examples/calc-plugin/main.js');
  assert.match(calc, /export async function mountWindow/, 'calc.demo must export mountWindow(bridge)');
  // it must take the envelope constructors from the host, not hard-code the shape
  assert.match(calc, /\.protocol\b/, 'the window UI should use the host-provided protocol, not a literal');
  assert.doesNotMatch(
    calc,
    /\{\s*v:\s*1\s*,\s*kind:/,
    'the window UI hard-codes an envelope literal instead of using protocol.req/…',
  );
});

// ------------------------------- the scheme table ------------------------------

// --------------------------- dangling-reference audit ---------------------------

/**
 * Strip comments and the *text* of string/template literals, keeping `${}`
 * interpolations as code.
 *
 * Every plugin builds its UI as a big HTML template string. Without this, the
 * audit would read markup ("Run", "save as profile") as if it were code.
 *
 * Regex literals need explicit handling, and skipping them is not optional:
 * every plugin has an `esc()` whose pattern is `/[&<>"']/g`, and the `"` inside
 * it reads as the start of a string. That one character used to swallow the rest
 * of the file — so a function declared below `esc` looked undeclared while its
 * call site above it survived, and the audit reported a phantom dead call.
 * Telling a regex from division is the classic hard case; the heuristic below
 * (a `/` in expression position opens a regex) is the standard one and is
 * exactly right for the code this audit reads.
 */
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', 'return',
]);

function codeOnly(src) {
  let out = '';
  let i = 0;
  /** Last significant character emitted — decides regex vs division. */
  let prev = '\n';
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '/' && REGEX_PRECEDERS.has(prev)) {
      // A regex literal: skip to the closing slash, honouring escapes and
      // character classes (`[/]` contains a slash that does not close it).
      i += 1;
      let inClass = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        else if (ch === '\n') break; // not a regex after all; bail out safely
        i += 1;
      }
      i += 1;
      while (i < src.length && /[a-z]/.test(src[i])) i += 1; // flags
      out += ' ';
      prev = ')';
      continue;
    }
    if (c === "'" || c === '"') {
      i += 1;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += ' ';
      prev = ')';
      continue;
    }
    if (c === '`') {
      i += 1;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          i += 2;
          const start = i;
          let depth = 1;
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth += 1;
            else if (src[i] === '}') {
              depth -= 1;
              if (depth === 0) break;
            }
            i += 1;
          }
          out += ` ${codeOnly(src.slice(start, i))} `;
          i += 1;
          continue;
        }
        i += 1;
      }
      i += 1;
      out += ' ';
      prev = ')';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

/** Words that may be followed by `(` without being a function call. */
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'new',
  'do', 'else', 'in', 'of', 'case', 'delete', 'void', 'yield', 'throw', 'with',
  'function', 'super', 'this', 'async',
]);

/**
 * Every name the file defines: declarations, imports, parameters and object
 * shorthand methods. Deliberately generous — a false "declared" only makes the
 * audit weaker, while a false "undeclared" makes it cry wolf.
 */
function declaredNames(code) {
  const names = new Set(KEYWORDS);
  const add = (re, group = 1) => {
    for (const m of code.matchAll(re)) {
      if (m[group]) names.add(m[group]);
    }
  };
  add(/\bfunction\s+([A-Za-z_$][\w$]*)/g);
  add(/\bclass\s+([A-Za-z_$][\w$]*)/g);
  add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g);
  add(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g);
  // `import { a, b as c }` and `{ a, b }` destructuring both end up here
  for (const m of code.matchAll(/\{([^{}]*)\}\s*(?:from|=[^=])/g)) {
    for (const part of m[1].split(',')) {
      const name = part.includes(':') ? part.split(':').pop() : part.split(/\s+as\s+/).pop();
      const t = (name ?? '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  // parameters: function headers, arrow parameter lists, catch bindings
  for (const re of [
    /\bfunction\s*[\w$]*\s*\(([^()]*)\)/g,
    /\(\s*([^()]*?)\s*\)\s*=>/g,
    /\bcatch\s*\(([^()]*)\)/g,
  ]) {
    for (const m of code.matchAll(re)) {
      for (const part of m[1].split(',')) {
        const t = part.split('=')[0].replace(/[{}[\].]/g, ' ').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
      }
    }
  }
  add(/(?:^|[,(\s])([A-Za-z_$][\w$]*)\s*=>/g); // `x => …`
  // object shorthand methods: `{ foo() { … } }`
  add(/(?:^|[{,;])\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g);
  return names;
}

/** Bare calls — `foo(…)` but not `x.foo(…)`, which is a property access. */
function calledNames(code) {
  const calls = new Set();
  for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!KEYWORDS.has(m[2])) calls.add(m[2]);
  }
  return calls;
}

/** Things that are legitimately global in a plugin (webview + Node-ish host). */
const GLOBALS = new Set([
  // JS language
  'Object', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Promise', 'JSON', 'Math',
  'Number', 'String', 'Boolean', 'Symbol', 'BigInt', 'Proxy', 'Reflect',
  'Function', 'ArrayBuffer', 'Uint8Array', 'Int8Array', 'Uint16Array',
  'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'DataView', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams',
  'structuredClone', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'queueMicrotask', 'requestAnimationFrame',
  'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'fetch', 'atob', 'btoa', 'crypto', 'performance', 'console', 'globalThis',
  'Blob', 'File', 'FileReader', 'FormData', 'Headers', 'Request', 'Response',
  'AbortController', 'AbortSignal', 'Event', 'CustomEvent', 'EventTarget',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'DOMParser',
  'HTMLElement', 'Node', 'Element', 'NodeList', 'Image', 'Audio', 'Path2D',
  'matchMedia', 'getComputedStyle', 'alert', 'confirm', 'prompt', 'postMessage',
  'WebSocket', 'Worker', 'Notification', 'localStorage', 'sessionStorage',
  'indexedDB', 'CSS', 'Intl', 'Iterator', 'AsyncIterator', 'FinalizationRegistry',
  'WeakRef', 'AggregateError', 'SuppressedError', 'eval', 'require', 'process',
  // library / host surface that is injected, not imported
  'defineComponent', 'createApp', 'watch', 'ref', 'computed', 'onMounted', 'onUnmounted',
  'nextTick', 'reactive', 'h', 'toRaw',
]);

test('plugins: no plugin calls a function it never declares (dead call sites)', () => {
  // This is the bug class a refactor leaves behind: a helper is deleted, one
  // call site is missed, and the plugin only throws when that button is
  // clicked. It is a static property, so it is checked statically.
  const offenders = [];
  for (const rel of [
    ...BUILTIN.map((n) => `src/plugins/${n}.js`),
    ...EXAMPLES.map((e) => `${e.dir}/main.js`),
  ]) {
    const code = codeOnly(read(rel));
    const declared = declaredNames(code);
    for (const name of calledNames(code)) {
      if (!declared.has(name) && !GLOBALS.has(name)) offenders.push(`${rel}: ${name}()`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `calls with no matching declaration (deleted helper? typo?):\n  ${offenders.join('\n  ')}`,
  );
});

// ------------------------------ theming invariants ------------------------------

/**
 * Where the design system lives.
 *
 * The tokens and the `.tb-*` vocabulary are in ONE file, and both stylesheet
 * entries import it: `app.css` for the shell, `plugin.css` for a plugin window.
 * That is what keeps the two windows from disagreeing about what a token means,
 * and it is why every check below reads this file rather than either entry —
 * an entry is a list of imports, not a place where the design system is defined.
 */
const DESIGN_SYSTEM = 'src/assets/design-system.css';

test('theming: both stylesheet entries import the one design system', () => {
  for (const entry of ['src/assets/app.css', 'src/assets/plugin.css']) {
    assert.match(
      read(entry),
      /@import '\.\/design-system\.css'/,
      `${entry} must import the shared design system`,
    );
    // And may not carry its own copy of it. A second `:root` or `@theme` block in
    // an entry is exactly how the two windows would start disagreeing — silently,
    // because both would still render.
    assert.doesNotMatch(read(entry), /^:root|^@theme|^@layer components/m, `${entry} must not define tokens or .tb-* itself`);
  }
});

test('theming: every .tb-* class a plugin uses actually exists in the stylesheet', () => {
  // The design system is class-based precisely so Blob-URL plugins can use it.
  // The cost of that choice is that a typo'd class name fails SILENTLY — the
  // element simply renders unstyled. This is the check that makes the trade
  // safe.
  const css = read(DESIGN_SYSTEM);
  const defined = new Set([...css.matchAll(/\.(tb-[a-z0-9-]+)/gi)].map((m) => m[1]));

  const files = [
    ...BUILTIN.map((n) => `src/plugins/${n}.js`),
    'src/App.vue',
    'src/views/SettingsView.vue',
  ];
  const unknown = new Set();
  for (const rel of files) {
    for (const m of read(rel).matchAll(/\btb-[a-z0-9-]+/gi)) {
      if (!defined.has(m[0])) unknown.add(`${rel}: ${m[0]}`);
    }
  }
  assert.deepEqual([...unknown], [], `classes with no definition in ${DESIGN_SYSTEM}:\n  ${[...unknown].join('\n  ')}`);
});

/**
 * The theme layer has three parts, and the failure mode this guards against is
 * specific to that shape:
 *
 *   :root / :root[data-theme='light']   raw values, one block per theme
 *   @theme inline                       aliases: --color-x: var(--raw)
 *
 * A colour token is a `var()` reference to a raw variable. Two things can go
 * wrong silently:
 *
 *   1. The alias points at a raw variable that does not exist — the token
 *      resolves to nothing and every surface using it renders transparent/black.
 *   2. The raw variable is defined for one theme only — that token keeps its
 *      dark value in the light theme, so exactly one element looks wrong.
 *
 * Both are checked here. Note this got STRONGER when the layer was introduced:
 * the old version compared two lists of names, which could not tell a typo in a
 * variable reference from a missing override.
 */
function readThemeBlocks() {
  const css = read(DESIGN_SYSTEM);
  const block = (startRe) => {
    const m = css.match(startRe);
    assert.ok(m, `${DESIGN_SYSTEM}: block not found (${startRe})`);
    const open = css.indexOf('{', m.index);
    let depth = 0;
    let i = open;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    return css.slice(open + 1, i);
  };
  const decls = (body) => {
    const out = new Map();
    for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out.set(m[1], m[2].trim());
    return out;
  };
  return {
    // `:root { … }` — anchored so it does not also match `:root[data-theme=…]`
    dark: decls(block(/^:root\s*\{/m)),
    light: decls(block(/^:root\[data-theme='light'\]\s*\{/m)),
    aliases: decls(block(/@theme\s+inline\s*\{/)),
  };
}

test('theming: every colour alias resolves to a raw variable defined in both themes', () => {
  const { dark, light, aliases } = readThemeBlocks();

  const colors = [...aliases.keys()].filter((n) => n.startsWith('--color-'));
  assert.ok(colors.length >= 20, 'expected a real colour palette in @theme inline');

  // One list, not two assertions: a second `assert.deepEqual` after a failing
  // first never runs, so a single typo would mask every missing theme override
  // in the same run. Reporting them together is the difference between one
  // build round-trip and three.
  const problems = [];
  for (const name of colors) {
    const value = aliases.get(name);
    const target = value.match(/^var\((--[a-z0-9-]+)\)$/i)?.[1];
    if (!target) {
      problems.push(`${name}: ${value} is not a var() alias`);
      continue;
    }
    if (!dark.has(target)) problems.push(`${name} -> ${target}, which :root does not define`);
    else if (!light.has(target)) problems.push(`${name} -> ${target}, missing from the light theme`);
  }

  assert.deepEqual(
    problems,
    [],
    `colour aliases that do not resolve in both themes:\n  ${problems.join('\n  ')}`,
  );
});

test('theming: every variable a utility resolves to holds a value, not another alias', () => {
  // This is the invariant that makes overrides WORK, and it is easy to get
  // backwards. A utility compiles to `var(<canonical name>)`. So if the
  // canonical name is itself `var(--something-else)`, overriding it does
  // nothing: the class looks override-able and silently is not.
  //
  // That was a real bug here. With the project's names canonical,
  // `--color-primary` resolved to `var(--brand)`, so `bg-primary` became
  // `var(--brand)` — and a plugin setting `--primary` (as every shadcn doc
  // says to) changed no colour at all. The fix is that shadcn's names hold the
  // values and the project's names are the aliases; this test keeps it that way.
  const { dark, aliases } = readThemeBlocks();
  const problems = [];
  const targets = new Set();
  for (const value of aliases.values()) {
    const t = value.match(/^var\((--[a-z0-9-]+)\)$/i)?.[1];
    if (t) targets.add(t);
  }
  assert.ok(targets.size >= 20, 'expected the aliases to resolve to a real token set');

  for (const name of targets) {
    const value = dark.get(name);
    if (value === undefined) {
      problems.push(`${name} is referenced by @theme but not defined in :root`);
      continue;
    }
    if (/^var\(/i.test(value)) {
      problems.push(`${name} is itself an alias (${value}) — overriding it would change nothing`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    `tokens that a utility cannot actually be overridden through:\n  ${problems.join('\n  ')}`,
  );
});

test('theming: the two vocabularies cover the same raw variables', () => {
  // The project vocabulary (`--color-brand`) and the shadcn vocabulary
  // (`--color-primary`) must resolve to the SAME canonical variable, not to two
  // copies. If someone "fixes" a colour by editing one side to a literal, the
  // two drift and the app ends up with two blues.
  const { aliases } = readThemeBlocks();
  const pairs = [
    ['--color-brand', '--color-primary'],
    ['--color-brand-ink', '--color-primary-foreground'],
    ['--color-canvas', '--color-background'],
    ['--color-surface', '--color-card'],
    ['--color-surface-2', '--color-secondary'],
    ['--color-ink', '--color-foreground'],
    ['--color-ink-muted', '--color-muted-foreground'],
    ['--color-line', '--color-border'],
    ['--color-danger', '--color-destructive'],
  ];
  const drift = [];
  for (const [a, b] of pairs) {
    assert.ok(aliases.has(a), `${a} is missing`);
    assert.ok(aliases.has(b), `${b} is missing`);
    if (aliases.get(a) !== aliases.get(b)) {
      drift.push(`${a} = ${aliases.get(a)}  but  ${b} = ${aliases.get(b)}`);
    }
  }
  assert.deepEqual(drift, [], `the two vocabularies have drifted apart:\n  ${drift.join('\n  ')}`);
});

test('theming: tokens that share a role stay in sync within a theme', () => {
  // Several shadcn tokens describe the SAME visual role in this app: it has one
  // raised surface, not three, so `--card`, `--popover`, `--secondary`,
  // `--muted` and `--accent` are all the same colour.
  //
  // They are deliberately SEPARATE variables rather than aliases, because a
  // token a utility resolves to must hold its own value or overriding it does
  // nothing (see the test above). The cost of that choice is duplicated values,
  // and the risk is drift: edit `--card` and the app quietly grows a second
  // surface colour. This pins the intent. A plugin may still override any ONE
  // of them — that is the point of them being separate.
  //
  // `--border` and `--input` are deliberately NOT in this list. They were, and
  // pinning them together is what forced one line to serve two opposite roles
  // (region divider vs control outline). See the note in app.css.
  const { dark, light } = readThemeBlocks();
  const groups = [
    ['--card', '--popover'],
    ['--foreground', '--card-foreground', '--secondary-foreground', '--accent-foreground'],
    ['--secondary', '--muted', '--accent'],
    ['--primary', '--ring'],
  ];
  const drift = [];
  for (const [themeName, block] of [['dark', dark], ['light', light]]) {
    for (const group of groups) {
      const values = group.map((n) => [n, block.get(n)]);
      const missing = values.filter(([, v]) => v === undefined).map(([n]) => n);
      if (missing.length) {
        drift.push(`${themeName}: ${missing.join(', ')} not defined`);
        continue;
      }
      const first = values[0][1];
      for (const [n, v] of values) {
        if (v !== first) drift.push(`${themeName}: ${n} = ${v} but ${group[0]} = ${first}`);
      }
    }
  }
  assert.deepEqual(drift, [], `roles that should be one colour have drifted:\n  ${drift.join('\n  ')}`);
});

test('layout: the main scroll container is also a containing block', () => {
  // `overflow-auto` alone does not clip absolutely-positioned descendants — per
  // spec a scroller clips them only if it is ALSO their containing block, which
  // needs `position` to be non-static. Without `relative`, any `position:
  // absolute` element a plugin view renders escapes the box and grows the
  // DOCUMENT instead, which gives two scrollbars and a page that scrolls out
  // from under the sidebar.
  //
  // Measured in the running app before the fix: document scrollHeight 4830 in a
  // 720px viewport, sidebar pushed 300px off the top. After: 720, sidebar at 0.
  const app = read('src/App.vue');
  const main = app.match(/<main\s+class="([^"]+)"/);
  assert.ok(main, 'App.vue has no <main class="…">');
  const cls = main[1];
  assert.ok(cls.includes('overflow-auto'), '<main> must still scroll');
  assert.ok(
    cls.includes('relative'),
    '<main> has overflow-auto but no `relative` — absolute descendants will escape it',
  );
});

test('theming: the dark: variant is redirected to data-theme, not the OS', () => {
  // shadcn-vue components carry `dark:` classes. Tailwind's default `dark:`
  // follows `prefers-color-scheme`, so without this redirect the app's own
  // theme setting would be ignored by every component — and it would look
  // right to anyone whose OS happened to match.
  const css = read(DESIGN_SYSTEM);
  const m = css.match(/@custom-variant\s+dark\s*\(([^)]*)\)/);
  assert.ok(m, `${DESIGN_SYSTEM}: no @custom-variant dark declaration`);
  assert.match(m[1], /data-theme/, 'the dark variant must key off data-theme');
  assert.doesNotMatch(m[1], /prefers-color-scheme/, 'the dark variant must not follow the OS');
});

test('theming: no plugin hard-codes a colour', () => {
  // A hex literal in a plugin is a colour that cannot follow the theme. The one
  // legitimate case is the fallback argument of the token reader, because xterm
  // is a canvas and needs a concrete value — so that form is stripped first.
  const offenders = [];
  for (const rel of BUILTIN.map((n) => `src/plugins/${n}.js`)) {
    const src = read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      // tok('--color-x', '#fallback') is allowed
      .replace(/\w+\(\s*'--[a-z0-9-]+'\s*,\s*'#[0-9a-f]{3,8}'\s*\)/gi, 'TOKEN()');
    for (const m of src.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
      offenders.push(`${rel}: ${m[0]}`);
    }
    for (const m of src.matchAll(/\b(?:rgba?|hsla?)\(/g)) {
      offenders.push(`${rel}: ${m[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `colours that cannot follow the theme (use var(--color-…) or a .tb-* class):\n  ${offenders.join('\n  ')}`,
  );
});

// ------------------------- the component-factory vocabulary ---------------------

// The kit loads `.vue`/`.ts` files and a Vite `import.meta.glob`; the stub loader
// fakes the rendering while keeping every export NAME real, so the vocabulary
// this test checks against is the real one.
register('./browser-stubs-loader.mjs', import.meta.url);
const { loadUiKit, uiKitVocabulary } = await import('../src/host/ui.js');
await loadUiKit();

/**
 * Tags a plugin names, with comments stripped but STRING LITERALS KEPT.
 *
 * `codeOnly` is the wrong tool here and using it made this audit pass vacuously:
 * it blanks every string literal, and the tag name IS a string literal, so
 * `el('card', …)` became `el( , …)` and the audit found zero tags. A guard that
 * matches nothing is worse than no guard — it reports success forever.
 */
function withoutComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function tagsUsedBy(src) {
  const code = withoutComments(src);
  const tags = new Set();
  for (const m of code.matchAll(/\b(?:el|native)\(\s*'([^']+)'/g)) tags.add(m[1]);
  return tags;
}

// Same allow-list the factory uses, so this test and the runtime agree on what
// "a plain element" means. A shape test here (`/^[a-z]+$/`) would have skipped
// every dash-free typo, which is exactly the case worth catching.
const HTML_TAGS = new Set(
  (
    'a abbr address area article aside audio b bdi bdo blockquote br button canvas caption cite code col ' +
    'colgroup data datalist dd del details dfn div dl dt em embed fieldset figcaption figure footer form ' +
    'h1 h2 h3 h4 h5 h6 header hgroup hr i iframe img input ins kbd label legend li main map mark menu meter ' +
    'nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp search section ' +
    'select slot small source span strong sub summary sup table tbody td tfoot th thead time tr track u ul var video wbr'
  ).split(' '),
);

test('factory: every tag a built-in plugin names exists', () => {
  // The factory throws on an unknown tag, which is the right runtime behaviour —
  // but only when that view renders. A typo in a rarely-opened view would sit
  // there until someone opened it, so it is checked statically instead.
  const vocabulary = new Set(uiKitVocabulary());
  assert.ok(vocabulary.size >= 20, 'the component vocabulary did not load');

  const problems = [];
  const seen = new Set();
  // Examples too, not just built-ins: the gallery is the reference for what a
  // drop-in plugin can build, and a wrong tag there is the most misleading kind
  // of error — it is the file people copy from.
  const files = [
    ...BUILTIN.map((n) => `src/plugins/${n}.js`),
    ...EXAMPLES.map((e) => `${e.dir}/main.js`),
  ];
  for (const file of files) {
    const src = read(file);
    for (const tag of tagsUsedBy(src)) {
      seen.add(tag);
      if (vocabulary.has(tag)) continue;
      if (HTML_TAGS.has(tag)) continue; // a plain element, which the factory allows
      problems.push(`${file}: el('${tag}') is neither a component nor a plain element`);
    }
  }
  // A guard that extracts nothing reports success forever. (This one DID, for a
  // while: the extractor ran `codeOnly` first, which blanks string literals —
  // and a tag name is a string literal.)
  assert.ok(seen.size >= 10, `the extractor found only ${seen.size} tag(s) — it is not working`);
  assert.deepEqual(problems, [], `tags the factory would reject:\n  ${problems.join('\n  ')}`);
});

test("factory: el('form') is never what a plugin wants — use native('form')", () => {
  // The vocabulary shadows HTML tag names. For most of them the component IS the
  // element (Input renders an <input>, Table a <table>), so `el('input')` is
  // right. `form` is the exception: `el('form')` is upstream's Form component, a
  // validation wrapper whose submit event is NOT native — so `ev.preventDefault`
  // is undefined and the handler throws. That bit for real, and it only showed up
  // when the form was actually submitted.
  //
  // `select` is deliberately NOT in this list. It is a genuine judgement call:
  // `el('select')` is the styled Select (a button + popover) and is usually what
  // you want; `native('select')` is for a real form control that `FormData`
  // reads. Both are correct in different places, so a blanket rule would be wrong.
  const offenders = [];
  const files = [
    ...BUILTIN.map((n) => `src/plugins/${n}.js`),
    ...EXAMPLES.map((e) => `${e.dir}/main.js`),
  ];
  for (const file of files) {
    const code = withoutComments(read(file));
    if (/\bel\(\s*'form'/.test(code)) {
      offenders.push(`${file}: el('form') is the Form component; use native('form')`);
    }
  }
  assert.deepEqual(offenders, [], `ambiguous tag used as a component:\n  ${offenders.join('\n  ')}`);
});

test('factory: built-in plugin views are built through the factory, not innerHTML', () => {
  // This is the invariant behind "main-window content is rendered with the
  // component library". An `innerHTML =` assignment bypasses the factory, and
  // because it is invisible to every other check it is exactly the kind of thing
  // a later edit reintroduces. (Passing `innerHTML` as a PROP is fine — that goes
  // through Vue, which sanitises and escapes on its own terms.)
  //
  // No exception list. The first version of this test carried one for
  // `floatwin-widget.js` (a plugin's own WINDOW — a separate document that
  // builds its own DOM), and an assertion about the list being non-empty caught
  // that it was dead code. That file is gone now, and the list stayed empty.
  const offenders = [];
  for (const name of BUILTIN) {
    const file = `src/plugins/${name}.js`;
    const code = codeOnly(read(file));
    // Any `.innerHTML =` — the receiver may be `querySelector('…')`, not just a
    // bare name. An earlier version required an identifier immediately before
    // the dot, so it silently missed `root.querySelector('.x').innerHTML = …`
    // and reported success on code that plainly violated the rule.
    for (const m of code.matchAll(/\.\s*innerHTML\s*=/g)) {
      const line = code.slice(0, m.index).split('\n').length;
      offenders.push(`${file}:${line}: .innerHTML = …`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `main-window DOM built outside the component factory:\n  ${offenders.join('\n  ')}`,
  );
});

test('plugins: no plugin hard-codes a transport command instead of a scheme', () => {
  // A plugin reaching for invoke()/a raw Channel would bypass the permission
  // gate and the scheme table — exactly what the unified protocol exists to
  // prevent. Only the protocol layer itself (and the host's own window page
  // pluginwin-host.js, which runs outside the plugin host and has no ctx) may
  // do that.
  const offenders = [];
  for (const rel of [
    ...BUILTIN.map((n) => `src/plugins/${n}.js`),
    ...EXAMPLES.map((e) => `${e.dir}/main.js`),
  ]) {
    const src = read(rel);
    if (/\binvoke\(/.test(src)) offenders.push(`${rel}: calls invoke() directly`);
    if (/new Channel\(/.test(src)) offenders.push(`${rel}: constructs a Channel directly`);
    if (/from\s+['"]@tauri-apps/.test(src)) offenders.push(`${rel}: imports a Tauri API`);
  }
  assert.deepEqual(offenders, [], `plugins must go through the hub:\n  ${offenders.join('\n  ')}`);
});

test('layout: each view gets its OWN container, so a stale redraw cannot leak', () => {
  // A plugin that redraws on its own schedule (a log panel appending a line)
  // keeps a reference to the element it was handed. With a SHARED container
  // that reference stays live after the user switches away, so the next redraw
  // writes into the container now owned by a different plugin — the view the
  // user is looking at gets replaced by the one they left, which reads as
  // "the app jumped back to that page".
  //
  // The fix is a keyed element: Vue discards the old node, so a stale reference
  // points at something detached and the write is invisible. No plugin has to
  // know it was unmounted, which matters because there is no such notification.
  const src = read('src/components/ViewHost.vue');
  assert.match(src, /:key="viewId"/, 'the container must be keyed by viewId');
  assert.match(
    src,
    /await nextTick\(\)/,
    'and the watcher must wait for the swap before rendering into the new element',
  );
});
