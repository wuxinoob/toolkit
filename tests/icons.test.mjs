/**
 * The sidebar icon vocabulary.
 *
 * `contributes.views[].icon` accepts three things and must handle all of them:
 * a `lucide:<name>` reference, an emoji (what every plugin used before), and a
 * typo. The typo case is the one worth pinning: the first implementation fell
 * back to `null`, which rendered the literal string "lucide:file-txt" in the
 * sidebar — it looked like the plugin was broken.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { ICON_NAMES, resolveIcon } = await import('../src/host/icons.js');

test('icons: a known lucide name resolves to a component', () => {
  const Terminal = resolveIcon('lucide:terminal');
  assert.equal(typeof Terminal, 'function', 'expected a Vue component (a function)');
});

test('icons: an emoji is not an icon — it renders as text', () => {
  assert.equal(resolveIcon('🧩'), null);
  assert.equal(resolveIcon('📝'), null);
});

test('icons: an unknown name falls back to an icon, never to raw text', () => {
  // Not null: null means "render the string", which is how "lucide:file-txt"
  // ended up in the sidebar. A generic glyph reads as a missing icon instead.
  const fallback = resolveIcon('lucide:file-txt');
  assert.equal(typeof fallback, 'function', 'a typo must still produce an icon');
  assert.equal(
    fallback,
    resolveIcon('lucide:puzzle'),
    'the fallback should be the generic glyph',
  );
});

test('icons: names are case- and whitespace-insensitive', () => {
  assert.equal(resolveIcon('lucide:Terminal'), resolveIcon('lucide:terminal'));
  assert.equal(resolveIcon('  lucide:terminal  '), resolveIcon('lucide:terminal'));
});

test('icons: non-strings and empty values are safe', () => {
  for (const bad of [undefined, null, 42, {}, []]) {
    assert.equal(resolveIcon(bad), null, `${JSON.stringify(bad)} should render as text`);
  }
});

test('icons: the vocabulary is non-trivial and all names resolve', () => {
  // A name in the list that does not resolve would be a typo in the map itself.
  assert.ok(ICON_NAMES.length >= 40, `vocabulary looks thin: ${ICON_NAMES.length}`);
  for (const name of ICON_NAMES) {
    assert.equal(typeof resolveIcon(`lucide:${name}`), 'function', `"${name}" does not resolve`);
  }
});
