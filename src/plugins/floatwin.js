/**
 * First-party plugin: FloatWin (悬浮窗)
 *
 * Creates a separate transparent, always-on-top WebviewWindow (label
 * "floatwin") that renders `floatwin-widget.js` via `index.html?mode=floatwin`,
 * and controls it live from this main-window panel:
 *   - size / click-through / always-on-top -> ctx.windows (window-level ops)
 *   - opacity                              -> storage "config" + a broadcast
 *
 * Message plane usage:
 *   ctx.storage.*     -> `rpc` scheme (durable config)
 *   ctx.bus.publish   -> `event-bus` scheme (live config to the widget window)
 *   ctx.windows.*     -> window control (Tauri ACL is the second layer)
 *
 * The widget used to poll storage every 250 ms because the event bus was
 * per-window. Publishing an `evt` envelope fixes that at the source: the host
 * fans it out to every window, so the widget reacts instantly and idles at
 * zero cost when nothing changes.
 */

import { CONFIG_TOPIC, DEFAULT_CONFIG, FLOATWIN_LABEL } from './floatwin-shared.js';

export const manifest = {
  id: 'builtin.floatwin',
  name: 'FloatWin',
  version: '0.1.0',
  description: 'Floating widget window with live-controllable size, opacity and mouse click-through.',
  contributes: {
    views: [{ slot: 'tool', id: 'floatwin', title: '悬浮窗', icon: '🪟' }],
  },
  // win:manage gates ctx.windows; rpc:storage persists config; rpc:bus fans
  // live config changes out to the widget window.
  permissions: ['rpc:storage', 'rpc:bus', 'win:manage'],
};

const RANGE = { width: [120, 800], height: [80, 600], opacity: [0.2, 1] };
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, Number(v) || lo));

/** Create the floating window (or show+focus it if it already exists). */
async function ensureWindow(ctx, cfg) {
  const how = await ctx.windows.create(FLOATWIN_LABEL, {
    url: 'index.html?mode=floatwin',
    title: '护眼悬浮窗',
    width: clamp(cfg.width, RANGE.width),
    height: clamp(cfg.height, RANGE.height),
    transparent: true, // CSS alpha inside the widget is the visual opacity
    decorations: false,
    shadow: false, // avoids a square shadow box around the rounded card
    alwaysOnTop: !!cfg.alwaysOnTop,
    skipTaskbar: true,
    resizable: false, // size is program-controlled from this panel
    maximizable: false,
    center: true,
  });
  if (how === 'created') {
    // Click-through cannot be expressed as a creation option.
    await ctx.windows.control(FLOATWIN_LABEL, 'clickThrough', !!cfg.clickThrough);
  }
  return how;
}

export async function activate(ctx) {
  const cfg = { ...DEFAULT_CONFIG, ...((await ctx.storage.get('config')) || {}) };

  // When the user closes the MAIN window, take the floating window down with
  // it so the app exits cleanly — an orphan overlay would keep the process
  // alive while the summon hotkey handler (registered in main) is already gone.
  await ctx.windows.onCloseRequested(async () => {
    await ctx.windows.control(FLOATWIN_LABEL, 'close').catch(() => {});
  });

  let statusEl = null;

  const setStatus = (exists) => {
    if (!statusEl) return;
    statusEl.textContent = exists ? '● 已创建（运行中）' : '○ 未创建';
    statusEl.classList.toggle('tb-t-ok', exists);
    statusEl.classList.toggle('tb-hint', !exists);
  };
  const refreshStatus = async () => {
    try {
      setStatus(await ctx.windows.exists(FLOATWIN_LABEL));
    } catch {
      /* window subsystem unavailable — keep last state */
    }
  };

  /**
   * Persist AND broadcast. Two schemes, two jobs: storage makes the value
   * durable, the broadcast makes it live. A widget window that is already open
   * updates instantly; one opened later reads storage on mount.
   */
  const persist = () =>
    ctx.storage
      .set('config', cfg)
      .then(() => ctx.bus.publish(CONFIG_TOPIC, cfg))
      .catch((e) => ctx.log.warn('persist failed', e));

  const applySize = async () => {
    cfg.width = clamp(cfg.width, RANGE.width);
    cfg.height = clamp(cfg.height, RANGE.height);
    await persist();
    try {
      await ctx.windows.control(FLOATWIN_LABEL, 'size', { width: cfg.width, height: cfg.height });
    } catch {
      ctx.ui.notify('悬浮窗未创建，尺寸将在创建时生效', 'info');
    }
  };

  ctx.registerView('floatwin', (root) => {
    const { el, render } = ctx.ui;

    // Live slider: update the label at once; debounce the write so a drag does
    // not hammer data.json. The broadcast is what the widget reacts to, so the
    // visual feedback is immediate regardless.
    let persistTimer = null;

    const checkbox = (key, label, hint, onChange) =>
      el(
        'div',
        { style: 'display:flex;gap:10px;align-items:flex-start;' },
        el('checkbox', {
          id: `fw-${key}`,
          defaultValue: !!cfg[key],
          'onUpdate:modelValue': (v) => {
            cfg[key] = !!v;
            onChange?.(!!v);
          },
        }),
        el(
          'div',
          { style: 'display:flex;flex-direction:column;gap:2px;' },
          el('label', { for: `fw-${key}` }, label),
          hint ? el('span', { class: 'tb-hint' }, hint) : null,
        ),
      );

    render(
      root,
      el(
        'div',
        { style: 'display:flex;flex-direction:column;gap:14px;max-width:500px;' },
        el(
          'div',
          {},
          el('h2', { style: 'margin:0 0 4px;font-size:16px;font-weight:500;' }, '悬浮窗'),
          el(
            'p',
            { class: 'tb-hint', style: 'margin:0;' },
            '一个独立的透明置顶窗口，尺寸、透明度与鼠标透传都在这里实时控制。',
          ),
        ),

        el(
          'card',
          {},
          el(
            'card-content',
            { style: 'display:flex;flex-direction:column;gap:12px;' },
            el('div', { class: 'tb-toolbar' }, el('span', { class: 'fw-status tb-hint' }, '…')),
            el(
              'div',
              { class: 'tb-toolbar' },
              el(
                'button',
                {
                  variant: 'default',
                  onClick: async () => {
                    try {
                      await ensureWindow(ctx, cfg);
                      setStatus(true);
                    } catch (e) {
                      ctx.ui.notify(`悬浮窗创建失败: ${e}`, 'error');
                    }
                  },
                },
                '创建 / 显示',
              ),
              el(
                'button',
                { variant: 'outline', onClick: () => ctx.windows.control(FLOATWIN_LABEL, 'hide').catch(() => ctx.ui.notify('悬浮窗未创建', 'info')) },
                '隐藏',
              ),
              el(
                'button',
                { variant: 'destructive', onClick: () => ctx.windows.control(FLOATWIN_LABEL, 'close').catch(() => ctx.ui.notify('悬浮窗未创建', 'info')) },
                '销毁',
              ),
            ),
          ),
        ),

        el(
          'card',
          {},
          el('card-header', {}, el('card-title', {}, '外观')),
          el(
            'card-content',
            { style: 'display:flex;flex-direction:column;gap:14px;' },
            el(
              'div',
              { style: 'display:flex;flex-direction:column;gap:8px;' },
              el(
                'span',
                { class: 'tb-label' },
                '透明度 ',
                el('span', { class: 'fw-opacity-val tb-t-muted' }, `${Math.round(cfg.opacity * 100)}%`),
              ),
              el('slider', {
                defaultValue: [cfg.opacity],
                min: RANGE.opacity[0],
                max: RANGE.opacity[1],
                step: 0.05,
                'onUpdate:modelValue': (v) => {
                  cfg.opacity = clamp(Array.isArray(v) ? v[0] : v, RANGE.opacity);
                  const label = root.querySelector('.fw-opacity-val');
                  if (label) label.textContent = `${Math.round(cfg.opacity * 100)}%`;
                  clearTimeout(persistTimer);
                  persistTimer = setTimeout(persist, 120);
                },
              }),
            ),
            el(
              'div',
              { class: 'tb-toolbar' },
              el(
                'div',
                { style: 'display:flex;flex-direction:column;gap:6px;' },
                el('label', { for: 'fw-width' }, '宽'),
                el('input', {
                  id: 'fw-width',
                  type: 'number',
                  min: RANGE.width[0],
                  max: RANGE.width[1],
                  step: 10,
                  defaultValue: cfg.width,
                  style: 'width:96px;',
                  onChange: (e) => {
                    cfg.width = clamp(e.target.value, RANGE.width);
                    e.target.value = cfg.width;
                    applySize();
                  },
                }),
              ),
              el(
                'div',
                { style: 'display:flex;flex-direction:column;gap:6px;' },
                el('label', { for: 'fw-height' }, '高'),
                el('input', {
                  id: 'fw-height',
                  type: 'number',
                  min: RANGE.height[0],
                  max: RANGE.height[1],
                  step: 10,
                  defaultValue: cfg.height,
                  style: 'width:96px;',
                  onChange: (e) => {
                    cfg.height = clamp(e.target.value, RANGE.height);
                    e.target.value = cfg.height;
                    applySize();
                  },
                }),
              ),
              el('button', { variant: 'outline', style: 'align-self:flex-end;', onClick: applySize }, '应用尺寸'),
            ),
          ),
        ),

        el(
          'card',
          {},
          el('card-header', {}, el('card-title', {}, '行为')),
          el(
            'card-content',
            { style: 'display:flex;flex-direction:column;gap:12px;' },
            checkbox('clickThrough', '鼠标透传', '开启后悬浮窗不响应鼠标，只能在本面板关闭', () => {
              persist();
              ctx.windows
                .control(FLOATWIN_LABEL, 'clickThrough', cfg.clickThrough)
                .catch(() => ctx.ui.notify('悬浮窗未创建，设置将在创建时生效', 'info'));
            }),
            checkbox('alwaysOnTop', '窗口置顶', null, () => {
              persist();
              ctx.windows
                .control(FLOATWIN_LABEL, 'alwaysOnTop', cfg.alwaysOnTop)
                .catch(() => ctx.ui.notify('悬浮窗未创建，设置将在创建时生效', 'info'));
            }),
            checkbox('autoRestore', '应用启动时自动恢复', null, () => persist()),
            el(
              'p',
              { class: 'tb-hint', style: 'margin:0;' },
              '在悬浮窗标题栏按住可拖动窗口；关闭面板不会销毁悬浮窗，用「销毁」或悬浮窗 ✕ 关闭。配置变更经 event-bus 广播，悬浮窗即时生效（不再轮询）。',
            ),
          ),
        ),
      ),
    );

    statusEl = root.querySelector('.fw-status');
    refreshStatus();
  });

  // Keep the status dot honest when the widget is closed from its own ✕.
  // This is a cheap local window lookup, NOT a data poll.
  const statusTimer = setInterval(refreshStatus, 2000);
  ctx.cleanup(() => clearInterval(statusTimer));

  if (cfg.autoRestore) {
    await ensureWindow(ctx, cfg).catch((e) => ctx.ui.notify(`悬浮窗自动恢复失败: ${e}`, 'error'));
  }
}

// No deactivate(): the disposer cleans timers/listeners; an existing floating
// window is intentionally kept alive across plugin toggles — create() reuses it.
export default { manifest, activate };
