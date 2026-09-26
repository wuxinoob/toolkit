/**
 * Documentation guards.
 *
 * Why this exists: an editing slip left whole sections pasted twice in
 * `docs/plugin-dev/api.md`, `recipes.md` and `debugging.md` — three files, six
 * duplicated sections, none of which anything noticed. Markdown has no
 * compiler, so a duplicated section is not an error anywhere: it just sits
 * there, and a reader who trusts the doc reads the same paragraph twice (or,
 * worse, reads the *stale* copy second and believes it supersedes the first).
 *
 * The check is deliberately narrow — top-level (`##`) headings only. Deeper
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

/**
 * The guard has to be able to fail. A heading-duplication checker whose own
 * heading extraction is broken (say, one that never matches a heading) reports
 * success forever — the same "assertion that can only pass" trap this repo has
 * already fallen into twice. So the extractor is exercised directly.
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
