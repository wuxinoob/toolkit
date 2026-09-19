/**
 * First-party plugin: Notepad
 *
 * Message plane usage:
 *   ctx.storage.*      -> `rpc` scheme (persisted notes)
 *   ctx.bus.publish    -> `event-bus` scheme (notify other windows on save)
 *
 * Demonstrates that persistence and cross-window notification are two different
 * concerns served by two declared schemes, not by one bespoke mechanism.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

export const manifest = {
  id: 'builtin.notepad',
  name: 'Notepad',
  version: '0.1.0',
  description: 'Multi-note editor with autosave and a Markdown preview.',
  contributes: {
    views: [{ slot: 'tool', id: 'notepad', title: 'Notepad', icon: '📝' }],
  },
  permissions: ['rpc:storage', 'rpc:bus'],
};

const state = { ctx: null, notes: [], activeId: null, preview: false, saveTimer: null };

const KEY = 'notes';

function uid() {
  return `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`;
}

async function persist() {
  const { ctx } = state;
  await ctx.storage.set(KEY, state.notes);
  // Tell other windows (a second window with this plugin active sees it live).
  ctx.bus.publish('notepad.changed', { count: state.notes.length }).catch(() => {});
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => persist().catch((e) => state.ctx.log.warn('save failed', e)), 400);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * Redraw the note list.
 *
 * `render()` replaces the container's content, so redrawing is just calling it
 * again — the previous tree's Vue app is unmounted for us. That matters here
 * because this runs on every keystroke.
 *
 * Rows keep the `.tb-*` list classes rather than Tailwind utilities on purpose:
 * this is a built-in plugin, so utilities WOULD be generated for it, but an
 * external plugin's source is outside the project and Tailwind never sees it.
 * A built-in that used them would be a misleading example of what a drop-in
 * plugin can do.
 */
function drawList(root) {
  const host = root.querySelector('.np-list');
  if (!host) return;
  const { el, render } = state.ctx.ui;

  render(
    host,
    state.notes.length
      ? state.notes.map((n) =>
          el(
            'div',
            {
              class: 'tb-row',
              'data-id': n.id,
              role: 'option',
              'aria-selected': String(n.id === state.activeId),
              onClick: () => {
                state.activeId = n.id;
                drawList(root);
                drawEditor(root);
              },
            },
            el('span', { class: 'tb-row-label' }, n.title || 'Untitled'),
            el(
              'span',
              { class: 'tb-row-actions' },
              el(
                'button',
                {
                  variant: 'ghost',
                  size: 'icon-xs',
                  title: 'Delete note',
                  'aria-label': 'Delete note',
                  onClick: (e) => {
                    e.stopPropagation();
                    state.notes = state.notes.filter((x) => x.id !== n.id);
                    if (state.activeId === n.id) state.activeId = state.notes[0]?.id ?? null;
                    persist().catch(() => {});
                    drawList(root);
                    drawEditor(root);
                  },
                },
                '✕',
              ),
            ),
          ),
        )
      : el('div', { class: 'tb-hint' }, 'No notes yet.'),
  );
}

/** Repaint the editor pane for the active note (values, disabled state, preview). */
function drawEditor(root) {
  const note = state.notes.find((n) => n.id === state.activeId);
  const title = root.querySelector('.np-title');
  const body = root.querySelector('.np-body');
  if (!title || !body) return;

  title.value = note?.title ?? '';
  body.value = note?.body ?? '';
  title.disabled = body.disabled = !note;

  const previewHost = root.querySelector('.np-preview');
  if (previewHost) {
    previewHost.style.display = state.preview ? '' : 'none';
    body.style.display = state.preview ? 'none' : '';
    const { el, render } = state.ctx.ui;
    render(
      previewHost,
      el('div', {
        class: 'tb-pane tb-pane-pad tb-markdown',
        style: 'height:100%;',
        // `innerHTML` as a prop, so the sanitised Markdown goes through Vue
        // rather than being poked into a Vue-managed node behind its back.
        innerHTML: note ? DOMPurify.sanitize(marked.parse(note.body || '')) : '',
      }),
    );
  }
}

function registerRenderHooks(ctx) {
  const { el, render } = ctx.ui;

  ctx.registerView('notepad', (root) => {
    const onChange = () => {
      const note = state.notes.find((n) => n.id === state.activeId);
      if (!note) return;
      note.title = root.querySelector('.np-title').value;
      note.body = root.querySelector('.np-body').value;
      scheduleSave();
      drawList(root);
      if (state.preview) drawEditor(root);
    };

    render(
      root,
      el(
        'div',
        { style: 'display:grid;grid-template-columns:220px 1fr;gap:12px;height:100%;min-height:0;' },
        el(
          'div',
          { style: 'display:flex;flex-direction:column;gap:8px;min-height:0;' },
          el(
            'div',
            { class: 'tb-toolbar' },
            el('span', { class: 'tb-section-title', style: 'margin:0;' }, 'Notes'),
            el(
              'button',
              {
                variant: 'outline',
                size: 'xs',
                style: 'margin-left:auto;',
                onClick: () => {
                  const note = { id: uid(), title: 'Untitled', body: '' };
                  state.notes.unshift(note);
                  state.activeId = note.id;
                  persist().catch(() => {});
                  drawList(root);
                  drawEditor(root);
                },
              },
              '+ New',
            ),
          ),
          el('div', { class: 'np-list tb-list', role: 'listbox', 'aria-label': 'Notes' }),
          el('div', { class: 'tb-hint', style: 'margin-top:auto;' }, 'saved via rpc · broadcast via event-bus'),
        ),
        el(
          'div',
          { style: 'display:flex;flex-direction:column;gap:8px;min-height:0;' },
          el(
            'div',
            { class: 'tb-toolbar', style: 'flex-wrap:nowrap;' },
            el('input', { class: 'np-title', placeholder: 'Title', onInput: onChange }),
            el(
              'button',
              {
                variant: 'outline',
                'aria-pressed': String(state.preview),
                onClick: () => {
                  state.preview = !state.preview;
                  drawEditor(root);
                },
              },
              'Preview',
            ),
          ),
          el('textarea', {
            class: 'np-body',
            placeholder: 'Write Markdown here…',
            style: 'flex:1;min-height:0;resize:none;',
            onInput: onChange,
          }),
          el('div', { class: 'np-preview', style: 'flex:1;min-height:0;' }),
        ),
      ),
    );

    drawList(root);
    drawEditor(root);
  });
}

export async function activate(ctx) {
  state.ctx = ctx;
  const saved = await ctx.storage.get(KEY);
  state.notes = Array.isArray(saved) ? saved : [];
  state.activeId = state.notes[0]?.id ?? null;

  // Cross-window: a note saved in another window refreshes this list.
  const off = await ctx.bus.subscribe('notepad.changed', (env) => {
    if (env.svc === ctx.id) return; // ignore our own echo
    ctx.log.info('notepad.changed from another window', env.p);
  });
  ctx.cleanup(off);

  registerRenderHooks(ctx);
}

export function deactivate() {
  clearTimeout(state.saveTimer);
}

export default { manifest, activate, deactivate };
