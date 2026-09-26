/**
 * `ctx` (main window) and `bridge` (plugin window) are two views of ONE plugin
 * contract. This pins the difference between them so it stays a decision instead
 * of drifting into an accident.
 *
 * Why it exists: `ctx.clipboard` and `ctx.screen` were added to the main window
 * only. Nothing failed — the main-window plugin worked, the docs were updated,
 * every test was green — but the same plugin code running in its OWN window hit
 * `undefined is not a function`. An asymmetry that nothing measures is an
 * asymmetry nobody chose.
 *
 * The check is two-sided on purpose:
 *   - everything in SHARED must be on both;
 *   - anything on exactly one must appear in an exception list below.
 * The second half is what makes it useful: a new `ctx`-only namespace fails here
 * until someone writes down whether that was intended.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Top-level keys of the object literal that follows `anchor`.
 *
 * Brace counting over a comment- and string-stripped copy, so both files build
 * their SDK as one plain literal and this reads the REAL surface rather than a
 * hand-copied list that would drift.
 *
 * The key regex uses `[ \t]`, not `\s`: `\s` matches newlines, so `^\s*name\s*:`
 * happily matches a name on the NEXT line. That is not a theoretical worry — it
 * made this extractor report every key twice (once from the blank line above it,
 * once from its own line) on the first run.
 */
function topLevelKeys(source, anchor) {
  const stripped = strip(source);
  const at = stripped.indexOf(anchor);
  assert.ok(at >= 0, `anchor not found: ${anchor}`);

  const start = stripped.indexOf('{', at);
  assert.ok(start > at, `no object literal after: ${anchor}`);

  const keys = [];
  let depth = 0;
  let lineStart = true;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) break;
    } else if (c === '\n') {
      lineStart = true;
      continue;
    } else if (depth === 1 && lineStart) {
      const m = /^[ \t]*([A-Za-z_$][\w$]*)[ \t]*:/.exec(stripped.slice(i));
      if (m) keys.push(m[1]);
    }
    lineStart = false;
  }
  return keys;
}

/** Blank out comments and string bodies so braces/newlines inside them are inert. */
function strip(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      out += ' ';
    } else if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
      out += ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      i += 1;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i += 1;
      out += '""';
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

const ctxRaw = topLevelKeys(
  readFileSync(path.join(root, 'src/host/ctx.js'), 'utf8'),
  'const ctx = {',
);
// `return {` — NOT `function makeBridge`. Anchoring on the function declaration
// lands on the function's BODY brace, so every key is one level too deep and the
// extractor returns nothing. (It did exactly that on the first run.)
const bridgeRaw = topLevelKeys(
  readFileSync(path.join(root, 'src/host/pluginwin-host.js'), 'utf8'),
  'return {',
);

/**
 * One capability, two names. Not worth changing now (both are published API),
 * but worth recording: a plugin author moving code between windows should not
 * have to discover this from a stack trace.
 */
const RENAMED_ON_BRIDGE = { rpc: 'request' };

const ctxKeys = [...new Set(ctxRaw.map((k) => RENAMED_ON_BRIDGE[k] ?? k))].sort();
const bridgeKeys = [...new Set(bridgeRaw)].sort();

/** On both, under the same name (after the rename above). */
const SHARED = [
  'protocol',
  'request',
  'log',
  'storage',
  'clipboard',
  'screen',
  'files',
  'subscribe',
  'once',
  'publish',
  'events',
  'bus',
  'onHotkey',
  'stream',
  'streamRaw',
  'uplink',
  'sidecar',
  'pty',
  'closeStream',
  'sessions',
  'schemes',
  'schema',
];

/**
 * Main-window concepts. A plugin window genuinely cannot have these: views live
 * in the main window, a drop is routed to the active view, and window ownership
 * stays with whoever created the window.
 */
const INTENTIONAL_CTX_ONLY = ['focusView', 'onDrop', 'registerView', 'windows'];

/**
 * Debt, not design. Nothing about this needs the main window — a plugin window
 * can render the same components. It is listed so that "missing" is a recorded
 * decision; move it to SHARED when the factory is mirrored.
 *
 * `files` / `log` / `closeStream` were here too until they were mirrored. They
 * had no reason to be main-window-only: the same plugin code worked in a view
 * and threw `undefined is not a function` in the plugin's own window. Mirroring
 * them also surfaced a real leak — see `bridge.dispose()` in pluginwin-host.js.
 */
const PENDING_CTX_ONLY = ['ui'];

const CTX_ONLY = [...INTENTIONAL_CTX_ONLY, ...PENDING_CTX_ONLY];

/**
 * `close` / `drag` are window-local and only mean something for a window.
 * `cleanup` / `dispose` are the teardown pair — `ctx` gets the same thing as
 * `ctx.cleanup`, assigned after the literal, so the extractor cannot see it.
 */
const BRIDGE_ONLY = ['cleanup', 'close', 'dispose', 'drag'];

test('the two SDK surfaces were actually parsed', () => {
  // Guards the extractor: if the literal shape changes, every assertion below
  // would pass on empty sets and audit nothing.
  assert.ok(ctxRaw.length >= 20, `ctx keys look wrong (${ctxRaw.length}): ${ctxRaw.join(',')}`);
  assert.ok(
    bridgeRaw.length >= 15,
    `bridge keys look wrong (${bridgeRaw.length}): ${bridgeRaw.join(',')}`,
  );
  // Duplicates mean the regex is matching across lines again (see above).
  assert.equal(
    new Set(ctxRaw).size,
    ctxRaw.length,
    `ctx extraction produced duplicates: ${ctxRaw.join(',')}`,
  );
  assert.equal(
    new Set(bridgeRaw).size,
    bridgeRaw.length,
    `bridge extraction produced duplicates: ${bridgeRaw.join(',')}`,
  );
  assert.ok(ctxKeys.includes('storage'), 'ctx parse missed a key that is definitely there');
  assert.ok(bridgeKeys.includes('storage'), 'bridge parse missed a key that is definitely there');
});

test('the one renamed capability is still renamed, and only that one', () => {
  assert.ok(ctxRaw.includes('rpc'), 'ctx.rpc is gone — update RENAMED_ON_BRIDGE');
  assert.ok(bridgeKeys.includes('request'), 'bridge.request is gone — update RENAMED_ON_BRIDGE');
  assert.ok(
    !bridgeKeys.includes('rpc'),
    'bridge gained an `rpc` — the two SDKs now have two names for one thing; pick one',
  );
});

test('every shared capability exists on both SDKs', () => {
  const missing = [];
  for (const k of SHARED) {
    if (!ctxKeys.includes(k)) missing.push(`ctx.${k}`);
    if (!bridgeKeys.includes(k)) missing.push(`bridge.${k}`);
  }
  assert.deepEqual(
    missing,
    [],
    `declared shared but absent — a plugin would work in one window and break in the other:\n  ${missing.join('\n  ')}`,
  );
});

test('every asymmetry is one of the recorded ones', () => {
  const ctxOnly = ctxKeys.filter((k) => !bridgeKeys.includes(k));
  const bridgeOnly = bridgeKeys.filter((k) => !ctxKeys.includes(k));

  assert.deepEqual(
    ctxOnly,
    [...CTX_ONLY].sort(),
    'the set of ctx-only namespaces changed. If you meant to add one, decide whether a\n' +
      'plugin window should have it: mirror it (add to SHARED), or record it as\n' +
      'INTENTIONAL_CTX_ONLY / PENDING_CTX_ONLY with the reason.',
  );
  assert.deepEqual(
    bridgeOnly,
    [...BRIDGE_ONLY].sort(),
    'the set of bridge-only namespaces changed — same question, other direction.',
  );
});

test('the exception bookkeeping is self-consistent', () => {
  // If a name is both "shared" and an "exception", the lists above stop meaning
  // anything — so this is what keeps the guard honest rather than merely green.
  const overlap = SHARED.filter((k) => CTX_ONLY.includes(k) || BRIDGE_ONLY.includes(k));
  assert.deepEqual(overlap, [], `a name is both shared and an exception: ${overlap.join(', ')}`);
  assert.deepEqual(
    INTENTIONAL_CTX_ONLY.filter((k) => PENDING_CTX_ONLY.includes(k)),
    [],
    'a name is listed as both intentional and debt',
  );
  assert.deepEqual(
    CTX_ONLY.filter((k) => BRIDGE_ONLY.includes(k)),
    [],
    'a name is listed as ctx-only and bridge-only at once',
  );
});
