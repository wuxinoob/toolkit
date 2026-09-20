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
  const { el, node } = ctx.ui;
  // Built through the factory, then handed to the overlay layer. `node()` (not
  // `render()`) because the overlay mounts into the host's overlay container
  // rather than into this plugin's view — there is no container to render into
  // at this point, and nothing here is portalled, so no theme scope is lost.
  overlay = node(
    el(
      'div',
      { class: 'tb-screen' },
      el('div', { class: 'tb-screen-title' }, 'Please look at something 20 feet away'),
      el('div', { class: 'ec-count tb-screen-count' }, String(cfg.breakSec)),
      el('button', { variant: 'default', size: 'lg', class: 'ec-skip', onClick: () => endBreak(ctx) }, 'Skip'),
    ),
  );
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

  ctx.registerView('eyecare', (root) => {
    const { el, render } = ctx.ui;

    const persist = () => ctx.storage.set('config', cfg).catch(() => {});
    const apply = () => {
      startTimer(ctx, cfg);
      persist();
    };

    render(
      root,
      el(
        'div',
        { style: 'display:flex;flex-direction:column;gap:14px;max-width:460px;' },
        el(
          'div',
          {},
          el('h2', { style: 'margin:0 0 4px;font-size:16px;font-weight:500;' }, 'Eyecare Assistant'),
          el(
            'p',
            { class: 'text-xs text-muted-foreground', style: 'margin:0;' },
            'A full-window reminder at a fixed interval. Timers run while the plugin is enabled.',
          ),
        ),
        el(
          'card',
          {},
          el(
            'card-content',
            { style: 'display:flex;flex-direction:column;gap:14px;' },
            el(
              'div',
              { style: 'display:flex;align-items:center;gap:9px;' },
              el('checkbox', {
                id: 'ec-enabled',
                defaultValue: cfg.enabled,
                'onUpdate:modelValue': (v) => {
                  cfg.enabled = !!v;
                  apply();
                },
              }),
              el('label', { for: 'ec-enabled' }, 'Enabled'),
            ),
            el(
              'div',
              { style: 'display:flex;flex-direction:column;gap:6px;max-width:170px;' },
              el('label', { for: 'ec-interval' }, 'Interval (minutes)'),
              el('input', {
                id: 'ec-interval',
                type: 'number',
                min: 5,
                max: 180,
                defaultValue: cfg.intervalMin,
                onChange: (e) => {
                  cfg.intervalMin = Math.max(5, Number(e.target.value) || DEFAULTS.intervalMin);
                  apply();
                },
              }),
            ),
            el(
              'div',
              { style: 'display:flex;flex-direction:column;gap:6px;max-width:170px;' },
              el('label', { for: 'ec-break' }, 'Break duration (seconds)'),
              el('input', {
                id: 'ec-break',
                type: 'number',
                min: 10,
                max: 120,
                defaultValue: cfg.breakSec,
                onChange: (e) => {
                  cfg.breakSec = Math.min(120, Math.max(10, Number(e.target.value) || DEFAULTS.breakSec));
                  apply();
                },
              }),
            ),
            el(
              'div',
              {},
              el(
                'button',
                { variant: 'outline', onClick: () => runBreak(ctx, cfg) },
                'Preview break overlay',
              ),
            ),
          ),
        ),
      ),
    );
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
