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
  const el = document.querySelector('.sl-log');
  if (!el) return;
  el.innerHTML = state.lines
    .map((l) => `<div class="${LOG_CLASS[l.kind] ?? 'tb-t-dim'}" style="white-space:pre-wrap;word-break:break-all;">${l.t} ${esc(l.text)}</div>`)
    .join('');
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
    renderSessions();
    log('info', `sessions ← ${state.sessions.length} live endpoint(s)`);
  } catch (e) {
    log('err', `sessions ← ${e.code}: ${e.message}`);
  }
}

/* ------------------------------------ view ------------------------------------ */

function renderSchemes() {
  const el = document.querySelector('.sl-schemes');
  if (!el) return;
  el.innerHTML = state.ctx
    .schemes()
    .map(
      (s) => `
    <tr>
      <td><code class="tb-mono tb-t-brand">${esc(s.id)}</code></td>
      <td>${esc(s.label)}</td>
      <td class="tb-hint">${esc(s.direction)}</td>
      <td class="tb-hint">${esc(s.capabilities)}</td>
      <td class="tb-hint">${esc(s.note)}</td>
    </tr>`,
    )
    .join('');
}

function renderSessions() {
  const el = document.querySelector('.sl-sessions');
  if (!el) return;
  el.innerHTML = state.sessions.length
    ? state.sessions
        .map(
          (s) => `
      <div class="tb-row" style="cursor:default;">
        <code class="tb-mono tb-t-brand">${esc(s.id)}</code>
        <span class="tb-t-muted">${esc(s.kind)}</span>
        <span class="tb-hint">pid=${s.pid ?? '—'}</span>
        <span class="tb-hint" style="margin-left:auto;">${s.bytesOut} B</span>
      </div>`,
        )
        .join('')
    : `<div class="tb-hint">No live endpoints.</div>`;
}

function registerRenderHooks(ctx) {
  ctx.registerView('streamlab', (el) => {
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px;max-width:900px;">
        <div>
          <h2 style="margin:0 0 4px;font-size:16px;">StreamLab</h2>
          <p class="tb-hint" style="margin:0;">
            同一个信封（envelope）走不同方案。下面每次实验都打印它收到的帧，
            可以直接对照：载体与编码是两件独立的事。
          </p>
        </div>

        <div class="tb-toolbar">
          <button class="sl-rpc tb-btn">rpc · host/info</button>
          <button class="sl-json tb-btn">channel-json · ticker</button>
          <button class="sl-raw tb-btn">channel-raw · ticker</button>
          <button class="sl-bus tb-btn">event-bus · publish</button>
          <button class="sl-local tb-btn">in-process · emit</button>
          <button class="sl-sess tb-btn">刷新会话表</button>
        </div>

        <div>
          <div class="tb-section-title">方案表（宿主已注册）</div>
          <table class="tb-table">
            <thead>
              <tr>
                <th>id</th><th>载体 · 编码</th>
                <th>方向</th><th>能力</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody class="sl-schemes"></tbody>
          </table>
        </div>

        <div>
          <div class="tb-section-title">统一会话注册表</div>
          <div class="sl-sessions tb-pane tb-pane-pad" style="min-height:34px;"></div>
        </div>

        <div>
          <div class="tb-section-title">帧日志</div>
          <pre class="sl-log tb-pane tb-mono" style="margin:0;padding:8px;line-height:1.6;max-height:320px;"></pre>
        </div>
      </div>`;

    el.querySelector('.sl-rpc').addEventListener('click', runRpc);
    el.querySelector('.sl-json').addEventListener('click', runStreamJson);
    el.querySelector('.sl-raw').addEventListener('click', runStreamRaw);
    el.querySelector('.sl-bus').addEventListener('click', runBroadcast);
    el.querySelector('.sl-local').addEventListener('click', runLocal);
    el.querySelector('.sl-sess').addEventListener('click', refreshSessions);

    renderSchemes();
    renderLog();
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
