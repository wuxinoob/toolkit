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
  pickSession,
  endedSessions,
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
  /**
   * The profile the user clicked — **the selector for the whole page**.
   *
   * There used to be two fields (`activeCh` + `selectedCh`) because the right
   * column had its own tab bar, so a tab could be "active" without being the
   * profile selected on the left. The tab bar is gone, so nothing needs keeping
   * in sync: one click, one selection, and the row highlight, the header, the
   * facts drawer and the terminal all read this.
   */
  selectedProfileId: null,
  /** Channel of the selected profile's session, or null when it has none. */
  selectedCh: null,
  /** The facts drawer — state, not DOM, because a re-render would drop the DOM's own. */
  showFacts: false,
  /** The raw output ring inside the drawer, same reason. */
  showRaw: false,
  ringRaw: false,
  debug: null,
};

const enc = new TextEncoder();

/**
 * Sequences that make a terminal TALK BACK, stripped out of a replay.
 *
 * A replay is HISTORY, and the queries inside it were asked once — live — and
 * answered then. Writing that history into a FRESH terminal asks them again:
 * xterm answers immediately, and the answer leaves through `onData` into a shell
 * that is still running. That is not a theory; it was measured on this repo's own
 * PowerShell session, on every return to this view:
 *
 *   `ESC[1;1R`  a cursor-position report, answering a DSR replayed from startup
 *   `ESC[O`     a focus-out, because the replayed stream had turned focus
 *               reporting ON and the new terminal believed it
 *
 * Stray escape sequences landing at an interactive prompt are exactly what an
 * audible PSReadLine bell rings for — the user's "滴" when switching pages.
 *
 *   `ESC[6n`       DSR / cursor-position query  -> xterm replies `ESC[r;cR`
 *   `ESC[?1004h/l` focus reporting on / off     -> xterm reports focus later
 *
 * The mute in `onData` covers the first class in general (any reply — DA,
 * XTWINOPS, … — is dropped while the replay parses); this covers the second,
 * which is not a reply at all but a MODE the terminal would keep and act on
 * long after the replay finished.
 */
const REPLAY_STRIP = /\x1b\[\?1004[hl]|\x1b\[6n/g;

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
    /** Last seen `handle.bells()` — BEL bytes the transport dropped. */
    bells: 0,
    /** True while the replay is being parsed: nothing it says is input. */
    replaying: false,
  };
  state.sessions.set(ch, session);

  // Attach the terminal BEFORE spawning so the PTY is created at the pane's
  // real, fitted size. A post-spawn resize forces ConPTY to emit a full-screen
  // redraw in a new coordinate system; if that size ever diverges from the
  // xterm grid, the pane looks frozen. Starting in sync avoids the dance.
  scheduleRefreshRows();
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
          // The transport eats BEL and counts it (`consumeBell` in
          // `src/protocol/transports/pty.js`). Reading the counter here is what
          // turns "sometimes the shell beeps" into a number in the facts drawer:
          // a rising count means the bytes reach us (and are dropped); a count
          // stuck at zero while the beep is still audible means the sound never
          // entered this stream — it is the child's or the console host's own.
          // Note `session.handle` is only assigned once `ctx.pty` resolves, and
          // a pty can emit before that; 0 is the right answer either way.
          const bells = session.handle?.bells?.() ?? 0;
          if (bells !== session.bells) {
            session.bells = bells;
            state.log?.('pty', `bell ch=${ch} ×${bells} dropped`);
          }
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

/**
 * The session a profile owns right now.
 *
 * NOT "the first entry with this id": Stop keeps its entry, so after Stop + Run
 * there are two, and the first is the dead one. The rule (and the four bugs it
 * fixes) lives in `pickSession`, where it is testable.
 */
function sessionOf(profileId) {
  return pickSession(state.sessions.values(), profileId);
}

/**
 * Select a profile: the row highlight, the right-hand header, the facts drawer
 * and the terminal all follow it. **This is the only way the right column
 * changes what it shows.**
 *
 * A background launch (schedule / auto-start / restart) deliberately does not
 * call this. `spawnFromSpec` used to activate its own session on every spawn,
 * which with a tab bar read as "a tab appeared"; without one it means a process
 * you are not watching replacing the output of the one you are. The row's status
 * is the signal for those, and clicking it is how you look.
 */
function selectProfile(id) {
  state.selectedProfileId = id ?? null;
  state.selectedCh = id ? (sessionOf(id)?.ch ?? null) : null;
  activateSession(state.selectedCh);
  renderProfiles(document);
  renderDetail();
}

/** Live sessions belonging to a profile. */
function runningFor(profileId) {
  return [...state.sessions.values()].filter(
    (s) => s.profileId === profileId && (s.status === 'running' || s.status === 'starting'),
  );
}

/**
 * Forget a profile's ended sessions.
 *
 * The other half of "Stop keeps its entry": those records would otherwise live
 * for as long as the window does, and once a new round has started they are
 * unreachable — the row, the header and the drawer all follow the picked
 * session, so nothing can clear them any more. Dropped only when a NEW round
 * starts (see `launchProfile`), never while one is still live.
 */
function dropEnded(profileId) {
  const ended = endedSessions(state.sessions.values(), profileId);
  for (const s of ended) {
    detachTerminal(s);
    state.sessions.delete(s.ch);
    if (state.selectedCh === s.ch) state.selectedCh = null;
  }
  if (ended.length) {
    state.log?.('profile', `dropped ${ended.length} ended session(s) of ${profileId}`);
  }
  return ended.length;
}

async function launchProfile(rawProfile, reason = 'manual') {
  const p = normalizeProfile(rawProfile);
  if (!p.program) {
    state.ui?.notify(`profile "${p.name || p.id}" has no program to run`, 'error');
    return null;
  }
  // One profile owns one process. Pressing run on a live profile focuses what is
  // already there instead of starting a second copy — "取消多开". A restart is
  // unaffected: the exited session is no longer counted as running.
  const live = runningFor(p.id);
  if (live.length) {
    state.ui?.notify(`"${p.name || p.id}" is already running`, 'info');
    // Pressing Run means "show me this one" — but a schedule firing must not
    // move the user's selection, so only the manual path follows it.
    if (reason === 'manual') selectProfile(p.id);
    return live[0];
  }
  // A manual Run starts a new round, so the previous round's record goes with
  // it. Only manual: a restart or a schedule firing must not take away the
  // output of the session the user is currently looking at (those paths
  // deliberately leave the selection alone).
  if (reason === 'manual') dropEnded(p.id);
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
  if (reason === 'manual') selectProfile(p.id);
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
    // `onData` is NOT "the user typed". It also carries every reply xterm
    // produces on its own — cursor reports, device attributes, focus — and while
    // the replay is being parsed those belong to a conversation that ended long
    // ago. Forwarding them writes stale escape sequences into a live shell.
    if (session.replaying) {
      state.log?.('pty', `dropped replay reply ch=${session.ch}`);
      return;
    }
    if (session.status === 'running') session.handle?.write?.(data);
  });
  const ro = new ResizeObserver(() => scheduleFit(session));
  ro.observe(container);
  session.terminal = term;
  session.fitAddon = fit;
  session.resizeObs = ro;
  session.termHost = container;

  scheduleFit(session);
  if (session.replay) {
    // The write callback fires when the parser has consumed the text, so the
    // flag covers exactly the replay — not one keystroke more.
    session.replaying = true;
    try {
      term.write(session.replay.replace(REPLAY_STRIP, ''), () => {
        session.replaying = false;
      });
    } catch (e) {
      session.replaying = false;
      state.log?.('pty', `replay failed ch=${session.ch}: ${e.message ?? e}`);
    }
  }
  return term;
}

function detachTerminal(session) {
  // Belt and braces: `replaying` is cleared by the replay's own write callback,
  // and this is the other end — if a terminal is torn down mid-write the
  // callback never runs, and a session-level flag left true would make the NEXT
  // terminal permanently deaf to the keyboard.
  session.replaying = false;
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
  const { el, render } = ctx.ui;

  ctx.registerView('procman', (root) => {
    reapDetached();

    render(
      root,
      el(
        'div',
        { class: 'pm-root', style: 'display:grid;grid-template-columns:340px 1fr;gap:8px;height:100%;min-height:0;' },

        el(
          'div',
          // The column does NOT scroll any more — the list inside it does. The
          // toolbar therefore stays put while the profiles scroll under it,
          // which is the only part of this column whose length is unbounded.
          { class: 'pm-left', style: 'display:flex;flex-direction:column;gap:8px;min-height:0;overflow:hidden;' },
          el(
            'div',
            { class: 'tb-toolbar', style: 'flex:none;' },
            el('span', { class: 'tb-section-title', style: 'margin:0;' }, 'Profiles'),
            el('span', { class: 'pm-count tb-hint', style: 'margin-left:auto;' }),
            el('button', { variant: 'outline', size: 'xs', 'data-act': 'profile-new' }, '+ New'),
          ),
          el('div', {
            class: 'pm-profiles tb-list',
            // `list`, not `listbox`: the rows are `listitem`s that happen to be
            // selectable, and a listbox expects its children to be `option`s —
            // which cannot hold the enable checkbox each row has.
            role: 'list',
            'aria-label': 'Profiles',
            // `.tb-list` already carries `overflow:auto; min-height:0`, so the
            // list is the one scroll region in this column.
            style: 'flex:1 1 auto;',
          }),
          // The detail panel used to live here. It moved to the right column,
          // next to the thing it describes: with one profile owning one process,
          // every fact in it is a fact about the profile the terminal is showing.
          // The editor mounts here as a dialog; nothing renders into it inline.
          el('div', { class: 'pm-profile-editor' }),
        ),

        el(
          'div',
          { class: 'pm-center tb-card', style: 'display:flex;flex-direction:column;min-height:0;overflow:hidden;' },
          /**
           * The right column owns the running state: a header that names what
           * you are looking at, a drawer for the profile's own facts, and the
           * terminal under both.
           *
           * There is NO tab bar. It used to be a second way to choose what the
           * terminal showed, and two selectors meant two places to look when the
           * output was not what you expected — the left row is the selector.
           */
          el('div', {
            class: 'pm-facts-head tb-card-head',
            style: 'display:none;align-items:center;gap:8px;flex:none;flex-wrap:wrap;padding:8px 12px;',
          }),
          el('div', {
            class: 'pm-facts tb-pane',
            // Built only while the drawer is open (see state.showFacts) — not
            // merely hidden — so a closed drawer costs nothing.
            style: 'display:none;margin:8px;padding:10px;flex:none;font-size:12px;',
          }),
          el(
            'div',
            { class: 'pm-term-area', style: 'flex:1;min-height:0;position:relative;background:var(--color-canvas);' },
            el(
              'div',
              { class: 'pm-term-empty tb-empty', style: 'position:absolute;inset:0;' },
              'Select a profile on the left, or create one with + New.',
            ),
          ),
        ),
      ),
    );

    // One handler, two columns. Both are bound (not `root`) so a click inside
    // the editor dialog — which is portalled to the plugin's container, i.e.
    // outside both — never routes through the row logic. The tree keeps the same
    // `data-*` hooks the handlers were written against, so only the DOM moved.
    for (const sel of ['.pm-left', '.pm-center']) {
      root.querySelector(sel).addEventListener('click', (ev) => onProfileClick(root, ev));
    }

    renderProfiles(root);
    renderProfileEditor(root);
    activateSession(state.selectedCh);
    renderDetail();
  });
}

function dot(status) {
  const variant = status === 'running' ? 'tb-dot-ok' : status === 'exited' ? '' : 'tb-dot-bad';
  return state.ctx.ui.el('span', { class: `tb-dot ${variant}`.trim(), title: status });
}

function refreshSessionRows() {
  const root = document.querySelector('.pm-root');
  if (!root) return;
  // The profile rows carry the live status now that the separate sessions list
  // is gone, so refreshing rows means redrawing the profile list.
  renderProfiles(root);
}

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
      const sess = sessionOf(p.id);
      const live = sess && (sess.status === 'running' || sess.status === 'starting');
      /**
       * The row is the selector, and that is ALL it is.
       *
       * Its four action buttons moved to the right column — Run/Stop/Edit into
       * the header, Clear/Delete into the drawer. Two sets of affordances for
       * one object is one place too many to look when something does not behave
       * as expected, and they were what made the row three lines tall.
       *
       * The status stays, deliberately: with the actions gone this is the only
       * thing on the page that says which profiles are running.
       */
      const selected = state.selectedProfileId === p.id;
      const status = sess ? sess.status : 'idle';
      return el(
        'div',
        {
          class: 'pm-profile tb-pane',
          'data-id': p.id,
          role: 'listitem',
          // `aria-current`, not `aria-selected`: the row holds a real checkbox,
          // and `aria-selected` is only meaningful on an option/tab — wrapping
          // an interactive control in `role="option"` is worse than just saying
          // "this is the current one".
          'aria-current': selected ? 'true' : undefined,
          style:
            'padding:6px 8px;cursor:pointer;display:flex;flex-direction:column;gap:3px;' +
            (selected
              ? 'background:color-mix(in srgb, var(--color-brand) 12%, transparent);box-shadow:inset 3px 0 0 var(--color-brand);'
              : '') +
            (p.enabled ? '' : 'opacity:.5;'),
        },
        el(
          'div',
          { style: 'display:flex;align-items:center;gap:6px;min-width:0;' },
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
          el(
            'span',
            { class: 'tb-row-label', style: 'font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' },
            p.name || p.program,
          ),
          el(
            'span',
            {
              class: `tb-hint ${live ? 'tb-t-ok' : sess ? 'tb-t-bad' : ''}`.trim(),
              title: status,
              style: 'margin-left:auto;flex:none;display:flex;align-items:center;gap:4px;',
            },
            el('span', { class: `tb-dot ${live ? 'tb-dot-ok' : sess ? 'tb-dot-bad' : ''}`.trim() }),
            status,
          ),
        ),
        el(
          'div',
          { style: 'display:flex;align-items:center;gap:6px;min-width:0;' },
          el(
            'span',
            { class: 'tb-hint tb-mono', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' },
            [p.program, ...p.args].join(' '),
          ),
          el(
            'span',
            { style: 'margin-left:auto;flex:none;display:flex;gap:3px;' },
            p.autoStart ? el('badge', { variant: 'outline' }, 'auto') : null,
            p.schedule.kind !== 'none' ? el('badge', { variant: 'outline' }, describeSchedule(p.schedule)) : null,
            // `restart` as a word, not `↻`: the arrow was one of the four
            // platform-dependent glyphs this row used to be full of, and the
            // policy it stands for is what the tooltip now spells out.
            p.restart.policy !== 'never'
              ? el('badge', { variant: 'outline', title: `restart: ${describeRestart(p.restart)}` }, 'restart')
              : null,
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
      // `align-items:stretch` is load-bearing: `el('label')` resolves to the
      // shadcn Label COMPONENT, whose own style centres its children — which
      // centred every 30px label over a 510px input (measured: the span's centre
      // was 639.5 against the input's 640). A left-aligned label above its field
      // is what a form is supposed to look like.
      { style: 'display:flex;flex-direction:column;gap:3px;font-size:10.5px;align-items:stretch;' },
      el('span', { class: 'tb-label' }, label),
      input,
    );
  /**
   * Two fields side by side, each taking half the row.
   *
   * They used to be a `display:flex` row, which let each field shrink to its
   * content: the numeric inputs came out 76px wide inside a 510px row, so two
   * thirds of every pair row was empty. A grid gives each half a real width and
   * keeps the two columns aligned between rows.
   */
  const pair = (...fields) =>
    el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px;' }, ...fields);
  const section = (title) =>
    el('div', { class: 'tb-section-title', style: 'margin:12px 0 2px;' }, title);
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

  const close = () => {
    state.editingId = null;
    state.draft = null;
    renderProfileEditor(root);
  };

  render(
    host,
    // A dialog, not an inline panel. Sixteen fields do not fit a 340px column,
    // and as a panel they pushed the profile list off the bottom of the window.
    // `defaultOpen` keeps it uncontrolled: the whole tree is rebuilt on every
    // state change rather than patched, so "open" is a property of the render.
    el(
      'dialog',
      {
        defaultOpen: true,
        'onUpdate:open': (open) => {
          if (!open) close();
        },
      },
      el(
        'dialog-content',
        // Inline, not `max-h-[85vh] overflow-y-auto sm:max-w-[560px]`: a plugin
        // view must not depend on Tailwind utilities (an external plugin cannot
        // use them at all), and this file is the reference others copy. The
        // dialog is 560x731 as measured, so the cap only matters on short windows.
        // Header and footer stay put; only the FIELDS scroll. The height cap is
        // what makes that necessary: measured at 1440x900 the form needs ~800px
        // and 85vh is 765, so with `overflow:auto` on the whole dialog the Save
        // button ended up below the fold — the one control that must always be
        // reachable.
        { style: 'max-height:85vh;max-width:560px;display:flex;flex-direction:column;' },
        el(
          'dialog-header',
          {},
          el('dialog-title', {}, editing ? 'Edit profile' : 'New profile'),
          el(
            'dialog-description',
            {},
            'One profile owns one process — the schedule and restart policy below apply to that single process.',
          ),
        ),
        // `native('form')`, not `el('form')`: the vocabulary contains a Form
        // COMPONENT, whose submit event is not native, so `ev.preventDefault`
        // would not exist on it.
        native(
          'form',
          {
            class: 'pm-profile-form',
            'data-id': d.id,
            style: 'display:flex;flex-direction:column;gap:8px;min-height:0;',
            onSubmit: onProfileSubmit,
          },
          el(
            'div',
            { class: 'pm-form-body', style: 'display:flex;flex-direction:column;gap:8px;overflow-y:auto;min-height:0;padding-right:4px;' },
          // Grouped, so the modal reads as "what it runs" then "when it runs"
          // instead of fourteen equal-looking rows.
          section('Program'),
          field('name', text('name', { placeholder: 'My backend' })),
          field('program', text('program', { placeholder: 'node' })),
          field('args (space separated)', text('args')),
          field('cwd', text('cwd', { placeholder: 'optional' })),
          field('env (KEY=VALUE, one per line)', el('textarea', { rows: 3, defaultValue: d.env, onInput: (e) => set('env')(e.target.value) })),
          section('Behaviour'),
          el('div', { style: 'display:flex;gap:14px;font-size:11px;' }, toggle('enabled', 'enabled'), toggle('autoStart', 'start with app')),
          field('schedule', choice('schedKind', ['none', 'daily', 'interval'], { none: 'manual only' })),
          pair(field('at (daily)', text('schedAt', { type: 'time' })), field('every (min)', number('schedEvery', 1, 1440))),
          field('restart on exit', choice('restartPolicy', ['never', 'on-failure', 'always'])),
          pair(field('max retries', number('maxRetries', 0, 100)), field('delay (ms)', number('delayMs', 0, 600000))),
          section('Terminal'),
          pair(field('cols', number('cols', 20, 500)), field('rows', number('rows', 5, 200))),
          ),
          // Outside the scrolling body: Cancel/Save must be reachable without
          // scrolling a modal, and the error line belongs next to them.
          el(
            'dialog-footer',
            {},
            el('button', { variant: 'outline', type: 'button', 'data-act': 'profile-cancel', onClick: close }, 'Cancel'),
            el('button', { variant: 'default', type: 'submit' }, 'Save'),
          ),
          el('div', { class: 'pm-profile-err tb-t-bad', style: 'font-size:11px;' }),
        ),
      ),
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

  // A click on the row itself (not on one of its buttons) selects the profile:
  // its process goes to the terminal and its facts to the drawer beside it.
  // Selecting a profile that is NOT running is a real answer, not a no-op: the
  // terminal swaps to that profile's "not running" state, so what you see always
  // belongs to the row you highlighted.
  if (!btn) {
    selectProfile(id);
    return;
  }

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

function activateSession(ch) {
  const area = document.querySelector('.pm-term-area');
  if (!area) return;
  const empty = area.querySelector('.pm-term-empty');
  area.querySelectorAll(':scope > .pm-term-box').forEach((n) => n.remove());
  /**
   * The empty state names the SELECTED profile rather than saying "nothing is
   * running". With the terminal driven by the left column, "nothing here" is a
   * statement about one row: either you have not picked one, or the one you
   * picked is not running — and saying which is the difference between an empty
   * pane and an answer.
   */
  if (empty) {
    const prof = state.profiles.find((p) => p.id === state.selectedProfileId);
    empty.textContent = prof
      ? `"${prof.name || prof.program}" is not running — press Run above.`
      : 'Select a profile on the left, or create one with + New.';
    empty.style.display = 'none';
  }
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
  // The profile keeps its selection — it is still the row the user is looking
  // at — but it no longer has a session, so the terminal falls back to its
  // "not running" state and the row's status goes back to idle.
  if (state.selectedCh === ch) {
    state.selectedCh = null;
    activateSession(null);
    renderProfiles(document);
  }
  renderDetail();
}

/**
 * Render the right column's two panels for whatever is selected.
 *
 * Same name as before — this is still "the detail of the selection" — but a
 * different home: the header above the terminal, and a drawer beside it, instead
 * of a panel under the profile list. Every fact in here is a fact about the
 * profile the terminal is showing, so it belongs next to the terminal.
 *
 * Both panels are rebuilt from scratch on each call (the factory replaces a
 * container's children), which is why the two disclosure states live in `state`:
 * a `<details>` element would forget it was open on the very next frame.
 */
function renderDetail() {
  const head = document.querySelector('.pm-facts-head');
  const facts = document.querySelector('.pm-facts');
  if (!head || !facts) return;
  const { el, render } = state.ctx.ui;

  const prof = state.profiles.find((p) => p.id === state.selectedProfileId) ?? null;
  const s = state.sessions.get(state.selectedCh);

  if (!prof) {
    // Nothing selected: no header, no drawer — and the terminal already says
    // what to do. `render(x, null)` is how a container is emptied THROUGH the
    // factory; clearing it by hand would leave the previous Vue app mounted.
    head.style.display = 'none';
    facts.style.display = 'none';
    render(head, null);
    render(facts, null);
    return;
  }

  const running = !!s && (s.status === 'running' || s.status === 'starting');
  const status = s ? s.status : 'idle';
  const uptime = s && s.status === 'running' ? `${Math.round((Date.now() - s.startedAt) / 1000)}s` : null;
  const fact = (label, value) =>
    el(
      'div',
      { style: 'min-width:0;' },
      el('span', { class: 'tb-label' }, label),
      el('span', { class: 'tb-mono', style: 'margin-left:6px;word-break:break-all;' }, value),
    );
  /**
   * Shown only when it is not zero, because zero is the common case and a row
   * that always says "0" teaches a reader to stop reading the grid.
   *
   * It is a fact, not a control: nothing in this app can ring, so there is
   * nothing to turn off. What the number answers is WHOSE sound the user heard —
   * see `consumeBell` in `src/protocol/transports/pty.js`.
   */
  const bells = s?.handle?.bells?.() ?? 0;

  /**
   * The header: what you are looking at, and what you can do to it.
   *
   * Handlers are closures over `prof`, NOT `data-act` delegation. The delegated
   * handler resolves a profile from the clicked ROW, and these buttons are not
   * in a row — routing them through it is how you get buttons that silently do
   * nothing.
   */
  head.style.display = 'flex';
  render(head, [
    el('strong', { style: 'font-size:13px;' }, prof.name || prof.program),
    el(
      'badge',
      {
        variant: status === 'running' ? 'secondary' : 'outline',
        title: s && s.status === 'exited' ? `exit code ${s.exitCode}` : undefined,
      },
      status,
    ),
    s
      ? el(
          'span',
          { class: 'tb-hint tb-mono' },
          [s.pid ? `pid ${s.pid}` : null, uptime, `${s.bytesIn} B`].filter(Boolean).join(' · '),
        )
      : el('span', { class: 'tb-hint' }, 'no process'),
    el(
      'span',
      { style: 'margin-left:auto;display:flex;gap:6px;align-items:center;' },
      running
        ? el('button', { variant: 'outline', size: 'xs', onClick: () => stopProfile(prof.id) }, 'Stop')
        : el('button', { variant: 'default', size: 'xs', onClick: () => launchProfile(prof, 'manual') }, 'Run'),
      el(
        'button',
        {
          variant: 'outline',
          size: 'xs',
          onClick: () => {
            state.editingId = prof.id;
            renderProfileEditor(document.querySelector('.pm-root'));
          },
        },
        'Edit',
      ),
      el(
        'button',
        {
          variant: 'ghost',
          size: 'xs',
          'aria-expanded': String(state.showFacts),
          onClick: () => {
            state.showFacts = !state.showFacts;
            renderDetail();
          },
        },
        // A typographic disclosure mark, not an icon: the icon vocabulary is the
        // host's sidebar set, and a plugin view has no legitimate way to reach it
        // (that would mean widening the plugin contract — `ctx.ui.icon` — which is
        // a separate decision, deliberately not taken here).
        state.showFacts ? 'Config ▴' : 'Config ▾',
      ),
    ),
  ]);

  /**
   * The drawer: the profile's own facts, then the raw capture for debugging.
   *
   * Closed means NOT BUILT (not `display:none`), which is what makes "collapsed
   * costs nothing" true: the ring `<pre>` and its ANSI stripping only exist
   * while someone is looking at them.
   */
  facts.style.display = state.showFacts ? 'block' : 'none';
  if (!state.showFacts) {
    render(facts, null);
    return;
  }

  render(facts, [
    el(
      'div',
      { style: 'display:grid;grid-template-columns:1fr 1fr;gap:4px 14px;font-size:11.5px;' },
      fact('program', [prof.program, ...(prof.args || [])].join(' ') || '—'),
      fact('cwd', prof.cwd || '(inherit)'),
      fact('schedule', describeSchedule(prof.schedule)),
      fact('restart', describeRestart(prof.restart) + (s && s.attempts ? ` · ${s.attempts}×` : '')),
      fact('auto-start', prof.autoStart ? 'yes' : 'no'),
      fact('enabled', prof.enabled ? 'yes' : 'no'),
      s ? fact('channel', s.ch) : null,
      s ? fact('scheme', 'pty-stream · raw-binary') : null,
      bells ? fact('bell', `${bells} × 0x07 — dropped, never rendered`) : null,
    ),
    s
      ? el(
          'div',
          { style: 'margin-top:8px;border-top:1px solid var(--color-line);padding-top:6px;' },
          el(
            'div',
            { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;' },
            el(
              'button',
              {
                variant: 'ghost',
                size: 'xs',
                'aria-expanded': String(state.showRaw),
                onClick: () => {
                  state.showRaw = !state.showRaw;
                  renderDetail();
                },
              },
              state.showRaw ? '▴ Raw output (last 4KB)' : '▾ Raw output (last 4KB)',
            ),
            el(
              'label',
              {
                class: 'tb-hint',
                style: 'display:flex;gap:5px;align-items:center;cursor:pointer;',
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
              'raw bytes',
            ),
            el(
              'button',
              {
                variant: 'outline',
                size: 'xs',
                disabled: running,
                title: running ? 'Stop it first' : 'Clear this output and forget the session',
                onClick: () => removeSession(s.ch),
              },
              'Clear output',
            ),
          ),
          state.showRaw
            ? el(
                'pre',
                { class: 'pm-ring tb-pane tb-mono', style: 'margin:6px 0 0;padding:6px;white-space:pre-wrap;word-break:break-all;max-height:220px;' },
                ringText(s) || '(empty)',
              )
            : null,
        )
      : null,
    el(
      'div',
      { style: 'margin-top:10px;border-top:1px solid var(--color-line);padding-top:8px;display:flex;gap:8px;align-items:center;' },
      // The destructive action lives behind the disclosure on purpose, and says
      // what it does NOT do — the two things people get wrong about it.
      el('span', { class: 'tb-hint', style: 'margin-right:auto;' }, 'Deleting a profile does not stop its process.'),
      el(
        'button',
        {
          variant: 'outline',
          size: 'xs',
          onClick: () => {
            deleteProfile(prof.id);
            renderProfiles(document.querySelector('.pm-root'));
            renderProfileEditor(document.querySelector('.pm-root'));
          },
        },
        'Delete',
      ),
    ),
  ]);
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
