import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { createI18n, useI18n } from 'vue-i18n';
import * as keys from '../src/host/hotkey-keys.js';
import { manifestText } from '../src/i18n/messages.js';

// Compile the real SFC and invoke the handlers on its rendered inputs. This
// catches a broken component call site even when the key converter still works.
const { descriptor } = parse(readFileSync(new URL('../src/views/SettingsView.vue', import.meta.url), 'utf8'));
const compiled = compileScript(descriptor, { id: 'settings-events', inlineTemplate: true }).content;
const code = ts.transpileModule(compiled, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function mount({ invoke = async () => {}, locale = 'en-US', languageError } = {}) {
  const bound = []; const notices = [];
  const localeListeners = new Set();
  let snapshot = { mode: 'manual', locale, resolvedLocale: locale, revision: 1 };
  const languageWrites = [];
  const messages = Object.fromEntries(['en-US', 'zh-CN'].map(language => [language,
    JSON.parse(readFileSync(new URL(`../src/i18n/locales/${language}/settings.json`, import.meta.url), 'utf8'))]));
  const i18n = createI18n({ legacy: false, locale, fallbackLocale: 'en-US', messages });
  const store = Vue.reactive({
    plugins: [{ id: 'test.keys', manifest: { id: 'test.keys', name: 'Keys', contributes: { hotkeys: [{ action: 'open', key: 'ctrl+alt+k' }] } }, status: 'active' }],
    settings: { hotkeys: {}, summonShortcut: 'ctrl+alt+t' }, schemes: [{id:'rpc',label:'invoke',direction:'up',capabilities:'ordered',note:'original diagnostic note'}],
  });
  const modules = {
    vue: { ...Vue, onMounted() {} },
    'vue-i18n': { useI18n },
    '../i18n/vue.js': { addMessages() {} },
    '../i18n/messages.js': { manifestText },
    '../i18n/locales/en-US/settings.json': messages['en-US'],
    '../i18n/locales/zh-CN/settings.json': messages['zh-CN'],
    '../i18n/state.js': {
      getLocaleSnapshot: () => snapshot,
      onLocaleChange(fn) { localeListeners.add(fn); return () => localeListeners.delete(fn); },
      async setLocale(value) {
        languageWrites.push(value);
        if (languageError) throw new Error(languageError);
        snapshot = { mode: value === 'system' ? 'system' : 'manual', locale: value === 'system' ? snapshot.locale : value, resolvedLocale: value === 'system' ? 'en-US' : value, revision: snapshot.revision + 1 };
        i18n.global.locale.value = snapshot.resolvedLocale;
        for (const fn of localeListeners) fn(snapshot);
        return snapshot;
      },
    },
    '@tauri-apps/api/core': { invoke },
    '../host/store.js': { store, saveSettings() {}, toast: (...args) => notices.push(args) },
    '../host/lifecycle.js': { async setHotkey(id, action, change) { bound.push({ id, action, ...change }); store.settings.hotkeys[`${id}:${action}`] = { key: change.key, enabled: false }; } },
    '../host/boot.js': { async applySummonShortcut() {} },
    '../host/plugins.js': { originOf: () => 'external', Origin: { EXTERNAL: 'external' } },
    '../protocol/hub.js': { hub: { request: async () => [] } },
    '../host/theme.js': { getResolvedTheme: () => 'light', getThemePref: () => 'system', onThemeChange: () => () => {} },
    '../host/updater.js': { updateState: { status: 'idle' } },
    '../host/hotkey-keys.js': keys,
  };
  function require(id) {
    if (id in modules) return modules[id];
    if (id.startsWith('@/components/ui/')) {
      const component = { inheritAttrs: false, setup(_, { attrs, slots }) { return () => Vue.h(id.endsWith('/button') ? 'button' : 'section', attrs, slots.default?.()); } };
      return new Proxy({}, { get: () => component });
    }
    throw new Error(`unstubbed module: ${id}`);
  }
  const exports = {};
  new Function('require', 'exports', code)(require, exports);
  const make = (tag, text = '') => ({ tag, text, props: {}, children: [], parent: null });
  const insert = (node, parent, anchor) => {
    if (node.parent) { const old = node.parent.children; old.splice(old.indexOf(node), 1); }
    node.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(at < 0 ? parent.children.length : at, 0, node);
  };
  const renderer = Vue.createRenderer({
    createElement: tag => make(tag), createText: text => make('#text', text), createComment: text => make('#comment', text),
    patchProp(node, key, _, value) { node.props[key] = value; },
    insert, remove(node) { const siblings = node.parent?.children; if (siblings) siblings.splice(siblings.indexOf(node), 1); },
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.children = []; node.text = text; },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1],
    insertStaticContent(content, parent, anchor) { const node = make('#static', content); insert(node, parent, anchor); return [node, node]; },
  });
  const root = make('root'); const app = renderer.createApp(exports.default); app.use(i18n); app.mount(root);
  const all = node => [node, ...node.children.flatMap(all)];
  const input = () => all(root).find(node => node.tag === 'input' && node.props.autocomplete === 'off' && !node.props['aria-label']);
  const models = () => all(root).find(node => node.tag === 'button' && all(node).some(child => /Manage models|Opening…/.test(child.text)));
  const key = (name, modifiers = {}) => {
    const node = input(); let prevented = false; let blurred = false;
    const event = { key: name, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers, preventDefault() { prevented = true; }, target: { blur() { blurred = true; node.props.onBlur(); } } };
    node.props.onKeydown(event); return { prevented, blurred };
  };
  return { app, store, input, models, bound, notices, key, root, all, localeListeners, languageWrites,
    languageSelect: () => all(root).find(node => ['system', 'en-US', 'zh-CN'].includes(node.props['model-value']) && node.props['onUpdate:modelValue']),
    text: () => all(root).map(node => node.text).join(' ') };
}

test('settings: clicking a binding and typing a combination reaches setHotkey', async () => {
  const view = mount();
  try {
    view.input().props.onFocus(); await Vue.nextTick(); assert.equal(view.input().props.value, '');
    const result = view.key('j', { ctrlKey: true, altKey: true }); await Vue.nextTick();
    assert.deepEqual(view.bound, [{ id: 'test.keys', action: 'open', key: 'ctrl+alt+j', enabled: null }]);
    assert.equal(view.input().props.value, 'ctrl+alt+j'); assert.ok(result.prevented && result.blurred);
  } finally { view.app.unmount(); }
});

test('settings: modifiers and invalid single letters do not silently bind', async () => {
  const view = mount();
  try {
    view.input().props.onFocus(); view.key('Control', { ctrlKey: true }); await Vue.nextTick(); assert.equal(view.bound.length, 0);
    view.key('x'); await Vue.nextTick(); assert.match(view.input().props.placeholder, /needs a modifier/);
    view.key('F8'); await Vue.nextTick(); assert.equal(view.bound[0].key, 'F8');
  } finally { view.app.unmount(); }
});

test('settings: Escape cancels and Backspace clears then permits another capture', async () => {
  const view = mount();
  try {
    view.input().props.onFocus(); view.key('Escape'); await Vue.nextTick(); assert.equal(view.bound.length, 0);
    view.input().props.onFocus(); assert.ok(view.key('Backspace').blurred); await Vue.nextTick(); assert.equal(view.bound[0].key, '');
    view.input().props.onFocus(); view.key('F7'); await Vue.nextTick(); assert.equal(view.bound[1].key, 'F7');
  } finally { view.app.unmount(); }
});

test('settings: Manage models suppresses double clicks and recovers after failure', async () => {
  let reject; let calls = 0;
  const view = mount({ invoke: () => { calls++; return new Promise((_, fail) => { reject = fail; }); } });
  try {
    const first = view.models().props.onClick(); view.models().props.onClick(); await Vue.nextTick();
    assert.equal(calls, 1); assert.equal(view.models().props.disabled, true);
    reject('WebView2 disconnected'); await first; await Vue.nextTick();
    assert.equal(view.models().props.disabled, false); assert.match(view.notices[0][0], /disconnected/);
  } finally { view.app.unmount(); }
});

test('settings: language switches in place, preserving hotkey capture and unsubscribing on unmount', async () => {
  const view = mount();
  try {
    view.input().props.onFocus(); await Vue.nextTick();
    await view.languageSelect().props['onUpdate:modelValue']('zh-CN'); await Vue.nextTick();
    assert.ok(view.text().includes('管理模型'));
    assert.ok(view.text().includes('控制请求'));
    assert.equal(view.input().props.value, '');
    view.key('F8'); await Vue.nextTick();
    assert.equal(view.bound[0].key, 'F8');
    assert.deepEqual(view.languageWrites, ['zh-CN']);
    assert.equal(view.localeListeners.size, 1);
  } finally { view.app.unmount(); }
  assert.equal(view.localeListeners.size, 0);
});

test('settings: a failed language save restores the selection and reports the error', async () => {
  const view = mount({ languageError: 'disk full' });
  try {
    await view.languageSelect().props['onUpdate:modelValue']('zh-CN'); await Vue.nextTick();
    assert.equal(view.languageSelect().props['model-value'], 'en-US');
    assert.ok(view.text().includes('disk full'));
    assert.ok(view.text().includes('Manage models'));
  } finally { view.app.unmount(); }
});
