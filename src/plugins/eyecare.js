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
  // .tb-screen is a tokenised full-window takeover, so the break screen is a
  // light screen in the light theme instead of a black one with green text.
  overlay.className = 'tb-screen';
  overlay.innerHTML = `
    <div class="tb-screen-title">Please look at something 20 feet away</div>
    <div class="ec-count tb-screen-count">${cfg.breakSec}</div>
    <button class="ec-skip tb-btn">Skip</button>`;
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
        <div>
          <h2 style="margin:0 0 4px;font-size:16px;">Eyecare Assistant</h2>
          <p class="tb-hint" style="margin:0;">
            A full-window reminder at a fixed interval. Timers run while the plugin is enabled.
          </p>
        </div>
        <div class="tb-card">
          <div class="tb-card-body" style="display:flex;flex-direction:column;gap:12px;">
            <label style="display:flex;gap:9px;align-items:center;">
              <input type="checkbox" class="ec-enabled" ${cfg.enabled ? 'checked' : ''} />
              <span>Enabled</span>
            </label>
            <label class="tb-field">
              <span class="tb-label">Interval (minutes)</span>
              <input type="number" class="ec-interval tb-input tb-input-inline" min="5" max="180"
                     value="${cfg.intervalMin}" style="width:110px;" />
            </label>
            <label class="tb-field">
              <span class="tb-label">Break duration (seconds)</span>
              <input type="number" class="ec-break tb-input tb-input-inline" min="10" max="120"
                     value="${cfg.breakSec}" style="width:110px;" />
            </label>
            <div>
              <button class="ec-test tb-btn">Preview break overlay</button>
            </div>
          </div>
        </div>
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
