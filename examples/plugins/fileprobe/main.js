/**
 * fileprobe.demo — a live check of the file-access surface.
 *
 * What it is for: `ctx.files` (native dialogs) and `ctx.onDrop` (OS drag-and-drop)
 * both involve the operating system, so neither can be covered by the in-app
 * selftest — the selftest runs in the webview and has no user to click a dialog
 * or drag a file. This plugin is the human-in-the-loop half of that check.
 *
 * It is also a working example of the two APIs, which is the other reason it
 * exists: the manual can say "call ctx.files.pick()" but a reader wants to see
 * one that runs.
 *
 * Constraint (same as every external plugin): this is a SINGLE-FILE ESM, fetched
 * by the host and imported from a Blob URL. No imports, no bare specifiers.
 * Everything comes from `ctx`.
 */

export const manifest = {
  id: 'fileprobe.demo',
  name: 'File Probe',
  version: '0.1.0',
  api: 2,
  description: 'Live check of ctx.files and ctx.onDrop.',
  contributes: {
    views: [{ slot: 'tool', id: 'fileprobe', title: 'File Probe', icon: 'lucide:folder' }],
    // The theme override is declared here AND in plugin.json — the two must
    // agree (there is an audit test). plugin.json is authoritative; this copy
    // exists so the module is honest about what it needs on its own.
    theme: {
      dark: { '--color-brand': '#4fb286', '--color-brand-hover': '#5fc79a' },
      light: { '--color-brand': '#2f7d5c', '--color-brand-hover': '#256a4d' },
    },
  },
  permissions: ['rpc:dialog', 'rpc:notify', 'rpc:host'],
};

/** Everything the plugin needs to remember between renders. */
const state = {
  ctx: null,
  /** Newest first. Each entry is `{ kind, text }`; kind drives the colour. */
  log: [],
  /** Bumped on every log write so the view knows to redraw. */
  rev: 0,
  /** Unsubscribe for ctx.onDrop, so deactivate can release it. */
  dropOff: null,
  /** The element the host gave us to render into, kept so async work can redraw. */
  root: null,
  /** How many drops have arrived — the one number that proves the wiring. */
  drops: 0,
};

function note(kind, text) {
  const stamp = new Date().toLocaleTimeString();
  state.log.unshift({ kind, text: `${stamp}  ${text}` });
  if (state.log.length > 60) state.log.pop();
  state.rev += 1;
  // ctx.log is the only channel that leaves the webview, so mirror it there:
  // if the view looks empty because of a render bug, the boot log still has it.
  const line = `[fileprobe] ${text}`;
  if (kind === 'bad') state.ctx?.log.error(line);
  else if (kind === 'warn') state.ctx?.log.warn(line);
  else state.ctx?.log.info(line);
}

export async function activate(ctx) {
  state.ctx = ctx;
  state.log = [];
  state.rev = 0;
  state.drops = 0;

  // ---- what can be checked without a human -------------------------------
  const surface = {
    'ctx.files.pick': typeof ctx.files?.pick === 'function',
    'ctx.files.save': typeof ctx.files?.save === 'function',
    'ctx.files.message': typeof ctx.files?.message === 'function',
    'ctx.onDrop': typeof ctx.onDrop === 'function',
    'ctx.ui.notifyOS': typeof ctx.ui?.notifyOS === 'function',
  };
  for (const [name, ok] of Object.entries(surface)) {
    note(ok ? 'ok' : 'bad', `${name} ${ok ? 'present' : 'MISSING'}`);
  }

  // Subscribe to drops. The host only routes drops aimed at the view that is
  // showing, so this callback means "the user dropped something on us".
  state.dropOff = ctx.onDrop((paths, info) => {
    state.drops += 1;
    note('ok', `drop #${state.drops} on view "${info.viewId}": ${paths.length} path(s)`);
    for (const p of paths) note('info', `  ${p}`);
  });
  note('info', 'subscribed to ctx.onDrop — drag a file onto this view');

  // A declared permission is not proof the gate lets you through, so ask the
  // host what it thinks we may do. This catches the classic failure where the
  // capability file and plugin.json disagree.
  try {
    const info = await ctx.rpc('host', 'info', {});
    note('ok', `host/info ok — dataDir ${info?.dataDir ?? '?'}`);
  } catch (e) {
    note('bad', `host/info failed: ${e?.message ?? e}`);
  }

  ctx.registerView('fileprobe', render);
}

export function deactivate() {
  // The ctx disposer releases ctx-owned subscriptions, but this one was created
  // by `onDrop`, which returns the unsubscribe promise. Awaiting it is not
  // possible here, so attach a catch — an unhandled rejection on teardown would
  // be reported as a plugin failure at shutdown.
  Promise.resolve(state.dropOff)
    .then((off) => (typeof off === 'function' ? off() : undefined))
    .catch(() => {});
  state.dropOff = null;
  state.ctx = null;
}

/* --------------------------------- the view -------------------------------- */

function render(root) {
  state.root = root;
  const { el, render: draw } = state.ctx.ui;

  draw(
    root,
    el(
      'div',
      { class: 'tb-pane tb-pane-pad', style: 'display:flex;flex-direction:column;gap:10px;height:100%;' },
      el(
        'div',
        {},
        el('div', { class: 'tb-section-title', style: 'margin:0;' }, 'File Probe'),
        el(
          'div',
          { class: 'tb-hint', style: 'margin-top:2px;' },
          'Two things the in-app selftest cannot cover, because they need a human: ' +
            'a native dialog and an OS file drop.',
        ),
      ),

      dropZone(el),

      el(
        'div',
        { style: 'display:flex;flex-wrap:wrap;gap:6px;' },
        button(el, 'Pick a file', () => pick({ multiple: false })),
        button(el, 'Pick several', () => pick({ multiple: true })),
        button(el, 'Pick a folder', () => pick({ folder: true })),
        button(el, 'Save as…', save),
        button(el, 'Message box', message),
        button(el, 'OS notification', notifyOS),
      ),

      el(
        'div',
        { style: 'display:flex;align-items:center;gap:8px;' },
        el('span', { class: 'tb-section-title', style: 'margin:0;font-size:11px;' }, 'Log'),
        el('span', { class: 'tb-hint' }, `${state.drops} drop(s) received`),
        el(
          'button',
          {
            class: 'tb-btn tb-btn-ghost tb-btn-sm',
            style: 'margin-left:auto;',
            onClick: () => {
              state.log = [];
              state.rev += 1;
              render(root);
            },
          },
          'Clear',
        ),
      ),
      el(
        'div',
        {
          class: 'tb-list tb-mono',
          style: 'flex:1;min-height:120px;overflow:auto;font-size:11px;padding:6px;',
        },
        ...state.log.map((entry) =>
          el(
            'div',
            {
              class:
                entry.kind === 'ok'
                  ? 'tb-t-ok'
                  : entry.kind === 'bad'
                    ? 'tb-t-bad'
                    : entry.kind === 'warn'
                      ? 'tb-t-warn'
                      : 'tb-t-muted',
              style: 'padding:1px 0;white-space:pre-wrap;word-break:break-all;',
            },
            entry.text,
          ),
        ),
      ),
    ),
  );

}

function button(el, label, onClick) {
  return el('button', { class: 'tb-btn tb-btn-sm', onClick }, label);
}

/**
 * The drop target.
 *
 * It is only a visual affordance — the actual listener is the host's, on the
 * whole window (see `watchDrops` in `boot.js`). A per-element drop target is
 * not possible here: Tauri's drag-drop is window-level and, with
 * `dragDropEnabled` on, the HTML5 events a per-element target would need are
 * suppressed. Drawing one anyway would be a lie.
 */
function dropZone(el) {
  return el(
    'div',
    {
      style:
        'border:1px dashed var(--color-line-strong);border-radius:8px;padding:14px;text-align:center;',
    },
    el('div', { class: 'tb-hint' }, 'Drag files anywhere onto this window'),
    el(
      'div',
      { class: 'tb-hint', style: 'font-size:10.5px;margin-top:3px;' },
      'the host routes a drop to whichever view is showing — that is why ctx.onDrop needs no permission',
    ),
  );
}

/* -------------------------------- the actions ------------------------------- */

async function pick(options) {
  note('info', `ctx.files.pick(${JSON.stringify(options)}) …`);
  try {
    const paths = await state.ctx.files.pick(options);
    if (!paths.length) {
      note('warn', 'pick cancelled (empty array — not an error)');
    } else {
      note('ok', `pick returned ${paths.length} path(s)`);
      for (const p of paths) note('info', `  ${p}`);
    }
  } catch (e) {
    // The interesting failure: `rpc:dialog` missing, or the command refused.
    note('bad', `pick threw: ${e?.message ?? e}`);
  }
  rerender();
}

async function save() {
  note('info', 'ctx.files.save({ defaultPath: "fileprobe.txt" }) …');
  try {
    const path = await state.ctx.files.save({ defaultPath: 'fileprobe.txt' });
    note(path ? 'ok' : 'warn', path ? `save returned ${path}` : 'save cancelled (null)');
  } catch (e) {
    note('bad', `save threw: ${e?.message ?? e}`);
  }
  rerender();
}

/**
 * The out-of-band one: a Windows action-centre toast, which shows even when the
 * app is behind something else — the case `ctx.ui.notify` (the in-app toast)
 * cannot serve at all, because a toast only exists inside a window.
 *
 * `ctx.ui.notifyOS` resolves `false` rather than throwing when the OS refuses,
 * so a missing notification never breaks the caller.
 */
async function notifyOS() {
  note('info', 'ctx.ui.notifyOS(…) …');
  try {
    const sent = await state.ctx.ui.notifyOS('If you can see this in the Windows action centre, it works.', {
      title: 'File Probe',
    });
    note(sent ? 'ok' : 'warn', sent ? 'OS notification sent' : 'OS notification refused (permission?)');
  } catch (e) {
    note('bad', `notifyOS threw: ${e?.message ?? e}`);
  }
  rerender();
}

async function message() {
  note('info', 'ctx.files.message(…) …');
  try {
    await state.ctx.files.message('If you can read this, the native message box works.', {
      title: 'File Probe',
    });
    note('ok', 'message box dismissed');
  } catch (e) {
    note('bad', `message threw: ${e?.message ?? e}`);
  }
  rerender();
}

/**
 * Redraw in place.
 *
 * The view is a pure function of `state`, so re-rendering IS the update
 * mechanism — no diffing, no bindings. `state.root` is the element the host
 * handed to `render`; keeping it is what lets an async action redraw when it
 * finishes, which is most of them.
 */
function rerender() {
  if (state.root) render(state.root);
}

export default { manifest, activate, deactivate };
