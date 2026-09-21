/**
 * First-party plugin: Process Manager
 * Three-pane layout:
 *   [left]   profiles (persisted: auto-start / schedule / restart) + live session
 *            list + spawn form
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
import { onThemeChange } from '../host/theme.js';

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

/**
 * Seeded once, so a fresh install has something to click.
 *
 * These are ordinary profiles — edit them, schedule them, delete them. They
 * replaced a separate "templates" concept, which was the same thing with fewer
 * fields: a profile with no schedule and no auto-start IS a template, and having
 * both meant two panels doing one job.
 */
const DEFAULT_PROFILES = [
  { id: 'seed-shell', name: 'Shell', program: 'powershell.exe', args: [] },
  { id: 'seed-cmd', name: 'Command prompt', program: 'cmd.exe', args: [] },
  { id: 'seed-node', name: 'Node version', program: 'node', args: ['--version'] },
];

const state = {
  ctx: null,
  ui: null,
  log: null,
  /** Persisted launch profiles — the things that auto-start and are scheduled. */
  profiles: [],
  /** "save as profile" on the run form — a Checkbox is a button, not a form control. */
  runSave: false,
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
        } else if (frame.kind === Kind.END) {
          // The stream was closed by us (Stop). Without this the row keeps
          // claiming `running` after a stop, which makes the button look broken.
          if (session.status === 'running' || session.status === 'starting') {
            session.status = 'stopped';
            session.exitCode = null;
          }
          session.terminal?.write(enc.encode('\r\n\x1b[90m[stopped]\x1b[0m\r\n'));
          scheduleRefreshRows();
          if (state.selectedCh === ch) scheduleRenderDetail();
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

/**
 * xterm paints to a canvas, so it cannot inherit CSS custom properties the way
 * DOM content does — it needs a concrete theme object. Read the tokens off the
 * document instead of hard-coding hex, and rebuild it when the theme changes
 * (`applyTermTheme` below). This is the one place a token has to be copied into
 * JS, and the copy is refreshed rather than frozen.
 */
function readTermTheme() {
  const cs = getComputedStyle(document.documentElement);
  const tok = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    background: tok('--color-canvas', '#0e1015'),
    foreground: tok('--color-ink', '#e7eaf0'),
    cursor: tok('--color-brand', '#6f9cf5'),
    cursorAccent: tok('--color-canvas', '#0e1015'),
    selectionBackground: tok('--color-line-strong', '#343c4c'),
  };
}

/** Re-tint every live terminal. Called when the theme changes. */
function applyTermTheme() {
  const theme = readTermTheme();
  for (const s of state.sessions.values()) {
    if (s.terminal) s.terminal.options.theme = theme;
  }
}

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
    theme: readTermTheme(),
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


function registerRenderHooks(ctx) {
  const { el, native, render } = ctx.ui;

  ctx.registerView('procman', (root) => {
    reapDetached();

    render(
      root,
      el(
        'div',
        { class: 'pm-root', style: 'display:grid;grid-template-columns:250px 1fr 270px;gap:8px;height:100%;min-height:0;' },

        el(
          'div',
          { class: 'pm-left', style: 'display:flex;flex-direction:column;gap:8px;min-height:0;' },
          el(
            'div',
            { style: 'display:flex;gap:6px;align-items:center;' },
            el('span', { class: 'tb-section-title', style: 'margin:0;' }, 'Sessions'),
            el('span', { class: 'pm-count tb-hint', style: 'margin-left:auto;' }),
          ),
          el('div', { class: 'pm-sessions tb-list', role: 'listbox', 'aria-label': 'Sessions', style: 'max-height:32%;' }),

          el(
            'div',
            {
              class: 'pm-profiles-panel',
              style: 'border-top:1px solid var(--color-line);padding-top:8px;display:flex;flex-direction:column;min-height:0;flex:1;',
            },
            el(
              'div',
              { class: 'tb-toolbar' },
              el('span', { class: 'tb-section-title', style: 'margin:0;' }, 'Profiles'),
              el(
                'button',
                { variant: 'outline', size: 'xs', 'data-act': 'profile-new', style: 'margin-left:auto;' },
                '+ New',
              ),
            ),
            el('div', { class: 'pm-profiles tb-list', style: 'margin-top:6px;' }),
            el('div', { class: 'pm-profile-editor' }),
          ),

          el(
            'details',
            { class: 'pm-form-wrap tb-pane tb-pane-pad', style: 'margin-top:auto;' },
            el('summary', { style: 'cursor:pointer;font-size:12px;' }, 'New session…'),
            // `native('form')`, not `el('form')`: the vocabulary contains a Form
            // COMPONENT (upstream's validation wrapper), and a component's submit
            // event is not a native one — `ev.preventDefault` does not exist on it.
            native(
              'form',
              { class: 'pm-form', style: 'display:flex;flex-direction:column;gap:6px;margin-top:8px;font-size:12px;' },
              el('input', { name: 'name', placeholder: 'display name' }),
              el('input', { name: 'program', placeholder: 'program (e.g. node)', required: true }),
              el('input', { name: 'args', placeholder: 'args (space separated)' }),
              el('input', { name: 'cwd', placeholder: 'cwd (optional)' }),
              // The text fields below are read with FormData, which works because
              // shadcn's Input renders a real <input>. A Checkbox does NOT — it
              // is a button — so this one keeps its state in `state.runSave`.
              el(
                'label',
                { class: 'tb-label', style: 'display:flex;gap:6px;align-items:center;' },
                el('checkbox', {
                  defaultValue: false,
                  'onUpdate:modelValue': (v) => {
                    state.runSave = !!v;
                  },
                }),
                ' save as profile',
              ),
              el('button', { variant: 'default', 'data-act': 'run', type: 'submit' }, 'Run'),
              el('div', { class: 'pm-form-err tb-t-bad', style: 'font-size:11px;' }),
            ),
          ),
        ),

        el(
          'div',
          { class: 'pm-center tb-card', style: 'display:flex;flex-direction:column;min-height:0;overflow:hidden;' },
          el('div', { class: 'pm-tabs tb-tabs', role: 'tablist', 'aria-label': 'Sessions' }),
          el(
            'div',
            { class: 'pm-term-area', style: 'flex:1;min-height:0;position:relative;background:var(--color-canvas);' },
            el(
              'div',
              { class: 'pm-term-empty tb-empty', style: 'position:absolute;inset:0;' },
              'No active session — run something, or hit ▶ on a profile.',
            ),
          ),
        ),

        el('div', { class: 'pm-detail tb-card', style: 'padding:10px;overflow:auto;font-size:12px;' }),
      ),
    );

    // Delegation is unchanged: the tree keeps the same `data-*` hooks and class
    // names the handlers were written against, so only the DOM building moved.
    root.querySelector('.pm-sessions').addEventListener('click', onSessionClick);
    // Bound to the PANEL, not the list: "+ New" lives in the header, and a
    // listener on the list alone never saw it (the button did nothing).
    root.querySelector('.pm-profiles-panel').addEventListener('click', (ev) => onProfileClick(root, ev));
    root.querySelector('.pm-tabs').addEventListener('click', onTabClick);
    root.querySelector('.pm-form').addEventListener('submit', onRunSubmit);

    renderSessionList(root);
    renderProfiles(root);
    renderProfileEditor(root);
    renderTabs(root);
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


function onTabClick(ev) {
  const tab = ev.target.closest('[data-ch]');
  if (!tab) return;
  const ch = tab.dataset.ch;
  if (ev.target.closest('[data-act="close"]')) {
    removeSession(ch);
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
  if (state.runSave) {
    // "Save as profile" is the one-click path from "I just ran this" to "run
    // this again on a schedule". It writes an ordinary profile — the same
    // record the editor edits — so the two entry points cannot diverge.
    upsertProfile({ ...spec, id: newProfileId() });
    renderProfiles(form.closest('.pm-root') || document);
  }
  form.reset();
  state.runSave = false;
}

/* --------------------------------- renderers ---------------------------------- */

/** A status dot. The colour comes from the stylesheet, so it themes. */
function dot(status) {
  const variant = status === 'running' ? 'tb-dot-ok' : status === 'exited' ? '' : 'tb-dot-bad';
  return state.ctx.ui.el('span', { class: `tb-dot ${variant}`.trim(), title: status });
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
  const { el, render } = state.ctx.ui;
  const items = [...state.sessions.values()].reverse();
  const countEl = (root || document).querySelector('.pm-count');
  if (countEl) {
    countEl.textContent = `${items.filter((s) => s.status === 'running').length} running / ${items.length}`;
  }
  const running = (s) => s.status === 'running' || s.status === 'starting';
  render(
    host,
    items.length
      ? items.map((s) =>
          el(
            'div',
            { class: 'tb-row', 'data-ch': s.ch, role: 'option', 'aria-selected': String(s.ch === state.activeCh) },
            dot(s.status),
            el('span', { class: 'tb-row-label' }, s.name),
            running(s)
              ? el(
                  'span',
                  { class: 'tb-row-actions' },
                  el('button', { class: 'tb-icon-btn tb-icon-btn-danger', 'data-act': 'kill', title: 'Stop', 'aria-label': 'Stop' }, '✕'),
                )
              : null,
          ),
        )
      : el('div', { class: 'tb-hint' }, 'No sessions yet.'),
  );
}

/* ---------------------------------- profiles UI -------------------------------- */

/** One row per profile: what it runs, when, and the actions available. */
function renderProfiles(root) {
  const host = root.querySelector('.pm-profiles');
  if (!host) return;
  const { el, render } = state.ctx.ui;

  if (!state.profiles.length) {
    render(
      host,
      el('div', { class: 'tb-hint' }, 'No profiles. A profile can auto-start with the app and run on a schedule.'),
    );
    return;
  }

  const redraw = () => {
    renderProfiles(root);
    renderProfileEditor(root);
  };

  render(
    host,
    state.profiles.map((p) => {
      const live = runningFor(p.id).length;
      return el(
        'div',
        {
          class: 'pm-profile tb-pane tb-pane-pad',
          'data-id': p.id,
          style: `padding:6px;${p.enabled ? '' : 'opacity:.5;'}`,
        },
        el(
          'div',
          { style: 'display:flex;align-items:center;gap:6px;' },
          // The enabled toggle is a real Checkbox, so its state arrives through
          // `update:modelValue` rather than a delegated `change` on a native
          // input. Attaching it here keeps the event next to the control that
          // owns it.
          el('checkbox', {
            'data-act': 'profile-toggle',
            title: 'Enabled',
            defaultValue: p.enabled,
            'onUpdate:modelValue': (v) => {
              upsertProfile({ ...p, enabled: !!v });
              redraw();
            },
          }),
          el('span', { class: 'tb-row-label', style: 'font-weight:500;' }, p.name || p.program),
          el(
            'span',
            { class: 'tb-hint', title: live ? `${live} running` : 'not running' },
            live ? el('span', { class: 'tb-dot tb-dot-ok' }) : el('span', { class: 'tb-dot' }),
            live ? ` ${live}` : '',
          ),
        ),
        el('div', { class: 'tb-hint tb-mono', style: 'margin-top:2px;' }, [p.program, ...p.args].join(' ')),
        el(
          'div',
          { style: 'display:flex;gap:4px;align-items:center;margin-top:5px;' },
          p.autoStart ? el('badge', { variant: 'outline' }, 'auto') : null,
          p.schedule.kind !== 'none' ? el('badge', { variant: 'outline' }, describeSchedule(p.schedule)) : null,
          p.restart.policy !== 'never' ? el('badge', { variant: 'outline', title: 'restart policy' }, '↻') : null,
          el(
            'span',
            { class: 'tb-row-actions', style: 'gap:3px;' },
            el('button', { variant: 'outline', size: 'icon-xs', 'data-act': 'profile-run', title: 'Run now', 'aria-label': 'Run now' }, '▶'),
            el(
              'button',
              { variant: 'outline', size: 'icon-xs', 'data-act': 'profile-stop', title: 'Stop', 'aria-label': 'Stop', disabled: !live },
              '■',
            ),
            el('button', { variant: 'outline', size: 'icon-xs', 'data-act': 'profile-edit', title: 'Edit', 'aria-label': 'Edit' }, '✎'),
            el('button', { variant: 'outline', size: 'icon-xs', 'data-act': 'profile-del', title: 'Delete', 'aria-label': 'Delete' }, '✕'),
          ),
        ),
      );
    }),
  );
}

/**
 * The add/edit form. Only one profile is edited at a time.
 *
 * The controls are the real components — no native `<select>` or `<input
 * type=checkbox>` left. That costs a little bookkeeping: reka-ui's Select and
 * Checkbox render buttons, so `FormData` cannot see them, and reading the form
 * back would silently drop the schedule and both flags. Instead each control
 * writes into `state.draft` and the submit handler reads that. The trade is a
 * dozen lines of wiring for controls that are actually styled by the theme.
 */
function renderProfileEditor(root) {
  const host = root.querySelector('.pm-profile-editor');
  if (!host) return;
  const { el, native, render } = state.ctx.ui;

  // `null` is "closed"; `''` is "creating a new one". The original guard was
  // `if (!state.editingId)`, which is TRUE for `''` — so "+ New" cleared the
  // editor instead of opening it. Same reported symptom as the mis-bound
  // listener fixed earlier, different cause.
  if (state.editingId === null) {
    state.draft = null;
    render(host, null);
    return;
  }

  const editing = state.profiles.find((p) => p.id === state.editingId) ?? null;
  const p = editing ?? { ...DEFAULT_PROFILE, id: newProfileId() };
  const d = (state.draft = {
    id: p.id,
    name: p.name,
    program: p.program,
    args: p.args.join(' '),
    cwd: p.cwd,
    env: p.env.join('\n'),
    cols: p.cols,
    rows: p.rows,
    enabled: p.enabled,
    autoStart: p.autoStart,
    schedKind: p.schedule.kind,
    schedAt: p.schedule.at,
    schedEvery: p.schedule.everyMinutes,
    restartPolicy: p.restart.policy,
    maxRetries: p.restart.maxRetries,
    delayMs: p.restart.delayMs,
  });

  const set = (key) => (v) => {
    d[key] = v;
  };
  const text = (key, extra = {}) =>
    el('input', {
      defaultValue: d[key],
      onInput: (e) => set(key)(e.target.value),
      ...extra,
    });
  const number = (key, min, max) => text(key, { type: 'number', min, max });
  const field = (label, input) =>
    el(
      'label',
      { style: 'display:flex;flex-direction:column;gap:3px;font-size:10.5px;' },
      el('span', { class: 'tb-label' }, label),
      input,
    );
  const toggle = (key, label) =>
    el(
      'div',
      { style: 'display:flex;gap:6px;align-items:center;' },
      el('checkbox', { defaultValue: d[key], 'onUpdate:modelValue': set(key) }),
      el('label', {}, label),
    );
  const choice = (key, options, labels = {}) =>
    el(
      'select',
      { defaultValue: d[key], 'onUpdate:modelValue': set(key) },
      el('select-trigger', { class: 'w-full' }, el('select-value', {})),
      el(
        'select-content',
        {},
        options.map((k) => el('select-item', { value: k }, labels[k] ?? k)),
      ),
    );

  render(
    host,
    // Same reason as the run form: `el('form')` is the Form component, and its
    // submit event has no `preventDefault`.
    native(
      'form',
      {
        class: 'pm-profile-form tb-pane tb-pane-pad',
        'data-id': d.id,
        style: 'display:flex;flex-direction:column;gap:6px;margin-top:8px;',
        onSubmit: onProfileSubmit,
      },
      el('div', { class: 'tb-section-title', style: 'margin:0;' }, editing ? 'Edit profile' : 'New profile'),
      field('name', text('name', { placeholder: 'My backend' })),
      field('program', text('program', { placeholder: 'node' })),
      field('args (space separated)', text('args')),
      field('cwd', text('cwd', { placeholder: 'optional' })),
      field('env (KEY=VALUE, one per line)', el('textarea', { rows: 2, defaultValue: d.env, onInput: (e) => set('env')(e.target.value) })),
      el(
        'div',
        { style: 'display:flex;gap:6px;' },
        field('cols', number('cols', 20, 500)),
        field('rows', number('rows', 5, 200)),
      ),
      el('div', { style: 'display:flex;gap:14px;font-size:11px;' }, toggle('enabled', 'enabled'), toggle('autoStart', 'start with app')),
      field('schedule', choice('schedKind', ['none', 'daily', 'interval'], { none: 'manual only' })),
      el(
        'div',
        { style: 'display:flex;gap:6px;' },
        field('at (daily)', text('schedAt', { type: 'time' })),
        field('every (min)', number('schedEvery', 1, 1440)),
      ),
      field('restart on exit', choice('restartPolicy', ['never', 'on-failure', 'always'])),
      el(
        'div',
        { style: 'display:flex;gap:6px;' },
        field('max retries', number('maxRetries', 0, 100)),
        field('delay (ms)', number('delayMs', 0, 600000)),
      ),
      el(
        'div',
        { style: 'display:flex;gap:6px;' },
        el('button', { variant: 'default', type: 'submit' }, 'Save'),
        el(
          'button',
          {
            variant: 'outline',
            type: 'button',
            'data-act': 'profile-cancel',
            onClick: () => {
              state.editingId = null;
              state.draft = null;
              renderProfileEditor(root);
            },
          },
          'Cancel',
        ),
      ),
      el('div', { class: 'pm-profile-err tb-t-bad', style: 'font-size:11px;' }),
    ),
  );
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
  const d = state.draft;
  if (!d) return;
  upsertProfile({
    id: d.id,
    name: String(d.name ?? '').trim(),
    program: String(d.program ?? '').trim(),
    // Simple whitespace split: quoting is not supported, and pretending
    // otherwise would silently mangle an argument with a space in it.
    args: String(d.args ?? '').trim() ? String(d.args).trim().split(/\s+/) : [],
    cwd: String(d.cwd ?? '').trim(),
    env: String(d.env ?? '').split('\n'),
    cols: d.cols,
    rows: d.rows,
    enabled: !!d.enabled,
    autoStart: !!d.autoStart,
    schedule: { kind: d.schedKind, at: d.schedAt, everyMinutes: d.schedEvery },
    restart: { policy: d.restartPolicy, maxRetries: d.maxRetries, delayMs: d.delayMs },
  });
  state.editingId = null;
  state.draft = null;
  const root = ev.target.closest('.pm-root');
  renderProfiles(root);
  renderProfileEditor(root);
  renderDetail();
}

function renderTabs(root) {
  const host = (root || document).querySelector('.pm-tabs');
  if (!host) return;
  const { el, render } = state.ctx.ui;
  render(
    host,
    [...state.sessions.values()].reverse().map((s) =>
      el(
        'div',
        { class: 'tb-tab', 'data-ch': s.ch, role: 'tab', 'aria-selected': String(s.ch === state.activeCh) },
        dot(s.status),
        s.name,
        el(
          'span',
          { class: 'tb-icon-btn', 'data-act': 'close', role: 'button', title: 'Remove tab', 'aria-label': 'Remove tab' },
          '×',
        ),
      ),
    ),
  );
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

/**
 * Remove a session from the list.
 *
 * Deliberately refuses while it is running. It used to kill the process and drop
 * the entry in one click, which loses the output you were looking at and stops
 * something you may not have meant to stop — two very different decisions
 * behind one button. Stop first (which keeps the entry), then remove it.
 */
function removeSession(ch) {
  const s = state.sessions.get(ch);
  if (!s) return;
  if (s.status === 'running' || s.status === 'starting') {
    state.ui?.notify('Stop the process before removing its tab', 'error');
    return;
  }
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
  const { el, render } = state.ctx.ui;

  const s = state.sessions.get(state.selectedCh);
  if (!s) {
    render(host, el('div', { class: 'tb-hint' }, 'Select a session to inspect it.'));
    return;
  }

  const uptime = s.status === 'running' ? `${((Date.now() - s.startedAt) / 1000).toFixed(1)}s` : '—';
  const running = s.status === 'running' || s.status === 'starting';
  const prof = state.profiles.find((p) => p.id === s.profileId);
  const code = (text, cls = 'tb-mono tb-t-muted') => el('code', { class: cls }, text);

  render(
    host,
    el(
      'div',
      {},
      el('strong', { style: 'font-size:13px;' }, s.name),
      el(
        'div',
        { class: 'tb-t-muted', style: 'margin:8px 0;display:flex;flex-direction:column;gap:4px;' },
        el('div', {}, dot(s.status), ` status: ${s.status}${s.status === 'exited' ? ` (code ${s.exitCode})` : ''}`),
        el('div', {}, 'program: ', code([s.cfg.program, ...(s.cfg.args || [])].join(' '))),
        s.cfg.cwd ? el('div', {}, `cwd: ${s.cfg.cwd}`) : null,
        s.cfg.env && Object.keys(s.cfg.env).length
          ? el('div', {}, 'env: ', code(Object.keys(s.cfg.env).join(', ')))
          : null,
        prof
          ? el(
              'div',
              { style: 'margin-top:6px;padding-top:6px;border-top:1px solid var(--color-line);' },
              el('div', {}, 'profile: ', code(prof.name || prof.id, 'tb-mono tb-t-brand')),
              el('div', {}, `schedule: ${describeSchedule(prof.schedule)}`),
              el('div', {}, `restart: ${describeRestart(prof.restart)}${s.attempts ? ` · restarted ${s.attempts}×` : ''}`),
              s.stoppedByUser ? el('div', { class: 'tb-hint' }, 'stopped by you — no restart') : null,
            )
          : null,
        el('div', {}, 'channel: ', code(s.ch)),
        el('div', {}, `pid: ${s.pid ?? '—'}`),
        el('div', {}, `uptime: ${uptime}`),
        el('div', {}, `bytes in: ${s.bytesIn}`),
        el('div', {}, 'scheme: pty-stream (raw-binary)'),
      ),
      el(
        'div',
        { class: 'tb-toolbar', style: 'margin-top:10px;' },
        el(
          'button',
          { variant: 'destructive', 'data-act': 'kill-sel', disabled: !running, onClick: () => killSession(s.ch) },
          'Stop',
        ),
        el(
          'button',
          {
            variant: 'outline',
            'data-act': 'close-sel',
            disabled: running,
            title: running ? 'Stop it first' : undefined,
            onClick: () => removeSession(s.ch),
          },
          'Remove tab',
        ),
      ),
      el(
        'div',
        { style: 'margin-top:12px;border-top:1px solid var(--color-line);padding-top:8px;' },
        el(
          'div',
          { style: 'display:flex;align-items:center;gap:8px;margin-bottom:5px;' },
          el('span', { class: 'tb-section-title', style: 'margin:0;' }, 'output ring (last 4KB)'),
          el(
            'label',
            {
              class: 'tb-hint',
              style: 'margin-left:auto;display:flex;gap:5px;align-items:center;cursor:pointer;',
              title: 'raw = byte-accurate stream incl. ANSI escapes (debug)',
            },
            el('checkbox', {
              'data-act': 'ring-raw',
              defaultValue: state.ringRaw,
              'onUpdate:modelValue': (v) => {
                state.ringRaw = !!v;
                renderDetail();
              },
            }),
            ' raw',
          ),
        ),
        el(
          'pre',
          { class: 'pm-ring tb-pane tb-mono', style: 'margin:0;padding:6px;white-space:pre-wrap;word-break:break-all;max-height:220px;' },
          ringText(s) || '(empty)',
        ),
      ),
    ),
  );
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


/* --------------------------------- lifecycle ---------------------------------- */

export async function activate(ctx) {
  state.ctx = ctx;
  state.ui = ctx.ui ?? { notify: console.log };
  state.log = (cat, msg) => ctx.log.info(`[${cat}]`, msg);

  const savedProfiles = await ctx.storage.get(PROFILES_KEY);
  const hasProfiles = Array.isArray(savedProfiles) && savedProfiles.length > 0;
  state.profiles = (hasProfiles ? savedProfiles : DEFAULT_PROFILES).map(normalizeProfile);
  if (!hasProfiles) persistProfiles();
  state.log?.('profile', `loaded ${state.profiles.length} profile(s)`);

  // Auto-start first, then arm the schedules: a profile that is both auto-start
  // and scheduled should come up now, not wait for its first slot.
  for (const p of state.profiles) {
    if (p.enabled && p.autoStart && !runningFor(p.id).length) {
      await launchProfile(p, 'autostart');
    }
  }
  armSchedules();

  // The terminal is a canvas and cannot inherit tokens, so it is re-tinted by
  // hand when the theme changes. Registered here, released by ctx.cleanup.
  ctx.cleanup(onThemeChange(() => applyTermTheme()));

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
