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
    // An external plugin may restyle ITSELF without shipping any CSS: declare
    // which design tokens it wants different, per theme. The host injects a
    // rule scoped to this plugin's own subtree, so it cannot touch the shell.
    // See docs/UI.md ("Giving external plugins more freedom").
    theme: {
      dark: { '--color-brand': '#a78bfa', '--color-brand-hover': '#bda4ff' },
      light: { '--color-brand': '#6d3fc4', '--color-brand-hover': '#5c33ac' },
    },
  },
  permissions: ['rpc:storage', 'rpc:bus', 'rpc:stream', 'rpc:host'],
};

const state = { ctx: null, lines: [], settings: {}, sessions: [] };

function log(text, cls = 'tb-t-dim') {
  state.lines.unshift({ t: new Date().toISOString().slice(11, 23), text, cls });
  if (state.lines.length > 120) state.lines.pop();
  const el = document.querySelector('.hl-log');
  if (el) {
    el.innerHTML = state.lines
      .map((l) => `<div class="${l.cls}" style="white-space:pre-wrap;word-break:break-all;">${l.t} ${esc(l.text)}</div>`)
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
    log('settings changed in the host Settings page', 'tb-t-ok');
  });

  // A broadcast from ANY window lands here (this is the cross-window path).
  // Subscriptions are async on every scheme, so this is awaited like any other.
  await ctx.bus.subscribe('hello.ping', (env) =>
    log(`broadcast from ${env.svc}: ${JSON.stringify(env.p)}`, 'tb-t-ok'),
  );

  ctx.registerView('hello', (el) => {
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px;max-width:640px;">
        <div>
          <h2 class="hl-greet tb-t-brand" style="margin:0 0 4px;font-size:16px;">${esc(greeting())}</h2>
          <p class="tb-hint" style="margin:0;">
            hello.demo v0.1.0 — 单文件 ESM 外部插件，零宿主代码改动。信封由 <code>ctx.protocol</code> 提供。
            这个插件的紫色不是写死的：它由 <code>contributes.theme</code> 声明，宿主注入到它自己的作用域里。
          </p>
        </div>
        <div class="tb-toolbar">
          <button class="hl-ping tb-btn tb-btn-primary">broadcast · ping</button>
          <button class="hl-json tb-btn">channel-json · ticker</button>
          <button class="hl-raw tb-btn">channel-raw · ticker</button>
          <button class="hl-sess tb-btn">sessions</button>
        </div>
        <div class="tb-hint">sessions: <span class="hl-sessions">…</span></div>
        <pre class="hl-log tb-pane tb-mono" style="margin:0;padding:8px;line-height:1.6;max-height:280px;"></pre>
      </div>`;

    el.querySelector('.hl-ping').addEventListener('click', async () => {
      const r = await ctx.bus.publish('hello.ping', { at: Date.now() });
      log(`published hello.ping → ${JSON.stringify(r)}`, 'tb-t-brand');
    });

    el.querySelector('.hl-json').addEventListener('click', async () => {
      const { Kind } = ctx.protocol;
      const ch = `hello-json-${Date.now().toString(36)}`;
      const ms = Number(state.settings.intervalMs) || 400;
      await ctx.stream('ticker', ch, {
        params: { intervalMs: ms, count: 4 },
        onFrame: (f) =>
          log(`json ← ${f.kind} ${f.kind === Kind.DATA ? JSON.stringify(f.p) : ''}`, f.kind === Kind.DATA ? 'tb-t-ok' : 'tb-t-dim'),
      });
      log(`opened channel-json ${ch} (${ms}ms × 4)`, 'tb-t-brand');
    });

    el.querySelector('.hl-raw').addEventListener('click', async () => {
      const { Kind } = ctx.protocol;
      const ch = `hello-raw-${Date.now().toString(36)}`;
      await ctx.streamRaw('ticker', ch, {
        params: { intervalMs: 300, count: 4 },
        onFrame: (f) => {
          // the SAME envelope shape, but the payload is bytes
          const n = f.p instanceof Uint8Array ? new DataView(f.p.buffer, f.p.byteOffset, 8).getBigInt64(0, true) : f.p;
          log(`raw  ← ${f.kind} ${f.kind === Kind.DATA ? `counter=${n}` : ''}`, f.kind === Kind.DATA ? 'tb-t-ok' : 'tb-t-dim');
        },
      });
      log(`opened channel-raw ${ch}`, 'tb-t-brand');
    });

    el.querySelector('.hl-sess').addEventListener('click', async () => {
      await refreshSessions();
      log(`sessions: ${JSON.stringify(state.sessions)}`, 'tb-t-brand');
    });

    refreshSessions();
  });
}

export function deactivate() {
  state.lines = [];
}

export default { manifest, activate, deactivate };
