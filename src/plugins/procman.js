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
 * - All terminal access goes through ctx.pty — the plugin never touches the
 *   PTY backend, so the transport can be swapped (a self-hosted PTY backend is
 *   a one-file change in the protocol layer, not here).
 *
 * Profiles (persisted, and the reason this plugin supervises anything):
 *   A *session* is one running process. A *profile* is the persisted
 *   description of one — what to run, how (args, cwd, env, size), and WHEN:
 *
 *     start with app   launch as soon as the plugin activates
 *     schedule         `daily at HH:MM` or `every N minutes`, counted from the
 *                      last firing so a slept-through night runs once, not N×
 *     restart on exit  never / on-failure / always, with a retry budget and a
 *                      delay; a user-initiated stop is never undone by it
 *
 *   The rules live in ./procman-supervisor.js as pure functions (clock math,
 *   restart policy, env parsing) so they are testable without a clock or a pty;
 *   this file owns the timers, the persistence and the UI.
 */

import {
  PROFILES_KEY,
  normalizeProfile,
  parseEnv,
  dueAt,
  shouldRestart,
  describeSchedule,
  describeRestart,
  DEFAULT_PROFILE,
} from './procman-supervisor.js';
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
  /** Persisted launch profiles — the things that auto-start and are scheduled. */
  profiles: [],
  /** profileId -> timer, so a schedule can be re-armed without leaking timers. */
  schedTimers: new Map(),
  /** profileId -> when it last fired, so an interval counts from the last run. */
  lastFired: new Map(),
  /** profileId being edited in the form, or null when adding. */
  editingId: null,
  /** profileId -> whether a restart is already pending (prevents double-arming). */
  restarting: new Set(),
  /** Pending restart timers, cleared on deactivate. */
  restartTimers: new Set(),
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
    cfg: {
      program: spec.program,
      args: spec.args || [],
      cwd: spec.cwd || undefined,
      env: spec.env || undefined,
      cols: 80,
      rows: 24,
    },
    /** Set when this session was launched from a profile. */
    profileId: spec.profileId ?? null,
    /** How many times this session has already been restarted. */
    attempts: 0,
    /** A user-initiated stop must never be undone by the restart policy. */
    stoppedByUser: false,
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
      env: session.cfg.env,
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
          maybeRestart(session);
        } else if (frame.kind === Kind.ERR) {
          session.status = 'error';
          session.exitCode = -1;
          maybeRestart(session);
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
  // A user stopping a process is a decision, not a failure: the restart policy
  // must not immediately undo it.
  s.stoppedByUser = true;
  s.handle?.close?.().catch((e) => state.log?.('pty', `close failed ch=${ch}: ${e.message ?? e}`));
}

/* --------------------------------- profiles ----------------------------------- */
/**
 * A profile is the persisted description of a process — what to run, how, and
 * when. Sessions are instances of it. This section is the supervision around
 * that: auto-start on activation, scheduled starts, and restart-on-exit.
 */

function persistProfiles() {
  const { ctx } = state;
  ctx.storage.set(PROFILES_KEY, state.profiles).catch((e) => ctx.log.warn('profiles persist failed', e));
}

/** Live sessions belonging to a profile. */
function runningFor(profileId) {
  return [...state.sessions.values()].filter(
    (s) => s.profileId === profileId && (s.status === 'running' || s.status === 'starting'),
  );
}

async function launchProfile(rawProfile, reason = 'manual') {
  const p = normalizeProfile(rawProfile);
  if (!p.program) {
    state.ui?.notify(`profile "${p.name || p.id}" has no program to run`, 'error');
    return null;
  }
  state.lastFired.set(p.id, Date.now());
  const session = await spawnFromSpec({
    name: p.name || p.program,
    program: p.program,
    args: p.args,
    cwd: p.cwd,
    env: parseEnv(p.env),
    profileId: p.id,
  });
  state.log?.('profile', `launch "${p.name}" (${reason}) ch=${session.ch}`);
  return session;
}

function clearSchedules() {
  for (const t of state.schedTimers.values()) clearTimeout(t);
  state.schedTimers.clear();
  for (const t of state.restartTimers) clearTimeout(t);
  state.restartTimers.clear();
  state.restarting.clear();
}

/**
 * Arm one timer per enabled profile that has a schedule.
 *
 * Re-armed from scratch whenever the profile list changes, so a stale timer can
 * never point at a profile that was deleted or disabled. `dueAt` counts from the
 * LAST FIRING, so a machine that slept through several intervals runs once on
 * wake rather than firing a burst of catch-up runs.
 */
function armSchedules() {
  clearSchedules();
  const now = Date.now();
  for (const p of state.profiles) {
    if (!p.enabled || p.schedule.kind === 'none') continue;
    const when = dueAt(p.schedule, now, state.lastFired.get(p.id) ?? null);
    if (when === null) continue;
    const delay = Math.max(0, when - now);
    state.schedTimers.set(
      p.id,
      setTimeout(() => {
        state.schedTimers.delete(p.id);
        const live = state.profiles.find((x) => x.id === p.id && x.enabled);
        if (!live) return armSchedules();
        launchProfile(live, 'schedule').finally(() => armSchedules());
      }, Math.min(delay, 2 ** 31 - 1)),
    );
    state.log?.('profile', `armed "${p.name}" in ${Math.round(delay / 1000)}s`);
  }
}

/** Apply the restart policy after a session ended. */
function maybeRestart(session) {
  const { profileId } = session;
  if (!profileId || session.stoppedByUser) return;
  if (state.restarting.has(profileId)) return; // already armed for this profile
  const profile = state.profiles.find((p) => p.id === profileId);
  if (!profile || !profile.enabled) return;
  if (!shouldRestart(profile.restart, session.exitCode, session.attempts)) {
    if (profile.restart.policy !== 'never') {
      state.log?.('profile', `not restarting "${profile.name}" (attempts ${session.attempts}/${profile.restart.maxRetries})`);
    }
    return;
  }

  const attempt = session.attempts + 1;
  const delay = profile.restart.delayMs;
  state.restarting.add(profileId);
  state.log?.('profile', `restart "${profile.name}" in ${delay}ms (attempt ${attempt}/${profile.restart.maxRetries})`);
  session.terminal?.write(
    enc.encode(`\x1b[90m[restarting in ${delay}ms — attempt ${attempt}/${profile.restart.maxRetries}]\x1b[0m\r\n`),
  );
  const timer = setTimeout(async () => {
    state.restartTimers.delete(timer);
    state.restarting.delete(profileId);
    // The attempts counter carries across restarts, so the cap is a total
    // budget — otherwise a crash loop with a long delay restarts forever.
    const next = await launchProfile(profile, 'restart');
    if (next) next.attempts = attempt;
    scheduleRefreshRows();
  }, Math.max(0, delay));
  state.restartTimers.add(timer);
}

/** Stop every session of a profile (a user action, so no restart follows). */
function stopProfile(profileId) {
  for (const s of runningFor(profileId)) killSession(s.ch);
}

function upsertProfile(raw) {
  const p = normalizeProfile(raw);
  const i = state.profiles.findIndex((x) => x.id === p.id);
  if (i >= 0) state.profiles[i] = p;
  else state.profiles.push(p);
  persistProfiles();
  armSchedules();
  return p;
}

function deleteProfile(profileId) {
  state.profiles = state.profiles.filter((p) => p.id !== profileId);
  state.lastFired.delete(profileId);
  persistProfiles();
  armSchedules();
}

function newProfileId() {
  return `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
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
const btnMiniCss =
  'padding:2px 6px;cursor:pointer;background:#1d2230;color:#dfe3ea;border:1px solid #2a2f3a;border-radius:4px;font-size:11px;';
const badgeCss =
  'padding:0 5px;border-radius:8px;font-size:10px;line-height:15px;border:1px solid #2a2f3a;color:#8ab4ff;';

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
          <div style="border-top:1px solid #2a2f3a;padding-top:8px;display:flex;flex-direction:column;min-height:0;flex:1;">
            <div style="display:flex;gap:6px;align-items:center;">
              <strong style="font-size:12px;opacity:.85;">PROFILES</strong>
              <button data-act="profile-new" style="margin-left:auto;${btnMiniCss}">+ New</button>
            </div>
            <div class="pm-profiles" style="display:flex;flex-direction:column;gap:4px;margin-top:6px;overflow:auto;min-height:0;"></div>
            <div class="pm-profile-editor"></div>
          </div>
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
    el.querySelector('.pm-profiles').addEventListener('click', (ev) => onProfileClick(el, ev));
    el.querySelector('.pm-profile-editor').addEventListener('change', (ev) => {
      // a toggle fires change, not click
      if (ev.target.closest('[data-act="profile-toggle"]')) onProfileClick(el, ev);
    });
    el.querySelector('.pm-templates').addEventListener('click', onTemplateClick);
    el.querySelector('.pm-tabs').addEventListener('click', onTabClick);
    el.querySelector('.pm-form').addEventListener('submit', onRunSubmit);

    renderSessionList(el);
    renderProfiles(el);
    renderProfileEditor(el);
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

/* ---------------------------------- profiles UI -------------------------------- */

/** One row per profile: what it runs, when, and the actions available. */
function renderProfiles(root) {
  const host = root.querySelector('.pm-profiles');
  if (!host) return;
  if (!state.profiles.length) {
    host.innerHTML = `<div style="opacity:.5;font-size:11px;">No profiles. A profile can auto-start with the app and run on a schedule.</div>`;
    return;
  }
  host.innerHTML = state.profiles
    .map((p) => {
      const live = runningFor(p.id).length;
      const badges = [
        p.autoStart ? `<span style="${badgeCss}">auto</span>` : '',
        p.schedule.kind !== 'none' ? `<span style="${badgeCss}">${esc(describeSchedule(p.schedule))}</span>` : '',
        p.restart.policy !== 'never' ? `<span style="${badgeCss}">↻</span>` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `
      <div class="pm-profile" data-id="${esc(p.id)}" style="border:1px solid #2a2f3a;border-radius:6px;padding:6px;${p.enabled ? '' : 'opacity:.5;'}">
        <div style="display:flex;align-items:center;gap:4px;">
          <input type="checkbox" data-act="profile-toggle" ${p.enabled ? 'checked' : ''} title="enabled" />
          <span style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.name || p.program)}</span>
          <span style="margin-left:auto;font-size:10px;color:${live ? '#9fe8a9' : '#5b6272'};">${live ? `● ${live}` : '○'}</span>
        </div>
        <div style="font-size:10.5px;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;">
          ${esc([p.program, ...p.args].join(' '))}
        </div>
        <div style="display:flex;gap:4px;align-items:center;margin-top:4px;">
          ${badges}
          <span style="margin-left:auto;display:flex;gap:3px;">
            <button data-act="profile-run" title="run now" style="${btnMiniCss}">▶</button>
            <button data-act="profile-stop" title="stop" ${live ? '' : 'disabled'} style="${btnMiniCss}">■</button>
            <button data-act="profile-edit" title="edit" style="${btnMiniCss}">✎</button>
            <button data-act="profile-del" title="delete" style="${btnMiniCss}">✕</button>
          </span>
        </div>
      </div>`;
    })
    .join('');
}

/** The add/edit form. Only one profile is edited at a time. */
function renderProfileEditor(root) {
  const host = root.querySelector('.pm-profile-editor');
  if (!host) return;
  const editing = state.editingId ? state.profiles.find((p) => p.id === state.editingId) : null;
  if (!state.editingId) {
    host.innerHTML = '';
    return;
  }
  const p = editing ?? { ...DEFAULT_PROFILE, id: newProfileId() };
  const field = (label, input) =>
    `<label style="display:flex;flex-direction:column;gap:2px;font-size:10.5px;opacity:.75;">${label}${input}</label>`;
  const num = (name, value, min, max) =>
    `<input name="${name}" type="number" min="${min}" max="${max}" value="${value}" style="${inputCss}" />`;

  host.innerHTML = `
    <form class="pm-profile-form" data-id="${esc(p.id)}" style="display:flex;flex-direction:column;gap:5px;margin-top:8px;border:1px solid #2a2f3a;border-radius:6px;padding:8px;">
      <div style="font-size:11px;opacity:.7;">${editing ? 'Edit profile' : 'New profile'}</div>
      ${field('name', `<input name="name" value="${esc(p.name)}" placeholder="My backend" style="${inputCss}" />`)}
      ${field('program', `<input name="program" value="${esc(p.program)}" placeholder="node" style="${inputCss}" />`)}
      ${field('args (space separated)', `<input name="args" value="${esc(p.args.join(' '))}" style="${inputCss}" />`)}
      ${field('cwd', `<input name="cwd" value="${esc(p.cwd)}" placeholder="optional" style="${inputCss}" />`)}
      ${field('env (KEY=VALUE, one per line)', `<textarea name="env" rows="2" style="${inputCss}">${esc(p.env.join('\n'))}</textarea>`)}
      <div style="display:flex;gap:6px;">
        ${field('cols', num('cols', p.cols, 20, 500))}
        ${field('rows', num('rows', p.rows, 5, 200))}
      </div>
      <div style="display:flex;gap:10px;font-size:11px;">
        <label style="display:flex;gap:4px;align-items:center;"><input type="checkbox" name="enabled" ${p.enabled ? 'checked' : ''} /> enabled</label>
        <label style="display:flex;gap:4px;align-items:center;"><input type="checkbox" name="autoStart" ${p.autoStart ? 'checked' : ''} /> start with app</label>
      </div>
      ${field(
        'schedule',
        `<select name="schedKind" style="${inputCss}">
           ${['none', 'daily', 'interval']
             .map((k) => `<option value="${k}" ${p.schedule.kind === k ? 'selected' : ''}>${k === 'none' ? 'manual only' : k}</option>`)
             .join('')}
         </select>`,
      )}
      <div style="display:flex;gap:6px;">
        ${field('at (daily)', `<input name="schedAt" type="time" value="${esc(p.schedule.at)}" style="${inputCss}" />`)}
        ${field('every (min)', num('schedEvery', p.schedule.everyMinutes, 1, 1440))}
      </div>
      ${field(
        'restart on exit',
        `<select name="restartPolicy" style="${inputCss}">
           ${['never', 'on-failure', 'always']
             .map((k) => `<option value="${k}" ${p.restart.policy === k ? 'selected' : ''}>${k}</option>`)
             .join('')}
         </select>`,
      )}
      <div style="display:flex;gap:6px;">
        ${field('max retries', num('maxRetries', p.restart.maxRetries, 0, 100))}
        ${field('delay (ms)', num('delayMs', p.restart.delayMs, 0, 600000))}
      </div>
      <div style="display:flex;gap:6px;">
        <button type="submit" style="${btnCss}">Save</button>
        <button type="button" data-act="profile-cancel" style="${btnCss}">Cancel</button>
      </div>
      <div class="pm-profile-err" style="color:#ff9aa8;font-size:11px;"></div>
    </form>`;
  host.querySelector('.pm-profile-form').addEventListener('submit', onProfileSubmit);
  host.querySelector('[data-act="profile-cancel"]').addEventListener('click', () => {
    state.editingId = null;
    renderProfileEditor(root);
  });
}

function onProfileClick(root, ev) {
  const btn = ev.target.closest('[data-act]');
  const row = ev.target.closest('.pm-profile');
  if (btn && btn.dataset.act === 'profile-new') {
    state.editingId = '';
    return renderProfileEditor(root);
  }
  if (!row) return;
  const id = row.dataset.id;
  const profile = state.profiles.find((p) => p.id === id);
  if (!profile) return;

  if (!btn) return;
  switch (btn.dataset.act) {
    case 'profile-toggle':
      upsertProfile({ ...profile, enabled: btn.checked });
      renderProfiles(root);
      renderProfileEditor(root);
      break;
    case 'profile-run':
      launchProfile(profile, 'manual');
      break;
    case 'profile-stop':
      stopProfile(id);
      break;
    case 'profile-edit':
      state.editingId = id;
      renderProfileEditor(root);
      break;
    case 'profile-del':
      deleteProfile(id);
      if (state.editingId === id) state.editingId = null;
      renderProfiles(root);
      renderProfileEditor(root);
      break;
    default:
      break;
  }
}

function onProfileSubmit(ev) {
  ev.preventDefault();
  const form = ev.target;
  const data = new FormData(form);
  const argsText = String(data.get('args') ?? '').trim();
  upsertProfile({
    id: form.dataset.id,
    name: String(data.get('name') ?? '').trim(),
    program: String(data.get('program') ?? '').trim(),
    // Simple whitespace split: quoting is not supported, and pretending
    // otherwise would silently mangle an argument with a space in it.
    args: argsText ? argsText.split(/\s+/) : [],
    cwd: String(data.get('cwd') ?? '').trim(),
    env: String(data.get('env') ?? '').split('\n'),
    cols: data.get('cols'),
    rows: data.get('rows'),
    enabled: data.get('enabled') === 'on',
    autoStart: data.get('autoStart') === 'on',
    schedule: {
      kind: data.get('schedKind'),
      at: data.get('schedAt'),
      everyMinutes: data.get('schedEvery'),
    },
    restart: {
      policy: data.get('restartPolicy'),
      maxRetries: data.get('maxRetries'),
      delayMs: data.get('delayMs'),
    },
  });
  state.editingId = null;
  const root = form.closest('.pm-root');
  renderProfiles(root);
  renderProfileEditor(root);
  renderDetail();
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
      ${s.cfg.env && Object.keys(s.cfg.env).length ? `<div>env: <code style="opacity:.8;">${esc(Object.keys(s.cfg.env).join(', '))}</code></div>` : ''}
      ${(() => {
        const prof = state.profiles.find((p) => p.id === s.profileId);
        if (!prof) return '';
        return `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #2a2f3a;">
          <div>profile: <code style="color:#8ab4ff;">${esc(prof.name || prof.id)}</code></div>
          <div>schedule: ${esc(describeSchedule(prof.schedule))}</div>
          <div>restart: ${esc(describeRestart(prof.restart))}${s.attempts ? ` · restarted ${s.attempts}×` : ''}</div>
          ${s.stoppedByUser ? '<div style="opacity:.6;">stopped by you — no restart</div>' : ''}
        </div>`;
      })()}
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

  const savedProfiles = await ctx.storage.get(PROFILES_KEY);
  state.profiles = (Array.isArray(savedProfiles) ? savedProfiles : []).map(normalizeProfile);
  state.log?.('profile', `loaded ${state.profiles.length} profile(s)`);

  // Auto-start first, then arm the schedules: a profile that is both auto-start
  // and scheduled should come up now, not wait for its first slot.
  for (const p of state.profiles) {
    if (p.enabled && p.autoStart && !runningFor(p.id).length) {
      await launchProfile(p, 'autostart');
    }
  }
  armSchedules();

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
  // Timers are the one thing that must NOT outlive the plugin: a schedule that
  // kept firing after deactivate would launch processes nobody can see.
  clearSchedules();
  // Sessions themselves are not killed here on purpose — but note that the ctx
  // disposer closes this plugin's streams, which does end them (see README).
  // Only detach view DOM here.
  for (const s of state.sessions.values()) detachTerminal(s);
}

export default { manifest, activate, deactivate };
