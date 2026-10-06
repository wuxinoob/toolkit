/**
 * The native-props -> component-props translation in the component factory.
 *
 * ## Why a test, and why this one
 *
 * `value` is a real DOM property of `<input>` and `Input.vue` does not declare
 * it, so passing `value` to the component makes Vue write it onto the root
 * element as a fallthrough attr. Every re-render (the component's own `v-model`
 * proxy changes on each keystroke) then writes the value from the LAST render
 * back into the box, wiping what the user just typed.
 *
 * Measured in the dev probe before the fix: the box read `""` 5ms after a
 * keystroke while the plugin's state was already `"a"` — the data was correct
 * and only the display rolled back. That is the "输入字符会回退" bug.
 *
 * So the rule this file pins is not "translate nicely" but the specific thing
 * that was missing: **the native key must be CONSUMED, not left on the vnode.**
 *
 * The tag list is not copied into this file on purpose — it iterates the table
 * the runtime uses, so adding a control there cannot skip the guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORM_PROP_RULES, normalizeFormProps } from '../src/host/ui.js';

const NATIVE_EVENTS = ['oninput', 'onInput', 'onchange', 'onChange'];

const makeHandler = () => () => {};

/** How many ways the plugin's "the value changed" handler can be reached. */
function deliveryPaths(props) {
  const native = NATIVE_EVENTS.filter((k) => typeof props[k] === 'function').length;
  const bridge = typeof props['onUpdate:modelValue'] === 'function' ? 1 : 0;
  return native + bridge;
}

test('every form control: the native key is consumed and the value reaches the component', () => {
  const tags = Object.entries(FORM_PROP_RULES);
  assert.ok(tags.length >= 8, `表里只剩 ${tags.length} 个控件 —— 抽取规则过期了`);

  for (const [tag, nativeKey] of tags) {
    const out = normalizeFormProps(tag, { [nativeKey]: 'v', oninput: makeHandler() });

    assert.ok(
      !(nativeKey in out),
      `${tag}: 原生 ${nativeKey} 必须从 props 里删掉 —— 留着就会作为 fallthrough attr 落到真实 DOM 上，` +
        `重渲染时把用户刚输入的字符写回去（这正是「输入回退」）。`,
    );
    assert.equal(out.modelValue, 'v', `${tag}: ${nativeKey} 应翻译成 modelValue`);
    assert.equal(out.defaultValue, 'v', `${tag}: ${nativeKey} 应翻译成 defaultValue`);
  }
});

test('every form control: exactly ONE way for the handler to be reached', () => {
  // Two paths is not a performance note: the plugin's handler would run twice
  // per keystroke, which silently double-applies anything that is not a plain
  // assignment (append, toggle, push).
  for (const [tag, nativeKey] of Object.entries(FORM_PROP_RULES)) {
    const out = normalizeFormProps(tag, { [nativeKey]: 'v', oninput: makeHandler() });
    assert.equal(deliveryPaths(out), 1, `${tag}: 插件的 handler 必须只有一条送达路径`);
  }
});

test('text controls keep the REAL native event (it carries more than target.value)', () => {
  // `preventDefault`, `selectionStart`, `e.target.files`: a bridged
  // `{ target: { value } }` cannot answer any of those, so for the controls
  // that render a real <input>/<textarea> the native listener stays.
  for (const tag of ['input', 'textarea', 'number-field']) {
    const out = normalizeFormProps(tag, { value: 'v', oninput: makeHandler() });
    assert.equal(typeof out.oninput, 'function', `${tag}: 原生事件不该被换成合成事件`);
    assert.equal(out['onUpdate:modelValue'], undefined, `${tag}: 不该再加一条桥`);
  }
});

test('a non-text control bridges, because nothing native ever fires on it', () => {
  // A reka root renders a button/div: `input`/`change` never arrive there, so
  // `onchange` on a checkbox would simply never run.
  for (const tag of ['checkbox', 'switch', 'select']) {
    const calls = [];
    const out = normalizeFormProps(tag, { checked: true, onchange: (e) => calls.push(e) });
    assert.equal(typeof out['onUpdate:modelValue'], 'function', `${tag}: 应该桥成 update:modelValue`);
    out['onUpdate:modelValue'](true);
    assert.deepEqual(calls, [{ target: { value: true, checked: true } }], `${tag}: 合成事件要带 value 和 checked`);
  }
});

test('switch/checkbox keep `value` — it is a real prop there, not a native key', () => {
  const out = normalizeFormProps('switch', { value: 'on', checked: true, onchange: makeHandler() });
  assert.equal(out.value, 'on', 'reka 的 SwitchRoot.value 是「表单提交值」，删掉就是另一个 bug');
  assert.equal(out.modelValue, true);
  assert.ok(!('checked' in out), 'checked 才是要翻译的那个原生键');
});

test("native input: `type: 'checkbox' | 'radio'` is left completely alone", () => {
  // `el('input', { type: 'checkbox' })` asks for the NATIVE control; value and
  // checked are real attributes there. Translating them would silently break
  // the one case that wants the browser's own behaviour.
  const props = { type: 'checkbox', value: 'a', checked: true };
  assert.equal(normalizeFormProps('input', props), props, '应当原样返回（同一个对象）');
  assert.equal(normalizeFormProps('input', { type: 'radio', value: 'a' }).value, 'a');
});

test('defaultValue alone stays uncontrolled — no modelValue is invented', () => {
  // Adding `modelValue` where the plugin did not ask for it turns a working
  // uncontrolled field into a controlled one.
  const out = normalizeFormProps('input', { defaultValue: 'x' });
  assert.equal(out.defaultValue, 'x');
  assert.ok(!('modelValue' in out));
  assert.equal(deliveryPaths(out), 0);
});

test('a plugin-supplied component handler wins, and the native one is dropped', () => {
  const own = makeHandler();
  const out = normalizeFormProps('checkbox', {
    checked: false,
    'onUpdate:modelValue': own,
    onchange: makeHandler(),
  });
  assert.equal(out['onUpdate:modelValue'], own);
  assert.ok(!('onchange' in out), '两条路都留着就会调用两次');
});

test('tags that are not form controls are not touched at all', () => {
  const props = { value: 'x', class: 'tb-input' };
  assert.equal(normalizeFormProps('div', props), props);
  assert.equal(normalizeFormProps('button', props), props);
  assert.equal(normalizeFormProps('select-item', { value: 'rpc' }).value, 'rpc');
});
