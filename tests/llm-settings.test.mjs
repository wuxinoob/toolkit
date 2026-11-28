import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { createI18n, useI18n } from 'vue-i18n';
import * as reasoning from '../src/host/llm-reasoning.js';
import * as presets from '../src/host/llm-presets.js';

const { descriptor } = parse(readFileSync(new URL('../src/views/LlmSettingsView.vue', import.meta.url), 'utf8'));
const compiled = compileScript(descriptor, { id: 'llm-settings', inlineTemplate: true }).content;
const code = ts.transpileModule(compiled, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const flush = async () => { await new Promise(setImmediate); await Vue.nextTick(); };

async function mount({ policy = null, model = { id: 'mock' }, locale = 'en-US' } = {}) {
  let saved = {
    connections: [{ id: 'local', name: 'Local', adapter: 'openai-chat', baseUrl: 'http://127.0.0.1:1234/v1' }],
    profiles: [{ id: 'profile', name: 'Mock', connectionId: 'local', model: 'mock', maxOutputTokens: 2048, timeoutMs: 120000, allowImages: false, reasoning: policy, allowedPlugins: [] }],
    defaultProfile: 'profile',
  };
  const calls = [];
  const messages = Object.fromEntries(['en-US', 'zh-CN'].map(language => [language,
    JSON.parse(readFileSync(new URL(`../src/i18n/locales/${language}/llm.json`, import.meta.url), 'utf8'))]));
  const modules = {
    // DOM v-model directives are irrelevant to this renderer; their compiled
    // update handlers and the component's own event handlers remain intact.
    vue: { ...Vue, vModelText: {}, vModelSelect: {}, vModelCheckbox: {}, vModelRadio: {} },
    'vue-i18n': { useI18n },
    '../i18n/vue.js': { addMessages() {} },
    '../i18n/locales/en-US/llm.json': messages['en-US'],
    '../i18n/locales/zh-CN/llm.json': messages['zh-CN'],
    '../host/llm-reasoning.js': reasoning,
    '../host/llm-presets.js': presets,
    '@tauri-apps/api/core': { async invoke(command, { action, params }) {
      assert.equal(command, 'host_llm_admin');
      calls.push({ action, params: structuredClone(params) });
      if (action === 'load') return { config: structuredClone(saved), hasKeys: {}, plugins: [] };
      if (action === 'inspect_connection') return { status: 'available', models: [structuredClone(model)], elapsedMs: 1, hasMore: false };
      if (action === 'save') { saved = structuredClone(params); return; }
      throw new Error(`unexpected action: ${action}`);
    } },
  };
  const exports = {};
  new Function('require', 'exports', code)(id => {
    assert.ok(id in modules, `unstubbed module: ${id}`); return modules[id];
  }, exports);
  const make = (tag, text = '') => ({ tag, text, props: {}, children: [], parent: null });
  const insert = (node, parent, anchor) => {
    if (node.parent) { const siblings = node.parent.children; siblings.splice(siblings.indexOf(node), 1); }
    node.parent = parent;
    const at = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(at < 0 ? parent.children.length : at, 0, node);
  };
  const renderer = Vue.createRenderer({
    createElement: tag => make(tag), createText: text => make('#text', text), createComment: text => make('#comment', text),
    patchProp(node, key, _, value) { node.props[key] = value; }, insert,
    remove(node) { const siblings = node.parent?.children; if (siblings) siblings.splice(siblings.indexOf(node), 1); },
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.children = []; node.text = text; },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1],
    insertStaticContent(content, parent, anchor) { const node = make('#static', content); insert(node, parent, anchor); return [node, node]; },
  });
  const root = make('root');
  const app = renderer.createApp(exports.default);
  app.use(createI18n({ legacy: false, locale, fallbackLocale: 'en-US', messages }));
  app.mount(root); await flush();
  const all = (node = root) => [node, ...node.children.flatMap(child => all(child))];
  const text = node => all(node).map(child => child.text).join(' ');
  const button = label => all().find(node => node.tag === 'button' && text(node).trim() === label);
  return { app, calls, all, text: () => text(root), button,
    async click(label) { const node = button(label); assert.ok(node, `missing button: ${label}`); await node.props.onClick(); await flush(); },
    checkbox: () => all().find(node => node.tag === 'input' && node.props.type === 'checkbox' && node.props.onChange),
    efforts: () => all().find(node => node.tag === 'input' && node.props['aria-invalid'] !== undefined),
    saved: () => structuredClone(saved),
  };
}

test('LLM settings: unknown metadata starts an empty manual draft and blocks an incomplete save', async () => {
  const view = await mount();
  try {
    assert.match(view.text(), /API effort levels: unknown/);
    view.checkbox().props.onChange({ target: { checked: true } }); await flush();
    assert.equal(view.efforts().props.value, '');
    await view.click('Save settings');
    assert.equal(view.calls.filter(call => call.action === 'save').length, 0);
    assert.match(view.text(), /Enter at least one allowed effort for Mock/);
    view.efforts().props.onChange({ target: { value: 'custom, future_level' } }); await flush();
    await view.click('Save settings');
    assert.deepEqual(view.saved().profiles[0].reasoning.allowedEfforts, ['custom', 'future_level']);
    assert.equal(view.saved().profiles[0].reasoning.defaultEffort, null);
  } finally { view.app.unmount(); }
});

test('LLM settings: querying preserves existing policy; applying adopts only declared levels and default', async () => {
  const policy = { allowedEfforts: ['manual'], defaultEffort: 'manual', chatOutputTokens: 'max_tokens' };
  const view = await mount({ policy, model: { id: 'mock', reasoningEfforts: ['low', 'max'], defaultReasoningEffort: 'max' } });
  try {
    await view.click('Query API effort declarations');
    assert.match(view.text(), /API-declared levels: low, max; declared default: max/);
    assert.equal(view.efforts().props.value, 'manual');
    assert.equal(view.calls.filter(call => call.action === 'save').length, 0);
    await view.click('Apply API-declared levels and default');
    assert.equal(view.efforts().props.value, 'low, max');
    await view.click('Save settings');
    assert.deepEqual(view.saved().profiles[0].reasoning.allowedEfforts, ['low', 'max']);
    assert.equal(view.saved().profiles[0].reasoning.defaultEffort, 'max');
    assert.equal(view.saved().profiles[0].reasoning.chatOutputTokens, 'max_tokens');
    assert.ok(!view.saved().profiles[0].reasoning.allowedEfforts.includes('none'));
  } finally { view.app.unmount(); }
});

test('LLM settings: explicit absence is displayed separately from unknown and does not imply thinking is disabled', async () => {
  const view = await mount({ model: { id: 'mock', reasoningEfforts: [] }, locale: 'zh-CN' });
  try {
    await view.click('查询 API 等级声明');
    assert.match(view.text(), /API 声明未提供可用的思考等级/);
    assert.equal(view.checkbox().props.checked, false);
    assert.equal(view.button('采用 API 声明的等级与默认值'), undefined);
    assert.match(view.text(), /并不关闭模型思考/);
  } finally { view.app.unmount(); }
});
