/**
 * First-party plugin: Process Manager
 * Three-pane layout:
 *   [left]   templates (persisted) + live session list + spawn form
 *   [center] terminal tabs, one xterm.js per live session
 *   [right]  selected session details + kill/restart controls
 *
 * Message plane usage:
 *   ctx.storage.*      -> `rpc` scheme (control calls)
 *   ctx.pty(...)       -> `pty-stream` scheme (raw-binary push)
 *   ctx.sessions()     -> the host's unified session registry
 *
 * Design notes:
 * - Sessions outlive the view: switching views only tears down DOM. On
 *   re-render, terminals are re-created and the output ring buffer is
 *   replayed, so background processes never lose their stream.
 * - All terminal access goes through ctx.pty — the plugin never touches
 *   tauri-pty, so the transport can be swapped (a self-hosted PTY backend
 *   is a one-file change in the protocol layer, not here).
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import { Kind } from '../protocol/envelope.js';

export const manifest = {
  id: 'builtin.procman',
  name: 'Processes',
  version: '0.1.0',
  description: 'Spawn, observe and interact with command-line subprocesses in pseudo-terminals.',
  contributes: {
    views: [{ slot: 'tool', id: 'procman', title: 'Processes', icon: '⚙️' }],
  },
  permissions: ['rpc:storage', 'rpc:stream', 'rpc:host'],
};

const DEFAULT_TEMPLATES = [
  { id: 'tpl-pwsh', name: 'PowerShell', program: 'powershell.exe', args: [] },
  { id: 'tpl-cmd', name: 'cmd', program: 'cmd.exe', args: [] },
  { id: 'tpl-nodever', name: 'node --version', program: 'node', args: ['--version'] },
];

const state = {
  ctx: null,
  ui: null,
  log: null,
  templates: null,
  sessions: new Map(), // ch -> session
  activeCh: null,
  selectedCh: null,
  ringRaw: false,
  debug: null,
};

const enc = new TextEncoder();

/* ---------------------------------- sessions ---------------------------------- */

async function spawnFromSpec(spec) {
  const { ctx, ui } = state;
  const ch = `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const session = {
    ch,
    name: spec.name || spec.program,
    cfg: { program: spec.program, args: spec.args || [], cwd: spec.cwd || undefined, cols: 80, rows: 24 },
    status: 'starting',
    exitCode: null,
    pid: null,
    startedAt: Date.now(),
    handle: null,
    terminal: null,
    fitAddon: null,
    resizeObs: null,
    termHost: null,
    lastCols: null,
    lastRows: null,
    replay: '', // decoded output for re-attach replay
    decoder: new TextDecoder('utf-8'), // streaming decoder across chunks
    bytesIn: 0,
  };
  state.sessions.set(ch, session);
  state.activeCh = ch;
  state.selectedCh = ch;

  // Attach the terminal BEFORE spawning so the PTY is created at the pane's
  // real, fitted size. A post-spawn resize forces ConPTY to emit a full-screen
  // redraw in a new coordinate system; if that size ever diverges from the
  // xterm grid, the pane looks frozen. Starting in sync avoids the dance.
  scheduleRefreshRows();
  activateSession(ch);
  if (session.terminal) {
    session.cfg.cols = session.terminal.cols;
    session.cfg.rows = session.terminal.rows;
  }

  try {
    session.handle = await ctx.pty(ch, {
      program: session.cfg.program,
      args: session.cfg.args,
      cwd: session.cfg.cwd,
      cols: session.cfg.cols,
      rows: session.cfg.rows,
      onFrame: (frame) => {
        if (frame.kind === Kind.DATA) {
          const chunk = frame.p;
          session.bytesIn += chunk?.byteLength ?? 0;
          // streaming decode survives UTF-8 chars split across chunks
          session.replay = (session.replay + session.decoder.decode(chunk, { stream: true })).slice(-64 * 1024);
          session.terminal?.write(chunk);
          if (state.selectedCh === ch) scheduleRenderDetail();
          scheduleRefreshRows();
        } else if (frame.kind === Kind.EXIT) {
          session.status = 'exited';
          session.exitCode = frame.p;
          session.terminal?.write(enc.encode(`\r\n\x1b[90m[process exited: ${frame.p}]\x1b[0m\r\n`));
          scheduleRefreshRows();
          if (state.selectedCh === ch) scheduleRenderDetail();
          state.log?.('pty', `exit ch=${ch} code=${frame.p}`);
        } else if (frame.kind === Kind.ERR) {
          session.status = 'error';
          session.exitCode = -1;
          session.terminal?.write(enc.encode(`\x1b[90m[stream error: ${frame.code} ${frame.msg}]\x1b[0m\r\n`));
          ui.notify(`stream error: ${frame.msg}`, 'error');
        }
      },
    });
    session.pid = session.handle.pid ?? null;
    if (session.status === 'starting') session.status = 'running';
    state.log?.('pty', `spawn ch=${ch} ${session.cfg.program} ${session.cfg.cols}x${session.cfg.rows} pid=${session.pid}`);
  } catch (e) {
    session.status = 'error';
    session.exitCode = -1;
    session.terminal?.write(enc.encode(`\x1b[90m[spawn failed: ${e}]\x1b[0m\r\n`));
    ui.notify(`spawn failed: ${e.message ?? e}`, 'error');
    state.log?.('pty', `spawn FAILED ch=${ch}: ${e.message ?? e}`);
  }
  scheduleRefreshRows();
  scheduleRenderDetail();
  return session;
}

function killSession(ch) {
  const s = state.sessions.get(ch);
  if (!s || s.status !== 'running') return;
  s.handle?.close?.().catch((e) => state.log?.('pty', `close failed ch=${ch}: ${e.message ?? e}`));
}

/* ---------------------------------- terminal ---------------------------------- */

const TERM_THEME = { background: '#111318', foreground: '#dfe3ea', cursor: '#7aa2f7' };

/**
 * Fit the xterm grid to its container and keep the PTY in sync.
 * Guards (each one closes a "frozen pane" ingredient):
 *  - hidden/zero-size container -> skip (a transient measure once pushed
 *    garbage dims to ConPTY, desyncing it from the xterm grid);
 *  - dims unchanged since last fit -> skip (avoids resize storms);
 *  - every applied resize is logged, so a desync is diagnosable from the log.
 */
function fitTerm(session) {
  const { terminal: term, fitAddon: fit, termHost: host } = session;
  if (!term || !fit || !host || !host.isConnected) return;
  const w = host.clientWidth;
  const h = host.clientHeight;
  if (w < 40 || h < 40) return;
  try {
    fit.fit();
  } catch {
    return;
  }
  const { cols, rows } = term;
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 1) return;
  if (cols === session.lastCols && rows === session.lastRows) return;
  const prev = session.lastCols ? `${session.lastCols}x${session.lastRows}` : 'new';
  session.lastCols = cols;
  session.lastRows = rows;
  state.log?.('pty', `fit ch=${session.ch} ${prev} -> ${cols}x${rows} (host ${w}x${h})`);
  session.handle?.resize?.(cols, rows);
}

/** rAF-coalesced fit (ResizeObserver can burst several events per frame). */
function scheduleFit(session) {
  if (session._fitPending) return;
  session._fitPending = true;
  requestAnimationFrame(() => {
    session._fitPending = false;
    fitTerm(session);
  });
}

function attachTerminal(session, container) {
  // Re-attach correctness: a live terminal whose DOM lives in a removed or
  // different container keeps consuming the stream invisibly — the pane
  // renders stale output forever (frozen-pane symptom). Recreate instead;
  // the replay buffer restores history and live writes continue fresh.
  if (session.terminal && (session.termHost !== container || !session.termHost.isConnected)) {
    detachTerminal(session);
  }
  if (session.terminal) return session.terminal;
  const term = new Terminal({
    convertEol: false,
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    theme: TERM_THEME,
    cursorBlink: true,
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  term.onData((data) => {
    if (session.status === 'running') session.handle?.write?.(data);
  });
  const ro = new ResizeObserver(() => scheduleFit(session));
  ro.observe(container);
  session.terminal = term;
  session.fitAddon = fit;
  session.resizeObs = ro;
  session.termHost = container;

  scheduleFit(session);
  if (session.replay) term.write(session.replay);
  return term;
}

function detachTerminal(session) {
  if (session.resizeObs) {
    session.resizeObs.disconnect();
    session.resizeObs = null;
  }
  if (session.terminal) {
    try {
      session.terminal.dispose();
    } catch {
      /* double dispose guard */
    }
    session.terminal = null;
    session.fitAddon = null;
    session.termHost = null;
    session.lastCols = null;
    session.lastRows = null;
  }
}

/* --------------------------------- dom refresh --------------------------------- */

// Data chunks arrive far faster than frames; re-rendering whole sections per
// chunk thrashes the DOM and kills selection/scroll position in the detail
// pane. Coalesce to at most one refresh per animation frame.
let rowsPending = false;
function scheduleRefreshRows() {
  if (rowsPending) return;
  rowsPending = true;
  requestAnimationFrame(() => {
    rowsPending = false;
    refreshSessionRows();
  });
}

let detailPending = false;
function scheduleRenderDetail() {
  if (detailPending) return;
  detailPending = true;
  requestAnimationFrame(() => {
    detailPending = false;
    renderDetail();
  });
}

/** Drop terminals of sessions whose DOM was torn down (view switch). */
function reapDetached() {
  for (const s of state.sessions.values()) {
    if (s.terminal && s.termHost && !s.termHost.isConnected) detachTerminal(s);
  }
}

/* ------------------------------------ view ------------------------------------ */

const inputCss =
  'padding:5px 8px;background:#0d0f13;color:#dfe3ea;border:1px solid #2a2f3a;border-radius:4px;font-family:inherit;';
const btnCss =
  'padding:5px 10px;cursor:pointer;background:#1d2230;color:#dfe3ea;border:1px solid #2a2f3a;border-radius:4px;';
const btnCssDanger =
  'padding:3px 8px;cursor:pointer;background:#2a1518;color:#ff9aa8;border:1px solid #4a2530;border-radius:4px;';

function registerRenderHooks(ctx) {
  ctx.registerView('procman', (el) => {
    reapDetached();
    el.innerHTML = `
      <div class="pm-root" style="display:grid;grid-template-columns:250px 1fr 270px;gap:8px;height:100%;min-height:0;">
        <div class="pm-left" style="display:flex;flex-direction:column;gap:8px;min-height:0;">
          <div style="display:flex;gap:6px;align-items:center;">
            <strong style="font-size:12px;opacity:.85;">SESSIONS</strong>
            <span class="pm-count" style="margin-left:auto;font-size:11px;opacity:.6;"></span>
          </div>
          <div class="pm-sessions" style="display:flex;flex-direction:column;gap:4px;overflow:auto;max-height:32%;"></div>
          <div style="border-top:1px solid #2a2f3a;padding-top:8px;">
            <strong style="font-size:12px;opacity:.85;">TEMPLATES</strong>
            <div class="pm-templates" style="display:flex;flex-direction:column;gap:4px;margin-top:6px;"></div>
          </div>
          <details class="pm-form-wrap" style="margin-top:auto;border:1px solid #2a2f3a;border-radius:6px;padding:8px;">
            <summary style="cursor:pointer;font-size:12px;">New session…</summary>
            <form class="pm-form" style="display:flex;flex-direction:column;gap:6px;margin-top:8px;font-size:12px;">
              <input name="name" placeholder="display name" style="${inputCss}" />
              <input name="program" placeholder="program (e.g. node)" required style="${inputCss}" />
              <input name="args" placeholder="args (space separated)" style="${inputCss}" />
              <input name="cwd" placeholder="cwd (optional)" style="${inputCss}" />
              <label style="display:flex;gap:6px;align-items:center;opacity:.8;">
                <input type="checkbox" name="saveTpl" /> save as template
              </label>
              <button data-act="run" class="pm-run" type="submit" style="${btnCss}">Run</button>
              <div class="pm-form-err" style="color:#ff9aa8;font-size:11px;"></div>
            </form>
          </details>
        </div>
        <div class="pm-center" style="display:flex;flex-direction:column;min-height:0;border:1px solid #2a2f3a;border-radius:6px;overflow:hidden;">
          <div class="pm-tabs" style="display:flex;gap:2px;background:#181b22;padding:4px;overflow-x:auto;flex-shrink:0;"></div>
          <div class="pm-term-area" style="flex:1;min-height:0;position:relative;background:#111318;">
            <div class="pm-term-empty" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#5b6272;font-size:13px;">
              No active session — pick a template on the left.
            </div>
          </div>
        </div>
        <div class="pm-detail" style="border:1px solid #2a2f3a;border-radius:6px;padding:10px;overflow:auto;font-size:12px;"></div>
      </div>`;

    el.querySelector('.pm-sessions').addEventListener('click', onSessionClick);
    el.querySelector('.pm-templates').addEventListener('click', onTemplateClick);
    el.querySelector('.pm-tabs').addEventListener('click', onTabClick);
    el.querySelector('.pm-form').addEventListener('submit', onRunSubmit);

    renderSessionList(el);
    renderTemplates(el);
    renderTabs(el);
    activateSession(state.activeCh);
    renderDetail();
  });
}

function onSessionClick(ev) {
  const row = ev.target.closest('[data-ch]');
  if (!row) return;
  const ch = row.dataset.ch;
  if (ev.target.closest('[data-act="kill"]')) {
    killSession(ch);
    return;
  }
  state.activeCh = ch;
  state.selectedCh = ch;
  activateSession(ch);
  renderTabs();
  renderDetail();
}

function onTemplateClick(ev) {
  const row = ev.target.closest('[data-tpl]');
  if (!row) return;
  const tpl = state.templates.find((t) => t.id === row.dataset.tpl);
  if (!tpl) return;
  if (ev.target.closest('[data-act="del"]')) {
    state.templates = state.templates.filter((t) => t.id !== tpl.id);
    persistTemplates();
    renderTemplates();
    return;
  }
  spawnFromSpec(tpl).then(() => {
    renderTabs();
    renderSessionList();
    renderDetail();
  });
}

function onTabClick(ev) {
  const tab = ev.target.closest('[data-ch]');
  if (!tab) return;
  const ch = tab.dataset.ch;
  if (ev.target.closest('[data-act="close"]')) {
    closeSessionTab(ch);
    return;
  }
  state.activeCh = ch;
  state.selectedCh = ch;
  activateSession(ch);
  renderTabs();
  renderDetail();
}

async function onRunSubmit(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const fd = new FormData(form);
  const program = String(fd.get('program') || '').trim();
  const errEl = form.querySelector('.pm-form-err');
  if (!program) {
    errEl.textContent = 'program is required';
    return;
  }
  errEl.textContent = '';
  const args = String(fd.get('args') || '').split(/\s+/).filter(Boolean);
  const spec = {
    name: String(fd.get('name') || '').trim() || program,
    program,
    args,
    cwd: String(fd.get('cwd') || '').trim() || undefined,
  };
  await spawnFromSpec(spec);
  renderTabs();
  renderSessionList();
  renderDetail();
  if (fd.get('saveTpl')) {
    state.templates.push({ id: `tpl-${Date.now().toString(36)}`, ...spec });
    persistTemplates();
    renderTemplates();
  }
  form.reset();
}

/* --------------------------------- renderers ---------------------------------- */

function dot(status) {
  const color = status === 'running' ? '#4ade80' : status === 'exited' ? '#5b6272' : '#ff9aa8';
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px;"></span>`;
}

function refreshSessionRows() {
  const root = document.querySelector('.pm-root');
  if (!root) return;
  renderSessionList(root);
  renderTabs(root);
}

function renderSessionList(root) {
  const host = (root || document).querySelector('.pm-sessions');
  if (!host) return;
  const items = [...state.sessions.values()].reverse();
  const countEl = (root || document).querySelector('.pm-count');
  if (countEl) {
    countEl.textContent = `${items.filter((s) => s.status === 'running').length} running / ${items.length}`;
  }
  host.innerHTML = items.length
    ? items
        .map(
          (s) => `
      <div data-ch="${s.ch}" style="display:flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid ${s.ch === state.activeCh ? '#3b4254' : '#2a2f3a'};border-radius:4px;cursor:pointer;background:${s.ch === state.activeCh ? '#1d2230' : 'transparent'};">
        ${dot(s.status)}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(s.name)}</span>
        ${s.status === 'running' ? `<button data-act="kill" title="kill" style="${btnCssDanger}">✕</button>` : ''}
      </div>`,
        )
        .join('')
    : `<div style="opacity:.5;font-size:12px;padding:4px;">no sessions yet</div>`;
}

function renderTemplates(root) {
  const host = (root || document).querySelector('.pm-templates');
  if (!host) return;
  host.innerHTML = state.templates.length
    ? state.templates
        .map(
          (t) => `
      <div data-tpl="${t.id}" style="display:flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid #2a2f3a;border-radius:4px;cursor:pointer;">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(t.name)}</span>
        <button data-act="del" title="remove template" style="${btnCssDanger}">×</button>
      </div>`,
        )
        .join('')
    : `<div style="opacity:.5;font-size:12px;">no templates</div>`;
}

function renderTabs(root) {
  const host = (root || document).querySelector('.pm-tabs');
  if (!host) return;
  const items = [...state.sessions.values()].reverse();
  host.innerHTML = items
    .map(
      (s) => `
    <div data-ch="${s.ch}" style="display:flex;align-items:center;gap:6px;padding:3px 10px;font-size:12px;border-radius:4px 4px 0 0;cursor:pointer;white-space:nowrap;background:${s.ch === state.activeCh ? '#111318' : 'transparent'};color:${s.ch === state.activeCh ? '#dfe3ea' : '#8b93a7'};border-bottom:2px solid ${s.ch === state.activeCh ? '#7aa2f7' : 'transparent'};">
      ${dot(s.status)}${esc(s.name)}
      <span data-act="close" style="opacity:.5;cursor:pointer;">×</span>
    </div>`,
    )
    .join('');
}

function activateSession(ch) {
  const area = document.querySelector('.pm-term-area');
  if (!area) return;
  const empty = area.querySelector('.pm-term-empty');
  area.querySelectorAll(':scope > .pm-term-box').forEach((n) => n.remove());
  if (empty) empty.style.display = 'none';
  if (!ch || !state.sessions.has(ch)) {
    if (empty) empty.style.display = '';
    return;
  }
  const session = state.sessions.get(ch);
  const box = document.createElement('div');
  box.className = 'pm-term-box';
  box.style.cssText = 'position:absolute;inset:0;';
  area.appendChild(box);
  attachTerminal(session, box);
}

function closeSessionTab(ch) {
  const s = state.sessions.get(ch);
  if (!s) return;
  if (s.status === 'running') killSession(ch);
  detachTerminal(s);
  state.sessions.delete(ch);
  if (state.activeCh === ch) state.activeCh = [...state.sessions.keys()][0] || null;
  if (state.selectedCh === ch) state.selectedCh = state.activeCh;
  renderTabs();
  renderSessionList();
  activateSession(state.activeCh);
  renderDetail();
}

function renderDetail() {
  const host = document.querySelector('.pm-detail');
  if (!host) return;
  const s = state.sessions.get(state.selectedCh);
  if (!s) {
    host.innerHTML = `<div style="opacity:.5;">Select a session to inspect it.</div>`;
    return;
  }
  const uptime = s.status === 'running' ? `${((Date.now() - s.startedAt) / 1000).toFixed(1)}s` : '—';
  host.innerHTML = `
    <strong style="font-size:13px;">${esc(s.name)}</strong>
    <div style="margin:8px 0;display:flex;flex-direction:column;gap:4px;color:#aeb6c6;">
      <div>${dot(s.status)} status: ${s.status}${s.status === 'exited' ? ` (code ${s.exitCode})` : ''}</div>
      <div>program: <code style="color:#dfe3ea;">${esc(s.cfg.program)} ${esc((s.cfg.args || []).join(' '))}</code></div>
      ${s.cfg.cwd ? `<div>cwd: ${esc(s.cfg.cwd)}</div>` : ''}
      <div>channel: <code style="color:#dfe3ea;">${esc(s.ch)}</code></div>
      <div>pid: ${s.pid ?? '—'}</div>
      <div>uptime: ${uptime}</div>
      <div>bytes in: ${s.bytesIn}</div>
      <div>scheme: pty-stream (raw-binary)</div>
    </div>
    <div style="display:flex;gap:6px;margin-top:10px;">
      ${s.status === 'running' ? `<button data-act="kill-sel" style="${btnCssDanger}">Kill</button>` : ''}
      <button data-act="close-sel" style="${btnCss}">Close tab</button>
    </div>
    <div style="margin-top:12px;border-top:1px solid #2a2f3a;padding-top:8px;">
      <div style="display:flex;align-items:center;gap:8px;opacity:.6;margin-bottom:4px;">
        <span>output ring (last 4KB)</span>
        <label style="margin-left:auto;display:flex;gap:4px;align-items:center;cursor:pointer;" title="raw = byte-accurate stream incl. ANSI escapes (debug)">
          <input type="checkbox" data-act="ring-raw" ${state.ringRaw ? 'checked' : ''} /> raw
        </label>
      </div>
      <pre class="pm-ring" style="margin:0;white-space:pre-wrap;word-break:break-all;font-size:11px;color:#8b93a7;max-height:220px;overflow:auto;background:#0d0f13;border:1px solid #2a2f3a;border-radius:4px;padding:6px;">${esc(ringText(s)) || '(empty)'}</pre>
    </div>`;
  host.querySelector('[data-act="kill-sel"]')?.addEventListener('click', () => killSession(s.ch));
  host.querySelector('[data-act="close-sel"]')?.addEventListener('click', () => closeSessionTab(s.ch));
  host.querySelector('[data-act="ring-raw"]')?.addEventListener('change', (ev) => {
    state.ringRaw = ev.target.checked;
    renderDetail();
  });
}

/* ---------------------------------- helpers ----------------------------------- */

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ANSI stripping for the ring's readable (default) view. Raw view keeps the
// byte-accurate stream — both remain available via the toggle in the pane.
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ESC_RE = /\x1b[@-Z\\-_]/g;

function ringText(s) {
  const raw = s.replay.slice(-4096);
  if (state.ringRaw) return raw;
  return raw.replace(OSC_RE, '').replace(CSI_RE, '').replace(ESC_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '');
}

function persistTemplates() {
  const { ctx } = state;
  ctx.storage.set('templates', state.templates).catch((e) => ctx.log.warn('templates persist failed', e));
}

/* --------------------------------- lifecycle ---------------------------------- */

export async function activate(ctx) {
  state.ctx = ctx;
  state.ui = ctx.ui ?? { notify: console.log };
  state.log = (cat, msg) => ctx.log.info(`[${cat}]`, msg);

  const saved = await ctx.storage.get('templates');
  state.templates = Array.isArray(saved) && saved.length ? saved : structuredClone(DEFAULT_TEMPLATES);
  if (!saved) persistTemplates();

  registerRenderHooks(ctx);

  // Debug handle: window.__toolbox.procman
  state.debug = {
    sessions: () =>
      [...state.sessions.values()].map(({ handle, terminal, ...rest }) => ({
        ...rest,
        termAttached: !!terminal,
      })),
    termDims: () =>
      [...state.sessions.values()].map((s) => ({
        ch: s.ch,
        attached: !!s.terminal,
        hostConnected: !!s.termHost?.isConnected,
        xterm: s.terminal ? { cols: s.terminal.cols, rows: s.terminal.rows } : null,
        lastFit: { cols: s.lastCols ?? null, rows: s.lastRows ?? null },
      })),
    fit: () => [...state.sessions.values()].forEach(scheduleFit),
    spawn: (spec) => spawnFromSpec(spec),
    kill: killSession,
    activate: (ch) => activateSession(ch),
    state,
  };
  globalThis.window ||= {};
  (globalThis.window.__toolbox ||= {}).procman = state.debug;
}

export function deactivate() {
  // Kill nothing: user sessions survive plugin toggles by design.
  // The ctx disposer closes this plugin's streams; only detach view DOM here.
  for (const s of state.sessions.values()) detachTerminal(s);
}

export default { manifest, activate, deactivate };
