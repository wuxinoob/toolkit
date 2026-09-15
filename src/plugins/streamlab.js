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

const BTN =
  'padding:5px 12px;cursor:pointer;background:#1d2230;color:#dfe3ea;border:1px solid #2a2f3a;border-radius:6px;font-size:12px;';
const BTN_ALT = BTN.replace('#1d2230', '#1a2a22');

function log(kind, text) {
  state.lines.unshift({ t: new Date().toISOString().slice(11, 23), kind, text });
  if (state.lines.length > 200) state.lines.pop();
  renderLog();
}

function renderLog() {
  const el = document.querySelector('.sl-log');
  if (!el) return;
  el.innerHTML = state.lines
    .map((l) => {
      const color = l.kind === 'err' ? '#ff9aa8' : l.kind === 'rx' ? '#9fe8a9' : l.kind === 'tx' ? '#8ab4ff' : '#8b93a7';
      return `<div style="color:${color};white-space:pre-wrap;word-break:break-all;">${l.t} ${esc(l.text)}</div>`;
    })
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
  const off = ctx.events.on('lab.local', (p) => log('rx', `in-process ← ${JSON.stringify(p)} (synchronous)`));
  ctx.events.emit('lab.local', { n: 1 });
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
    <tr style="border-bottom:1px solid #232838;">
      <td style="padding:5px 8px;"><code style="color:#8ab4ff;">${esc(s.id)}</code></td>
      <td style="padding:5px 8px;opacity:.85;">${esc(s.label)}</td>
      <td style="padding:5px 8px;opacity:.6;font-size:11px;">${esc(s.direction)}</td>
      <td style="padding:5px 8px;opacity:.6;font-size:11px;">${esc(s.capabilities)}</td>
      <td style="padding:5px 8px;opacity:.55;font-size:11px;">${esc(s.note)}</td>
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
      <div style="display:flex;gap:8px;align-items:center;padding:3px 6px;border-bottom:1px solid #1e2330;font-size:11.5px;">
        <code style="color:#8ab4ff;">${esc(s.id)}</code>
        <span style="opacity:.7;">${esc(s.kind)}</span>
        <span style="opacity:.5;">pid=${s.pid ?? '—'}</span>
        <span style="margin-left:auto;opacity:.5;">${s.bytesOut}B</span>
      </div>`,
        )
        .join('')
    : `<div style="opacity:.5;font-size:12px;">no live endpoints</div>`;
}

function registerRenderHooks(ctx) {
  ctx.registerView('streamlab', (el) => {
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px;max-width:900px;">
        <div>
          <h2 style="margin:0 0 4px;">StreamLab</h2>
          <p style="opacity:.6;font-size:12.5px;margin:0;">
            同一个信封（envelope）走不同方案。下面每次实验都打印它收到的帧，
            可以直接对照：载体与编码是两件独立的事。
          </p>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="sl-rpc" style="${BTN}">rpc · host/info</button>
          <button class="sl-json" style="${BTN_ALT}">channel-json · ticker</button>
          <button class="sl-raw" style="${BTN_ALT}">channel-raw · ticker</button>
          <button class="sl-bus" style="${BTN}">event-bus · publish</button>
          <button class="sl-local" style="${BTN}">in-process · emit</button>
          <button class="sl-sess" style="${BTN}">刷新会话表</button>
        </div>

        <div>
          <strong style="font-size:12px;opacity:.85;">方案表（宿主已注册）</strong>
          <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:6px;">
            <thead>
              <tr style="opacity:.55;font-size:11px;text-align:left;">
                <th style="padding:4px 8px;">id</th><th style="padding:4px 8px;">载体 · 编码</th>
                <th style="padding:4px 8px;">方向</th><th style="padding:4px 8px;">能力</th>
                <th style="padding:4px 8px;">说明</th>
              </tr>
            </thead>
            <tbody class="sl-schemes"></tbody>
          </table>
        </div>

        <div>
          <strong style="font-size:12px;opacity:.85;">统一会话注册表</strong>
          <div class="sl-sessions" style="margin-top:6px;background:#0d0f13;border:1px solid #2a2f3a;border-radius:6px;padding:6px;min-height:34px;"></div>
        </div>

        <div>
          <strong style="font-size:12px;opacity:.85;">帧日志</strong>
          <pre class="sl-log" style="margin:6px 0 0;background:#0d0f13;border:1px solid #2a2f3a;border-radius:6px;padding:8px;font-size:11px;line-height:1.6;max-height:320px;overflow:auto;"></pre>
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
