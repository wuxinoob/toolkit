/**
 * 键盘事件 ↔ 快捷键字符串。纯函数，没有 DOM、没有 Tauri。
 *
 * 设置页有两处需要"按一下键"：插件声明的每一条热键，以及宿主自己的**召唤热键**。
 * 它们必须收发同一种字符串，否则同一份设置会在两个地方表现不同 —— 所以这份规则
 * 只有一份，放在这里，而不是塞进某个组件里。
 *
 * 字符串形态跟 Rust 侧的 `parse_shortcut`（以及 tauri-plugin-global-shortcut）一致：
 *
 *   ctrl+alt+t   alt+shift+F5   super+Space
 *
 * 修饰键固定 ctrl → alt → shift → super 的顺序，主键放最后：顺序固定了，
 * "同一个绑定"在设置里、日志里、注册表里才是同一个字符串。
 */

/** 只按下修饰键不算一个组合 —— 用户还在往组合键上凑。 */
export function isModifierKey(key) {
  return key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta';
}

/** 浏览器给的 `event.key` → Tauri `Code` 里的写法。 */
function normalizeKey(key) {
  if (!key) return '';
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toLowerCase(); // 'T' → 't'，与 Tauri 的解析一致
  return key; // Enter / ArrowUp / F5 / Tab …原样
}

/**
 * 单独一个键，能不能当**全局**热键？
 *
 * 全局热键抢在所有应用之前：把单字母或数字绑上去，等于在这台机器上吃掉那个键 ——
 * 用户会发现自己突然打不出 `t` 了，而且很难想到是这里。所以"没有修饰键的可打印主键"
 * 一律不接受；功能键（F1–F24）例外，它们本来就是给快捷键准备的。
 *
 * 这是**捕获输入**的规则，不是清单语法的规则：插件在 `plugin.json` 里声明什么键，
 * 宿主仍旧照收（那是作者的选择，而且在启用之前不会真的注册）。
 */
function isBindableAlone(key) {
  if (/^F([1-9]|1\d|2[0-4])$/.test(key)) return true;
  return key.length > 1; // 具名键：Space / Enter / ArrowUp / Escape…
}

/**
 * 一次 keydown → 快捷键字符串，还没成型就返回 `null`。
 *
 * 返回 null 的三种情况：只按了修饰键；主键是空的；没有修饰键的可打印主键（见上）。
 */
export function comboFromEvent(event) {
  if (!event || isModifierKey(event.key)) return null;

  const parts = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  if (event.metaKey) parts.push('super');

  const key = normalizeKey(event.key);
  if (!key) return null;
  if (parts.length === 0 && !isBindableAlone(key)) return null;

  parts.push(key);
  return parts.join('+');
}

const PRETTY = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
  cmd: 'Super',
  space: 'Space',
  escape: 'Esc',
};

/**
 * 把一个绑定渲染成键帽用的片段：`'super+Space'` → `['Super', 'Space']`。
 *
 * 同时负责"把存量值弄好看"：设置里可能存着大小写不一的旧值（`Ctrl+Alt+T`），
 * 这里统一成展示形态，而不是要求存储值也先规范化。
 */
export function shortcutKeys(combo) {
  return String(combo ?? '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (PRETTY[lower]) return PRETTY[lower];
      if (lower.length === 1) return lower.toUpperCase();
      if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase();
      return part;
    });
}
