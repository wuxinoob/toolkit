/**
 * `contributes.theme` — plugin-declared design-token overrides.
 *
 * The feature exists so a plugin can restyle *itself* without shipping CSS.
 * That only holds if the plugin supplies a COLOUR and never a declaration, so
 * most of this file is about the validator: what it must accept, and every
 * shape of "close the declaration and write my own rules" it must refuse.
 *
 * A validator that cannot be shown to reject anything is not a validator, so
 * the rejection cases below are the point of the test, not a formality.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The module injects a <style> into the document. This is the smallest stub that
// exercises the real code path: createElement + head.appendChild + a lookup that
// finds what was appended, so repeated flushes reuse one element (as in a
// browser) rather than piling up.
let injected = null;
globalThis.document = {
  createElement: (tagName) => ({ tagName, id: '', textContent: '' }),
  head: {
    appendChild: (el) => {
      injected = el;
    },
  },
  getElementById: (id) => (injected && injected.id === id ? injected : null),
};

const {
  normalizeThemeContribution,
  applyPluginTheme,
  clearPluginTheme,
  listPluginThemes,
} = await import('../src/host/pluginTheme.js');

const css = () => injected?.textContent ?? '';
const reset = () => {
  for (const { pluginId } of listPluginThemes()) clearPluginTheme(pluginId);
};

// ------------------------------- accepted values -------------------------------

test('theme: ordinary colour syntaxes are accepted', () => {
  const { dark, rejected } = normalizeThemeContribution({
    dark: {
      '--color-brand': '#7c3aed',
      '--color-brand-hover': '#8b5cf6',
      '--color-ink': 'rgb(240, 240, 245)',
      '--color-danger': 'rgba(255, 0, 0, 0.5)',
      '--color-surface': 'oklch(0.98 0.01 260)',
      '--color-warn': 'color-mix(in srgb, #f0c674 80%, white)',
      '--color-success': 'var(--color-brand)',
      '--color-ink-subtle': 'transparent',
      '--color-line': 'currentColor',
    },
  });
  assert.deepEqual(rejected, [], 'nothing should have been rejected');
  assert.equal(Object.keys(dark).length, 9);
  assert.equal(dark['--color-surface'], 'oklch(0.98 0.01 260)');
});

test('theme: a plugin may declare only one theme', () => {
  const { dark, light, rejected } = normalizeThemeContribution({ dark: { '--color-brand': '#fff' } });
  assert.deepEqual(rejected, []);
  assert.ok(dark);
  assert.equal(light, null, 'an undeclared theme must stay null so it keeps the app value');
});

// ------------------------------- rejected values -------------------------------

test('theme: values that could escape the declaration are rejected', () => {
  // Each of these is an attempt to stop being a value and become a rule. The
  // first two are the classic ones; the rest are the same idea spelled
  // differently.
  const attacks = [
    'red; } body { display: none',
    '#fff; --color-canvas: #000',
    'red}',
    '#fff; background: url(https://evil.example/x.png)',
    '#fff</style><script>alert(1)</script>',
    'red\\3c /style',
    'red\n}\nbody{display:none}',
    'url(https://evil.example/beacon)',
    'expression(alert(1))',
    'image-set("https://evil.example/x.png")',
    '#fff;@import url(https://evil.example/a.css)',
  ];
  for (const value of attacks) {
    const { dark, rejected } = normalizeThemeContribution({ dark: { '--color-brand': value } });
    assert.equal(dark, null, `accepted a value it must refuse: ${JSON.stringify(value)}`);
    assert.equal(rejected.length, 1, `expected one rejection for ${JSON.stringify(value)}`);
  }
});

test('theme: malformed token names are rejected', () => {
  const bad = ['color-brand', '--Color-Brand', '--', '--1abc', '--a b', '--a;b', '', '--a'.repeat(40)];
  for (const name of bad) {
    const { dark, rejected } = normalizeThemeContribution({ dark: { [name]: '#fff' } });
    assert.equal(dark, null, `accepted a token name it must refuse: ${JSON.stringify(name)}`);
    assert.equal(rejected.length, 1);
  }
});

test('theme: malformed contributions do not throw, they report', () => {
  const cases = [
    [{ dark: 'not an object' }, 'string block'],
    [{ dark: ['#fff'] }, 'array block'],
    [[], 'array at the top'],
    ['nope', 'string at the top'],
  ];
  for (const [input, label] of cases) {
    const r = normalizeThemeContribution(input);
    assert.equal(r.dark, null, label);
    assert.equal(r.light, null, label);
    assert.ok(r.rejected.length > 0, `${label}: should have reported something`);
  }
  // null/undefined is "no contribution", which is not an error
  assert.deepEqual(normalizeThemeContribution(null).rejected, []);
  assert.deepEqual(normalizeThemeContribution(undefined).rejected, []);
});

test('theme: a non-string value is rejected, not coerced', () => {
  for (const value of [42, true, null, {}, ['#fff']]) {
    const { dark, rejected } = normalizeThemeContribution({ dark: { '--color-brand': value } });
    assert.equal(dark, null, `accepted ${JSON.stringify(value)}`);
    assert.equal(rejected.length, 1);
  }
});

test('theme: the token cap is enforced and reported', () => {
  const dark = {};
  for (let i = 0; i < 70; i++) dark[`--color-x${i}`] = '#fff';
  const { dark: out, rejected } = normalizeThemeContribution({ dark });
  assert.equal(Object.keys(out).length, 64, 'should keep exactly the cap');
  assert.ok(
    rejected.some((r) => r.includes('more than')),
    'hitting the cap should be reported, not silent',
  );
});

// ---------------------------------- injection ----------------------------------

test('theme: the injected rule is scoped to the plugin and covers both themes', () => {
  reset();
  const { applied, rejected } = applyPluginTheme('acme.demo', {
    dark: { '--color-brand': '#a78bfa' },
    light: { '--color-brand': '#6d3fc4' },
  });
  assert.equal(applied, 2);
  assert.deepEqual(rejected, []);

  const out = css();
  // Scoped to the plugin's own subtree — this is what makes over-declaring safe.
  assert.match(out, /:root\[data-theme='dark'\] \[data-plugin='acme\.demo'\]\{--color-brand:#a78bfa\}/);
  assert.match(out, /:root\[data-theme='light'\] \[data-plugin='acme\.demo'\]\{--color-brand:#6d3fc4\}/);
  // Both themes are emitted up front, so no JS runs when the theme changes.
  assert.equal(out.split('\n').length, 2);
});

test('theme: plugins compose — one override does not disturb another', () => {
  reset();
  applyPluginTheme('a.one', { dark: { '--color-brand': '#111111' } });
  applyPluginTheme('b.two', { dark: { '--color-danger': '#222222' } });
  const out = css();
  assert.match(out, /a\.one/);
  assert.match(out, /b\.two/);
  assert.match(out, /--color-brand:#111111/);
  assert.match(out, /--color-danger:#222222/);
  assert.equal(listPluginThemes().length, 2);
});

test('theme: re-applying replaces rather than duplicates', () => {
  reset();
  applyPluginTheme('x.y', { dark: { '--color-brand': '#111111' } });
  applyPluginTheme('x.y', { dark: { '--color-brand': '#999999' } });
  const out = css();
  assert.doesNotMatch(out, /#111111/, 'the old value should be gone');
  assert.match(out, /#999999/);
  assert.equal(out.split('\n').length, 1, 'one plugin must produce one rule per theme');
});

test('theme: clearing removes the rule, and an empty contribution is a no-op', () => {
  reset();
  applyPluginTheme('x.y', { dark: { '--color-brand': '#111111' } });
  assert.equal(clearPluginTheme('x.y'), true);
  assert.equal(css(), '');
  assert.equal(clearPluginTheme('x.y'), false, 'clearing twice is not an error, just false');

  // A contribution where everything was rejected must not leave a stray rule.
  const r = applyPluginTheme('bad.actor', { dark: { '--color-brand': 'red; } body {' } });
  assert.equal(r.applied, 0);
  assert.equal(css(), '');
  assert.equal(listPluginThemes().length, 0);
});

test('theme: a plugin id containing quotes cannot break out of the selector', () => {
  reset();
  applyPluginTheme("ev'il", { dark: { '--color-brand': '#fff' } });
  const out = css();
  assert.doesNotMatch(out, /ev'il/, 'the quote must be stripped from the selector');
  assert.match(out, /\[data-plugin='evil'\]/);
});

// ------------------------------- shipped manifests ------------------------------

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

/** Same brace-counting extraction the manifest audit uses. */
function extractManifest(src, label) {
  const start = src.indexOf('export const manifest');
  assert.ok(start >= 0, `${label}: no manifest`);
  const open = src.indexOf('{', start);
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
  // eslint-disable-next-line no-new-func
  return new Function(`return (${src.slice(open, i + 1)});`)();
}

test('theme: every shipped theme contribution is valid and complete', () => {
  const cases = [
    ...['notepad', 'eyecare', 'procman', 'streamlab', 'floatwin'].map((n) => ({
      label: `src/plugins/${n}.js`,
      manifest: extractManifest(read(`src/plugins/${n}.js`), n),
    })),
    ...['examples/plugins/fileprobe', 'examples/plugins/msglog', 'examples/calc-plugin', 'examples/plugins/probe'].map((dir) => ({
      label: `${dir}/plugin.json`,
      manifest: JSON.parse(read(`${dir}/plugin.json`)),
    })),
  ];

  const problems = [];
  let contributors = 0;
  for (const { label, manifest } of cases) {
    const declared = manifest.contributes?.theme;
    if (!declared) continue;
    contributors += 1;
    const { dark, light, rejected } = normalizeThemeContribution(declared);
    for (const why of rejected) problems.push(`${label}: ${why}`);
    if (!dark && !light) problems.push(`${label}: declares contributes.theme but nothing survived`);
    // Both themes must be present, otherwise the plugin looks right in one theme
    // and half-styled in the other — the exact failure this feature invites.
    if (dark && !light) problems.push(`${label}: declares dark but not light`);
    if (light && !dark) problems.push(`${label}: declares light but not dark`);
  }

  assert.deepEqual(problems, [], `bad theme contributions:\n  ${problems.join('\n  ')}`);
  assert.ok(contributors > 0, 'no plugin exercises contributes.theme — the audit would pass vacuously');
});
