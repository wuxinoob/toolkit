/**
 * Doc-sync guards for the plugin-facing documentation.
 *
 * The repo already had two guards of this shape — `hygiene.test.mjs` counts the
 * native commands named in `docs/INTERFACES.md`, and `codes.test.mjs` compares
 * the Rust and JS error-code lists. The plugin manual was the one body of docs
 * with NO guard, and it had drifted: the overview still advertised
 * "8 个原生命令 / 6 服务 29 动作" while the code had 13 / 9 / 35, and three
 * pages still measured "九个内置插件" as if the built-in set had not been cut
 * to two.
 *
 * The rule these guards implement is the one written down in
 * `docs/plugin-dev/MAINTENANCE.md`: **a fact a machine can read must not be
 * maintained by hand in prose.** Each test below reads the fact from the code
 * and asserts the doc agrees, so "the doc is stale" becomes a red test rather
 * than something a reader discovers a year later.
 *
 * Deliberately NOT checked here: parameter shapes, `ctx` method-by-method
 * prose, and anything else that is neither enumerable nor derivable. Those are
 * the human half of the docs (see MAINTENANCE.md) — a guard that tried to read
 * them would only pin the wording, which is not the property that matters.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');

/** The brace-balanced block that follows `marker` (which ends at an `{`). */
function blockAt(text, marker) {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, `could not find ${JSON.stringify(marker)} — the extraction is stale`);
  const open = at + marker.length - 1;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${JSON.stringify(marker)}`);
}

/**
 * One `## `-delimited section of a doc.
 *
 * Scoping matters more than it looks: a page like `bridge.md` has several
 * tables, and only ONE of them is the enumeration. Reading the whole file would
 * fold the prose tables in and make the expected sets impossible to reason
 * about — so every table reader below goes through here.
 */
function docSection(rel, heading) {
  const doc = read(...rel.split('/'));
  const at = doc.indexOf(heading);
  assert.ok(at >= 0, `${rel} no longer has a "${heading}" section`);
  const rest = doc.slice(at + heading.length);
  const end = rest.indexOf('\n## ');
  return end >= 0 ? rest.slice(0, end) : rest;
}

// ---------------------------------------------------------------------------
// extractors — each one reads a fact out of the CODE, never out of a doc
// ---------------------------------------------------------------------------

/** Every `.rs` under `src-tauri/src/services`. */
function serviceSources() {
  const dir = path.join(root, 'src-tauri', 'src', 'services');
  return readdirSync(dir)
    .filter((n) => n.endsWith('.rs'))
    .map((n) => path.join(dir, n));
}

/**
 * The authoritative service table: `impl Service for X` -> `name()` + `actions()`.
 *
 * Split on the `impl Service for` header rather than scanning the whole file,
 * because `stream.rs` also implements `StreamProvider` — whose `name()` is
 * `"ticker"`, not a service. A file-wide scan would quietly add a phantom
 * service and the guard would then demand the doc list it.
 */
function serviceTable() {
  const out = new Map();
  for (const file of serviceSources()) {
    const text = readFileSync(file, 'utf8');
    for (const chunk of text.split(/^impl Service for /m).slice(1)) {
      const name = chunk.match(/fn name\(&self\)\s*->\s*&'static str\s*\{\s*"([a-z_]+)"/);
      const actions = chunk.match(
        /fn actions\(&self\)\s*->\s*&'static \[&'static str\]\s*\{\s*&\[([\s\S]*?)\]/,
      );
      if (!name || !actions) continue;
      out.set(name[1], [...actions[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
    }
  }
  return out;
}

/** The scheme ids declared in `src/protocol/registry.js`. */
function schemeIds() {
  const text = read('src', 'protocol', 'registry.js');
  const block = text.slice(text.indexOf('export const DESCRIPTORS'), text.indexOf('const BY_ID'));
  return [...block.matchAll(/^\s{4}id: '([a-z-]+)',/gm)].map((m) => m[1]);
}

/** The built-in plugin ids, resolved from the modules the registry imports. */
function builtinIds() {
  const text = read('src', 'host', 'registry.js');
  const ids = [];
  for (const m of text.matchAll(/from '\.\.\/plugins\/([a-z0-9_-]+)\.js'/g)) {
    const mod = read('src', 'plugins', `${m[1]}.js`);
    const id = mod.match(/^\s{2}id: '([^']+)'/m);
    assert.ok(id, `could not read the manifest id out of src/plugins/${m[1]}.js`);
    ids.push(id[1]);
  }
  return ids;
}

/** The in-app selftest case ids. */
function selftestIds() {
  return [...read('src', 'core', 'selftest.js').matchAll(/'(t\d\d-[a-z0-9-]+)'/g)].map((m) => m[1]);
}

/** Every permission literal the JS side can gate on, across both windows. */
function jsGatedPermissions() {
  const found = new Set();
  for (const rel of ['src/host/ctx.js', 'src/host/pluginwin-host.js']) {
    const text = read(...rel.split('/'));
    for (const m of text.matchAll(/'(rpc:[a-z_]+|win:manage)'/g)) found.add(m[1]);
    // The bridge helper spells its gate as `gate('svc', …)` rather than a
    // literal permission, so it needs its own pattern.
    for (const m of text.matchAll(/\bgate\('([a-z_]+)'/g)) found.add(`rpc:${m[1]}`);
  }
  return found;
}

/**
 * The capabilities the MAIN window exposes: the `ctx` object literal, plus the
 * methods bolted on afterwards (`ctx.cleanup`).
 */
function ctxCapabilities() {
  const text = read('src', 'host', 'ctx.js');
  const open = text.indexOf('  const ctx = {');
  const close = text.indexOf('\n  // `ctx.onSettingsChanged`');
  assert.ok(open >= 0 && close > open, 'could not bracket the ctx object literal in ctx.js (the extraction is stale)');
  const literal = text.slice(open, close);
  // `[,:]` — `id` and `manifest` are shorthand, exactly as on the bridge. Demanding
  // a colon here is what made `pluginId` look window-only.
  const keys = new Set([...literal.matchAll(/^\s{4}([A-Za-z_]\w*)\s*[,:]/gm)].map((m) => m[1]));
  // Methods bolted on after the literal (`ctx.cleanup = …`) are part of the
  // surface too, so the scan is not limited to the object body.
  for (const m of text.matchAll(/^\s*ctx\.([A-Za-z_]\w*)\s*=/gm)) keys.add(m[1]);
  return keys;
}

/** The capabilities a plugin's OWN window exposes (the `bridge` object). */
function bridgeCapabilities() {
  const text = read('src', 'host', 'pluginwin-host.js');
  const from = text.indexOf('export function makeBridge');
  const to = text.indexOf('export async function mountPluginWindow');
  assert.ok(from >= 0 && to > from, 'could not bracket makeBridge() in pluginwin-host.js (the extraction is stale)');
  const fn = text.slice(from, to);
  const at = fn.lastIndexOf('\n  return {');
  assert.ok(at >= 0, 'could not find the object makeBridge() returns (the extraction is stale)');
  const literal = fn.slice(at);
  // `[,:]`, not `:` — `pluginId`, `label` and `manifest` are shorthand
  // properties, and demanding a colon silently dropped three capabilities from
  // the bridge's surface (which made an earlier version of these guards pass
  // while missing the very fields they exist to compare).
  return new Set([...literal.matchAll(/^\s{4}([A-Za-z_]\w*)\s*[,:]/gm)].map((m) => m[1]));
}

/**
 * Every member of `ctx.ui`, which is assembled from two places: the `ui: { … }`
 * block in ctx.js, and the object `createUiKit()` returns (spread into it).
 * Reading only one of them silently loses half the namespace.
 */
function uiNamespace() {
  const ui = read('src', 'host', 'ui.js');
  assert.ok(ui.includes('export function createUiKit'), 'createUiKit() is gone from ui.js');
  // The factory builds `const kit = …` and returns it, so the object literal is
  // the surface — not whatever `return` happens to look like.
  const kitBlock = blockAt(ui, '  const kit = {');
  const kit = new Set([...kitBlock.matchAll(/^\s{4}([A-Za-z_]\w*)\s*[,:]/gm)].map((m) => m[1]));
  assert.ok(kit.size >= 5, `createUiKit() extraction found only ${kit.size} members: ${[...kit]}`);

  const ctx = read('src', 'host', 'ctx.js');
  const block = blockAt(ctx, '    ui: {');
  const own = new Set([...block.matchAll(/^\s{6}([A-Za-z_]\w*)\s*[,:]/gm)].map((m) => m[1]));
  assert.ok(own.size >= 3, `ctx.ui extraction found only ${own.size} members: ${[...own]}`);

  return new Set([...kit, ...own]);
}

/**
 * A row of the `ctx` vs `bridge` table in api.md.
 *
 * The first cell is a group of backticked names (`stream` / `streamRaw`), the
 * third says whether the plugin-window bridge has them. Dotted and called forms
 * (`windows.create`, `drag()`) reduce to their head, which is the capability.
 */
function parseParityRow(line) {
  const cells = line.split('|');
  if (cells.length < 5) return null;
  const bridge = cells[3];
  if (!/✅|❌|⚠️/.test(bridge)) return null;
  const names = [...cells[1].matchAll(/`([^`]+)`/g)].map((m) =>
    m[1].split(/[.(]/)[0].trim(),
  );
  if (!names.length) return null;
  return { names, ctxUsable: !/❌/.test(cells[2]), bridgeUsable: !/❌/.test(bridge) };
}

/**
 * Two names for one capability. The comparison normalises them, so the
 * asymmetry it reports is the real one rather than a spelling difference.
 */
const ALIAS = { id: 'pluginId', rpc: 'request' };
const norm = (n) => ALIAS[n] ?? n;

/** The single authoritative parity table, as `bridge.md` declares it. */
function documentedParity() {
  const section = docSection('docs/plugin-dev/bridge.md', '## 1. 完整矩阵');

  const available = new Set();
  const absent = new Set();
  const ctxAbsent = new Set();
  let rows = 0;
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const row = parseParityRow(line);
    if (!row) continue;
    rows += 1;
    for (const n of row.names) {
      const key = norm(n);
      (row.bridgeUsable ? available : absent).add(key);
      if (!row.ctxUsable) ctxAbsent.add(key);
    }
  }
  assert.ok(rows >= 20, `parsed only ${rows} parity rows out of bridge.md`);
  return { available, absent, ctxAbsent };
}

// ---------------------------------------------------------------------------
// the extractors have to be able to fail, or every guard below is vacuous
// ---------------------------------------------------------------------------

test('the service extractor finds the real table, and not the stream providers', () => {
  const table = serviceTable();
  assert.ok(table.size >= 9, `extracted only ${table.size} services: ${[...table.keys()]}`);
  const total = [...table.values()].reduce((n, a) => n + a.length, 0);
  assert.ok(total >= 30, `extracted only ${total} actions`);
  // The phantom this parser exists to avoid.
  assert.ok(!table.has('ticker'), 'ticker is a StreamProvider, not a Service');
  assert.ok(!table.has('blob'), 'blob is a StreamProvider, not a Service');
  assert.deepEqual(table.get('bus'), ['publish']);
});

test('the scheme extractor finds all eight, and the registry owns the list', () => {
  const ids = schemeIds();
  assert.equal(ids.length, 8, `expected 8 schemes, extracted ${ids.length}: ${ids}`);
  assert.ok(ids.includes('channel-in'), 'channel-in is missing from the registry scan');
  assert.equal(new Set(ids).size, ids.length, 'a scheme id is declared twice');
});

test('the permission extractor reads both gate styles', () => {
  const perms = jsGatedPermissions();
  assert.ok(perms.has('rpc:stream'), 'missed the ctx gate for streams');
  assert.ok(perms.has('win:manage'), 'missed the window gate');
  assert.ok(perms.has('rpc:dialog'), 'missed the dialog gate');
  assert.ok(perms.size >= 8, `only found ${perms.size}: ${[...perms]}`);
});

// ---------------------------------------------------------------------------
// the guards
// ---------------------------------------------------------------------------

test('INTERFACES.md §2 lists every service with every action it declares', () => {
  const doc = read('docs', 'INTERFACES.md');
  const section = doc.slice(doc.indexOf('## 2.'), doc.indexOf('## 3.'));
  const rows = new Map();
  for (const m of section.matchAll(/^\|\s*`([a-z_]+)`\s*\|([^|]*)\|/gm)) {
    rows.set(m[1], [...m[2].matchAll(/`([a-z_]+)`/g)].map((x) => x[1]));
  }

  const problems = [];
  for (const [svc, actions] of serviceTable()) {
    const listed = rows.get(svc);
    if (!listed) {
      problems.push(`${svc}: no row in §2`);
      continue;
    }
    for (const a of actions) {
      if (!listed.includes(a)) problems.push(`${svc}: action \`${a}\` is not in the row`);
    }
    for (const a of listed) {
      if (!actions.includes(a)) problems.push(`${svc}: row documents \`${a}\`, which the code rejects`);
    }
  }
  assert.deepEqual(problems, [], `docs/INTERFACES.md §2 is out of step with Service::actions():\n  ${problems.join('\n  ')}`);
});

test('INTERFACES.md states the service and action counts it actually lists', () => {
  const table = serviceTable();
  const services = table.size;
  const actions = [...table.values()].reduce((n, a) => n + a.length, 0);
  const doc = read('docs', 'INTERFACES.md');
  assert.match(
    doc,
    new RegExp(`${services} 个服务 / ${actions} 个动作`),
    `INTERFACES.md must say "${services} 个服务 / ${actions} 个动作" (the code has exactly that)`,
  );
});

test('the plugin manual documents exactly the permissions the code can gate', () => {
  const documented = new Set(
    [...read('docs', 'plugin-dev', 'manifest.md').matchAll(/`(rpc:[a-z_]+|win:manage)`/g)].map(
      (m) => m[1],
    ),
  );
  const expected = new Set([...serviceTable().keys()].map((s) => `rpc:${s}`));
  expected.add('rpc:dialog'); // a raw command, deliberately not a gateway service
  expected.add('win:manage'); // window control, likewise outside the envelope

  const gated = jsGatedPermissions();
  const undocumented = [...gated].filter((p) => !documented.has(p));
  const invented = [...documented].filter((p) => !expected.has(p));
  const unlisted = [...expected].filter((p) => !documented.has(p));

  assert.deepEqual(
    { undocumented, invented, unlisted },
    { undocumented: [], invented: [], unlisted: [] },
    'docs/plugin-dev/manifest.md and the code disagree about the permission set.\n' +
      '  a permission the code gates but the doc omits:\n' +
      `    ${undocumented.join('\n    ') || '(none)'}\n` +
      '  a permission the doc lists but the code cannot produce (a stale row):\n' +
      `    ${invented.join('\n    ') || '(none)'}\n` +
      '  a service with no documented permission:\n' +
      `    ${unlisted.join('\n    ') || '(none)'}`,
  );
});

test('every scheme in the registry is named in the protocol and architecture docs', () => {
  const ids = schemeIds();
  const docs = {
    'docs/PROTOCOL.md': read('docs', 'PROTOCOL.md'),
    'docs/plugin-dev/architecture.md': read('docs', 'plugin-dev', 'architecture.md'),
    'README.md': read('README.md'),
    'docs/INTERFACES.md': read('docs', 'INTERFACES.md'),
  };
  for (const [rel, text] of Object.entries(docs)) {
    const missing = ids.filter((id) => !text.includes(id));
    assert.deepEqual(missing, [], `${rel} never mentions the scheme(s): ${missing.join(', ')}`);
  }
  assert.match(
    docs['docs/INTERFACES.md'],
    new RegExp(`## 3\\. 方案表：${ids.length} 个方案`),
    `INTERFACES.md §3 must say "${ids.length} 个方案"`,
  );
  assert.match(
    docs['docs/PROTOCOL.md'],
    new RegExp(`One envelope, ${ids.length} schemes`),
    `PROTOCOL.md's opening line must say "${ids.length} schemes"`,
  );
});

test('the docs name the built-in plugins that actually ship, and no others', () => {
  const ids = builtinIds();
  assert.ok(ids.length >= 1, 'no built-in plugin was found in src/host/registry.js');

  for (const rel of ['README.md', 'docs/plugin-dev/architecture.md']) {
    const text = read(...rel.split('/'));
    const missing = ids.filter((id) => !text.includes(`\`${id}\``));
    assert.deepEqual(missing, [], `${rel} does not name the built-in(s): ${missing.join(', ')}`);
    // And nothing that used to be one: a backticked builtin.* that the registry
    // does not import is a stale claim about what every boot pays for.
    const mentioned = [...text.matchAll(/`(builtin\.[a-z0-9._-]+)`/g)].map((m) => m[1]);
    const stale = [...new Set(mentioned)].filter((id) => !ids.includes(id));
    assert.deepEqual(stale, [], `${rel} still advertises retired built-in(s): ${stale.join(', ')}`);
  }
});

test('the docs agree with the in-app selftest on how many checks it runs', () => {
  const n = selftestIds().length;
  assert.ok(n >= 10, `extracted only ${n} selftest cases — the pattern is probably stale`);
  for (const rel of ['docs/plugin-dev/architecture.md', 'docs/plugin-dev/debugging.md']) {
    assert.match(
      read(...rel.split('/')),
      new RegExp(`${n} 项`),
      `${rel} must say the selftest runs "${n} 项"`,
    );
  }
});

test('the parity-table parser reads both columns, so the guards below can fail', () => {
  // Same reasoning as the heading extractor in hygiene.test.mjs: a parser that
  // silently matched nothing would make every guard below pass forever.
  assert.deepEqual(parseParityRow('| `stream` / `streamRaw` | ✅ | ✅ |'), {
    names: ['stream', 'streamRaw'],
    ctxUsable: true,
    bridgeUsable: true,
  });
  assert.deepEqual(parseParityRow('| `windows.create` / `windows.control` | ✅ | ❌ **没有** |'), {
    names: ['windows', 'windows'],
    ctxUsable: true,
    bridgeUsable: false,
  });
  assert.deepEqual(parseParityRow('| `close` / `drag` | ❌ | ✅ |'), {
    names: ['close', 'drag'],
    ctxUsable: false,
    bridgeUsable: true,
  });
  assert.equal(parseParityRow('| 能力 | 主窗口 `ctx` | 独立窗口 `bridge` |'), null);
  assert.equal(parseParityRow('not a row at all'), null);
});

/**
 * The asymmetry, stated once as a fact about the code. It is hard-coded rather
 * than derived from the doc, so this guard still fires if someone "fixes" the
 * doc to match a change that widened the gap.
 */
const INTENDED_CTX_ONLY = ['focusView', 'registerView', 'ui', 'windows'];
const INTENDED_BRIDGE_ONLY = ['close', 'dispose', 'drag', 'label'];

test('the two surfaces differ by exactly the capabilities that are one-sided by design', () => {
  const ctx = new Set([...ctxCapabilities()].map(norm));
  const bridge = new Set([...bridgeCapabilities()].map(norm));
  assert.ok(ctx.size >= 20, `ctx extraction found only ${ctx.size} capabilities`);
  assert.ok(bridge.size >= 20, `bridge extraction found only ${bridge.size} capabilities`);

  const ctxOnly = [...ctx].filter((k) => !bridge.has(k)).sort();
  const bridgeOnly = [...bridge].filter((k) => !ctx.has(k)).sort();

  // A capability that grew on one side only is how the historical bug happened:
  // `files` / `log` / `closeStream` landed on ctx first, so the same plugin code
  // failed with "undefined is not a function" purely because its UI lived in a
  // window instead of a view.
  assert.deepEqual(
    ctxOnly,
    INTENDED_CTX_ONLY,
    'ctx has capabilities the plugin window cannot reach. If this is deliberate, add it to\n' +
      'INTENDED_CTX_ONLY and document it in bridge.md; if not, mirror it in pluginwin-host.js.',
  );
  assert.deepEqual(
    bridgeOnly,
    INTENDED_BRIDGE_ONLY,
    'the plugin-window bridge has capabilities the main window does not. Anything beyond the\n' +
      'window-frame primitives is probably the same drift in the other direction.',
  );
});

test('bridge.md is the single list, and it matches the code exactly', () => {
  const ctx = new Set([...ctxCapabilities()].map(norm));
  const bridge = new Set([...bridgeCapabilities()].map(norm));
  const doc = documentedParity();

  // The headline counts are the first thing a reader trusts, so they are read
  // from the code too — a "25 capabilities on both sides" that silently became
  // 26 is exactly the class of drift this file exists to stop.
  const shared = [...ctx].filter((k) => bridge.has(k)).length;
  assert.equal(shared, 26, `the surfaces now share ${shared} capabilities, not 26`);
  assert.match(
    read('docs', 'plugin-dev', 'bridge.md'),
    new RegExp(`\\*\\*${shared} 个能力两边都有\\*\\*`),
    `bridge.md must open with "**${shared} 个能力两边都有**"`,
  );
  assert.match(
    read('docs', 'PROTOCOL.md'),
    new RegExp(`${shared} capabilities on both sides`),
    `PROTOCOL.md must say "${shared} capabilities on both sides"`,
  );
  assert.match(
    read('docs', 'plugin-dev', 'api.md'),
    new RegExp(`\\*\\*其余 ${shared} 个能力两边都有\\*\\*`),
    `api.md's summary must say "**其余 ${shared} 个能力两边都有**"`,
  );

  // The bridge column, both directions, is the whole point of the page.
  assert.deepEqual(
    [...doc.absent].sort(),
    INTENDED_CTX_ONLY,
    'bridge.md documents these as unavailable to a plugin window, but the code disagrees',
  );
  assert.deepEqual(
    [...doc.ctxAbsent].sort(),
    INTENDED_BRIDGE_ONLY,
    'bridge.md documents these as window-only, but the code disagrees',
  );

  // Nothing on the page may be invented, and nothing real may be left uncovered.
  const invented = [...doc.available].filter((n) => !ctx.has(n) && !bridge.has(n));
  assert.deepEqual(invented, [], `bridge.md lists ${invented.join(', ')}, which no surface has`);
  const uncovered = [...bridge].filter((k) => !doc.available.has(k));
  assert.deepEqual(
    uncovered,
    [],
    `bridge.${uncovered.join(', bridge.')} exists but is not in the bridge.md matrix, so a ` +
      'reader cannot learn whether the main window has an equivalent',
  );
  // Every main-window capability must be stated either way — "the window cannot
  // do this" has to be a written fact, not an omission a reader has to infer.
  const unstated = [...ctx].filter((k) => !doc.available.has(k) && !doc.absent.has(k));
  assert.deepEqual(
    unstated,
    [],
    `ctx.${unstated.join(', ctx.')} exists, but bridge.md never says whether a plugin window has it`,
  );
});

test('api.md links to bridge.md instead of keeping a second copy of the list', () => {
  const doc = read('docs', 'plugin-dev', 'api.md');
  assert.match(doc, /\]\(bridge\.md\)/, 'api.md must link to bridge.md for the authoritative list');
  // Two lists of the same thing is how one of them goes stale. api.md may
  // summarise; it may not re-enumerate the matrix.
  const duplicated = doc
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .filter((l) => parseParityRow(l));
  assert.deepEqual(duplicated, [], `api.md has grown its own parity table again:\n  ${duplicated.join('\n  ')}`);

  // The one thing api.md DOES name is the headline asymmetry (which side lacks
  // what), because that is what a reader needs before deciding to click through.
  // Shortening it to save space is exactly when the names would go stale.
  const headline = doc.split('\n').find((l) => l.startsWith('| 能力 |'));
  assert.ok(headline, 'api.md no longer has the "| 能力 | 只有主窗口 … |" summary row');
  // cells: ['', ' 能力 ', ' <ctx-only> ', ' <bridge-only> ', '']
  const cells = headline.split('|');
  const left = cells[2];
  const right = cells[3];
  const name = (cell) =>
    [...cell.matchAll(/`([^`]+)`/g)].map((m) => norm(m[1].split(/[.(]/)[0].trim())).sort();
  assert.deepEqual(name(left), INTENDED_CTX_ONLY, 'the ctx-only half of api.md\u2019s summary is wrong');
  assert.deepEqual(name(right), INTENDED_BRIDGE_ONLY, 'the bridge-only half of api.md\u2019s summary is wrong');
});

test('the manual says where plugin logs actually go', () => {
  // `ctx.log` / `bridge.log` are three console.* wrappers. `api.md` used to claim
  // they land in debug.log, which sent plugin authors looking for lines that are
  // never written. The true rule is: console only, and debug.log needs the
  // gateway action — so both facts are pinned here.
  for (const rel of ['docs/plugin-dev/api.md', 'docs/plugin-dev/bridge.md']) {
    const doc = read(...rel.split('/'));
    assert.match(doc, /只到当前 webview 的 console/, `${rel} must state that plugin logs stay in the console`);
    assert.match(doc, /write_debug_log/, `${rel} must name the only way into debug.log`);
  }
});

test('the notifyOS gap in plugin windows is documented with its workaround', () => {
  for (const rel of ['docs/plugin-dev/api.md', 'docs/plugin-dev/bridge.md']) {
    const doc = read(...rel.split('/'));
    assert.match(doc, /notifyOS/, `${rel} must mention notifyOS`);
    assert.match(
      doc,
      /'notify', 'send'/,
      `${rel} must show the bridge.request('notify', 'send', …) substitute — otherwise the ` +
        'only guidance a plugin-window author gets is "you cannot"',
    );
  }
});

test('the manual does not tell plugin-window authors that drops are impossible', () => {
  // api.md used to carry a bold warning: "插件自己的窗口收不到拖放" — written when
  // onDrop was believed to be view-only. `bridge.onDrop` exists now, so that
  // sentence is not just stale, it is the exact opposite of the truth and it
  // sits right where an author would look. Kept as its own test so a regression
  // names the mistake instead of looking like a table typo.
  const doc = read('docs', 'plugin-dev', 'api.md');
  assert.doesNotMatch(
    doc,
    /插件自己的窗口收不到拖放/,
    'api.md claims a plugin window cannot receive drops — bridge.onDrop exists (see bridge.md §1)',
  );
  assert.match(doc, /bridge\.onDrop/, 'and it must show the working call instead');
});

/**
 * Count the component vocabulary the same way `loadUiKit()` discovers it: the
 * PascalCase names exported from each `src/components/ui/<dir>/index.ts`.
 */
function vocabularySize() {
  const dir = path.join(root, 'src', 'components', 'ui');
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const index = path.join(dir, entry.name, 'index.ts');
    let src;
    try {
      src = readFileSync(index, 'utf8');
    } catch {
      continue;
    }
    const names = new Set();
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = (part.includes(' as ') ? part.split(' as ')[1] : part).trim();
        if (/^[A-Z]/.test(name)) names.add(name);
      }
    }
    total += names.size;
  }
  return total;
}

test('ui.md quotes the real vocabulary size, and it is a number it can re-derive', () => {
  const n = vocabularySize();
  assert.ok(n > 100, `vocabulary extraction found only ${n} components — the rule is probably stale`);
  assert.match(
    read('docs', 'plugin-dev', 'ui.md'),
    new RegExp(`\\*\\*${n} 个组件导出\\*\\*`),
    `ui.md must say "**${n} 个组件导出**"`,
  );
  // Every other page must point at ui.md rather than keep its own copy of a
  // number that only the code can answer.
  const strays = [];
  for (const rel of ['docs/plugin-dev/recipes.md', 'docs/plugin-dev/debugging.md', 'docs/plugin-dev/FILE-ACCESS-PLAN.md']) {
    const doc = read(...rel.split('/'));
    for (const m of doc.matchAll(/(\d{3}) 个(?:组件|tag|shadcn)/g)) {
      if (Number(m[1]) !== n) strays.push(`${rel}: "${m[0]}"`);
    }
  }
  assert.deepEqual(strays, [], `a page kept its own copy of the vocabulary size:\n  ${strays.join('\n  ')}`);
});

test('bridge.md accounts for every member of ctx.ui, not just the ones with a story', () => {
  // The `ui` namespace is where "it is different by design" is easiest to say
  // and hardest to check: a member that quietly stops being mentioned reads as
  // "handled" when it may be one more collateral gap like notifyOS.
  const expected = [...uiNamespace()].sort();
  assert.ok(expected.length >= 8, `ui namespace extraction found only ${expected.length}: ${expected}`);

  const section = docSection('docs/plugin-dev/bridge.md', '## 4. `ui` 为什么整块不在');
  const documented = new Set();
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|');
    if (cells.length < 5) continue;
    if (!/❌|✅/.test(cells[2])) continue; // the "插件窗口" column
    for (const m of cells[1].matchAll(/`([^`]+)`/g)) {
      documented.add(m[1].split(/[.(]/)[0].trim());
    }
  }
  assert.deepEqual(
    [...documented].sort(),
    expected,
    'bridge.md §4 must account for every ctx.ui member — add the missing one with the reason ' +
      'it is absent (and, if it is collateral like notifyOS, a substitute)',
  );
});

test('every page of the plugin manual is reachable from its index', () => {
  const dir = path.join(root, 'docs', 'plugin-dev');
  const index = readFileSync(path.join(dir, 'README.md'), 'utf8');
  const orphaned = readdirSync(dir)
    .filter((n) => n.endsWith('.md') && n !== 'README.md')
    .filter((n) => !index.includes(`(${n})`));
  assert.deepEqual(
    orphaned,
    [],
    `these pages exist but nothing in docs/plugin-dev/README.md links to them, so a\n` +
      `reader will never find them: ${orphaned.join(', ')}`,
  );
});

test('the status table accounts for every page, so a new one cannot be added quietly', () => {
  // The table is the only place that says which pages have been verified and by
  // what. A page that exists but has no row is a page nobody has decided about —
  // which is exactly the state this whole exercise started from.
  const index = read('docs', 'plugin-dev', 'README.md');
  const at = index.indexOf('## 文档状态');
  assert.ok(at >= 0, 'docs/plugin-dev/README.md lost its "## 文档状态" table');
  const rest = index.slice(at);
  const end = rest.indexOf('\n## ');
  const section = end >= 0 ? rest.slice(0, end) : rest;
  const listed = new Set([...section.matchAll(/\[([\w.-]+\.md)\]/g)].map((m) => m[1]));

  const pages = readdirSync(path.join(root, 'docs', 'plugin-dev')).filter(
    (n) => n.endsWith('.md') && n !== 'README.md',
  );
  const unlisted = pages.filter((n) => !listed.has(n));
  assert.deepEqual(
    unlisted,
    [],
    `these pages have no row in the status table, so their state is undeclared: ${unlisted.join(', ')}`,
  );
});

/**
 * Relative links are the cheapest kind of rot: a page gets renamed, the link
 * keeps its old text, and the reader gets a 404 they blame on the app. Only
 * relative `.md` links are checked — external URLs are not ours to guarantee.
 */
test('every relative page link in the docs resolves to a file that exists', () => {
  const pages = [];
  for (const dir of ['docs', path.join('docs', 'plugin-dev')]) {
    for (const name of readdirSync(path.join(root, dir))) {
      if (name.endsWith('.md')) pages.push(path.join(dir, name));
    }
  }
  pages.push('README.md');

  const broken = [];
  for (const rel of pages) {
    const text = readFileSync(path.join(root, rel), 'utf8');
    // Markdown links whose target is a local file, with any #anchor stripped.
    for (const m of text.matchAll(/\]\(([^)\s]+\.md)(#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^[a-z]+:/i.test(target)) continue; // absolute URL — not our file
      const resolved = path.resolve(path.dirname(path.join(root, rel)), target);
      try {
        if (!readFileSync(resolved)) throw new Error('unreadable');
      } catch {
        broken.push(`${rel} -> ${target}`);
      }
    }
  }
  assert.deepEqual(broken, [], `these doc links point at nothing:\n  ${broken.join('\n  ')}`);
});

/** Every `.md` page a plugin author is expected to read. */
function manualPages() {
  const dir = path.join(root, 'docs', 'plugin-dev');
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .map((n) => path.join('docs', 'plugin-dev', n));
}

test('every repo path the manual names actually exists', () => {
  // Prose rots quietly: a file gets moved and the doc keeps pointing at it, so
  // the reader concludes the feature is missing rather than the link. Cheap to
  // check, and it caught a real one (three pages linked the audit report one
  // directory too high).
  const missing = [];
  for (const rel of manualPages()) {
    const text = readFileSync(path.join(root, rel), 'utf8');
    for (const m of text.matchAll(/`((?:src|docs|examples|tests|scripts|bench)\/[\w./-]+)`/g)) {
      if (!statSafe(path.join(root, m[1]))) missing.push(`${rel} -> ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `the manual names files that are not there:\n  ${missing.join('\n  ')}`);
});

function statSafe(p) {
  try {
    readFileSync(p);
    return true;
  } catch {
    try {
      readdirSync(p);
      return true;
    } catch {
      return false;
    }
  }
}

test('every .tb-* class the manual tells a plugin to use actually exists', () => {
  // The whole point of `.tb-*` is that it is ALWAYS in the stylesheet (unlike a
  // Tailwind utility, which a plugin's source cannot generate). So a class the
  // manual recommends but the CSS never defines would fail silently and look
  // exactly like the problem `.tb-*` exists to solve.
  const css = ['src/assets/design-system.css', 'src/assets/app.css']
    .map((p) => readFileSync(path.join(root, p), 'utf8'))
    .join('\n');
  const defined = new Set([...css.matchAll(/\.(tb-[a-z0-9-]+)/g)].map((m) => m[1]));

  const missing = [];
  for (const rel of manualPages()) {
    const text = readFileSync(path.join(root, rel), 'utf8');
    for (const m of new Set([...text.matchAll(/\.(tb-[a-z0-9-]+)/g)].map((x) => x[1]))) {
      if (!defined.has(m)) missing.push(`${rel} -> .${m}`);
    }
  }
  assert.deepEqual(missing, [], `the manual recommends classes the CSS does not define:\n  ${missing.join('\n  ')}`);
});
