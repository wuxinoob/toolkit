/**
 * Hygiene guards: the things that go wrong silently because nothing compiles
 * them.
 *
 * Markdown has no compiler and `node --test` does not care what a test is
 * called, so neither a duplicated doc section nor a duplicated test name is an
 * error anywhere — they just sit there. A reader who trusts the doc reads the
 * same paragraph twice (or reads the STALE copy second and believes it
 * supersedes the first), and a duplicated test name hides the fact that
 * coverage did not grow.
 *
 * This is not hypothetical. One editing slip left:
 *   - whole sections pasted twice in api.md / recipes.md / debugging.md
 *   - `ctx.focusView` defined twice in src/host/ctx.js (the later one silently won)
 *   - two duplicated assertions in plugin-interfaces.test.mjs
 *   - two duplicated test names in host-kernel.test.mjs — and the later copy of
 *     `declared hotkeys are registered…` asserted the OPPOSITE of the real
 *     behaviour, passing only because an earlier test left the hotkey enabled
 *
 * So the rule these guards enforce is: a declaration that is supposed to be
 * unique must actually be unique.
 *
 * The doc check is deliberately narrow — top-level (`##`) headings only. Deeper
 * levels legitimately repeat: `SUPPLEMENT.md` gives every lesson the same four
 * `###` subheadings, and that is structure, not duplication.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Every doc a plugin author is expected to read, plus the design docs. */
function docFiles() {
  const out = [];
  for (const dir of ['docs', path.join('docs', 'plugin-dev')]) {
    const abs = path.join(root, dir);
    for (const name of readdirSync(abs)) {
      if (name.endsWith('.md')) out.push(path.join(dir, name));
    }
  }
  return out.sort();
}

/** Top-level headings, in order, ignoring fenced code blocks. */
function topHeadings(text) {
  const found = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    // `## ` exactly — `###` and deeper are subsections and may repeat.
    if (/^## /.test(line)) found.push(line.trim());
  }
  return found;
}

/**
 * The heading extractor has to be able to fail. A checker whose own extraction
 * is broken (say, one that never matches a heading) reports success forever —
 * the "assertion that can only pass" trap this repo has fallen into twice. So
 * it is exercised directly rather than trusted.
 */
test('the heading extractor actually finds headings and skips code fences', () => {
  const sample = [
    '# title',
    '## alpha',
    '```',
    '## not-a-heading',
    '```',
    '### subsection',
    '## beta',
    '## alpha',
  ].join('\n');

  assert.deepEqual(topHeadings(sample), ['## alpha', '## beta', '## alpha']);
  assert.deepEqual(topHeadings('### only-a-subsection'), []);
});

test('no doc repeats a top-level section', () => {
  const files = docFiles();
  assert.ok(files.length >= 10, `expected to find the docs, got ${files.length}`);

  const offenders = [];
  for (const rel of files) {
    const heads = topHeadings(readFileSync(path.join(root, rel), 'utf8'));
    const seen = new Set();
    for (const h of heads) {
      if (seen.has(h)) offenders.push(`${rel}: ${h}`);
      seen.add(h);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these sections are pasted twice — delete one copy:\n  ${offenders.join('\n  ')}`,
  );
});

/** `test('…')` / `test("…")` names, in file order. */
function testNames(text) {
  return [...text.matchAll(/^test\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm)].map((m) => m[2]);
}

test('the test-name extractor actually finds names', () => {
  // Same reasoning as the heading extractor: this file's own name must be
  // findable, or the guard below is vacuous.
  const names = testNames(readFileSync(path.join(root, 'tests/hygiene.test.mjs'), 'utf8'));
  assert.ok(names.length >= 3, `extractor found ${names.length} names: ${names.join(', ')}`);
  assert.ok(
    names.includes('no doc repeats a top-level section'),
    `extractor missed a name it should see: ${names.join(', ')}`,
  );
});

test('no test file declares the same test name twice', () => {
  const dir = path.join(root, 'tests');
  const files = readdirSync(dir).filter((n) => n.endsWith('.test.mjs'));
  assert.ok(files.length >= 10, `expected the test suite, got ${files.length} files`);

  const offenders = [];
  for (const name of files.sort()) {
    const seen = new Set();
    for (const t of testNames(readFileSync(path.join(dir, name), 'utf8'))) {
      if (seen.has(t)) offenders.push(`tests/${name}: ${t}`);
      seen.add(t);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'the same test name is declared twice. If the bodies differ, one of them is\n' +
      'probably an older version asserting stale behaviour — check which one the\n' +
      'product actually does before deleting:\n  ' +
      offenders.join('\n  '),
  );
});

/** Every `.rs` file under `src-tauri/src`, so the guards below read the real tree. */
function rustSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.rs')) out.push(p);
    }
  };
  walk(path.join(root, 'src-tauri', 'src'));
  return out.sort();
}

/**
 * The headline counts in INTERFACES.md are the first thing a reader trusts, and
 * nothing compiles them. They had already drifted: the doc said "9 个命令" while
 * the code had 13, because four commands were added over time and the table was
 * never extended.
 */
test('INTERFACES.md counts the native commands correctly', () => {
  let commands = 0;
  const names = [];
  for (const f of rustSources()) {
    const text = readFileSync(f, 'utf8');
    commands += (text.match(/#\[tauri::command\]/g) ?? []).length;
    for (const m of text.matchAll(/#\[tauri::command\]\s*\n\s*(?:pub\s+)?async\s+fn\s+(\w+)/g)) {
      names.push(m[1]);
    }
  }

  assert.ok(commands >= 10, `command extraction looks wrong (${commands})`);
  // Every command must be `async fn` — a sync one runs on the message thread.
  // (`tests/main-thread.test.mjs` owns the detailed version of this; here it
  // just keeps the count below meaningful.)
  assert.equal(
    names.length,
    commands,
    `${commands} #[tauri::command] but only ${names.length} parsed as \`async fn\``,
  );

  const doc = readFileSync(path.join(root, 'docs', 'INTERFACES.md'), 'utf8');
  assert.match(
    doc,
    new RegExp(`\\|\\s*${commands} 个原生命令`),
    `INTERFACES.md's summary must say "${commands} 个原生命令" (the code has ${commands}:\n  ${names.join(', ')})`,
  );
  assert.match(
    doc,
    new RegExp(`^## 1\\. 原生入口：${commands} 个命令$`, 'm'),
    `the §1 heading must say "## 1. 原生入口：${commands} 个命令"`,
  );
  // …and the table must actually have that many rows, or the heading is a label
  // on the wrong list.
  const table = doc.slice(doc.indexOf('## 1. 原生入口'));
  const rows = [...table.matchAll(/^\|\s*\d+\s*\|/gm)].length;
  assert.equal(rows, commands, `§1's table has ${rows} rows but there are ${commands} commands`);
});

/**
 * "The host only looks up tables — it never special-cases a service."
 *
 * That is one of the four hard rules the whole message plane rests on, and
 * nothing enforced it. The moment `plugin_rpc` contains `if svc == "storage"`,
 * every service has two possible implementations (the table, and the branch) and
 * the table stops being the source of truth — which is how a framework turns
 * back into a pile of special cases.
 *
 * The pattern deliberately does NOT match `match services::route(...)`: that is
 * a match on the RESULT of the lookup, which is the correct shape.
 */
test('lib.rs does not special-case a service name', () => {
  const text = readFileSync(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const offenders = [];
  const patterns = [
    [/\b(?:svc|service)\s*(?:==|!=)/g, 'a comparison on the service name'],
    [/(?:==|!=)\s*(?:svc|service)\b/g, 'a comparison against the service name'],
    [/\bmatch\s+(?:svc|service)\s*\{/g, 'a `match` on the service name'],
  ];
  for (const [re, what] of patterns) {
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split('\n').length;
      offenders.push(`lib.rs:${line}: ${what} — ${text.split('\n')[line - 1].trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'the gateway must route through the service table, not branch on the service name:\n  ' +
      offenders.join('\n  '),
  );

  // The rule is only meaningful if the table is actually what does the routing.
  assert.match(
    text,
    /services::route\(/,
    'lib.rs no longer calls `services::route` — either the gateway moved or this guard is stale',
  );
});
