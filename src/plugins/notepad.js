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

function renderList() {
  const el = document.querySelector('.np-list');
  if (!el) return;
  el.innerHTML = state.notes
    .map(
      (n) => `
    <div class="tb-row" data-id="${n.id}" role="option" aria-selected="${n.id === state.activeId}">
      <span class="tb-row-label">${esc(n.title || 'Untitled')}</span>
      <span class="tb-row-actions">
        <button class="tb-icon-btn tb-icon-btn-danger" data-act="del" title="Delete note" aria-label="Delete note">✕</button>
      </span>
    </div>`,
    )
    .join('') || `<div class="tb-hint">No notes yet.</div>`;
}

function renderEditor() {
  const titleEl = document.querySelector('.np-title');
  const bodyEl = document.querySelector('.np-body');
  const previewEl = document.querySelector('.np-preview');
  if (!titleEl || !bodyEl) return;
  const note = state.notes.find((n) => n.id === state.activeId);
  titleEl.value = note?.title ?? '';
  bodyEl.value = note?.body ?? '';
  titleEl.disabled = bodyEl.disabled = !note;
  if (previewEl) {
    previewEl.style.display = state.preview ? '' : 'none';
    bodyEl.style.display = state.preview ? 'none' : '';
    previewEl.innerHTML = note ? DOMPurify.sanitize(marked.parse(note.body || '')) : '';
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function registerRenderHooks(ctx) {
  ctx.registerView('notepad', (el) => {
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:220px 1fr;gap:12px;height:100%;min-height:0;">
        <div style="display:flex;flex-direction:column;gap:8px;min-height:0;">
          <div class="tb-toolbar">
            <span class="tb-section-title" style="margin:0;">Notes</span>
            <button class="np-new tb-btn tb-btn-sm" style="margin-left:auto;">+ New</button>
          </div>
          <div class="np-list tb-list" role="listbox" aria-label="Notes"></div>
          <div class="tb-hint" style="margin-top:auto;">saved via rpc · broadcast via event-bus</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;min-height:0;">
          <div class="tb-toolbar" style="flex-wrap:nowrap;">
            <input class="np-title tb-input" placeholder="Title" />
            <button class="np-preview-toggle tb-btn" aria-pressed="${state.preview}">Preview</button>
          </div>
          <textarea class="np-body tb-textarea tb-mono" placeholder="Write Markdown here…"
                    style="flex:1;min-height:0;resize:none;line-height:1.6;"></textarea>
          <div class="np-preview tb-pane tb-pane-pad tb-markdown" style="flex:1;display:none;"></div>
        </div>
      </div>`;

    el.querySelector('.np-new').addEventListener('click', () => {
      const note = { id: uid(), title: 'Untitled', body: '' };
      state.notes.unshift(note);
      state.activeId = note.id;
      persist().catch(() => {});
      renderList();
      renderEditor();
    });

    el.querySelector('.np-list').addEventListener('click', (ev) => {
      const row = ev.target.closest('[data-id]');
      if (!row) return;
      const id = row.dataset.id;
      if (ev.target.closest('[data-act="del"]')) {
        state.notes = state.notes.filter((n) => n.id !== id);
        if (state.activeId === id) state.activeId = state.notes[0]?.id ?? null;
        persist().catch(() => {});
        renderList();
        renderEditor();
        return;
      }
      state.activeId = id;
      renderList();
      renderEditor();
    });

    const onChange = () => {
      const note = state.notes.find((n) => n.id === state.activeId);
      if (!note) return;
      note.title = el.querySelector('.np-title').value;
      note.body = el.querySelector('.np-body').value;
      scheduleSave();
      renderList();
      if (state.preview) renderEditor();
    };
    el.querySelector('.np-title').addEventListener('input', onChange);
    el.querySelector('.np-body').addEventListener('input', onChange);
    el.querySelector('.np-preview-toggle').addEventListener('click', (ev) => {
      state.preview = !state.preview;
      // aria-pressed is the state; the class only reflects it.
      ev.currentTarget.setAttribute('aria-pressed', String(state.preview));
      renderEditor();
    });

    renderList();
    renderEditor();
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
