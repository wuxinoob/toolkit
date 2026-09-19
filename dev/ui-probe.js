/**
 * Development harness for the plugin-facing component factory.
 *
 * Why this exists: a plugin cannot activate outside Tauri (the first thing the
 * loader does is register with the native permission gate), so there is no way
 * to see `ctx.ui` output in a plain browser — and "render it and look" is the
 * only honest test for a component factory. This page drives `src/host/ui.js`
 * directly, with the same tree shapes a plugin would build.
 *
 * It is a DEV page, not shipped: `vite build` only takes `index.html` as an
 * entry, so this file never reaches the bundle.
 *
 *   npm run dev   ->  http://127.0.0.1:1420/ui-probe.html
 *
 * Two sections:
 *   1. compositions — realistic trees, so the layout can be judged
 *   2. vocabulary   — every tag `ctx.ui.el` accepts, straight from the loaded
 *                     kit, so an added/renamed component is visible immediately
 */
import '../src/assets/app.css';
import { createUiKit, el, loadUiKit, uiKitVocabulary } from '../src/host/ui.js';
import { normalizeThemeContribution, serializeThemeCss } from '../src/host/pluginTheme.js';

const kit = createUiKit({});

/**
 * The scenario the portal fix exists for: a plugin that declares
 * `contributes.theme`, and a dropdown inside it. The override is applied to the
 * container exactly as the host would, using the SAME serializer, so this page
 * cannot show a behaviour the app does not have.
 */
const PROBE_PLUGIN = 'probe.theme';
const probeContribution = normalizeThemeContribution({
  dark: { '--primary': '#c084fc' },
  light: { '--primary': '#7c3aed' },
});

function h(tag, props, ...children) {
  return el(tag, props, children.length ? children : undefined);
}

function section(title, note) {
  const wrap = document.createElement('section');
  wrap.className = 'tb-card';
  wrap.style.marginBottom = '14px';
  const head = document.createElement('div');
  head.className = 'tb-card-head';
  head.textContent = title;
  const body = document.createElement('div');
  body.className = 'tb-card-body';
  if (note) {
    const p = document.createElement('p');
    p.className = 'tb-hint';
    p.style.margin = '0 0 10px';
    p.textContent = note;
    body.appendChild(p);
  }
  wrap.append(head, body);
  return { wrap, body };
}

async function main() {
  const root = document.getElementById('app');
  root.className = 'tb-content';
  root.style.padding = '14px';

  const loaded = await loadUiKit();
  if (!loaded.size) {
    root.textContent = 'No components loaded — import.meta.glob found nothing.';
    return;
  }

  const title = document.createElement('h1');
  title.textContent = `Component factory · ${loaded.size} tags`;
  title.style.cssText = 'margin:0 0 4px;font-size:17px;font-weight:500;';
  const sub = document.createElement('p');
  sub.className = 'tb-hint';
  sub.style.margin = '0 0 14px';
  sub.textContent = 'The exact trees a plugin builds via ctx.ui.el(...). Dark/light follows the OS or localStorage.';
  root.append(title, sub);

  /* ------------------------------- compositions ------------------------------ */

  {
    const { wrap, body } = section(
      'Actions',
      'button — variant and size come straight from the component, not from a hand-written class',
    );
    kit.render(
      body,
      h('div', { class: 'tb-toolbar' },
        h('button', { variant: 'default' }, 'Default'),
        h('button', { variant: 'secondary' }, 'Secondary'),
        h('button', { variant: 'outline' }, 'Outline'),
        h('button', { variant: 'destructive' }, 'Destructive'),
        h('button', { variant: 'ghost' }, 'Ghost'),
        h('button', { variant: 'link' }, 'Link'),
        h('button', { size: 'sm', variant: 'outline' }, 'Small'),
        h('button', { size: 'icon', variant: 'outline' }, '✕'),
        h('button', { disabled: true }, 'Disabled'),
      ),
    );
    root.append(wrap);
  }

  {
    const { wrap, body } = section('Badges', 'badge — the status vocabulary');
    kit.render(
      body,
      h('div', { class: 'tb-toolbar' },
        h('badge', {}, 'default'),
        h('badge', { variant: 'secondary' }, 'secondary'),
        h('badge', { variant: 'destructive' }, 'destructive'),
        h('badge', { variant: 'outline' }, 'outline'),
      ),
    );
    root.append(wrap);
  }

  {
    const { wrap, body } = section('Form controls', 'input / textarea / checkbox / switch / slider / select / label');
    kit.render(
      body,
      h('div', { style: 'display:flex;flex-direction:column;gap:12px;max-width:460px;' },
        h('div', { style: 'display:flex;flex-direction:column;gap:6px;' },
          h('label', { for: 'p-name' }, 'Name'),
          h('input', { id: 'p-name', modelValue: 'backend-1' }),
        ),
        h('div', { style: 'display:flex;flex-direction:column;gap:6px;' },
          h('label', { for: 'p-note' }, 'Notes'),
          h('textarea', { id: 'p-note', rows: 2, modelValue: 'Markdown supported.' }),
        ),
        h('div', { style: 'display:flex;align-items:center;gap:16px;flex-wrap:wrap;' },
          h('div', { style: 'display:flex;align-items:center;gap:8px;' },
            h('checkbox', { id: 'p-auto', modelValue: true }),
            h('label', { for: 'p-auto' }, 'Auto-start'),
          ),
          h('div', { style: 'display:flex;align-items:center;gap:8px;' },
            h('switch', { modelValue: true }),
            h('label', {}, 'Enabled'),
          ),
        ),
        h('div', { style: 'display:flex;flex-direction:column;gap:6px;' },
          h('label', {}, 'Interval'),
          h('slider', { modelValue: [40], max: 100, step: 1 }),
        ),
      ),
    );
    root.append(wrap);
  }

  {
    // The one that proves portal scoping: this dropdown is teleported, and the
    // kit should have pointed it at THIS container so the theme scope survives.
    const { wrap, body } = section(
      'Portalled component (the interesting one)',
      'select — its dropdown teleports. The kit injects portalTo so the popup stays inside this container instead of escaping to <body>.',
    );
    // Give the container a theme override, exactly as the host does for a
    // plugin's view. Then the popup's accent is observable: purple means the
    // portal stayed inside the scope, the app's blue means it escaped.
    body.setAttribute('data-plugin', PROBE_PLUGIN);
    const style = document.createElement('style');
    style.textContent = serializeThemeCss([[PROBE_PLUGIN, probeContribution]]);
    document.head.appendChild(style);

    kit.render(
      body,
      h('div', { style: 'display:flex;flex-direction:column;gap:8px;' },
        h('div', { class: 'tb-toolbar' },
          h('button', { variant: 'default' }, 'Purple, because of contributes.theme'),
          h('span', { class: 'tb-hint' }, '— this button is inside the scope'),
        ),
        h('select', { modelValue: 'pty-stream' },
          h('select-trigger', { class: 'w-[240px]' }, h('select-value', { placeholder: 'Pick a scheme' })),
          h('select-content', {},
            h('select-item', { value: 'rpc' }, 'rpc · invoke'),
            h('select-item', { value: 'channel-raw' }, 'channel-raw · binary'),
            h('select-item', { value: 'pty-stream' }, 'pty-stream · pty'),
            h('select-item', { value: 'event-bus' }, 'event-bus · broadcast'),
          ),
        ),
      ),
    );
    root.append(wrap);
  }

  {
    const { wrap, body } = section('Table', 'table / table-header / table-row / table-head / table-cell');
    kit.render(
      body,
      h('div', { class: 'tb-pane' },
        h('table', {},
          h('table-header', {},
            h('table-row', {},
              h('table-head', {}, 'id'),
              h('table-head', {}, 'transport · codec'),
              h('table-head', {}, 'direction'),
            ),
          ),
          h('table-body', {},
            h('table-row', {},
              h('table-cell', {}, h('code', { class: 'tb-mono tb-t-brand' }, 'rpc')),
              h('table-cell', {}, 'invoke · json-envelope'),
              h('table-cell', { class: 'tb-hint' }, 'bidirectional'),
            ),
            h('table-row', {},
              h('table-cell', {}, h('code', { class: 'tb-mono tb-t-brand' }, 'channel-raw')),
              h('table-cell', {}, 'channel · raw-binary'),
              h('table-cell', { class: 'tb-hint' }, 'downlink'),
            ),
          ),
        ),
      ),
    );
    root.append(wrap);
  }

  {
    const { wrap, body } = section('Tabs', 'tabs / tabs-list / tabs-trigger / tabs-content');
    kit.render(
      body,
      h('tabs', { modelValue: 'live', class: 'max-w-[520px]' },
        h('tabs-list', {},
          h('tabs-trigger', { value: 'live' }, 'Live'),
          h('tabs-trigger', { value: 'exited' }, 'Exited'),
        ),
        h('tabs-content', { value: 'live', class: 'pt-3' }, 'Two sessions running.'),
        h('tabs-content', { value: 'exited', class: 'pt-3' }, 'One session exited with code 0.'),
      ),
    );
    root.append(wrap);
  }

  {
    const { wrap, body } = section('Layout primitives', 'card / separator / skeleton / spinner / scroll-area');
    kit.render(
      body,
      h('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;' },
        h('card', { style: 'flex:1 1 220px;' },
          h('card-header', {}, h('card-title', {}, 'Card title'), h('card-description', {}, 'A short description.')),
          h('card-content', {}, 'Body content goes here.'),
          h('card-footer', {}, h('button', { size: 'sm', variant: 'outline' }, 'Action')),
        ),
        h('div', { style: 'flex:1 1 220px;display:flex;flex-direction:column;gap:10px;' },
          h('skeleton', { style: 'height:18px;' }),
          h('skeleton', { style: 'height:18px;width:60%;' }),
          h('separator', {}),
          h('div', { style: 'display:flex;align-items:center;gap:8px;' },
            h('spinner', {}),
            h('span', { class: 'tb-hint' }, 'spinner'),
          ),
        ),
      ),
    );
    root.append(wrap);
  }

  {
    const { wrap, body } = section(
      'Portal scoping check',
      'Each select above should open with a popover background matching this card, not the page background. If the theme scope leaked, the popup would render unstyled at the end of <body>.',
    );
    const out = document.createElement('div');
    out.className = 'tb-hint tb-mono';
    body.appendChild(out);
    // Rendered after mount, so the injected attribute is observable.
    requestAnimationFrame(() => {
      const targets = [...document.querySelectorAll('[data-reka-popper-content-wrapper]')];
      out.textContent = `popper wrappers in body: ${targets.length} (expected 0 until a select is opened)`;
    });
    root.append(wrap);
  }

  {
    const { wrap, body } = section('Vocabulary', 'every tag ctx.ui.el accepts, derived from what is installed');
    const list = document.createElement('div');
    list.className = 'tb-mono tb-hint';
    list.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
    for (const tag of uiKitVocabulary()) {
      const chip = document.createElement('span');
      chip.className = 'tb-badge';
      chip.textContent = tag;
      list.appendChild(chip);
    }
    body.appendChild(list);
    root.append(wrap);
  }
}

main().catch((e) => {
  document.getElementById('app').textContent = `probe failed: ${e?.stack || e}`;
});
