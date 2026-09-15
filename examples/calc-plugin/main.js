/**
 * calc.demo — window frontend + calc.exe sidecar backend.
 *
 * The interesting part is that BOTH hops use the same envelope:
 *
 *   main-window view ─┐
 *                     ├─ ctx.request / ctx.sidecar ─ plugin_rpc gateway
 *   plugin window ────┘                              └─ proc service ─ calc.exe
 *                                                       (line-json envelopes)
 *
 * So the plugin's native helper is not a special case: it is a `stdio-line`
 * stream carrying `req`/`res`/`err` envelopes, exactly the shapes the host
 * speaks. `ctx.protocol` supplies the constructors (this file is a single-file
 * ESM loaded from a Blob URL and cannot import them).
 */

const OPS = { add: '+', sub: '−', mul: '×', div: '÷', mod: 'mod' };

/** One sidecar connection, shared by every call from this JS context. */
function makeCalc(rpc, ch) {
  const protocol = rpc.protocol;
  const { Kind } = protocol;
  const pending = new Map();
  let handle = null;
  let seq = 0;

  const connect = async () => {
    if (handle) return handle;
    handle = await rpc.sidecar(ch, {
      exe: 'calc.exe',
      pollMs: 30,
      timeoutMs: 150,
      onFrame: (env) => {
        if (env.kind !== Kind.RES && env.kind !== Kind.ERR) return;
        const p = pending.get(env.id);
        if (!p) return; // stale or unrelated frame
        pending.delete(env.id);
        if (env.kind === Kind.ERR) p.reject(new Error(env.msg || env.code));
        else p.resolve(env.p.result);
      },
      onEnd: (env) => {
        // The backend went away: fail everything in flight and reconnect on
        // the next call (self-healing, no bespoke retry ladder).
        handle = null;
        const reason = env?.kind === Kind.EXIT ? `backend exited (${env.p})` : 'backend stream ended';
        for (const p of pending.values()) p.reject(new Error(reason));
        pending.clear();
      },
    });
    return handle;
  };

  const calc = async (op, a, b) => {
    const h = await connect();
    const id = ++seq;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    // set the pending entry BEFORE sending, or a fast reply can be dropped
    await h.send(protocol.req(id, 'calc', 'eval', { op, a, b }));
    return result;
  };

  /** Release the sidecar (the window calls this on teardown). */
  calc.dispose = async () => {
    const h = handle;
    handle = null;
    await h?.close?.().catch(() => {});
  };

  return calc;
}

/* ------------------------------ main window view ------------------------------ */

const WIN_LABEL = 'plugin-calc-win';

export const manifest = {
  id: 'calc.demo',
  name: 'Calculator',
  version: '0.1.0',
  api: 2,
  description: 'Integer calculator: window frontend + calc.exe sidecar backend, both speaking the same protocol.',
  contributes: {
    views: [{ slot: 'tool', id: 'calc', title: '计算器', icon: '🧮' }],
  },
  permissions: ['rpc:proc', 'rpc:host', 'win:manage'],
};

export async function activate(ctx) {
  const calc = makeCalc(ctx, 'calc-view');
  let statusTimer = null;

  ctx.registerView('calc', (el) => {
    if (statusTimer) clearInterval(statusTimer); // re-mount guard

    el.innerHTML = `
      <div style="font-size:13px;line-height:1.6;max-width:560px;">
        <h3 style="margin:4px 0 6px;">🧮 Calculator <small style="opacity:.55;font-weight:400;">calc.demo v0.1.0</small></h3>
        <p style="opacity:.65;margin:0 0 10px;">
          演示 sidecar 动态后端：前端把算式经 <code>stdio-line</code> 方案发给插件目录下的
          calc.exe，双方使用同一个信封（line-json 编码）。
        </p>
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <button class="cx-open" style="padding:4px 12px;border:1px solid #6aa1ff88;border-radius:6px;background:#6aa1ff22;color:inherit;cursor:pointer;">打开计算器窗口</button>
          <button class="cx-stop" style="padding:4px 12px;border:1px solid #8885;border-radius:6px;background:#ffffff10;color:inherit;cursor:pointer;">关闭后端进程</button>
        </div>
        <div class="cx-status" style="font-size:12px;opacity:.75;">后端状态：查询中…</div>
        <hr style="border:none;border-top:1px solid #ffffff18;margin:10px 0;" />
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          <input class="cx-a" type="number" value="6" style="width:72px;" />
          <select class="cx-op">
            <option value="add">+</option><option value="sub">−</option>
            <option value="mul">×</option><option value="div">÷</option>
            <option value="mod">mod</option>
          </select>
          <input class="cx-b" type="number" value="7" style="width:72px;" />
          <button class="cx-go" style="padding:4px 12px;border:1px solid #8885;border-radius:6px;background:#ffffff10;color:inherit;cursor:pointer;">=</button>
          <span class="cx-result" style="min-width:60px;font-weight:500;">—</span>
        </div>
      </div>`;

    const $ = (sel) => el.querySelector(sel);

    const refresh = async () => {
      try {
        const list = await ctx.sessions();
        const mine = list.filter((s) => s.ch === 'calc-view' || s.ch === 'calc-win');
        $('.cx-status').textContent = mine.length
          ? `后端状态：运行中 — ${mine.map((s) => `${s.ch} (pid ${s.pid})`).join('、')}`
          : '后端状态：未运行（首次计算时自动拉起）';
      } catch (e) {
        $('.cx-status').textContent = `后端状态：查询失败 (${e.message || e})`;
      }
    };
    refresh();
    statusTimer = setInterval(refresh, 2000);
    ctx.cleanup(() => clearInterval(statusTimer));

    $('.cx-open').addEventListener('click', async () => {
      try {
        const how = await ctx.windows.create(WIN_LABEL, {
          url: `index.html?mode=pluginwin&plugin=${encodeURIComponent(ctx.id)}&label=${WIN_LABEL}`,
          title: '计算器 — calc.demo',
          width: 300,
          height: 440,
          resizable: false,
          center: true,
        });
        ctx.log.info('window', how);
      } catch (e) {
        ctx.ui.notify(`窗口创建失败: ${e.message || e}`, 'error');
      }
    });

    $('.cx-stop').addEventListener('click', async () => {
      const list = await ctx.sessions();
      let killed = 0;
      for (const s of list.filter((x) => x.ch === 'calc-view' || x.ch === 'calc-win')) {
        if (await ctx.closeStream(s.ch)) killed += 1;
      }
      ctx.ui.notify(`已关闭后端进程 ×${killed}`);
      refresh();
    });

    $('.cx-go').addEventListener('click', async () => {
      const a = Math.trunc(Number($('.cx-a').value || 0));
      const b = Math.trunc(Number($('.cx-b').value || 0));
      $('.cx-result').textContent = '…';
      try {
        $('.cx-result').textContent = String(await calc($('.cx-op').value, a, b));
      } catch (e) {
        $('.cx-result').textContent = `错误: ${e.message}`;
      }
      refresh();
    });
  });
}

export async function deactivate(ctx) {
  // The ctx disposer closes this plugin's streams; nothing extra to do.
  void ctx;
}

/* ------------------------------ plugin window UI ------------------------------ */

/**
 * Called by the host's pluginwin page: this window is already inside
 * `?mode=pluginwin`, and `bridge` exposes the same scheme helpers plus
 * `protocol`, `close()` and `drag()`.
 */
export async function mountWindow(bridge) {
  const calc = makeCalc(bridge, 'calc-win');

  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; user-select: none; }
    html, body { margin:0; height:100%; overflow:hidden; font-family: system-ui,'Microsoft YaHei',sans-serif; }
    body { background:#14161c; color:#e8ebf0; }
    .cx-win { display:flex; flex-direction:column; height:100%; padding:0 10px 10px; }
    .cx-bar { display:flex; justify-content:space-between; align-items:center; height:34px;
      margin:0 -10px; padding:0 10px; font-size:12px; opacity:.9; cursor:grab; }
    .cx-bar button { border:0; background:transparent; color:inherit; font-size:14px; cursor:pointer; opacity:.6; }
    .cx-bar button:hover { opacity:1; color:#ff8f8f; }
    .cx-sub { height:18px; font-size:12px; color:#9aa3b2; text-align:right; }
    .cx-disp { font-size:30px; font-weight:500; text-align:right; padding:2px 2px 8px;
      min-height:44px; word-break:break-all; }
    .cx-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; }
    .cx-key { padding:10px 0; font-size:15px; border:1px solid #ffffff14; border-radius:8px;
      background:#ffffff0a; color:inherit; cursor:pointer; }
    .cx-key:hover { background:#ffffff18; }
    .cx-fn { background:#6aa1ff14; border-color:#6aa1ff30; }
    .cx-eq { background:#6aa1ff33; border-color:#6aa1ff55; }
    .cx-hist { margin-top:8px; font-size:11px; color:#8b93a3; text-align:right; line-height:1.7; overflow:hidden; }`;
  document.head.appendChild(style);

  document.body.innerHTML = `
    <div class="cx-win">
      <div class="cx-bar" id="cx-drag"><span>🧮 Calculator</span><button id="cx-close">✕</button></div>
      <div class="cx-sub" id="cx-sub">&nbsp;</div>
      <div class="cx-disp" id="cx-disp">0</div>
      <div class="cx-grid" id="cx-grid"></div>
      <div class="cx-hist" id="cx-hist"></div>
    </div>`;

  const disp = document.getElementById('cx-disp');
  const sub = document.getElementById('cx-sub');
  const hist = document.getElementById('cx-hist');
  const grid = document.getElementById('cx-grid');

  document.getElementById('cx-close').addEventListener('click', bridge.close);
  document.getElementById('cx-drag').addEventListener('mousedown', (e) => {
    if (e.target.id !== 'cx-close') bridge.drag();
  });

  let cur = '0';
  let pend = null; // { lhs, op }
  let fresh = true; // just evaluated / pressed an operator
  let busy = false;
  let errMsg = null;
  const history = [];

  const LAYOUT = [
    ['C', '⌫', 'mod', '÷'],
    ['7', '8', '9', '×'],
    ['4', '5', '6', '−'],
    ['1', '2', '3', '+'],
    ['±', '0', '=', ''],
  ];
  const KEY_OP = { '+': 'add', '−': 'sub', '×': 'mul', '÷': 'div', mod: 'mod' };

  for (const row of LAYOUT) {
    for (const k of row) {
      if (k === '') continue;
      const b = document.createElement('button');
      b.className = 'cx-key' + (k === '=' ? ' cx-eq' : '') + (KEY_OP[k] || 'C⌫±'.includes(k) ? ' cx-fn' : '');
      b.textContent = k;
      if (k === '=') b.style.gridColumn = 'span 2';
      b.addEventListener('click', () => press(k));
      grid.appendChild(b);
    }
  }

  function paint() {
    disp.textContent = cur;
    if (errMsg) sub.textContent = `⚠ ${errMsg}`;
    else if (pend) sub.innerHTML = `${pend.lhs} ${OPS[pend.op]}${fresh ? '&nbsp;' : ' …'}`;
    else sub.innerHTML = '&nbsp;';
    hist.innerHTML = history.slice(0, 5).map((h) => `<div>${h}</div>`).join('');
  }

  function press(k) {
    if (busy) return;
    errMsg = null;
    if (k >= '0' && k <= '9') {
      if (fresh) { cur = k; fresh = false; }
      else if (cur === '0') cur = k;
      else if (cur.replace('-', '').length < 15) cur += k;
    } else if (k === 'C') {
      cur = '0'; pend = null; fresh = true;
    } else if (k === '⌫') {
      cur = cur.length > 1 ? cur.slice(0, -1) : '0';
      if (cur === '-') cur = '0';
    } else if (k === '±') {
      cur = cur.startsWith('-') ? cur.slice(1) : cur === '0' ? cur : '-' + cur;
    } else if (KEY_OP[k]) {
      // async: repaint only after the state has settled, or the synchronous
      // paint below would put the stale state back on screen
      opPress(KEY_OP[k]).finally(paint);
    } else if (k === '=') {
      equals().finally(paint);
    }
    paint();
  }

  async function opPress(op) {
    if (pend && !fresh) {
      const r = await compute(pend.op, Number(pend.lhs), Number(cur));
      if (r === null) return;
      pend = { lhs: String(r), op };
    } else if (pend) {
      pend = { ...pend, op };
    } else {
      pend = { lhs: cur, op };
    }
    fresh = true;
  }

  async function equals() {
    if (!pend) return;
    const r = await compute(pend.op, Number(pend.lhs), Number(cur));
    if (r === null) return;
    history.unshift(`${pend.lhs} ${OPS[pend.op]} ${cur} = ${r}`);
    cur = String(r);
    pend = null;
    fresh = true;
  }

  async function compute(op, a, b) {
    busy = true;
    disp.style.opacity = '.6';
    try {
      return await calc(op, a, b);
    } catch (e) {
      errMsg = String(e?.message || e);
      return null;
    } finally {
      busy = false;
      disp.style.opacity = '';
    }
  }

  paint();
  // release the sidecar when this window goes away
  bridge.cleanup(() => calc.dispose());
}

export default { manifest, activate, deactivate };
