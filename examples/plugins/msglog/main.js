/**
 * msglog.demo — the observability layer, live.
 *
 * Four things this shows that a plugin otherwise cannot see:
 *
 *   1. The COMMUNICATION TRACE — every gateway round trip, with the identity the
 *      caller claimed, the service/action, the duration and the outcome
 *      (including permission denials). Off by default; this turns it on.
 *   2. Window-local events (`ctx.events`, the `in-process` scheme).
 *   3. Cross-window broadcasts (`ctx.bus`, the `event-bus` scheme).
 *   4. The unified session table.
 *
 * ## Why this reaches for `window.__toolbox` instead of `ctx`
 *
 * Deliberate, and worth stating: **the trace is not a plugin API.**
 * "Watch every plugin's traffic" is a DEBUG capability, not a plugin capability —
 * exposing it as `ctx.observe` would let any plugin read every other plugin's
 * calls, which is a privacy hole dressed as a feature.
 *
 * A *test* plugin is exactly the right place for it, and the debug handle is
 * exactly the right door. It is the host's own diagnostic surface, and using it
 * from here is honest about what this is.
 *
 * Constraint (same as every external plugin): SINGLE-FILE ESM, imported from a
 * Blob URL. No imports. Everything comes from `ctx` or the debug handle.
 */

export const manifest = {
  id: 'msglog.demo',
  name: 'Message Log',
  version: '0.1.0',
  api: 2,
  description: 'Live view of the communication trace, events and sessions.',
  contributes: {
    views: [{ slot: 'tool', id: 'msglog', title: 'Message Log', icon: 'lucide:activity' }],
  },
  // Mirrors plugin.json — the two must agree (there is an audit test).
  permissions: ['rpc:notify', 'rpc:host', 'rpc:bus', 'rpc:storage'],
};

/** Cap on retained lines. A trace can be chatty; the view is not a log file. */
const MAX = 300;

const state = {
  ctx: null,
  root: null,
  /** Newest first: `{ src, text, kind }`. `src` groups the three sources. */
  lines: [],
  /** Which sources are shown. */
  show: { trace: true, event: true, bus: true },
  /** Restore function from the previous trace sink, so deactivate can undo. */
  restoreSink: null,
  /** Unsubscribes for the two event subscriptions. */
  offs: [],
};

function push(src, kind, text) {
  const stamp = new Date().toLocaleTimeString();
  state.lines.unshift({ src, kind, text: `${stamp}  ${text}` });
  if (state.lines.length > MAX) state.lines.length = MAX;
  // Only redraw if this source is on screen — a muted source must not cost a
  // re-render, or turning the trace off would still make the view flicker.
  if (state.show[src]) redraw();
}

function redraw() {
  if (state.root) render(state.root);
}

/* --------------------------------- activate -------------------------------- */

export async function activate(ctx) {
  state.ctx = ctx;
  state.lines = [];
  state.offs = [];

  // ---- 1. the trace -------------------------------------------------------
  const hub = globalThis.window?.__toolbox?.hub;
  if (!hub || typeof hub.setTraceSink !== 'function') {
    push('trace', 'bad', 'no debug handle — run inside the app, not a plain browser');
  } else {
    // Keep the previous sink so the boot-installed one (which writes to
    // debug.log) is restored on deactivate — otherwise this plugin would
    // silently steal the host's own trace destination.
    state.restoreSink = hub.setTraceSink((line) => push('trace', 'info', line));
    hub.setTrace(true);
    push('trace', 'ok', 'trace ON — every gateway call now shows here');
    push('trace', 'info', 'this plugin calls the gateway too, so expect its own lines');
  }

  // ---- 2. window-local events --------------------------------------------
  // `in-process`: zero IPC, same window. The callback gets the RAW payload
  // (unlike `ctx.bus`, which gets the whole envelope) — that asymmetry is a
  // known wart, see docs/COMMS-AUDIT-2026-09-23.md.
  state.offs.push(
    ctx.events.on('msglog:local', (payload) => push('event', 'ok', `local evt: ${JSON.stringify(payload)}`)),
  );

  // ---- 3. cross-window broadcasts ----------------------------------------
  // `event-bus`: reaches other windows. The callback gets the ENVELOPE, so the
  // payload is `env.p` and `env.svc` says who published.
  state.offs.push(
    ctx.bus.subscribe('msglog:broadcast', (env) =>
      push('bus', 'ok', `broadcast from ${env?.svc ?? '?'}: ${JSON.stringify(env?.p ?? null)}`),
    ),
  );

  ctx.registerView('msglog', render);

  // The trace is already on, so this call shows up in its own view — which is
  // the clearest possible demonstration that the trace works.
  await refreshSessions();
}

export function deactivate() {
  for (const off of state.offs) {
    try {
      off();
    } catch {
      /* already gone */
    }
  }
  state.offs = [];

  const hub = globalThis.window?.__toolbox?.hub;
  if (hub && state.restoreSink) {
    hub.setTrace(false);
    hub.setTraceSink(state.restoreSink);
  }
  state.restoreSink = null;
  state.root = null;
  state.ctx = null;
}

/* ----------------------------------- view ---------------------------------- */

function render(root) {
  state.root = root;
  const { el, render: draw } = state.ctx.ui;

  const shown = state.lines.filter((l) => state.show[l.src]);

  draw(
    root,
    el(
      'div',
      { class: 'tb-pane tb-pane-pad', style: 'display:flex;flex-direction:column;gap:9px;height:100%;' },
      el(
        'div',
        {},
        el('div', { class: 'tb-section-title', style: 'margin:0;' }, 'Message Log'),
        el(
          'div',
          { class: 'tb-hint', style: 'margin-top:2px;' },
          'The observability layer, live. The trace is a DEBUG facility — it is reached through ' +
            'window.__toolbox, not ctx, because watching every plugin\'s traffic is not a plugin capability.',
        ),
      ),

      el(
        'div',
        { style: 'display:flex;flex-wrap:wrap;gap:6px;' },
        button(el, `trace ${state.show.trace ? 'ON' : 'off'}`, () => toggle('trace'), state.show.trace),
        button(el, `local ${state.show.event ? 'ON' : 'off'}`, () => toggle('event'), state.show.event),
        button(el, `bus ${state.show.bus ? 'ON' : 'off'}`, () => toggle('bus'), state.show.bus),
        button(el, 'Emit local', emitLocal),
        button(el, 'Broadcast', broadcast),
        button(el, 'OS notification', notifyOS),
        button(el, 'Sessions', refreshSessions),
        button(el, 'Clear', () => {
          state.lines = [];
          redraw();
        }),
      ),

      el(
        'div',
        { class: 'tb-hint' },
        `${shown.length} line(s) shown · ${state.lines.length} retained · ` +
          'trace also lands in debug.log',
      ),

      el(
        'div',
        {
          class: 'tb-list tb-mono',
          style: 'flex:1;min-height:160px;overflow:auto;font-size:11px;padding:6px;',
        },
        ...(shown.length
          ? shown.map((l) =>
              el(
                'div',
                {
                  class: l.kind === 'bad' ? 'tb-t-bad' : l.kind === 'ok' ? 'tb-t-ok' : 'tb-t-muted',
                  style: 'padding:1px 0;white-space:pre-wrap;word-break:break-all;',
                },
                `[${l.src}] ${l.text}`,
              ),
            )
          : [el('div', { class: 'tb-hint' }, 'Nothing yet — press a button.')]),
      ),
    ),
  );
}

function button(el, label, onClick, active) {
  return el(
    'button',
    { class: `tb-btn tb-btn-sm${active ? ' tb-btn-primary' : ''}`, onClick },
    label,
  );
}

function toggle(which) {
  state.show[which] = !state.show[which];
  redraw();
}

/* --------------------------------- actions --------------------------------- */

function emitLocal() {
  // Window-local: no IPC, synchronous delivery. Shows up under [event].
  state.ctx.events.emit('msglog:local', { at: Date.now() });
  push('event', 'info', 'emitted a local event');
}

async function broadcast() {
  // Cross-window: goes through the gateway, so it ALSO shows up under [trace].
  try {
    await state.ctx.bus.publish('msglog:broadcast', { at: Date.now() });
    push('bus', 'info', 'published a broadcast (see the trace line too)');
  } catch (e) {
    push('bus', 'bad', `publish failed: ${e?.message ?? e}`);
  }
}

async function notifyOS() {
  // The trace will show `notify/send ok`, and the OS shows the toast. Seeing
  // BOTH at once is the verification: one proves the call reached the host, the
  // other proves the host reached the operating system.
  try {
    const sent = await state.ctx.ui.notifyOS('Check the Windows action centre for this.', {
      title: 'Message Log',
    });
    push('trace', sent ? 'ok' : 'bad', sent ? 'OS notification sent' : 'OS notification refused');
  } catch (e) {
    push('trace', 'bad', `notifyOS threw: ${e?.message ?? e}`);
  }
}

async function refreshSessions() {
  try {
    const { sessions } = await state.ctx.sessions();
    push('trace', 'ok', `sessions: ${Array.isArray(sessions) ? sessions.length : '?'} live`);
    for (const s of sessions ?? []) {
      push('trace', 'info', `  ${s.kind} ${s.id} pid=${s.pid ?? '-'} bytesOut=${s.bytesOut ?? 0}`);
    }
  } catch (e) {
    push('trace', 'bad', `sessions failed: ${e?.message ?? e}`);
  }
}

export default { manifest, activate, deactivate };
