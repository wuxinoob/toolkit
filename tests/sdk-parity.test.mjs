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
import { ctxSurface, bridgeSurface } from './helpers/sdk-surfaces.mjs';

const ctxRaw = Object.keys(ctxSurface);
const bridgeRaw = Object.keys(bridgeSurface);

/**
 * One capability, two names. Not worth changing now (both are published API),
 * but worth recording: a plugin author moving code between windows should not
 * have to discover this from a stack trace.
 */
const RENAMED_ON_BRIDGE = { rpc: 'request', id: 'pluginId' };

const ctxKeys = [...new Set(ctxRaw.map((k) => RENAMED_ON_BRIDGE[k] ?? k))].sort();
const bridgeKeys = [...new Set(bridgeRaw)].sort();

/** On both, under the same name (after the rename above). */
const SHARED = [
  'pluginId',
  'manifest',
  'protocol',
  'request',
  'bytes',
  'binary',
  'fs',
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
  'onDrop',
  'stream',
  'streamRaw',
  'uplink',
  'sidecar',
  'pty',
  'closeStream',
  'sessions',
  'schemes',
  'schema',
  'paths',
  'cleanup',
];

/**
 * Main-window concepts. A plugin window genuinely cannot have these: views live
 * in the main window, and window ownership stays with whoever created the
 * window.
 *
 * `onDrop` used to be on this list, on the theory that a drop is routed to the
 * active view. That was the wrong model: a plugin window belongs to exactly one
 * plugin, so it can watch its OWN drag-and-drop and needs no router at all —
 * which is simpler than the main window, not more complex. It moved to SHARED
 * on 2026-09-27.
 */
const INTENTIONAL_CTX_ONLY = [
  'focusView',
  'registerView',
  'windows',
  // Decided 2026-09-26: `ui` is NOT being mirrored. It is Vue + 376 shadcn
  // components whose look comes entirely from Tailwind UTILITIES, and a plugin
  // window's stylesheet deliberately ships none (it is tokens + `.tb-*` only —
  // measured 5 KB JS + 19 KB CSS per window). Mirroring it would mean adding
  // ~122 KB of utilities back to every plugin window, or maintaining a second
  // trimmed-down component set. A plugin window that wants rich UI builds it
  // from `.tb-*`.
  'ui',
];

/**
 * Debt, not design — currently empty.
 *
 * `files` / `log` / `closeStream` were here until they were mirrored. They had
 * no reason to be main-window-only: the same plugin code worked in a view and
 * threw `undefined is not a function` in the plugin's own window. Mirroring them
 * also surfaced a real leak — see `bridge.dispose()` in pluginwin-host.js.
 */
const PENDING_CTX_ONLY = [];

const CTX_ONLY = [...INTENTIONAL_CTX_ONLY, ...PENDING_CTX_ONLY];

/**
 * `close` / `drag` are window-local and only mean something for a window.
 * `label` is the window's own name (the main window is `main` — there is no
 * second window to name). `dispose` is the window's teardown; `ctx` gets the
 * equivalent as `cleanup`, which is SHARED.
 */
const BRIDGE_ONLY = ['close', 'dispose', 'drag', 'label'];

test('the two SDK surfaces are constructed with their published capabilities', () => {
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
