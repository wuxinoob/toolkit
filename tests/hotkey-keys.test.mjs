/**
 * 捕获键盘按键 → 快捷键字符串。
 *
 * 设置页有两处输入热键（插件声明的行、宿主的召唤键），它们共用这一份规则；
 * 这些断言就是"两处一致"的定义。规则本身很小，但每一条都对应一个真实的坑：
 *
 *   - 只按修饰键不能提交（否则按 Ctrl 的瞬间就把 "ctrl" 存下来了）；
 *   - 修饰键顺序固定（同一个绑定必须永远是同一个字符串，否则"已注册哪些键"
 *     这种比较会失效）；
 *   - 没有修饰键的可打印主键不接受（全局热键会在这台机器上吃掉那个键）；
 *   - 功能键可以单独用（F1–F24 本来就是给快捷键用的）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { comboFromEvent, isModifierKey, shortcutKeys } from '../src/host/hotkey-keys.js';

/** 只在测试里造事件：真实事件里这些字段由浏览器填。 */
const key = (k, { ctrl = false, alt = false, shift = false, meta = false } = {}) => ({
  key: k,
  ctrlKey: ctrl,
  altKey: alt,
  shiftKey: shift,
  metaKey: meta,
});

test('a combination becomes the modifier order everything else assumes', () => {
  assert.equal(comboFromEvent(key('t', { ctrl: true, alt: true })), 'ctrl+alt+t');
  // 按下的顺序不影响结果：修饰键的顺序是固定的。
  assert.equal(comboFromEvent(key('t', { alt: true, ctrl: true })), 'ctrl+alt+t');
  assert.equal(comboFromEvent(key('t', { ctrl: true, alt: true, shift: true, meta: true })), 'ctrl+alt+shift+super+t');
});

test('every modifier can lead, not just ctrl', () => {
  assert.equal(comboFromEvent(key('F5', { alt: true })), 'alt+F5');
  assert.equal(comboFromEvent(key('Enter', { shift: true })), 'shift+Enter');
  assert.equal(comboFromEvent(key(' ', { meta: true })), 'super+Space');
  assert.equal(comboFromEvent(key('ArrowUp', { alt: true })), 'alt+ArrowUp');
  assert.equal(comboFromEvent(key('T', { ctrl: true })), 'ctrl+t', '大写字母归一成小写');
});

test('a modifier on its own is not a combination yet', () => {
  for (const m of ['Control', 'Alt', 'Shift', 'Meta']) {
    assert.ok(isModifierKey(m));
    assert.equal(comboFromEvent(key(m, { ctrl: true, alt: true })), null, `${m} 自己不算`);
  }
  assert.equal(comboFromEvent(null), null);
  assert.equal(comboFromEvent(key('')), null);
});

test('a printable key with no modifier is refused, a function key is not', () => {
  // 全局热键会吃掉这个键：绑上 't' 就等于全机器打不出 t。
  for (const k of ['t', 'T', '5', ';', '/']) {
    assert.equal(comboFromEvent(key(k)), null, `${k} 不该能单独绑`);
  }
  for (const k of ['F1', 'F9', 'F12', 'F24']) {
    assert.equal(comboFromEvent(key(k)), k, `${k} 本来就该能单独绑`);
  }
  // 具名键（不需要字母）也放行：Space / Enter / ArrowUp…
  assert.equal(comboFromEvent(key('Enter')), 'Enter');
  assert.equal(comboFromEvent(key(' ')), 'Space');
});

test('a stored shortcut renders as keycaps, whatever case it was stored in', () => {
  assert.deepEqual(shortcutKeys('ctrl+alt+t'), ['Ctrl', 'Alt', 'T']);
  assert.deepEqual(shortcutKeys('Ctrl+Alt+T'), ['Ctrl', 'Alt', 'T'], '存量值的大小写不该影响展示');
  assert.deepEqual(shortcutKeys('super+Space'), ['Super', 'Space']);
  assert.deepEqual(shortcutKeys('alt+f5'), ['Alt', 'F5']);
  assert.deepEqual(shortcutKeys('meta+k'), ['Super', 'K'], 'meta 与 super 是同一个东西的两种写法');
  assert.deepEqual(shortcutKeys(''), []);
  assert.deepEqual(shortcutKeys(null), []);
});
