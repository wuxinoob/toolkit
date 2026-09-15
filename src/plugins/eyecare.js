/**
 * First-party plugin: Eyecare Assistant (护眼助手)
 *
 * Pure frontend + timers. Message plane usage:
 *   ctx.storage.*        -> `rpc` scheme (settings persisted natively)
 *   ctx.ui.mountOverlay  -> host overlay layer (no IPC)
 *   ctx.events           -> `in-process` scheme (window-local)
 */

export const manifest = {
  id: 'builtin.eyecare',
  name: 'Eyecare',
  version: '0.1.0',
  description: 'Periodic break reminders with a fullscreen overlay countdown.',
  contributes: {
    views: [{ slot: 'tool', id: 'eyecare', title: 'Eyecare', icon: '👁' }],
  },
  permissions: ['rpc:storage'],
};

const DEFAULTS = { enabled: true, intervalMin: 45, breakSec: 20 };
let timer = null;
let overlay = null;
let countdown = null;
let countdownTimer = null;

function startTimer(ctx, cfg) {
  stopTimer();
  if (!cfg.enabled) return;
  timer = setInterval(() => runBreak(ctx, cfg), cfg.intervalMin * 60_000);
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

function endBreak(ctx) {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  countdown = null;
  ctx.ui.unmountOverlay(overlay);
  overlay = null;
}

function runBreak(ctx, cfg) {
  if (overlay) return; // already in a break
  overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:rgba(8,12,18,.94);color:#9fe8a9;' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;font-family:sans-serif;';
  overlay.innerHTML = `
    <div style="font-size:52px;font-weight:500;">Please look at something 20 feet away</div>
    <div class="ec-count" style="font-size:92px;font-weight:500;">${cfg.breakSec}</div>
    <button class="ec-skip" style="padding:8px 24px;font-size:15px;cursor:pointer;background:#2a2f3a;color:#dfe3ea;border:none;border-radius:8px;">Skip</button>`;
  overlay.querySelector('.ec-skip').addEventListener('click', () => endBreak(ctx));
  ctx.ui.mountOverlay(overlay);

  countdown = cfg.breakSec;
  countdownTimer = setInterval(() => {
    countdown -= 1;
    const el = overlay?.querySelector('.ec-count');
    if (el) el.textContent = countdown;
    if (countdown <= 0) endBreak(ctx);
  }, 1000);
}

export async function activate(ctx) {
  const cfg = { ...DEFAULTS, ...((await ctx.storage.get('config')) || {}) };

  ctx.registerView('eyecare', (el) => {
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px;max-width:420px;">
        <h2 style="margin:0;">Eyecare Assistant</h2>
        <label style="display:flex;gap:10px;align-items:center;">
          <input type="checkbox" class="ec-enabled" ${cfg.enabled ? 'checked' : ''}/> Enabled
        </label>
        <label>Interval (minutes)
          <input type="number" class="ec-interval" min="5" max="180" value="${cfg.intervalMin}"
                 style="margin-left:8px;width:90px;background:#111318;color:#dfe3ea;border:1px solid #2a2f3a;border-radius:6px;padding:4px 8px;"/>
        </label>
        <label>Break duration (seconds)
          <input type="number" class="ec-break" min="10" max="120" value="${cfg.breakSec}"
                 style="margin-left:8px;width:90px;background:#111318;color:#dfe3ea;border:1px solid #2a2f3a;border-radius:6px;padding:4px 8px;"/>
        </label>
        <button class="ec-test" style="align-self:flex-start;padding:6px 16px;cursor:pointer;">Preview break overlay</button>
        <p style="opacity:.6;font-size:12px;margin:0;">Timer runs while this plugin is enabled; closing the app pauses it.</p>
      </div>`;

    const persist = () => ctx.storage.set('config', cfg);
    const apply = () => {
      startTimer(ctx, cfg);
      persist().catch(() => {});
    };
    el.querySelector('.ec-enabled').addEventListener('change', (e) => {
      cfg.enabled = e.target.checked;
      apply();
    });
    el.querySelector('.ec-interval').addEventListener('change', (e) => {
      cfg.intervalMin = Math.max(5, Number(e.target.value) || DEFAULTS.intervalMin);
      apply();
    });
    el.querySelector('.ec-break').addEventListener('change', (e) => {
      cfg.breakSec = Math.min(120, Math.max(10, Number(e.target.value) || DEFAULTS.breakSec));
      apply();
    });
    el.querySelector('.ec-test').addEventListener('click', () => runBreak(ctx, cfg));
  });

  startTimer(ctx, cfg);
}

export function deactivate() {
  stopTimer();
  if (overlay) overlay.remove();
  overlay = null;
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}

export default { manifest, activate, deactivate };
