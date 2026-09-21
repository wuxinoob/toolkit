/**
 * Style decision aid: the border-token question, rendered.
 *
 * The finding: `--border` (region dividers) and `--input` (control outlines) hold
 * the SAME value, so one line is doing two jobs. You cannot lighten the dividers
 * without making the inputs vanish, or strengthen the inputs without thickening
 * every divider. This page renders the alternatives side by side so the choice
 * is a glance rather than a paragraph.
 *
 * DEV ONLY — `vite build` takes only `index.html` as an entry.
 *
 *   npm run dev  ->  http://127.0.0.1:1420/style-options.html
 */
import '../src/assets/app.css';
import { createUiKit, el, loadUiKit } from '../src/host/ui.js';

const kit = createUiKit({});

/** The variants, expressed as token overrides. Only the colour tokens change. */
const VARIANTS = [
  {
    key: 'current',
    title: 'A · 现状',
    note: '--border 与 --input 同一个值。一种线干两份活。',
    dark: {},
    light: {},
  },
  {
    key: 'split',
    title: 'B · 拆开（分隔线更轻，控件轮廓略强）',
    note: '分隔线退到几乎看不见，输入框反而更清楚。两个诉求各自满足。',
    dark: { '--border': '#1c212b', '--input': '#333b4a' },
    light: { '--border': '#e9edf4', '--input': '#c8d1e0' },
  },
  {
    key: 'quiet',
    title: 'C · 拆开 + card 不再描边',
    note: 'card 只靠表面色差表达层级（--card 与 --background 拉开一点），线条只留给控件和真正的分区。',
    dark: { '--border': '#1c212b', '--input': '#333b4a', '--card': '#171c26', '--background': '#0b0d12' },
    light: { '--border': '#e9edf4', '--input': '#c8d1e0', '--card': '#ffffff', '--background': '#eef1f6' },
    noCardBorder: true,
  },
];

/** One sample of the UI under test: the pieces where borders do real work. */
function sample(el, variant) {
  const cardStyle = variant.noCardBorder ? 'border:0;box-shadow:0 1px 2px rgb(0 0 0 / 0.04);' : '';
  return el(
    'div',
    { style: 'display:flex;flex-direction:column;gap:12px;' },
    el(
      'card',
      { style: cardStyle },
      el('card-header', {}, el('card-title', {}, 'Card title'), el('card-description', {}, 'Dividers inside and around')),
      el(
        'card-content',
        { style: 'display:flex;flex-direction:column;gap:12px;' },
        el('input', { defaultValue: 'an input — its outline is --input' }),
        el('textarea', { rows: 2, defaultValue: 'a textarea' }),
        el(
          'div',
          { style: 'display:flex;gap:14px;align-items:center;' },
          el('checkbox', { defaultValue: true }),
          el('switch', { defaultValue: true }),
          el('button', { variant: 'outline', size: 'sm' }, 'outline button'),
          el('button', { variant: 'default', size: 'sm' }, 'primary'),
        ),
        el('separator', {}),
        el(
          'table',
          {},
          el('table-header', {}, el('table-row', {}, el('table-head', {}, 'col'), el('table-head', {}, 'col'))),
          el('table-body', {}, el('table-row', {}, el('table-cell', {}, 'a'), el('table-cell', {}, 'b'))),
        ),
      ),
      el('card-footer', {}, el('span', { class: 'tb-hint' }, 'card-footer has a top border (a divider)')),
    ),
    el('div', { class: 'tb-hint' }, 'A plain divider:'),
    el('separator', {}),
  );
}

function column(el, theme, variant) {
  const tokens = theme === 'dark' ? variant.dark : variant.light;
  const style = Object.entries(tokens)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
  return el(
    'div',
    {
      style: `flex:1 1 320px;min-width:320px;display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:12px;${style}`,
    },
    el('div', { style: 'font-weight:500;' }, variant.title),
    el('div', { class: 'tb-hint', style: 'min-height:34px;' }, variant.note),
    sample(el, variant),
  );
}

async function main() {
  await loadUiKit();
  const root = document.getElementById('app');
  const q = new URLSearchParams(location.search);
  const theme = q.get('theme') ?? 'dark';
  const embed = q.get('embed') === '1';

  document.documentElement.dataset.theme = theme;

  // The theme tokens are declared on `:root[data-theme=…]`, so a nested element
  // with `data-theme` does NOT get them — the selector only matches the root.
  // Rather than duplicate the values here (which would drift from app.css), each
  // theme gets its own iframe: a separate document, where `:root` really is the
  // root and the real stylesheet applies untouched.
  if (!embed) {
    root.style.cssText = 'display:flex;flex-direction:column;gap:20px;';
    for (const t of ['dark', 'light']) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
      const label = document.createElement('div');
      label.className = 'tb-section-title';
      label.style.margin = '0';
      label.textContent = t === 'dark' ? '深色主题' : '浅色主题';
      const frame = document.createElement('iframe');
      frame.src = `?theme=${t}&embed=1`;
      frame.style.cssText =
        'width:100%;height:620px;border:1px solid var(--color-line);border-radius:10px;background:transparent;';
      wrap.append(label, frame);
      root.append(wrap);
    }
    return;
  }

  kit.render(
    root,
    el(
      'div',
      { style: 'display:flex;flex-direction:column;gap:18px;' },
      el(
        'div',
        {},
        el('h1', { style: 'margin:0 0 4px;font-size:16px;font-weight:500;' }, '边框令牌：三个选项，同一套内容'),
        el(
          'p',
          { class: 'tb-hint', style: 'margin:0;' },
          '同一个卡片、同一个输入框、同一条分隔线，只换颜色令牌。',
        ),
      ),
      el(
        'div',
        { style: 'display:flex;gap:14px;flex-wrap:wrap;align-items:stretch;' },
        ...VARIANTS.map((v) => column(el, theme, v)),
      ),
    ),
  );
}

main().catch((e) => {
  document.getElementById('app').textContent = String(e?.stack ?? e);
});
