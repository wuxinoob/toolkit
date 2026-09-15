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
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

const BUILTIN = ['notepad', 'eyecare', 'procman', 'streamlab', 'floatwin'];
const EXAMPLES = [
  { id: 'hello.demo', dir: 'examples/plugins/hello' },
  { id: 'calc.demo', dir: 'examples/calc-plugin' },
  { id: 'probe.demo', dir: 'examples/plugins/probe' },
];

/** The permission vocabulary the host understands. */
const KNOWN_PERMISSIONS = new Set([
  'rpc:storage',
  'rpc:host',
  'rpc:proc',
  'rpc:stream',
  'rpc:bus',
  'rpc:hotkey',
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

test('builtin plugins: manifests parse, ids are unique, views are declared', () => {
  const seen = new Set();
  for (const name of BUILTIN) {
    const src = read(`src/plugins/${name}.js`);
    const manifest = extractManifest(src, name);

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
    const src = read(`src/plugins/${name}.js`);
    const manifest = extractManifest(src, name);
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
    notepad: ['rpc:storage', 'rpc:bus'],
    eyecare: ['rpc:storage'],
    procman: ['rpc:storage', 'rpc:stream', 'rpc:host'],
    streamlab: ['rpc:host', 'rpc:stream', 'rpc:bus', 'rpc:storage'],
    floatwin: ['rpc:storage', 'rpc:bus', 'win:manage'],
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

test('plugins: no plugin hard-codes a transport command instead of a scheme', () => {
  // A plugin reaching for invoke()/a raw Channel would bypass the permission
  // gate and the scheme table — exactly what the unified protocol exists to
  // prevent. Only the protocol layer itself (and the host's own window pages
  // floatwin-widget.js / pluginwin-host.js, which run outside the plugin host
  // and have no ctx) may do that.
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
