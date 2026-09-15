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
const BTN =
  'padding:4px 10px;cursor:pointer;background:#1d2230;color:#dfe3ea;border:1px solid #2a2f3a;border-radius:6px;font-size:12px;';

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
    <div data-id="${n.id}" style="display:flex;align-items:center;gap:6px;padding:5px 8px;border:1px solid ${
      n.id === state.activeId ? '#3b4254' : '#2a2f3a'
    };border-radius:6px;cursor:pointer;background:${n.id === state.activeId ? '#1d2230' : 'transparent'};">
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;">${esc(n.title || 'Untitled')}</span>
      <button data-act="del" style="${BTN}padding:2px 7px;">×</button>
    </div>`,
    )
    .join('') || `<div style="opacity:.5;font-size:12px;">no notes</div>`;
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
          <div style="display:flex;gap:6px;align-items:center;">
            <strong style="font-size:12px;opacity:.85;">NOTES</strong>
            <button class="np-new" style="${BTN}margin-left:auto;">+ New</button>
          </div>
          <div class="np-list" style="display:flex;flex-direction:column;gap:4px;overflow:auto;"></div>
          <div style="margin-top:auto;font-size:11px;opacity:.5;">saved via rpc · broadcast via event-bus</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;min-height:0;">
          <div style="display:flex;gap:8px;align-items:center;">
            <input class="np-title" placeholder="Title" style="flex:1;padding:6px 10px;background:#0d0f13;color:#dfe3ea;border:1px solid #2a2f3a;border-radius:6px;" />
            <button class="np-preview-toggle" style="${BTN}">Preview</button>
          </div>
          <textarea class="np-body" placeholder="Write Markdown here…" style="flex:1;min-height:0;resize:none;padding:10px;background:#0d0f13;color:#dfe3ea;border:1px solid #2a2f3a;border-radius:6px;font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:1.6;"></textarea>
          <div class="np-preview" style="flex:1;min-height:0;overflow:auto;padding:10px;background:#0d0f13;border:1px solid #2a2f3a;border-radius:6px;display:none;font-size:13px;line-height:1.7;"></div>
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
    el.querySelector('.np-preview-toggle').addEventListener('click', () => {
      state.preview = !state.preview;
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
