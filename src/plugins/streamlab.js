/**
 * First-party plugin: StreamLab — the message plane's control panel.
 *
 * This plugin exists to make the architecture inspectable. It shows the scheme
 * table the host resolved, and lets you fire the SAME envelope through every
 * scheme so the difference is visible in one screen:
 *
 *   rpc           control call, res/err
 *   channel-json  structured push (ticker provider)
 *   channel-raw   binary push, 8 LE bytes per frame (same provider!)
 *   event-bus     broadcast, delivered to every window
 *   in-process    window-local, synchronous, zero IPC
 *
 * Each experiment prints the envelopes it saw, so the shared shape is obvious.
 */

import { Kind, isTerminal } from '../protocol/envelope.js';

export const manifest = {
  id: 'builtin.streamlab',
  name: 'StreamLab',
  version: '0.1.0',
  description: 'Inspect the message plane: scheme table + one experiment per transport.',
  contributes: {
    views: [{ slot: 'tool', id: 'streamlab', title: 'StreamLab', icon: '🧪' }],
  },
  permissions: ['rpc:host', 'rpc:stream', 'rpc:bus', 'rpc:storage'],
};

const state = { ctx: null, lines: [], unsub: null, sessions: [] };

/** Log line -> intent class. Colour lives in the stylesheet, not in a hex here. */
const LOG_CLASS = { err: 'tb-t-bad', rx: 'tb-t-ok', tx: 'tb-t-brand', info: 'tb-t-dim' };

function log(kind, text) {
  state.lines.unshift({ t: new Date().toISOString().slice(11, 23), kind, text });
  if (state.lines.length > 200) state.lines.pop();
  renderLog();
}

function renderLog() {
  state.draw?.log();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Render an envelope compactly — the same shape regardless of the scheme. */
function fmt(env) {
  const p = env.p;
  let payload;
  if (p instanceof Uint8Array) payload = `Uint8Array(${p.byteLength}) [${[...p.subarray(0, 8)].join(',')}${p.byteLength > 8 ? ',…' : ''}]`;
  else payload = JSON.stringify(p);
  const route = env.ch ? `ch=${env.ch}` : env.id !== undefined ? `id=${env.id}` : env.topic ? `topic=${env.topic}` : '';
  return `${env.kind.padEnd(5)} ${route.padEnd(18)} p=${payload}`;
}

/* --------------------------------- experiments -------------------------------- */

async function runRpc() {
  const { ctx } = state;
  log('tx', 'rpc  → host/info');
  try {
    const info = await ctx.rpc('host', 'info', {});
    log('rx', `rpc  ← res  ${JSON.stringify(info)}`);
  } catch (e) {
    log('err', `rpc  ← err  ${e.code}: ${e.message}`);
  }
}

async function runStreamJson() {
  const { ctx } = state;
  const ch = `lab-json-${Date.now().toString(36)}`;
  log('tx', `channel-json → ticker/${ch}`);
  try {
    await ctx.stream('ticker', ch, {
      params: { intervalMs: 300, count: 4 },
      onFrame: (f) => log('rx', `channel-json ← ${fmt(f)}`),
      onEnd: (f) => log('info', `channel-json terminal: ${f.kind}`),
    });
  } catch (e) {
    log('err', `channel-json ← ${e.code}: ${e.message}`);
  }
}

async function runStreamRaw() {
  const { ctx } = state;
  const ch = `lab-raw-${Date.now().toString(36)}`;
  log('tx', `channel-raw → ticker/${ch}  (same provider, binary wire)`);
  try {
    await ctx.streamRaw('ticker', ch, {
      params: { intervalMs: 300, count: 4 },
      onFrame: (f) => log('rx', `channel-raw ← ${fmt(f)}`),
      onEnd: (f) => log('info', `channel-raw terminal: ${f.kind}`),
    });
  } catch (e) {
    log('err', `channel-raw ← ${e.code}: ${e.message}`);
  }
}

async function runBroadcast() {
  const { ctx } = state;
  const topic = 'lab.ping';
  log('tx', `event-bus → publish ${topic} (all windows)`);
  try {
    const r = await ctx.bus.publish(topic, { from: ctx.id, at: Date.now() });
    log('rx', `event-bus ← ack ${JSON.stringify(r)}`);
  } catch (e) {
    log('err', `event-bus ← ${e.code}: ${e.message}`);
  }
}

async function runLocal() {
  const { ctx } = state;
  log('tx', 'in-process → emit lab.local');
  // every subscription is async and every scheme has the same shape, so this
  // call site is identical to the event-bus one above
  const off = await ctx.events.on('lab.local', (p) => log('rx', `in-process ← ${JSON.stringify(p)}`));
  await ctx.events.emit('lab.local', { n: 1 });
  off();
}

async function refreshSessions() {
  const { ctx } = state;
  try {
    state.sessions = await ctx.sessions();
    state.draw?.sessions();
    log('info', `sessions ← ${state.sessions.length} live endpoint(s)`);
  } catch (e) {
    log('err', `sessions ← ${e.code}: ${e.message}`);
  }
}

/* ------------------------------------ view ------------------------------------ */

function drawSchemes(root) {
  const host = root.querySelector('.sl-schemes');
  if (!host) return;
  const { el, render } = state.ctx.ui;
  render(
    host,
    el(
      'table',
      {},
      el(
        'table-header',
        {},
        el('table-row', {}, el('table-head', {}, 'id'), el('table-head', {}, '载体 · 编码'), el('table-head', {}, '方向'), el('table-head', {}, '能力'), el('table-head', {}, '说明')),
      ),
      el(
        'table-body',
        {},
        state.ctx.schemes().map((s) =>
          el(
            'table-row',
            {},
            el('table-cell', {}, el('code', { class: 'tb-mono tb-t-brand' }, s.id)),
            el('table-cell', {}, s.label),
            el('table-cell', { class: 'tb-hint' }, s.direction),
            el('table-cell', { class: 'tb-hint' }, s.capabilities),
            el('table-cell', { class: 'tb-hint' }, s.note),
          ),
        ),
      ),
    ),
  );
}

function drawSessions(root) {
  const host = root.querySelector('.sl-sessions');
  if (!host) return;
  const { el, render } = state.ctx.ui;
  render(
    host,
    state.sessions.length
      ? state.sessions.map((s) =>
          el(
            'div',
            { class: 'tb-row', style: 'cursor:default;' },
            el('code', { class: 'tb-mono tb-t-brand' }, s.id),
            el('span', { class: 'tb-t-muted' }, s.kind),
            el('span', { class: 'tb-hint' }, `pid=${s.pid ?? '—'}`),
            el('span', { class: 'tb-hint', style: 'margin-left:auto;' }, `${s.bytesOut} B`),
          ),
        )
      : el('div', { class: 'tb-hint' }, 'No live endpoints.'),
  );
}

function drawLog(root) {
  const host = root.querySelector('.sl-log');
  if (!host) return;
  const { el, render } = state.ctx.ui;
  render(
    host,
    state.lines.map((l) =>
      el('div', { class: LOG_CLASS[l.kind] ?? 'tb-t-dim', style: 'white-space:pre-wrap;word-break:break-all;' }, `${l.t} ${l.text}`),
    ),
  );
}

function registerRenderHooks(ctx) {
  const { el, render } = ctx.ui;

  ctx.registerView('streamlab', (root) => {
    const btn = (label, fn) => el('button', { variant: 'outline', onClick: fn }, label);

    render(
      root,
      el(
        'div',
        { style: 'display:flex;flex-direction:column;gap:14px;max-width:900px;' },
        el(
          'div',
          {},
          el('h2', { style: 'margin:0 0 4px;font-size:16px;font-weight:500;' }, 'StreamLab'),
          el(
            'p',
            { class: 'tb-hint', style: 'margin:0;' },
            '同一个信封（envelope）走不同方案。下面每次实验都打印它收到的帧，可以直接对照：载体与编码是两件独立的事。',
          ),
        ),
        el(
          'div',
          { class: 'tb-toolbar' },
          btn('rpc · host/info', runRpc),
          btn('channel-json · ticker', runStreamJson),
          btn('channel-raw · ticker', runStreamRaw),
          btn('event-bus · publish', runBroadcast),
          btn('in-process · emit', runLocal),
          btn('刷新会话表', refreshSessions),
        ),
        el(
          'div',
          {},
          el('div', { class: 'tb-section-title' }, '方案表（宿主已注册）'),
          el('div', { class: 'sl-schemes', style: 'overflow-x:auto;border:1px solid var(--color-line);border-radius:var(--radius-md);' }),
        ),
        el(
          'div',
          {},
          el('div', { class: 'tb-section-title' }, '统一会话注册表'),
          el('div', { class: 'sl-sessions tb-pane tb-pane-pad', style: 'min-height:34px;' }),
        ),
        el(
          'div',
          {},
          el('div', { class: 'tb-section-title' }, '帧日志'),
          el('div', { class: 'sl-log tb-pane tb-mono', style: 'padding:8px;line-height:1.6;max-height:320px;' }),
        ),
      ),
    );

    // Every draw needs `root` so it can find its own container: several views can
    // be mounted at once (one per window), so a bare `document.querySelector`
    // would reach into another instance.
    state.draw = { schemes: () => drawSchemes(root), sessions: () => drawSessions(root), log: () => drawLog(root) };
    drawSchemes(root);
    drawLog(root);
    refreshSessions();
  });
}

/* --------------------------------- lifecycle ---------------------------------- */

export async function activate(ctx) {
  state.ctx = ctx;

  // A broadcast subscriber: proves the cross-window path, since this same
  // handler fires in every window that has the plugin active.
  state.unsub = await ctx.bus.subscribe('lab.ping', (env) => {
    log('rx', `event-bus ← evt topic=${env.topic} from=${env.svc} p=${JSON.stringify(env.p)}`);
  });
  ctx.cleanup(() => state.unsub?.());

  registerRenderHooks(ctx);
  log('info', `activated; ${ctx.schemes().length} schemes available`);
}

export function deactivate() {
  state.unsub?.();
  state.unsub = null;
}

export default { manifest, activate, deactivate };
