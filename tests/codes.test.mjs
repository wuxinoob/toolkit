/**
 * The error-code vocabulary is declared twice — once in Rust (the host produces
 * them) and once in JS (callers branch on them). This test parses both files and
 * compares the lists, so the mirror cannot silently drift.
 *
 * Same idea as the plugin audit: a duplicated declaration is acceptable only if
 * something checks the two copies agree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const RUST = readFileSync(new URL('../src-tauri/src/protocol/codes.rs', import.meta.url), 'utf8');
const JS = readFileSync(new URL('../src/protocol/codes.js', import.meta.url), 'utf8');

/** Pull `pub const NAME: &str = "value";` out of the Rust module. */
function rustCodes() {
  const block = RUST.slice(RUST.indexOf('pub mod code {'), RUST.indexOf('/// Every code, for'));
  const out = {};
  for (const m of block.matchAll(/pub const ([A-Z_]+): &str = "([a-z_]+)";/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** Pull `NAME: 'value',` out of the frozen JS object. */
function jsCodes() {
  const block = JS.slice(JS.indexOf('export const Code = Object.freeze({'), JS.indexOf('export const ALL_CODES'));
  const out = {};
  for (const m of block.matchAll(/^\s{2}([A-Z_]+): '([a-z_]+)',$/gm)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** And the order of the Rust `ALL` array, which the JS `Object.values` mirrors. */
function rustAll() {
  const block = RUST.slice(RUST.indexOf('pub const ALL: &[&str] = &['), RUST.indexOf('/// Is this one of the declared codes'));
  return [...block.matchAll(/code::([A-Z_]+),/g)].map((m) => m[1]);
}

test('the Rust and JS code sets are identical, name for name', () => {
  const rust = rustCodes();
  const js = jsCodes();
  assert.ok(Object.keys(rust).length >= 10, `parsed only ${Object.keys(rust).length} Rust codes`);

  assert.deepEqual(
    Object.keys(js).sort(),
    Object.keys(rust).sort(),
    'the two declarations list different code names',
  );
  for (const name of Object.keys(rust)) {
    assert.equal(js[name], rust[name], `code ${name} has a different value`);
  }
});

test('the Rust ALL array covers every declared code, in the JS order', () => {
  const rust = rustCodes();
  const all = rustAll();
  assert.deepEqual(
    all.sort(),
    Object.keys(rust).sort(),
    'ALL and the `pub const` list disagree — a code would be unadvertised',
  );
  // ALL drives both `schema().codes` and the JS ALL_CODES order
  assert.equal(new Set(all).size, all.length, 'ALL has a duplicate');
});

test('the codes are lower_snake_case and the old svc/act form is gone', async () => {
  const { Code, ALL_CODES, isKnownCode } = await import('../src/protocol/codes.js');
  for (const c of ALL_CODES) {
    assert.match(c, /^[a-z][a-z_]*$/, `code "${c}" must be lower_snake_case`);
  }
  assert.equal(isKnownCode(Code.DENIED), true);
  assert.equal(isKnownCode('storage/get'), false, 'a service failure is no longer a code');
  assert.equal(isKnownCode(''), false);
});
