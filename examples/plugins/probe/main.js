/**
 * probe.demo — drives every frontend<->backend interface in one pass.
 *
 * Two purposes:
 *
 *  1. It is the proof that a NEW plugin can call the existing interfaces with
 *     no host changes: this file imports nothing, touches no Tauri API, and
 *     uses only `ctx.*` + `ctx.protocol`.
 *  2. It is a living integration check. Every step runs inside `activate()`, so
 *     if any interface is broken the plugin ends up `error` in the boot log
 *     instead of `active` — the boot trace is the verdict, no clicking needed.
 *     Open the view to see the per-step report, or press Re-run.
 *
 * Constraint: single-file ESM (loaded from a Blob URL), hence no imports and
 * `ctx.protocol` instead of importing the envelope module.
 */

export const manifest = {
  id: 'probe.demo',
  name: 'Plane Probe',
  version: '0.1.0',
  description: 'Drives every frontend<->backend interface in one pass and reports the result.',
  contributes: {
    views: [{ slot: 'tool', id: 'probe', title: 'Plane Probe', icon: '🧭' }],
    // Declared here and registered by the HOST at activate — a plugin never
    // touches the shortcut API itself.
    hotkeys: [{ key: 'ctrl+alt+shift+p', action: 'probe' }],
  },
  permissions: ['rpc:storage', 'rpc:host', 'rpc:stream', 'rpc:bus', 'rpc:hotkey'],
};

const BTN =
  'padding:5px 12px;cursor:pointer;background:#1d2230;color:#dfe3ea;border:1px solid #2a2f3a;border-radius:6px;font-size:12px;';

const state = { ctx: null, results: [], ranAt: null, busy: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run one step, timing it, and never let it abort the rest of the sweep. */
async function step(name, iface, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    state.results.push({ name, iface, ok: true, detail: detail ?? 'ok', ms: Date.now() - started });
  } catch (e) {
    state.results.push({ name, iface, ok: false, detail: String(e?.message ?? e), ms: Date.now() - started });
  }
}

/** Collect a stream to its terminal frame (bounded). */
function collect(open, ms = 5000) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const timer = setTimeout(() => reject(new Error(`stream timed out after ${ms}ms`)), ms);
    Promise.resolve(open({
      onFrame: (f) => frames.push(f),
      onEnd: (end) => {
        clearTimeout(timer);
        resolve({ frames, end });
      },
    })).catch((e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function sweep(ctx) {
  const { Kind } = ctx.protocol;
  state.results = [];

  // ---- 1. control plane: the `rpc` scheme ----
  await step('host/info', 'rpc', async () => {
    const info = await ctx.rpc('host', 'info', {});
    if (!info?.dataDir) throw new Error('no dataDir');
    return `dataDir=…${info.dataDir.slice(-28)} liveSessions=${info.liveSessions}`;
  });

  await step('storage set/get', 'rpc', async () => {
    const stamp = { n: Date.now(), list: [1, 2, 3] };
    await ctx.storage.set('probe', stamp);
    const back = await ctx.storage.get('probe');
    if (back?.n !== stamp.n || back?.list?.length !== 3) throw new Error(`mismatch: ${JSON.stringify(back)}`);
    const keys = await ctx.storage.keys();
    if (!keys.includes('probe')) throw new Error('key missing from keys()');
    return `round trip ok (${keys.length} keys)`;
  });

  await step('scheme table', 'registry', async () => {
    const schemes = ctx.schemes();
    if (!Array.isArray(schemes) || schemes.length !== 7) throw new Error(`expected 7 schemes, got ${schemes?.length}`);
    return schemes.map((s) => s.id).join(', ');
  });

  await step('session registry', 'rpc', async () => {
    const sessions = await ctx.sessions();
    if (!Array.isArray(sessions)) throw new Error('not an array');
    return `${sessions.length} live endpoint(s)`;
  });

  // ---- 2. downlink push, structured codec ----
  await step('ticker stream', 'channel-json', async () => {
    const { frames, end } = await collect((h) =>
      ctx.stream('ticker', 'probe-json', { params: { intervalMs: 1, count: 3 }, ...h }),
    );
    const data = frames.filter((f) => f.kind === Kind.DATA);
    if (data.length !== 3) throw new Error(`expected 3 data frames, got ${data.length}`);
    if (data[0].p?.n !== 0 || data[2].p?.n !== 2) throw new Error(`bad payloads: ${JSON.stringify(data)}`);
    if (end.kind !== Kind.END) throw new Error(`expected end, got ${end.kind}`);
    return `3 data + end, p=${JSON.stringify(data[0].p)}`;
  });

  // ---- 3. downlink push, binary codec ----
  await step('ticker stream (raw)', 'channel-raw', async () => {
    const { frames, end } = await collect((h) =>
      ctx.streamRaw('ticker', 'probe-raw', { params: { intervalMs: 1, count: 2 }, ...h }),
    );
    const data = frames.filter((f) => f.kind === Kind.DATA);
    if (data.length !== 2) throw new Error(`expected 2 data frames, got ${data.length}`);
    if (!(data[0].p instanceof Uint8Array)) throw new Error(`payload is ${typeof data[0].p}, expected Uint8Array`);
    if (data[0].p.byteLength !== 8) throw new Error(`expected 8 bytes, got ${data[0].p.byteLength}`);
    if (end.kind !== Kind.END) throw new Error(`expected end, got ${end.kind}`);
    return `2 data + end, p=Uint8Array(8) first=${new DataView(data[0].p.buffer, data[0].p.byteOffset, 8).getBigInt64(0, true)}`;
  });

  // ---- 4. cross-window broadcast ----
  await step('broadcast round trip', 'event-bus', async () => {
    const topic = 'probe.ping';
    let got = null;
    const off = await ctx.bus.subscribe(topic, (env) => (got = env));
    try {
      await ctx.bus.publish(topic, { n: 7 });
      const deadline = Date.now() + 3000;
      while (!got && Date.now() < deadline) await sleep(20);
      if (!got) throw new Error('broadcast never arrived');
      if (got.p?.n !== 7) throw new Error(`bad payload: ${JSON.stringify(got.p)}`);
      return `evt topic=${got.topic} p=${JSON.stringify(got.p)}`;
    } finally {
      off();
    }
  });

  // ---- 5. window-local event (no IPC at all) ----
  await step('local event', 'in-process', async () => {
    let got = null;
    const off = await ctx.events.on('probe.local', (p) => (got = p));
    await ctx.events.emit('probe.local', { n: 1 });
    off();
    if (got?.n !== 1) throw new Error('not delivered');
    return 'delivered over the in-process scheme, zero IPC';
  });

  // ---- 7. negotiation surface: ask what the host supports ----
  await step('host schema', 'rpc', async () => {
    const schema = await ctx.schema();
    if (schema.protocol !== 1) throw new Error('protocol version not reported');
    const services = Object.keys(schema.services || {});
    if (services.length < 5) throw new Error('services not listed: ' + JSON.stringify(services));
    if (!schema.services.storage?.includes('get')) throw new Error('storage actions missing');
    if (!Array.isArray(schema.schemes) || schema.schemes.length !== 7) throw new Error('schemes missing');
    return services.length + ' services, ' + schema.schemes.length + ' schemes, providers=' + schema.providers;
  });

  // ---- 8. a declared hotkey is registered by the host on our behalf ----
  await step('hotkey registration', 'rpc', async () => {
    const { keys } = await ctx.rpc('hotkey', 'list', {});
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error('no hotkey registered (declared in contributes.hotkeys)');
    }
    return 'host holds ' + JSON.stringify(keys) + ' for this plugin';
  });

  // ---- 6. permission gate is real ----
  await step('permission gate', 'guard', async () => {
    const before = state.results.length;
    try {
      // `nope` is intentionally NOT declared — this call must be rejected.
      // audit-ignore-next-line
      await ctx.rpc('nope', 'ping', {});
      throw new Error('an undeclared service was allowed');
    } catch (e) {
      if (!/missing permission/.test(String(e.message ?? e))) throw e;
    }
    if (state.results.length !== before) throw new Error('unexpected state change');
    return 'undeclared rpc:nope rejected before IPC';
  });

  state.ranAt = new Date().toISOString();
}

/* ------------------------------------ view ------------------------------------ */

function render(root) {
  if (!root) return;
  const passed = state.results.filter((r) => r.ok).length;
  root.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;max-width:760px;">
      <div>
        <h2 style="margin:0 0 4px;">Plane Probe</h2>
        <p style="opacity:.6;font-size:12.5px;margin:0;">
          一次性调用全部前后端接口。本插件不 import 任何模块、不直接调用 Tauri API，
          只使用 <code>ctx.*</code> 与 <code>ctx.protocol</code> —— 能跑通即说明新插件可直接复用现有接口。
        </p>
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        <button class="pb-run" style="${BTN}" ${state.busy ? 'disabled' : ''}>重新运行</button>
        <span style="font-size:12px;opacity:.7;">
          ${passed}/${state.results.length} 通过${state.ranAt ? ` · ${state.ranAt.slice(11, 19)}` : ''}
        </span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="opacity:.55;font-size:11px;text-align:left;">
            <th style="padding:4px 8px;">结果</th><th style="padding:4px 8px;">步骤</th>
            <th style="padding:4px 8px;">方案</th><th style="padding:4px 8px;">耗时</th>
            <th style="padding:4px 8px;">详情</th>
          </tr>
        </thead>
        <tbody>
          ${state.results
            .map(
              (r) => `
            <tr style="border-bottom:1px solid #1e2330;">
              <td style="padding:4px 8px;color:${r.ok ? '#9fe8a9' : '#ff9aa8'};">${r.ok ? 'PASS' : 'FAIL'}</td>
              <td style="padding:4px 8px;">${esc(r.name)}</td>
              <td style="padding:4px 8px;"><code style="color:#8ab4ff;">${esc(r.iface)}</code></td>
              <td style="padding:4px 8px;opacity:.6;">${r.ms}ms</td>
              <td style="padding:4px 8px;opacity:.75;word-break:break-all;">${esc(r.detail)}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
  root.querySelector('.pb-run')?.addEventListener('click', async () => {
    state.busy = true;
    render(root);
    await sweep(state.ctx);
    state.busy = false;
    render(root);
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* --------------------------------- lifecycle ---------------------------------- */

export async function activate(ctx) {
  state.ctx = ctx;

  await sweep(ctx);

  ctx.registerView('probe', (el) => {
    el.innerHTML = '<div class="pb-host" style="height:100%;"></div>';
    const root = el.querySelector('.pb-host');
    render(root);
    // keep the live node for the re-run button
    ctx.cleanup(() => {
      root.innerHTML = '';
    });
  });

  // Persist the sweep so it survives a restart, and fail loudly if any step did
  // not pass: the boot log then says `error` instead of `active`, which is the
  // whole point of running the sweep during activation.
  const failed = state.results.filter((r) => !r.ok);
  await ctx.storage.set('lastSweep', {
    at: state.ranAt,
    passed: state.results.length - failed.length,
    total: state.results.length,
    results: state.results,
  });
  if (failed.length) {
    throw new Error(
      `${failed.length}/${state.results.length} interface check(s) failed: ` +
        failed.map((f) => `${f.name} (${f.detail})`).join('; '),
    );
  }
}

export function deactivate() {
  state.results = [];
}

export default { manifest, activate, deactivate };
