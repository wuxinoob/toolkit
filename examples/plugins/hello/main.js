/**
 * hello.demo — a drop-in external plugin.
 *
 * Constraint: this file must be a SINGLE-FILE ESM. It is fetched by the host,
 * turned into a Blob URL and dynamically imported, so bare/relative imports
 * cannot resolve. That is why it uses `ctx.protocol` (handed over by the host)
 * instead of importing the protocol barrel, and why the window UI is built
 * with plain DOM.
 *
 * Everything it does goes through the declared schemes:
 *   ctx.storage.*      rpc          (durable values)
 *   ctx.bus.*          event-bus    (every window sees it)
 *   ctx.stream(...)    channel-json (structured push)
 *   ctx.streamRaw(...) channel-raw  (binary push)
 *   ctx.sessions()     rpc          (the unified session registry)
 */

export const manifest = {
  id: 'hello.demo',
  name: 'Hello',
  version: '0.1.0',
  api: 2,
  description: 'Drop-in demo plugin: storage, settings form, broadcast and both stream codecs.',
  contributes: {
    views: [{ slot: 'tool', id: 'hello', title: 'Hello', icon: '👋' }],
    settings: [
      { key: 'greeting', label: 'Greeting', type: 'text', default: 'Hello' },
      { key: 'loud', label: 'Shout it', type: 'boolean', default: false },
      { key: 'intervalMs', label: 'Ticker interval (ms)', type: 'number', default: 400, min: 50, max: 5000 },
    ],
  },
  permissions: ['rpc:storage', 'rpc:bus', 'rpc:stream', 'rpc:host'],
};

const BTN =
  'padding:5px 12px;cursor:pointer;background:#1d2230;color:#dfe3ea;border:1px solid #2a2f3a;border-radius:6px;font-size:12px;';

const state = { ctx: null, lines: [], settings: {}, sessions: [] };

function log(text, color = '#8b93a7') {
  state.lines.unshift({ t: new Date().toISOString().slice(11, 23), text, color });
  if (state.lines.length > 120) state.lines.pop();
  const el = document.querySelector('.hl-log');
  if (el) {
    el.innerHTML = state.lines
      .map((l) => `<div style="color:${l.color};white-space:pre-wrap;word-break:break-all;">${l.t} ${esc(l.text)}</div>`)
      .join('');
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function greeting() {
  const g = state.settings.greeting ?? 'Hello';
  return state.settings.loud ? g.toUpperCase() + '!' : g;
}

function renderSessions() {
  const el = document.querySelector('.hl-sessions');
  if (!el) return;
  el.textContent = state.sessions.length
    ? state.sessions.map((s) => `${s.id} (${s.kind}${s.pid ? ` pid=${s.pid}` : ''})`).join('  ·  ')
    : 'no live endpoints';
}

async function refreshSessions() {
  try {
    state.sessions = await state.ctx.sessions();
  } catch {
    state.sessions = [];
  }
  renderSessions();
}

export async function activate(ctx) {
  state.ctx = ctx;
  state.settings = (await ctx.storage.get('settings')) || {};

  // The settings form lives in the host Settings page; this keeps us in sync.
  ctx.onSettingsChanged(async () => {
    state.settings = (await ctx.storage.get('settings')) || {};
    const el = document.querySelector('.hl-greet');
    if (el) el.textContent = greeting();
    log('settings changed in the host Settings page', '#9fe8a9');
  });

  // A broadcast from ANY window lands here (this is the cross-window path).
  // Subscriptions are async on every scheme, so this is awaited like any other.
  await ctx.bus.subscribe('hello.ping', (env) =>
    log(`broadcast from ${env.svc}: ${JSON.stringify(env.p)}`, '#9fe8a9'),
  );

  ctx.registerView('hello', (el) => {
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px;max-width:640px;">
        <h2 class="hl-greet" style="margin:0;">${esc(greeting())}</h2>
        <p style="opacity:.6;font-size:12.5px;margin:0;">
          hello.demo v0.1.0 — 单文件 ESM 外部插件，零宿主代码改动。信封由 <code>ctx.protocol</code> 提供。
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="hl-ping" style="${BTN}">broadcast · ping</button>
          <button class="hl-json" style="${BTN}">channel-json · ticker</button>
          <button class="hl-raw" style="${BTN}">channel-raw · ticker</button>
          <button class="hl-sess" style="${BTN}">sessions</button>
        </div>
        <div style="font-size:11.5px;opacity:.6;">sessions: <span class="hl-sessions">…</span></div>
        <pre class="hl-log" style="margin:0;background:#0d0f13;border:1px solid #2a2f3a;border-radius:6px;padding:8px;font-size:11px;line-height:1.6;max-height:280px;overflow:auto;"></pre>
      </div>`;

    el.querySelector('.hl-ping').addEventListener('click', async () => {
      const r = await ctx.bus.publish('hello.ping', { at: Date.now() });
      log(`published hello.ping → ${JSON.stringify(r)}`, '#8ab4ff');
    });

    el.querySelector('.hl-json').addEventListener('click', async () => {
      const { Kind } = ctx.protocol;
      const ch = `hello-json-${Date.now().toString(36)}`;
      const ms = Number(state.settings.intervalMs) || 400;
      await ctx.stream('ticker', ch, {
        params: { intervalMs: ms, count: 4 },
        onFrame: (f) =>
          log(`json ← ${f.kind} ${f.kind === Kind.DATA ? JSON.stringify(f.p) : ''}`, f.kind === Kind.DATA ? '#9fe8a9' : '#8b93a7'),
      });
      log(`opened channel-json ${ch} (${ms}ms × 4)`, '#8ab4ff');
    });

    el.querySelector('.hl-raw').addEventListener('click', async () => {
      const { Kind } = ctx.protocol;
      const ch = `hello-raw-${Date.now().toString(36)}`;
      await ctx.streamRaw('ticker', ch, {
        params: { intervalMs: 300, count: 4 },
        onFrame: (f) => {
          // the SAME envelope shape, but the payload is bytes
          const n = f.p instanceof Uint8Array ? new DataView(f.p.buffer, f.p.byteOffset, 8).getBigInt64(0, true) : f.p;
          log(`raw  ← ${f.kind} ${f.kind === Kind.DATA ? `counter=${n}` : ''}`, f.kind === Kind.DATA ? '#9fe8a9' : '#8b93a7');
        },
      });
      log(`opened channel-raw ${ch}`, '#8ab4ff');
    });

    el.querySelector('.hl-sess').addEventListener('click', async () => {
      await refreshSessions();
      log(`sessions: ${JSON.stringify(state.sessions)}`, '#8ab4ff');
    });

    refreshSessions();
  });
}

export function deactivate() {
  state.lines = [];
}

export default { manifest, activate, deactivate };
