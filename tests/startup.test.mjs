import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

register('./helpers/startup-loader.mjs', import.meta.url);

test('a hidden window is shown before the host loads, without animation frames', { timeout: 2000 }, async (t) => {
  const trace = [];
  let finishShow;
  const show = new Promise((resolve) => { finishShow = resolve; });
  let onShow;
  const requested = new Promise((resolve) => { onShow = resolve; });
  let entry;
  t.after(async () => { finishShow(); await entry?.startup; });
  globalThis.__startupTest = { trace, show, onShow, label: 'main' };
  globalThis.window = { location: { search: '' } };
  // Hidden WebViews need not deliver animation frames at all.
  globalThis.requestAnimationFrame = () => { trace.push('animation-wait'); };

  entry = await import('../src/main.js?startup-test');
  await requested;
  assert.ok(trace.includes('show'), `the window stayed hidden: ${trace}`);
  assert.ok(!trace.includes('host-module'), 'loading the host must wait for show()');
  assert.ok(!trace.includes('animation-wait'), 'visibility must not depend on an animation frame');
  assert.ok(trace.indexOf('mount') < trace.indexOf('show'));
  assert.ok(trace.indexOf('dom-ready') < trace.indexOf('show'));

  finishShow();
  await entry.startup;
  assert.ok(trace.indexOf('show') < trace.indexOf('host-module'));
  assert.equal(trace.at(-1), 'boot');
});

test('the legacy plugin page redirects without mounting or booting the shell', async () => {
  const trace = [];
  globalThis.__startupTest = { trace, show: Promise.resolve(), label: 'plugin-old' };
  globalThis.window = { location: { search: '?mode=pluginwin&plugin=test.plugin&label=plugin-old' } };
  globalThis.location = { replace: (url) => trace.push(url) };
  const entry = await import('../src/main.js?legacy-startup-test');
  await entry.startup;
  assert.deepEqual(trace, ['pluginwin.html?mode=pluginwin&plugin=test.plugin&label=plugin-old']);
});

test('a failed show request still allows host startup and is not marked as shown', async (t) => {
  const trace = [];
  performance.clearMarks();
  t.mock.method(console, 'error', () => {});
  globalThis.__startupTest = {
    trace, label: 'main', onShow() { throw new Error('show rejected'); },
  };
  globalThis.window = { location: { search: '' } };
  const entry = await import('../src/main.js?show-failure-test');
  await entry.startup;
  assert.equal(trace.at(-1), 'boot');
  assert.equal(performance.getEntriesByName('toolkit:shown').length, 0);
  assert.equal(performance.getEntriesByName('toolkit:show-requested').length, 1);
});

test('a plugin window pointed at the shell cannot start another host', async () => {
  const trace = [];
  globalThis.__startupTest = { trace, label: 'plugin-misconfigured' };
  globalThis.window = { location: { search: '?mode=floatwin' } };
  globalThis.document = { body: { innerHTML: '' } };
  const entry = await import('../src/main.js?misplaced-window-test');
  await entry.startup;
  assert.deepEqual(trace, []);
  assert.match(document.body.innerHTML, /pluginwin\.html/);
});

test('a plain browser can mount the shell without a native show request', async () => {
  const trace = [];
  globalThis.__startupTest = { trace, browser: true };
  globalThis.window = { location: { search: '' } };
  const entry = await import('../src/main.js?browser-preview-test');
  await entry.startup;
  assert.ok(trace.includes('mount'));
  assert.ok(!trace.includes('show'));
  assert.equal(trace.at(-1), 'boot');
});

test('the initial shell dependency graph excludes host startup and plugin implementations', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pending = [resolve(root, 'src/main.js'), resolve(root, 'src/App.vue')];
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const specs = [
      ...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
      ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
    ].map((match) => match[1]);
    for (const spec of specs) {
      if (!spec.startsWith('.') && !spec.startsWith('@/')) continue;
      const base = spec.startsWith('@/') ? resolve(root, 'src', spec.slice(2)) : resolve(dirname(file), spec);
      const target = [base, `${base}.js`, `${base}.ts`, `${base}.vue`, resolve(base, 'index.ts')]
        .find((path) => existsSync(path) && statSync(path).isFile());
      assert.ok(target, `unresolved static dependency ${spec} in ${file}`);
      pending.push(target);
    }
  }
  const reached = [...seen].map((path) => path.slice(root.length).replace(/\\/g, '/'));
  assert.ok(reached.length > 10, 'the shell graph must traverse its actual components');
  assert.deepEqual(reached.filter((path) => /\/(plugins\/|views\/SettingsView|host\/(boot|lifecycle|plugins|registry)|core\/selftest)/.test(path)), []);
});
