/**
 * FloatWin widget page — runs inside the "floatwin" WebviewWindow, NOT in the
 * main window. `src/main.js` routes here when the URL carries `?mode=floatwin`,
 * so this window skips the plugin host entirely (a second host would
 * double-register shortcuts and startup selftests).
 *
 * Cross-window sync: the panel publishes an `evt` envelope on `CONFIG_TOPIC`
 * and the host fans it out, so this page receives config changes immediately
 * and does no polling at all. That replaced a 250 ms storage poll.
 *
 * Content opacity in particular MUST be applied here: the window is created
 * transparent, and the CSS alpha IS the visual opacity (Tauri 2 has no runtime
 * set_opacity). Window-level properties (size, click-through, always-on-top)
 * are applied by the main-window panel through ctx.windows.
 */

import { getCurrentWindow } from '@tauri-apps/api/window';

import { hub } from '../protocol/hub.js';
import { DEFAULT_CONFIG, PLUGIN_ID, CONFIG_TOPIC } from './floatwin-shared.js';

const TIPS = [
  '20-20-20：每 20 分钟看 6 米外 20 秒',
  '有意识地多眨眼，保持角膜湿润',
  '屏幕略低于视线，减少眼部暴露',
  '环境光与屏幕亮度别差太多',
  '久坐伤身，起身接杯水吧',
];

async function loadConfig() {
  try {
    const value = await hub.request(PLUGIN_ID, 'storage', 'get', { key: 'config' });
    return { ...DEFAULT_CONFIG, ...(value && typeof value === 'object' ? value : {}) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function mountWidget() {
  const cfg = await loadConfig();
  const startedAt = Date.now();

  document.documentElement.style.background = 'transparent';
  document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden;';

  const style = document.createElement('style');
  style.textContent = `
    .fw-root{position:fixed;inset:0;display:flex;flex-direction:column;
      background:linear-gradient(160deg,rgba(16,22,32,.97),rgba(22,36,30,.93));
      border:1px solid rgba(120,200,160,.35);border-radius:14px;overflow:hidden;
      color:#dfeee6;font-family:system-ui,'Microsoft YaHei',sans-serif;
      user-select:none;box-shadow:0 8px 30px rgba(0,0,0,.35);}
    .fw-bar{display:flex;align-items:center;gap:6px;padding:7px 10px;
      font-size:12px;cursor:move;background:rgba(255,255,255,.06);}
    .fw-badge{font-size:10px;padding:1px 6px;border-radius:8px;
      background:rgba(255,180,80,.2);color:#ffcf99;display:none;}
    .fw-close{margin-left:auto;width:20px;height:20px;line-height:18px;
      border:none;border-radius:6px;background:rgba(255,255,255,.1);
      color:#dfeee6;cursor:pointer;font-size:11px;padding:0;}
    .fw-close:hover{background:rgba(255,90,90,.5);}
    .fw-clock{font-size:38px;font-weight:500;text-align:center;margin-top:auto;
      font-variant-numeric:tabular-nums;}
    .fw-session{text-align:center;font-size:11px;opacity:.65;margin-top:2px;}
    .fw-tip{text-align:center;font-size:12px;opacity:.75;margin:0 12px 12px;}`;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'fw-root';
  root.innerHTML = `
    <div class="fw-bar">护眼悬浮窗<span class="fw-badge">透传中</span>
      <button class="fw-close" title="关闭">✕</button></div>
    <div class="fw-clock">--:--:--</div>
    <div class="fw-session">挂机 0 分钟</div>
    <div class="fw-tip">${TIPS[0]}</div>`;
  document.body.appendChild(root);

  const clock = root.querySelector('.fw-clock');
  const session = root.querySelector('.fw-session');
  const tip = root.querySelector('.fw-tip');
  const badge = root.querySelector('.fw-badge');

  let appliedOpacity = null;
  const applyConfig = (c) => {
    if (c.opacity !== appliedOpacity) {
      appliedOpacity = c.opacity;
      root.style.opacity = String(c.opacity);
    }
    badge.style.display = c.clickThrough ? '' : 'none';
  };
  applyConfig(cfg);

  const timers = [
    setInterval(() => {
      clock.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      session.textContent = `挂机 ${Math.floor((Date.now() - startedAt) / 60_000)} 分钟`;
    }, 1000),
    setInterval(() => {
      tip.textContent = TIPS[Math.floor(Date.now() / 8000) % TIPS.length];
    }, 8000),
  ];

  // Live config: an evt envelope from the panel, fanned out by the host.
  // No polling — the window is completely idle between changes.
  const off = await hub.subscribe(PLUGIN_ID, CONFIG_TOPIC, (env) => {
    applyConfig({ ...DEFAULT_CONFIG, ...(env.p || {}) });
  });

  // Title-bar drag (native move loop). With click-through on, the mouse never
  // reaches this window — the main panel is the control plane in that state.
  root.querySelector('.fw-bar').addEventListener('mousedown', (e) => {
    if (e.target.closest('.fw-close')) return;
    getCurrentWindow().startDragging().catch(() => {});
  });
  root.querySelector('.fw-close').addEventListener('click', () => {
    timers.forEach(clearInterval);
    off();
    getCurrentWindow().close().catch(() => {});
  });
}
