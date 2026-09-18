/**
 * Capability audit: every Tauri window API the JS calls must be permitted.
 *
 * A denied call does not throw where you can see it. In this case Tauri's own
 * `onCloseRequested` closes the window by calling `destroy()` after the JS
 * handler resolves — and `core:window:default` grants 28 READ-ONLY permissions,
 * `destroy` among neither of them. So adding a close listener silently turned the
 * title-bar X into a no-op: the native close was replaced by a JS-mediated
 * `destroy()` that the ACL refused, and the rejection was swallowed inside the
 * listener.
 *
 * That class of bug is invisible to every other test, so it gets its own audit.
 * The effective permission set is computed from the ACL manifest the build
 * generates, so `core:default` expanding into `core:window:default` is accounted
 * for rather than hand-copied.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MANIFEST = JSON.parse(
  readFileSync(new URL('../src-tauri/gen/schemas/acl-manifests.json', import.meta.url), 'utf8'),
);
const capability = (name) =>
  JSON.parse(readFileSync(new URL(`../src-tauri/capabilities/${name}`, import.meta.url), 'utf8'));

/**
 * Expand a permission id into the concrete `plugin:permission` grants it stands
 * for, following `default` sets (including the nested `core:default`).
 */
function resolve(id, seen = new Set()) {
  if (seen.has(id)) return [];
  seen.add(id);
  // `core:default` is the core plugin's own set, while `core:window:allow-x` is
  // the window plugin's — so the plugin id is `core:<x>` only when there IS an
  // <x>. Getting this wrong makes the expansion silently return nothing.
  const parts = id.split(':');
  const isCorePlugin = parts[0] === 'core' && parts.length >= 3;
  const plugin = isCorePlugin ? `core:${parts[1]}` : parts[0];
  const rest = (isCorePlugin ? parts.slice(2) : parts.slice(1)).join(':');
  const manifest = MANIFEST[plugin];
  if (!manifest) return [id];
  if (rest === 'default') {
    return (manifest.default_permission?.permissions ?? []).flatMap((p) =>
      // A plugin's own default set lists BARE names (`allow-close`), while the
      // core set lists ALREADY-QUALIFIED ones (`core:event:default`). Prefixing
      // blindly turns the latter into `core:core:event:default` and the whole
      // expansion silently returns nothing.
      resolve(p.includes(':') ? p : `${plugin}:${p}`, seen),
    );
  }
  return [`${plugin}:${rest}`];
}

const effective = (cap) => new Set(cap.permissions.flatMap((p) => resolve(p)));

/** JS window API method -> the permission it needs. */
const NEEDS = {
  destroy: 'core:window:allow-destroy',
  close: 'core:window:allow-close',
  startDragging: 'core:window:allow-start-dragging',
  setSize: 'core:window:allow-set-size',
  setPosition: 'core:window:allow-set-position',
  setIgnoreCursorEvents: 'core:window:allow-set-ignore-cursor-events',
  setAlwaysOnTop: 'core:window:allow-set-always-on-top',
  setSkipTaskbar: 'core:window:allow-set-skip-taskbar',
  show: 'core:window:allow-show',
  hide: 'core:window:allow-hide',
  setFocus: 'core:window:allow-set-focus',
  // Tauri implements onCloseRequested as `handler(); if (!prevented) destroy()`
  // — so listening for the close event is what makes `destroy` mandatory.
  onCloseRequested: 'core:window:allow-destroy',
};

/** Which window each file runs in, and therefore which capability governs it. */
const WHERE = [
  ['src/host/ctx.js', 'default.json', 'the main window (host + builtin plugins)'],
  ['src/host/pluginwin-host.js', 'pluginwin.json', 'plugin-* windows'],
  ['src/plugins/floatwin-widget.js', 'floatwin.json', 'the floating widget'],
];

const methodsUsed = (source) => {
  const found = new Set();
  for (const m of source.matchAll(/\.([a-zA-Z]+)\(/g)) {
    if (NEEDS[m[1]]) found.add(m[1]);
  }
  return found;
};

for (const [file, capFile, where] of WHERE) {
  test(`${where}: every window API it calls is permitted`, () => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const cap = capability(capFile);
    const granted = effective(cap);
    const missing = [...methodsUsed(source)]
      .map((m) => [m, NEEDS[m]])
      .filter(([, perm]) => !granted.has(perm));

    assert.deepEqual(
      missing,
      [],
      `${file} calls ${missing.map(([m]) => `${m}()`).join(', ')} but ${capFile} does not grant ` +
        `${missing.map(([, p]) => p).join(', ')} — the call would fail silently at runtime`,
    );
  });
}

test('a close listener requires allow-destroy, because that is how Tauri closes', () => {
  // The specific trap, stated on its own so a regression is unmistakable.
  const ctx = readFileSync(new URL('../src/host/ctx.js', import.meta.url), 'utf8');
  assert.match(ctx, /onCloseRequested/, 'the host exposes a close listener');
  assert.ok(
    effective(capability('default.json')).has('core:window:allow-destroy'),
    'the main window must be allowed to destroy itself, or its X button does nothing',
  );
});

test('the effective set really does expand core:default', () => {
  // Guards the resolver: if this ever came back empty, every check above would
  // pass vacuously.
  const granted = effective(capability('default.json'));
  assert.ok(granted.has('core:window:allow-get-all-windows'), 'window:default is expanded');
  assert.ok(granted.has('core:event:allow-listen'), 'event:default is expanded');
  assert.ok(!granted.has('core:window:allow-nonsense'), 'and it is not a blanket allow');
});
