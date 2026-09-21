/**
 * gallery.demo — every component the host hands to plugins, rendered live.
 *
 * Two things this demonstrates that the other examples do not:
 *
 *   1. **`permissions: []`.** This plugin declares NO capabilities at all. It is
 *      pure UI built from `ctx.ui`, and the component factory is not gated —
 *      it constructs DOM and touches nothing native. The permission list is a
 *      statement about what a plugin can DO, not about how much it can show.
 *
 *   2. **The whole vocabulary is reachable from a drop-in plugin.** This file is
 *      a Blob-URL single-file ESM: it cannot import anything. Every component
 *      below arrives through `ctx.ui`, which is the same trick `ctx.protocol`
 *      uses for the wire contract.
 *
 * The panels are grouped the way the upstream docs group them. Components that
 * need real data or a controller (chart, carousel, sidebar, form validation) are
 * shown in their simplest working form rather than exhaustively.
 */

export const manifest = {
  id: 'gallery.demo',
  name: 'Component Gallery',
  version: '0.1.0',
  api: 2,
  description: 'Every component ctx.ui offers, rendered in the main window.',
  contributes: {
    views: [{ slot: 'tool', id: 'gallery', title: 'Gallery', icon: '🧩' }],
  },
  // Not an oversight: nothing here reaches native code. `ctx.ui` builds DOM.
  permissions: [],
};

const state = { ctx: null, toast: null };

/* --------------------------------- helpers --------------------------------- */

/** A labelled row, so each component is identifiable in the gallery. */
function row(el, label, ...nodes) {
  return el(
    'div',
    { style: 'display:flex;flex-direction:column;gap:6px;' },
    el('span', { class: 'tb-label' }, label),
    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;' }, ...nodes),
  );
}

function section(el, title, ...nodes) {
  return el(
    'card',
    {},
    el('card-header', {}, el('card-title', {}, title)),
    el('card-content', { style: 'display:flex;flex-direction:column;gap:16px;' }, ...nodes),
  );
}

const note = (el, text) => el('p', { class: 'tb-hint', style: 'margin:0;' }, text);

/* ---------------------------------- panels --------------------------------- */

function basics(el) {
  return [
    section(
      el,
      'Button',
      row(
        el,
        'variant',
        el('button', {}, 'Default'),
        el('button', { variant: 'secondary' }, 'Secondary'),
        el('button', { variant: 'outline' }, 'Outline'),
        el('button', { variant: 'destructive' }, 'Destructive'),
        el('button', { variant: 'ghost' }, 'Ghost'),
        el('button', { variant: 'link' }, 'Link'),
      ),
      row(
        el,
        'size',
        el('button', { size: 'xs' }, 'xs'),
        el('button', { size: 'sm' }, 'sm'),
        el('button', {}, 'default'),
        el('button', { size: 'lg' }, 'lg'),
        el('button', { size: 'icon' }, '✕'),
        el('button', { disabled: true }, 'disabled'),
      ),
    ),
    section(
      el,
      'Badge · Kbd · Separator',
      row(
        el,
        'badge',
        el('badge', {}, 'default'),
        el('badge', { variant: 'secondary' }, 'secondary'),
        el('badge', { variant: 'destructive' }, 'destructive'),
        el('badge', { variant: 'outline' }, 'outline'),
      ),
      row(el, 'kbd', el('kbd', {}, 'Ctrl'), el('kbd-group', {}, el('kbd', {}, 'Alt'), el('kbd', {}, 'T'))),
      row(el, 'separator', el('div', { style: 'width:100%;' }, el('separator', {}))),
    ),
    section(
      el,
      'Avatar · Skeleton · Spinner · Progress',
      row(
        el,
        'avatar',
        el('avatar', {}, el('avatar-fallback', {}, 'TB')),
        el('avatar', { class: 'size-12' }, el('avatar-fallback', {}, '42')),
      ),
      row(el, 'skeleton', el('skeleton', { style: 'height:16px;width:200px;' })),
      row(el, 'spinner', el('spinner', {}), note(el, 'animated while the parent is mounted')),
      row(el, 'progress', el('progress', { modelValue: 62, class: 'w-[240px]' }), el('span', { class: 'tb-hint' }, '62%')),
    ),
    section(
      el,
      'Toggle · ToggleGroup · AspectRatio',
      row(el, 'toggle', el('toggle', {}, 'Bold'), el('toggle', { variant: 'outline' }, 'Italic')),
      row(
        el,
        'toggle-group',
        el('toggle-group', { type: 'single', defaultValue: 'left' },
          el('toggle-group-item', { value: 'left' }, 'Left'),
          el('toggle-group-item', { value: 'center' }, 'Center'),
          el('toggle-group-item', { value: 'right' }, 'Right'),
        ),
      ),
      row(el, 'aspect-ratio', el('aspect-ratio', { ratio: 16 / 9, style: 'width:220px;border-radius:var(--radius-md);overflow:hidden;background:var(--color-muted);' })),
    ),
  ];
}

function forms(el) {
  return [
    section(
      el,
      'Input · Textarea · Label',
      row(el, 'input', el('input', { defaultValue: 'hello', class: 'max-w-[240px]' })),
      row(el, 'input (disabled)', el('input', { defaultValue: 'read only', disabled: true, class: 'max-w-[240px]' })),
      row(el, 'textarea', el('textarea', { rows: 3, defaultValue: 'multi\nline', class: 'max-w-[320px]' })),
    ),
    section(
      el,
      'NumberField · InputGroup',
      row(
        el,
        'number-field',
        el('number-field', { defaultValue: 3, min: 0, max: 10, class: 'max-w-[180px]' },
          el('number-field-content', {},
            el('number-field-decrement', {}, '−'),
            el('number-field-input', {}),
            el('number-field-increment', {}, '+'),
          ),
        ),
        note(el, 'the stepper input — increment / decrement are part of the component'),
      ),
      row(
        el,
        'input-group',
        el('input-group', { class: 'max-w-[280px]' },
          el('input-group-input', { placeholder: 'Search…' }),
          el('input-group-addon', {}, '@'),
        ),
      ),
    ),
    section(
      el,
      'Select · NativeSelect',
      row(
        el,
        'select',
        el('select', { defaultValue: 'rpc' },
          el('select-trigger', { class: 'w-[200px]' }, el('select-value', { placeholder: 'Pick a scheme' })),
          el('select-content', {},
            el('select-item', { value: 'rpc' }, 'rpc'),
            el('select-item', { value: 'channel-raw' }, 'channel-raw'),
            el('select-item', { value: 'pty-stream' }, 'pty-stream'),
          ),
        ),
      ),
      row(
        el,
        'native-select',
        el('native-select', {},
          el('native-select-option', { value: 'a' }, 'native A'),
          el('native-select-option', { value: 'b' }, 'native B'),
        ),
        note(
          el,
          'a real <select> — use it when something reads the form back with FormData, which cannot see the Select component (that one is a button).',
        ),
        // Worth stating plainly rather than letting it read as an unfixed bug:
        // opening this adds ZERO nodes to the DOM (measured 1614 -> 1614). The
        // option list is drawn by the OS outside the document, so no CSS can
        // reach it — not a gap in the styling, a platform limit. `select` above
        // is fully themeable precisely because its popup is a real DOM element.
        note(el, '↑ the open dropdown is drawn by the OS and cannot be themed; compare the select above.'),
      ),
    ),
    section(
      el,
      'Checkbox · Switch · RadioGroup · Slider',
      row(el, 'checkbox', el('checkbox', { defaultValue: true }), el('checkbox', {}), el('checkbox', { disabled: true })),
      row(el, 'switch', el('switch', { defaultValue: true }), el('switch', {})),
      row(
        el,
        'radio-group',
        el('radio-group', { defaultValue: 'a', class: 'flex gap-4' },
          el('radio-group-item', { value: 'a' }), el('span', { class: 'tb-hint' }, 'A'),
          el('radio-group-item', { value: 'b' }), el('span', { class: 'tb-hint' }, 'B'),
        ),
      ),
      row(el, 'slider', el('slider', { defaultValue: [40], max: 100, step: 1, class: 'w-[240px]' })),
    ),
    section(
      el,
      'InputOTP · PinInput · TagsInput',
      row(el, 'input-otp', el('input-otp', { maxlength: 6 }, el('input-otp-group', {}, el('input-otp-slot', { index: 0 }), el('input-otp-slot', { index: 1 }), el('input-otp-slot', { index: 2 })))),
      row(el, 'pin-input', el('pin-input', { otp: true, type: 'number' }, ...[0, 1, 2].map((i) => el('pin-input-slot', { index: i })))),
      row(el, 'tags-input', el('tags-input', { defaultValue: ['alpha', 'beta'], class: 'max-w-[320px]' }, el('tags-input-input', { placeholder: 'Add…' }))),
    ),
    section(
      el,
      'Calendar',
      row(el, 'calendar', el('calendar', { class: 'rounded-md border' })),
    ),
  ];
}

function data(el) {
  return [
    section(
      el,
      'Table',
      el('div', { style: 'overflow-x:auto;border:1px solid var(--color-line);border-radius:var(--radius-md);' },
        el('table', {},
          el('table-header', {}, el('table-row', {}, el('table-head', {}, 'id'), el('table-head', {}, 'transport · codec'), el('table-head', {}, 'direction'))),
          el('table-body', {},
            el('table-row', {}, el('table-cell', {}, 'rpc'), el('table-cell', {}, 'invoke · json-envelope'), el('table-cell', {}, 'both')),
            el('table-row', {}, el('table-cell', {}, 'channel-raw'), el('table-cell', {}, 'channel · raw-binary'), el('table-cell', {}, 'down')),
          ),
        ),
      ),
    ),
    section(
      el,
      'Accordion · Collapsible',
      el('accordion', { type: 'single', collapsible: true, defaultValue: 'one' },
        el('accordion-item', { value: 'one' },
          el('accordion-trigger', {}, 'First section'),
          el('accordion-content', {}, 'Content of the first section.'),
        ),
        el('accordion-item', { value: 'two' },
          el('accordion-trigger', {}, 'Second section'),
          el('accordion-content', {}, 'Content of the second section.'),
        ),
      ),
      el('collapsible', {},
        el('collapsible-trigger', {}, 'Toggle details'),
        el('collapsible-content', {}, 'Hidden until you expand it.'),
      ),
    ),
    section(
      el,
      'Breadcrumb · Pagination',
      el('breadcrumb', {},
        el('breadcrumb-list', {},
          el('breadcrumb-item', {}, el('breadcrumb-link', { href: '#' }, 'Home')),
          el('breadcrumb-separator', {}),
          el('breadcrumb-item', {}, el('breadcrumb-link', { href: '#' }, 'Plugins')),
          el('breadcrumb-separator', {}),
          el('breadcrumb-item', {}, el('breadcrumb-page', {}, 'Gallery')),
        ),
      ),
      el('pagination', {},
        el('pagination-content', {},
          el('pagination-item', {}, el('pagination-previous', {})),
          el('pagination-item', {}, el('a', { href: '#', 'aria-current': 'page' }, '1')),
          el('pagination-item', {}, el('pagination-ellipsis', {})),
          el('pagination-item', {}, el('a', { href: '#' }, '2')),
          el('pagination-item', {}, el('pagination-next', {})),
        ),
      ),
    ),
    section(
      el,
      'Item · Empty',
      el('item', { variant: 'outline' },
        el('item-content', {}, el('item-title', {}, 'A list item'), el('item-description', {}, 'with a title and a description')),
      ),
      el('empty', {},
        el('empty-header', {}, el('empty-media', { variant: 'icon' }, '🧩'), el('empty-title', {}, 'Nothing here'), el('empty-description', {}, 'The empty state has its own component.')),
        el('empty-content', {}, el('button', { variant: 'outline', size: 'sm' }, 'Add one')),
      ),
    ),
    section(
      el,
      'Stepper',
      el('stepper', { defaultValue: 1, class: 'max-w-[420px]' },
        el('stepper-item', { step: 1 }, el('stepper-trigger', {}, el('stepper-indicator', {}, '1'), el('stepper-title', {}, 'Fetch')), el('stepper-separator', {})),
        el('stepper-item', { step: 2 }, el('stepper-trigger', {}, el('stepper-indicator', {}, '2'), el('stepper-title', {}, 'Build')), el('stepper-separator', {})),
        el('stepper-item', { step: 3 }, el('stepper-trigger', {}, el('stepper-indicator', {}, '3'), el('stepper-title', {}, 'Ship'))),
      ),
    ),
  ];
}

function overlays(el, ctx) {
  const toast = (msg, kind) => () => (kind ? state.toast[kind](msg) : state.toast(msg));

  return [
    section(
      el,
      'Tooltip · Popover · HoverCard',
      row(
        el,
        'tooltip',
        el('tooltip', {}, el('tooltip-trigger', { asChild: true }, el('button', { variant: 'outline' }, 'Hover me')), el('tooltip-content', {}, 'A tooltip')),
      ),
      row(
        el,
        'popover',
        el('popover', {},
          el('popover-trigger', { asChild: true }, el('button', { variant: 'outline' }, 'Open popover')),
          el('popover-content', { class: 'w-[220px]' }, 'Popover content.'),
        ),
      ),
      row(
        el,
        'hover-card',
        el('hover-card', {},
          el('hover-card-trigger', { asChild: true }, el('button', { variant: 'outline' }, 'Hover card')),
          el('hover-card-content', { class: 'w-[220px]' }, 'Hover card content.'),
        ),
      ),
    ),
    section(
      el,
      'DropdownMenu · ContextMenu · Menubar',
      row(
        el,
        'dropdown-menu',
        el('dropdown-menu', {},
          el('dropdown-menu-trigger', { asChild: true }, el('button', { variant: 'outline' }, 'Open menu')),
          el('dropdown-menu-content', {},
            el('dropdown-menu-label', {}, 'Actions'),
            el('dropdown-menu-item', {}, 'Rename'),
            el('dropdown-menu-item', {}, 'Duplicate'),
            el('dropdown-menu-separator', {}),
            el('dropdown-menu-item', { variant: 'destructive' }, 'Delete'),
          ),
        ),
      ),
      row(
        el,
        'context-menu',
        el('context-menu', {},
          el('context-menu-trigger', {}, 'Right-click this area'),
          el('context-menu-content', {}, el('context-menu-item', {}, 'Cut'), el('context-menu-item', {}, 'Copy')),
        ),
      ),
      row(
        el,
        'menubar',
        el('menubar', {},
          el('menubar-menu', {},
            el('menubar-trigger', {}, 'File'),
            el('menubar-content', {}, el('menubar-item', {}, 'New'), el('menubar-item', {}, 'Open')),
          ),
        ),
      ),
    ),
    section(
      el,
      'Dialog · AlertDialog · Sheet · Drawer',
      row(
        el,
        'dialog',
        el('dialog', {},
          el('dialog-trigger', { asChild: true }, el('button', { variant: 'outline' }, 'Open dialog')),
          el('dialog-content', {},
            el('dialog-header', {}, el('dialog-title', {}, 'Dialog title'), el('dialog-description', {}, 'Focus is trapped while this is open.')),
            el('dialog-footer', {}, el('dialog-close', { asChild: true }, el('button', { variant: 'outline' }, 'Close'))),
          ),
        ),
      ),
      row(
        el,
        'alert-dialog',
        el('alert-dialog', {},
          el('alert-dialog-trigger', { asChild: true }, el('button', { variant: 'destructive' }, 'Delete…')),
          el('alert-dialog-content', {},
            el('alert-dialog-header', {}, el('alert-dialog-title', {}, 'Are you sure?'), el('alert-dialog-description', {}, 'This cannot be undone.')),
            el('alert-dialog-footer', {}, el('alert-dialog-cancel', {}, 'Cancel'), el('alert-dialog-action', {}, 'Delete')),
          ),
        ),
      ),
      row(
        el,
        'sheet',
        el('sheet', {},
          el('sheet-trigger', { asChild: true }, el('button', { variant: 'outline' }, 'Open sheet')),
          el('sheet-content', {}, el('sheet-header', {}, el('sheet-title', {}, 'Sheet')), 'Slides in from the side.'),
        ),
      ),
      row(
        el,
        'drawer',
        el('drawer', {},
          el('drawer-trigger', { asChild: true }, el('button', { variant: 'outline' }, 'Open drawer')),
          el('drawer-content', {}, el('drawer-header', {}, el('drawer-title', {}, 'Drawer')), 'Slides up from the bottom.'),
        ),
      ),
    ),
    section(
      el,
      'Command · Combobox',
      row(el, 'command', el('command', { class: 'max-w-[320px] rounded-md border' },
        el('command-input', { placeholder: 'Type a command…' }),
        el('command-list', {}, el('command-empty', {}, 'No results.'),
          el('command-group', { heading: 'Suggestions' }, el('command-item', { value: 'a' }, 'Alpha'), el('command-item', { value: 'b' }, 'Beta')),
        ),
      )),
      row(el, 'combobox', el('combobox', { class: 'max-w-[320px]' },
        el('combobox-anchor', {}, el('combobox-input', { placeholder: 'Search…' }), el('combobox-trigger', {}, '⌄')),
        el('combobox-list', {}, el('combobox-empty', {}, 'Nothing found.'), el('combobox-item', { value: 'alpha' }, 'Alpha')),
      )),
    ),
    section(
      el,
      'Alert · Sonner',
      el('alert', {}, el('alert-title', {}, 'Heads up'), el('alert-description', {}, 'The Alert component is static; Sonner is the live one.')),
      row(
        el,
        'sonner (the host toaster)',
        el('button', { variant: 'outline', onClick: toast('A plain toast') }, 'toast'),
        el('button', { variant: 'outline', onClick: toast('Saved', 'success') }, 'success'),
        el('button', { variant: 'outline', onClick: toast('Something broke', 'error') }, 'error'),
        note(el, 'routed through the host toaster via ctx.ui.notify'),
      ),
    ),
  ];
}

function layout(el) {
  return [
    section(
      el,
      'Card',
      el('card', { class: 'max-w-[420px]' },
        el('card-header', {}, el('card-title', {}, 'Card title'), el('card-description', {}, 'With a description and an action.'), el('card-action', {}, el('button', { variant: 'ghost', size: 'xs' }, '⋯'))),
        el('card-content', {}, 'Body content.'),
        el('card-footer', {}, el('button', { variant: 'outline', size: 'sm' }, 'Action')),
      ),
    ),
    section(
      el,
      'Tabs · ScrollArea · Resizable',
      el('tabs', { defaultValue: 'one', class: 'max-w-[420px]' },
        el('tabs-list', {}, el('tabs-trigger', { value: 'one' }, 'One'), el('tabs-trigger', { value: 'two' }, 'Two')),
        el('tabs-content', { value: 'one', class: 'pt-3' }, 'First panel.'),
        el('tabs-content', { value: 'two', class: 'pt-3' }, 'Second panel.'),
      ),
      el('scroll-area', { class: 'h-[120px] w-[280px] rounded-md border p-2' },
        ...Array.from({ length: 12 }, (_, i) => el('div', { class: 'tb-hint' }, `scrollable line ${i + 1}`)),
      ),
      el('resizable-panel-group', { direction: 'horizontal', class: 'h-[140px] max-w-[420px] rounded-md border' },
        el('resizable-panel', { defaultSize: 40 }, el('div', { style: 'padding:10px;' }, 'left')),
        el('resizable-handle', { withHandle: true }),
        el('resizable-panel', { defaultSize: 60 }, el('div', { style: 'padding:10px;' }, 'right')),
      ),
    ),
    section(
      el,
      'Typography (via plain elements + tokens)',
      el('div', { style: 'display:flex;flex-direction:column;gap:6px;' },
        el('h1', { style: 'margin:0;font-size:22px;font-weight:500;' }, 'Heading 1'),
        el('h2', { style: 'margin:0;font-size:18px;font-weight:500;' }, 'Heading 2'),
        el('p', { style: 'margin:0;' }, 'Body text uses the inherited token colour, so it follows the theme.'),
        el('p', { class: 'tb-hint', style: 'margin:0;' }, 'Muted text.'),
        el('code', { class: 'tb-mono' }, 'inline code'),
      ),
    ),
  ];
}

/* --------------------------------- lifecycle --------------------------------- */

export async function activate(ctx) {
  state.ctx = ctx;
  // The host toaster, so this plugin does not need its own.
  state.toast = (msg, kind) => ctx.ui.notify(msg, kind ?? 'info');

  const { el, render, components } = ctx.ui;
  const vocabulary = components();

  ctx.registerView('gallery', (root) => {
    const panels = [
      ['Basics', basics(el)],
      ['Forms', forms(el)],
      ['Data', data(el)],
      ['Overlays', overlays(el, ctx)],
      ['Layout', layout(el)],
    ];

    // A plain stack rather than an outer Tabs. Two reasons: a gallery is meant
    // to be looked at all at once, and a nested Tabs would only ever render one
    // panel — which makes the page impossible to check without driving clicks.
    // (The Tabs component is demonstrated in the Layout panel.)
    render(
      root,
      el(
        'div',
        { style: 'display:flex;flex-direction:column;gap:20px;' },
        el(
          'div',
          {},
          el('h2', { style: 'margin:0 0 4px;font-size:16px;font-weight:500;' }, 'Component Gallery'),
          el(
            'p',
            { class: 'tb-hint', style: 'margin:0;' },
            `${vocabulary.length} components are available through ctx.ui — this plugin declares no permissions and imports nothing.`,
          ),
        ),
        ...panels.map(([title, nodes]) =>
          el(
            'div',
            { style: 'display:flex;flex-direction:column;gap:14px;' },
            el('div', { class: 'tb-section-title', style: 'margin:0;' }, title),
            ...nodes,
          ),
        ),
        section(
          el,
          'Full vocabulary',
          el(
            'div',
            { style: 'display:flex;flex-wrap:wrap;gap:5px;' },
            ...vocabulary.map((tag) => el('badge', { variant: 'outline' }, tag)),
          ),
        ),
      ),
    );
  });
}

export function deactivate() {
  state.toast = null;
}

export default { manifest, activate, deactivate };
