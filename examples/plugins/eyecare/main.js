/**
 * eyecare.demo — Eye Care / 护眼助手
 *
 * A port of the Script Kit plugin `eye-care.js` onto the toolbox plugin
 * contract. It is deliberately a *drop-in* plugin: it imports nothing, touches
 * no Tauri API, and uses only `ctx` (main window) and `bridge` (its own
 * windows) — so it is also the reference for "how far can an external plugin
 * go".
 *
 * ── What the original did, and what it maps to ──────────────────────────
 *
 *   Kit `widget(html, {…})`            -> ctx.windows.create + mountWindow(bridge)
 *   widget.executeJavaScript(patch)    -> bridge.bus.publish / subscribe (`evt`)
 *   named-pipe single-instance guard   -> contributes.hotkeys (the host owns
 *                                         the single instance; there is no
 *                                         second process to talk to)
 *   db("eye-care-config")              -> ctx.storage   (rpc:storage)
 *   execFileSync(idle_check.exe) xN/s  -> ctx.sidecar('idle.exe') — ONE
 *                                         long-lived helper (rpc:proc)
 *   fields([…11 fields…]) dialog       -> the config panel in this view
 *                                         (ctx.ui factory + .tb-*) AND a
 *                                         settings page in the menu window,
 *                                         both generated from FIELDS below
 *   new Notification / notify()        -> ctx.ui.notify  (host toast)
 *   Kit getActiveScreen()              -> window.screen (the main window's
 *                                         monitor; see README "limits")
 *   image_path + SVG gamma filter      -> NOT PORTED, see README
 *
 * ── Two colours, two places ─────────────────────────────────────────────
 *
 * The main-window view is rendered with the component factory and `.tb-*`, so
 * it uses TOKENS and follows the app theme. The plugin's own windows are
 * separate documents that ship their own stylesheet (the documented escape
 * hatch, same as examples/calc-plugin), so the four Eye Care palettes below are
 * literals — that is what a "theme" means here, and it is why they must NOT be
 * used in the view.
 */

export const manifest = {
  id: 'eyecare.demo',
  name: '护眼助手',
  version: '0.1.0',
  api: 2,
  description: '定时护眼：自绘悬浮胶囊 + 穿透锁定 + 全屏休息遮罩；键鼠空闲检测由自带 sidecar 提供。',
  contributes: {
    views: [{ slot: 'tool', id: 'eyecare', title: '护眼助手', icon: 'lucide:eye' }],
    // The declaration IS the permission — the host registers it before
    // activate() runs. It replaces the original's named-pipe "focus the
    // already-running instance" path.
    hotkeys: [{ key: 'ctrl+alt+e', action: 'toggle-menu' }],
  },
  // One capability, one permission. `bridge.*` in a window hits the same gate,
  // so this list covers both contexts.
  permissions: ['rpc:storage', 'rpc:proc', 'rpc:bus', 'win:manage'],
};

/* ═══════════════════════════════ 1. constants ═══════════════════════════════ */

const LABELS = {
  pill: 'plugin-ec-pill',
  lock: 'plugin-ec-lock',
  menu: 'plugin-ec-menu',
  rest: 'plugin-ec-rest',
  ctl: 'plugin-ec-restctl',
};

const TOPIC_STATE = 'eyecare.state';
const TOPIC_CMD = 'eyecare.cmd';
/**
 * The drag hot path, deliberately its own topic.
 *
 * `eyecare.cmd` is subscribed by every window this plugin opens, and the host
 * has to deliver a bus message to each of them separately. A pointer drag
 * publishes once per animation frame, so routing it through the shared topic
 * meant five webview deliveries per frame — for a message only the main window
 * ever acts on. On its own topic it costs one.
 */
const TOPIC_DRAG = 'eyecare.drag';
const SIDE_CH = 'ec-idle';

/**
 * Geometry.
 *
 * Only what CANNOT be measured lives here: heights and paddings that are a
 * design decision. Every size the content decides is measured by the window
 * that owns it and reported back (`win-size`) — see `measure`.
 *
 * That split is the lesson from three wrong guesses. A fixed 186 px pill left a
 * 35 px dead gap between the clock and the pause button, which is what made it
 * read as "too long" for what it holds. The break buttons needed 56 px of
 * height in a 42 px window, so their labels wrapped and the pills were clipped
 * into squashed ellipses. And the settings page was pinned at 566 px when its
 * content wanted 345, leaving a third of the window empty.
 */
const BOX = {
  /** The pill's chrome at scale 1. Its WIDTH is measured, never fixed. */
  pillH: 34,
  pillPadL: 10,
  pillPadR: 8,
  pillDot: 7,
  pillDotGap: 6,
  pillBtn: 20,
  pillBtnGap: 6,
  pillLock: 22,
  pillFont: 12,
  /** Fallback pill width, in em-widths of the widest label the pill shows. */
  pillEm: 8.4,

  // The lock hit-box is exactly the `#lock-visual` box inside the pill. The
  // window hosting it is sized and placed from a rect the PILL measures and
  // reports (`lock-rect`); these numbers are only the fallback for the frames
  // before that report arrives. The first version of this guessed the geometry
  // here instead — a 28x28 target over a 22x22 icon, with a glow drawn outside
  // the window and clipped by it.
  lockW: 22,
  lockH: 22,

  // Fallbacks for the three windows that report their own size. The widths are
  // fixed on purpose (a menu that changed width with its longest row would
  // twitch); the heights are replaced by the measurement.
  menuW: 186,
  menuH: 266,
  cfgW: 276,
  cfgH: 372,
  ctlW: 300,
  ctlH: 40,

  gap: 6,
  edge: 6,
  /**
   * How far the break mask overshoots the monitor on every side.
   *
   * Small on purpose. The first version padded by 80 px on every side to
   * blanket-cover a taskbar docked to ANY edge, which made the mask 2080x1240
   * on a 1920x1080 monitor: 25% more transparent surface for the compositor to
   * re-blend every time anything moved underneath it, and the mask covers the
   * whole screen for the whole break. The taskbar's real thickness is measured
   * now (see `readArea`), so all that is left is a couple of pixels to absorb a
   * fractional-pixel monitor origin.
   */
  maskPad: 6,
};

const FONTS = ['Segoe UI', 'Arial', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia'];

/** The four palettes, verbatim from the original. */
const THEMES = {
  Dark: {
    rgb: '24, 24, 28',
    text: '#ffffff',
    fontFamily: 'Segoe UI',
    textStyle: 'normal',
    border: 'rgba(255, 255, 255, 0.18)',
    dotWork: '#10b981',
    dotPause: '#f59e0b',
    dotRest: '#38bdf8',
    icon: '#E0E0E0',
    iconLocked: '#ffffff',
    hover: 'rgba(255, 255, 255, 0.20)',
  },
  Light: {
    rgb: '255, 255, 255',
    text: '#111827',
    fontFamily: 'Segoe UI',
    textStyle: 'normal',
    border: 'rgba(0, 0, 0, 0.14)',
    dotWork: '#059669',
    dotPause: '#d97706',
    dotRest: '#0284c7',
    icon: '#333333',
    iconLocked: '#000000',
    hover: 'rgba(0, 0, 0, 0.10)',
  },
  Aqua: {
    rgb: '10, 132, 143',
    text: '#ffffff',
    fontFamily: 'Verdana',
    textStyle: 'normal',
    border: 'rgba(255, 255, 255, 0.28)',
    dotWork: '#34d399',
    dotPause: '#fbbf24',
    dotRest: '#67e8f9',
    icon: '#C8F0F0',
    iconLocked: '#ffffff',
    hover: 'rgba(255, 255, 255, 0.22)',
  },
  Minimal: {
    rgb: '18, 18, 18',
    text: '#ffffff',
    fontFamily: 'Arial',
    textStyle: 'bold',
    border: 'rgba(255, 255, 255, 0.16)',
    dotWork: '#22c55e',
    dotPause: '#eab308',
    dotRest: '#38bdf8',
    icon: '#E0E0E0',
    iconLocked: '#ffffff',
    hover: 'rgba(255, 255, 255, 0.20)',
  },
};
const THEME_NAMES = ['Dark', 'Light', 'Aqua', 'Minimal'];

/**
 * The numeric knobs, described ONCE.
 *
 * Both config surfaces are generated from this table — the `.tb-*` panel in the
 * view (component factory) and the plain-HTML page in the menu window. One
 * table, two renderers, so the two cannot drift apart.
 */
const FIELDS = [
  { key: 'workMinutes', label: '专注工作时长', unit: '分钟', def: 25, min: 0.1, max: 600, step: 0.5 },
  { key: 'restMinutes', label: '休息放松时长', unit: '分钟', def: 5, min: 0.1, max: 180, step: 0.5 },
  { key: 'extendMinutes', label: '每次延长', unit: '分钟', def: 5, min: 0.5, max: 120, step: 0.5 },
  { key: 'opacityNormal', label: '悬浮窗透明度', unit: '', def: 0.82, min: 0.05, max: 1, step: 0.01 },
  { key: 'opacityLocked', label: '锁定透传透明度', unit: '', def: 0.22, min: 0.05, max: 1, step: 0.01 },
  { key: 'restScrim', label: '休息遮罩暗度', unit: '', def: 0.86, min: 0.05, max: 1, step: 0.01 },
  { key: 'restTextActiveOpacity', label: '有输入时文字透明度', unit: '', def: 0.05, min: 0, max: 0.5, step: 0.01 },
  { key: 'fadeMs', label: '渐隐缓动', unit: 'ms', def: 1000, min: 0, max: 5000, step: 100, int: true },
  { key: 'idleThresholdSec', label: '键鼠空闲判定', unit: '秒', def: 1.2, min: 0.2, max: 10, step: 0.1 },
  // Work-time idle: how long the user has to be away before the focus timer is
  // treated as "they left" rather than "they are thinking". Five minutes is the
  // usual reading of a screen-share break; it is a setting because "away" means
  // different things to different people.
  { key: 'workIdleResetSec', label: '无输入多久重置专注', unit: '秒', def: 300, min: 10, max: 3600, step: 10, int: true },
  // The two pill knobs. The pill's WIDTH is never configured — it is measured
  // from its contents, so a bigger font or a bigger scale just makes it as long
  // as it needs to be instead of leaving a gap or clipping the clock.
  { key: 'pillScale', label: '胶囊缩放', unit: '×', def: 1, min: 0.7, max: 1.8, step: 0.05 },
  { key: 'pillFontSize', label: '胶囊字号', unit: 'px', def: 12, min: 9, max: 20, step: 1, int: true },
];

/** Look a knob up by name — an index into `FIELDS` is one edit away from a bug. */
const fieldOf = (key) => FIELDS.find((f) => f.key === key);

const SWITCHES = [
  { key: 'enabled', label: '启用护眼助手', hint: '关闭会同时隐藏全部悬浮窗' },
  {
    key: 'autoStart',
    label: '随应用一起启动',
    hint: '应用启动后自动创建并显示悬浮窗；关闭后需手动点「显示悬浮窗」',
  },
  { key: 'pauseOnActive', label: '休息时检测键鼠空闲', hint: '需要 idle.exe；缺失时自动降级为普通倒计时' },
  {
    key: 'pauseWorkWhenIdle',
    label: '工作时检测键鼠空闲',
    hint: '离开超过设定时长就把专注计时重置并暂停，回来继续',
  },
  { key: 'rememberPosition', label: '记住悬浮窗位置', hint: '拖动结束后写回配置' },
];

const DEFAULTS = {
  enabled: true,
  autoStart: true,
  pauseOnActive: true,
  pauseWorkWhenIdle: true,
  rememberPosition: true,
  theme: 'Dark',
  fontFamily: 'Segoe UI',
  pillX: null,
  pillY: null,
};
for (const f of FIELDS) DEFAULTS[f.key] = f.def;

/* ═══════════════════════════════ 2. helpers ════════════════════════════════ */

const msg = (e) => String((e && e.message) || e);

const pad2 = (n) => (n < 10 ? '0' + n : String(n));

const clock = (sec) => pad2(Math.floor(sec / 60)) + ':' + pad2(sec % 60);

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const themeOf = (name) => THEMES[name] || THEMES.Dark;

const fontOf = (name, theme) => (FONTS.indexOf(name) >= 0 ? name : theme.fontFamily);

/** The theme as CSS custom properties, so a palette swap is a variable write. */
function themeVars(name, font) {
  const t = themeOf(name);
  const family = fontOf(font, t);
  return {
    '--ec-rgb': t.rgb,
    '--ec-text': t.text,
    '--ec-border': t.border,
    '--ec-icon': t.icon,
    '--ec-icon-locked': t.iconLocked,
    '--ec-hover': t.hover,
    '--ec-dot': t.dotWork,
    '--ec-font': "'" + family + "', -apple-system, 'Segoe UI', Roboto, sans-serif",
    '--ec-weight': t.textStyle === 'bold' ? '700' : '500',
  };
}

function applyVars(root, vars) {
  for (const k in vars) root.style.setProperty(k, vars[k]);
}

/**
 * The size a window's content actually wants, measured rather than guessed.
 *
 * The element is switched to `max-content` for the duration of one SYNCHRONOUS
 * read: `getBoundingClientRect()` forces layout on the spot, and the browser
 * only paints once the task yields, so nothing is ever painted at the wrong
 * size and nothing flickers. Whatever the window already is on an axis we are
 * not measuring stays as it is.
 */
function measure(node, axes, floor) {
  const prevW = node.style.width;
  const prevH = node.style.height;
  if (axes.w) node.style.width = 'max-content';
  if (axes.h) node.style.height = 'max-content';
  const r = node.getBoundingClientRect();
  node.style.width = prevW;
  node.style.height = prevH;
  const lo = floor || {};
  return {
    w: axes.w ? Math.max(Math.ceil(r.width), lo.w || 0) : 0,
    h: axes.h ? Math.max(Math.ceil(r.height), lo.h || 0) : 0,
  };
}

/**
 * A reporter that publishes `win-size` only when the measurement changes.
 *
 * The dedupe is what keeps the loop closed: the main window resizes this window
 * from the report, the resize re-runs the measurement, and the second
 * measurement is identical — so it publishes nothing and the exchange stops.
 */
function sizeReporter(bridge, fn, extra) {
  let last = '';
  return () => {
    const m = fn();
    if (!m) return;
    const key = m.w + 'x' + m.h + '|' + (m.page || '');
    if (key === last) return;
    last = key;
    const payload = { act: 'win-size', from: bridge.label, w: m.w, h: m.h };
    if (extra) Object.assign(payload, extra());
    if (m.page) payload.page = m.page;
    bridge.publish(TOPIC_CMD, payload).catch(() => {});
  };
}

/**
 * The pill's live geometry, from its two size knobs.
 *
 * `pillScale` multiplies the CHROME (height, paddings, dot, buttons, lock) and
 * `pillFontSize` sets the text size — two orthogonal knobs, so "make the widget
 * bigger" and "make the text bigger" stay separate decisions. The pill's width
 * is deliberately not here: it is measured by the pill and reported back, which
 * is the only way it can be exactly as long as what it holds.
 */
function pillMetrics(cfg) {
  const c = cfg || S.cfg || {};
  const k = clampNum(num(c.pillScale, 1), 0.7, 1.8);
  const fs = clampNum(num(c.pillFontSize, BOX.pillFont), 9, 20);
  const r = (n) => Math.max(1, Math.round(n * k));
  return {
    k,
    fs: Math.round(fs * 10) / 10,
    h: r(BOX.pillH),
    padL: r(BOX.pillPadL),
    padR: r(BOX.pillPadR),
    dot: r(BOX.pillDot),
    dotGap: r(BOX.pillDotGap),
    btn: r(BOX.pillBtn),
    btnGap: r(BOX.pillBtnGap),
    lock: r(BOX.pillLock),
  };
}

/** The same metrics as CSS custom properties, for the pill's stylesheet. */
function pillVars(m) {
  return {
    '--ec-sz-h': m.h + 'px',
    '--ec-sz-padl': m.padL + 'px',
    '--ec-sz-padr': m.padR + 'px',
    '--ec-sz-dot': m.dot + 'px',
    '--ec-sz-dotgap': m.dotGap + 'px',
    '--ec-sz-btn': m.btn + 'px',
    '--ec-sz-btngap': m.btnGap + 'px',
    '--ec-sz-lock': m.lock + 'px',
    '--ec-fs': m.fs + 'px',
  };
}

/** The pill's size: what it reported, or the fallback until the report lands. */
function pillSize() {
  if (S.pillSize) return S.pillSize;
  const m = pillMetrics();
  return {
    w:
      Math.round(m.fs * BOX.pillEm) + m.padL + m.padR + m.dot + m.dotGap + m.btnGap + m.btn + m.lock,
    h: m.h,
  };
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ═══════════════════════════ 3. main-window runtime ════════════════════════ */

/**
 * All live state. One object because there is exactly one controller: the main
 * window. Every other window is a dumb view driven by the `eyecare.state`
 * broadcast, and can only ask for things over `eyecare.cmd`.
 */
const S = {
  ctx: null,
  cfg: null,
  cfgRev: 0,
  ready: false,

  mode: 'work', // 'work' | 'rest'
  paused: false,
  locked: false,
  menuOpen: false,
  menuPage: 'menu', // 'menu' | 'cfg'
  restShown: false,
  remaining: 0,
  endsAt: 0,
  lastTick: 0,
  rev: 0,

  idleMs: -1,
  idleOk: false,
  idleHandle: null,
  idleTries: 0,
  userActive: false,
  /**
   * The work countdown is held because the user walked away.
   *
   * A flag of its own rather than reusing `S.paused`: the pause BUTTON is the
   * user's decision and must survive, so coming back from a screen-share break
   * cannot silently un-pause a countdown they paused on purpose. The effective
   * pause is the union of the two.
   */
  workIdlePaused: false,
  /** The last failure the helper reported, or null. Shown in the view. */
  idleWhy: null,
  /** True while a close of the helper is still in flight — see `startIdle`. */
  idleClosing: null,

  /** The monitor's WORK AREA — what the pill, menu and buttons are clamped to. */
  area: { x: 0, y: 0, w: 1920, h: 1080 },
  /** The monitor's own rect plus `maskPad`. Only the break mask uses this. */
  full: { x: 0, y: 0, w: 1920, h: 1080 },
  /**
   * The display signature the geometry above was built from.
   *
   * Compared on every tick, because there is no event for "the resolution
   * changed" and the plugin has no display API beyond `window.screen`. See
   * `syncDisplay`.
   */
  screenSig: '',
  /** The last rect the mask was actually given, so a no-op resize is skipped. */
  maskRect: null,
  /** Where `#lock-visual` sits inside the pill, as measured by the pill. */
  lockRect: null,
  /** The pill's measured size; null until the pill has reported in. */
  pillSize: null,
  /** Sizes reported by the windows themselves (`win-size`), by label. */
  winSize: {},
  pill: { x: 0, y: 0 },

  win: { pill: false, lock: false, menu: false, rest: false, ctl: false },
  /** Labels whose UI has reported `hello`, i.e. `mountWindow` has run. */
  mounted: new Set(),
  /** Labels waiting to be shown the moment they report `hello`. */
  reveal: new Set(),
  revealTimer: {},
  tick: null,
  retry: null,
  view: null,
  lastKey: '',
};

const workSec = () => Math.max(1, Math.round(S.cfg.workMinutes * 60));
const restSec = () => Math.max(1, Math.round(S.cfg.restMinutes * 60));

/* ------------------------------ configuration ----------------------------- */

function normalizeConfig(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const f of FIELDS) out[f.key] = clampNum(num(src[f.key], f.def), f.min, f.max);
  for (const s of SWITCHES) out[s.key] = typeof src[s.key] === 'boolean' ? src[s.key] : DEFAULTS[s.key];
  out.theme = THEME_NAMES.indexOf(src.theme) >= 0 ? src.theme : DEFAULTS.theme;
  out.fontFamily = FONTS.indexOf(src.fontFamily) >= 0 ? src.fontFamily : DEFAULTS.fontFamily;
  out.pillX = Number.isFinite(src.pillX) ? Math.round(src.pillX) : null;
  out.pillY = Number.isFinite(src.pillY) ? Math.round(src.pillY) : null;
  return out;
}

/**
 * A changed duration restarts the phase it governs, right away.
 *
 * Without this the pill kept counting down the OLD duration after the user had
 * changed it, and the new number only took effect at the next cycle — so
 * "set the work timer to 1 minute" looked like it had done nothing at all.
 * Only the phase being edited is restarted: changing the break length while
 * working must not throw away the work countdown.
 */
function applyTimingReset(before, after) {
  if (!before) return false;
  const key = S.mode === 'rest' ? 'restMinutes' : 'workMinutes';
  if (before[key] === after[key]) return false;
  S.paused = false;
  setRemaining(S.mode === 'rest' ? restSec() : workSec());
  S.ctx.log.info('timer restarted: ' + key + ' = ' + after[key] + 'm');
  return true;
}

async function saveConfig(patch) {
  if (patch) {
    const before = S.cfg;
    const merged = { ...S.cfg, ...patch };
    // Keep the derived keys that must not be smuggled in from a window page.
    S.cfg = normalizeConfig(merged);
    applyTimingReset(before, S.cfg);
  }
  S.cfgRev += 1;
  try {
    await S.ctx.storage.set('config', S.cfg);
  } catch (e) {
    S.ctx.log.warn('config save failed: ' + msg(e));
  }
  // One funnel for both config surfaces, so a switch flipped in the menu and a
  // slider dragged in the view reach the helper the same way. Turning
  // `pauseWorkWhenIdle` off has to both release the hold and stop the process.
  syncIdle();
  publishState(true);
}

/** Persist just the position (the hot path — no full normalize/publish). */
async function savePosition(x, y) {
  S.cfg.pillX = x;
  S.cfg.pillY = y;
  if (!S.cfg.rememberPosition) return;
  try {
    await S.ctx.storage.set('config', S.cfg);
  } catch {
    /* a failed position write must not break the drag */
  }
}

/* --------------------------------- geometry -------------------------------- */

/**
 * The main window's monitor: its work area AND its own rect.
 *
 * `availLeft`/`availTop` are non-standard but implemented by Chromium, and they
 * are the only way to learn a monitor's origin from a plugin (no window API is
 * exposed on `ctx` for it). Missing -> primary-monitor origin.
 *
 * This is read on every break, not once at activation: the resolution, the
 * display scale or the monitor itself can change while the app runs, and a mask
 * built from a stale rect is a mask that misses a strip of the screen.
 */
function readArea() {
  const sc = window.screen || {};
  const aw = Math.round(num(sc.availWidth, num(sc.width, 1920)));
  const ah = Math.round(num(sc.availHeight, num(sc.height, 1080)));
  const ax = Math.round(num(sc.availLeft, 0));
  const ay = Math.round(num(sc.availTop, 0));
  S.area = { x: ax, y: ay, w: aw, h: ah };

  const mw = Math.round(num(sc.width, aw));
  const mh = Math.round(num(sc.height, ah));

  // The taskbar is exactly what the work area is missing. `availLeft`/`availTop`
  // only move away from the monitor's origin when the taskbar is docked on that
  // side, which is what recovers the monitor's own origin without a monitor API.
  // `avail*` is the work area, so sizing the mask to it was why the taskbar was
  // never covered; the monitor's real rect is `screen.width/height` at that
  // origin, and the pad only absorbs a fractional-pixel origin.
  const tbW = Math.max(0, mw - aw);
  const tbH = Math.max(0, mh - ah);
  const mx = ax - (tbW > 0 && ax >= tbW ? tbW : 0);
  const my = ay - (tbH > 0 && ay >= tbH ? tbH : 0);
  const pad = BOX.maskPad;
  S.full = { x: mx - pad, y: my - pad, w: mw + pad * 2, h: mh + pad * 2 };
}

/**
 * A signature of the display as `window.screen` reports it right now.
 *
 * Six numbers, no IPC. `availLeft`/`availTop` are in it on purpose: docking the
 * taskbar to another edge changes the work area's origin without changing
 * either size, and that alone moves every window the plugin places.
 */
function screenSig() {
  const sc = window.screen || {};
  return [
    num(sc.width, 0),
    num(sc.height, 0),
    num(sc.availWidth, 0),
    num(sc.availHeight, 0),
    num(sc.availLeft, 0),
    num(sc.availTop, 0),
  ].join('x');
}

/**
 * Re-read the display and re-place everything that depends on it.
 *
 * This exists because `readArea` used to run only on wake and on the way into a
 * break. Shrinking the resolution therefore left `S.area` describing a screen
 * that no longer existed, and two things went wrong at once:
 *
 *  - the pill was clamped against the stale work area, so it could be asked to
 *    sit off the new screen — at which point Windows relocates the window
 *    itself, and the plugin's `S.pill` no longer describes where the pill
 *    actually is;
 *  - the lock hit-box is placed at `S.pill + lockRect`, computed from that same
 *    stale `S.pill`, so it stayed where the pill *used* to be. That is the
 *    visible symptom: the click-through control and the pill's lock icon stop
 *    coinciding.
 *
 * Re-clamping and re-placing both windows is the whole fix — but only after the
 * plugin notices, which is what the tick comparison buys.
 */
async function syncDisplay() {
  const sig = screenSig();
  if (sig === S.screenSig) return false;
  S.screenSig = sig;
  readArea();
  S.pill = safePill(S.pill.x, S.pill.y);
  await syncGeometry();
  publishState(true);
  return true;
}

function defaultPill() {
  const a = S.area;
  const s = pillSize();
  return { x: Math.round(a.x + a.w - s.w - 20), y: Math.round(a.y + 40) };
}

/** Clamp a requested position so the pill can never be dragged off screen. */
function safePill(x, y) {
  const a = S.area;
  const s = pillSize();
  if (!Number.isFinite(x) || !Number.isFinite(y)) return defaultPill();
  return {
    x: Math.round(clampNum(x, a.x - 10, a.x + a.w - s.w - 10)),
    y: Math.round(clampNum(y, a.y - 10, a.y + a.h - s.h - 10)),
  };
}

/** The menu's current size: what it reported for THIS page, or the fallback. */
function menuSize() {
  const page = S.menuPage === 'cfg' ? 'cfg' : 'menu';
  const got = S.winSize[LABELS.menu];
  if (got && got.page === page) return { w: got.w, h: got.h };
  return page === 'cfg' ? { w: BOX.cfgW, h: BOX.cfgH } : { w: BOX.menuW, h: BOX.menuH };
}

/** The break buttons' size: what they reported, or the fallback. */
function ctlSize() {
  const got = S.winSize[LABELS.ctl];
  return got ? { w: got.w, h: got.h } : { w: BOX.ctlW, h: BOX.ctlH };
}

/**
 * The size a window has RIGHT NOW, for the axis a report did not mention.
 *
 * The menu is the awkward one: its two pages are different sizes, so a report
 * for the action list must never be used as the settings page's starting point.
 */
function sizeOf(label, page) {
  if (label === LABELS.pill) return pillSize();
  if (label === LABELS.menu) {
    const got = S.winSize[LABELS.menu];
    if (got && got.page === page) return { w: got.w, h: got.h };
    return page === 'cfg' ? { w: BOX.cfgW, h: BOX.cfgH } : { w: BOX.menuW, h: BOX.menuH };
  }
  if (label === LABELS.ctl) return ctlSize();
  if (label === LABELS.lock) {
    const r = lockRect();
    return { w: r.w, h: r.h };
  }
  const got = S.winSize[label];
  return got ? { w: got.w, h: got.h } : { w: 0, h: 0 };
}

/**
 * Below the pill, flipped above when it would overflow the work area.
 *
 * Aligned on the RIGHT edge, not the left.
 *
 * The pill is anchored to the top-right of the work area, and the menu is
 * WIDER than it is (186 vs 159 at the default font) — so aligning left edges
 * put the menu's right edge past the screen margin and the clamp shoved the
 * whole thing left, leaving the two edges matched to nothing. Anchoring the
 * shared right edge makes the menu hang off the pill like a dropdown, which is
 * also the only alignment that survives the pill's width changing: the pill is
 * measured, so its width moves with the font and the scale, and a left-aligned
 * menu would drift by exactly that much every time either knob changed.
 */
function menuPos() {
  const a = S.area;
  const box = menuSize();
  let y = S.pill.y + pillSize().h + BOX.gap;
  if (y + box.h > a.y + a.h - BOX.edge) y = S.pill.y - box.h - BOX.gap;
  y = clampNum(y, a.y + BOX.edge, Math.max(a.y + BOX.edge, a.y + a.h - box.h - BOX.edge));
  const x = clampNum(
    S.pill.x + pillSize().w - box.w,
    a.x + BOX.edge,
    Math.max(a.x + BOX.edge, a.x + a.w - box.w - BOX.edge),
  );
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Where `#lock-visual` sits inside the pill.
 *
 * The pill measures this and reports it (`lock-rect`). A hit-box guessed from
 * constants in the main window can only ever be approximately right — and the
 * first version of this was exactly that: a 28x28 window over a 22x22 icon, so
 * the clickable area and the hover glow were both the wrong size and the glow
 * was clipped by the window edge into a flat, cut-off shape.
 *
 * The computed fallback below is exact for the current CSS; it only covers the
 * frames before the pill has reported in.
 */
function lockRect() {
  if (S.lockRect) return S.lockRect;
  const m = pillMetrics();
  const s = pillSize();
  return {
    x: s.w - m.padR - m.lock,
    y: Math.round((s.h - m.lock) / 2),
    w: m.lock,
    h: m.lock,
  };
}

const lockPos = () => {
  const r = lockRect();
  return { x: S.pill.x + r.x, y: S.pill.y + r.y };
};

function ctlPos() {
  const a = S.area;
  const s = ctlSize();
  return { x: Math.round(a.x + a.w - s.w - 24), y: Math.round(a.y + 24) };
}

/* ---------------------------------- windows -------------------------------- */

const winUrl = (label) =>
  'pluginwin.html?plugin=' + encodeURIComponent(S.ctx.id) + '&label=' + label;

function winOptions(label, extra) {
  return {
    url: winUrl(label),
    transparent: true, // every window in this plugin paints its own alpha
    decorations: false, // and draws its own chrome
    shadow: false, // a square shadow box would show around rounded corners
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    focus: false, // never steal the caret from whatever the user is typing in
    // Created hidden, shown by `reveal()` once the window reports `hello`.
    // Until `mountWindow` has run, a plugin window is nothing but the user
    // agent's white page background — that is the multi-second white flash the
    // original had when the break mask appeared. Loading it out of sight
    // removes the flash without a placeholder to style.
    visible: false,
    ...extra,
  };
}

const createWin = (label, extra) => S.ctx.windows.create(label, winOptions(label, extra));

const moveWin = (label, p) => S.ctx.windows.control(label, 'position', p).catch(() => {});
const sizeWin = (label, size) => S.ctx.windows.control(label, 'size', size).catch(() => {});
const showWin = (label) => S.ctx.windows.control(label, 'show').catch(() => {});
const hideWin = (label) => S.ctx.windows.control(label, 'hide').catch(() => {});
const setThrough = (label, on) => S.ctx.windows.control(label, 'clickThrough', !!on).catch(() => {});

/**
 * Forget the mounted flag on close: a re-created window mounts again, so its
 * measured size has to be re-measured too rather than reused.
 */
function closeWin(label) {
  S.mounted.delete(label);
  delete S.winSize[label];
  return S.ctx.windows.control(label, 'close').catch(() => {});
}

/**
 * Show a window — but only once its UI exists.
 *
 * Every window here is created hidden; this is the other half. If the window
 * has already mounted, show it now; otherwise remember it and show it from the
 * `hello` handler. The 5 s fallback exists so a window that never mounts cannot
 * make the feature silently disappear — in that case a white window is the
 * lesser evil, and it is logged.
 */
function reveal(label) {
  if (S.mounted.has(label)) {
    showWin(label);
    return;
  }
  S.reveal.add(label);
  clearTimeout(S.revealTimer[label]);
  S.revealTimer[label] = setTimeout(() => {
    delete S.revealTimer[label];
    if (!S.reveal.delete(label)) return;
    S.ctx.log.warn(label + ' never reported ready — showing it anyway');
    showWin(label);
  }, 5000);
}

async function ensurePill() {
  if (S.win.pill) return;
  // `null` means "no saved position" and must become NaN, not 0 — Number(null)
  // is 0, which would silently place the pill at the work area's top-left.
  const px = S.cfg.pillX == null ? NaN : S.cfg.pillX;
  const py = S.cfg.pillY == null ? NaN : S.cfg.pillY;
  const s = pillSize();
  const p = safePill(px, py);
  S.pill = p;
  await createWin(LABELS.pill, {
    title: '护眼助手',
    width: s.w,
    height: s.h,
    x: p.x,
    y: p.y,
  });
  S.win.pill = true;
  await setThrough(LABELS.pill, S.locked);
}

/**
 * The unlock hit-box — only while the pill is locked.
 *
 * A click-through window cannot receive the click that would turn click-through
 * off, so a small non-click-through window has to sit over the lock icon. When
 * the pill is NOT locked it handles that click itself, and this window is
 * closed instead: every always-on-top transparent window is one more surface
 * the compositor has to deal with while the user drags something, and one more
 * window a drag would otherwise have to move.
 */
async function ensureLock() {
  const r = lockRect();
  const p = lockPos();
  if (S.win.lock) {
    await sizeWin(LABELS.lock, { width: r.w, height: r.h });
    await moveWin(LABELS.lock, p);
    return;
  }
  await createWin(LABELS.lock, {
    title: '解锁护眼助手',
    width: r.w,
    height: r.h,
    x: p.x,
    y: p.y,
  });
  S.win.lock = true;
}

/**
 * The menu is created lazily and kept: it is the only window the user opens and
 * closes repeatedly, and re-creating a webview costs more than hiding one.
 */
async function ensureMenu() {
  const box = menuSize();
  const p = menuPos();
  if (S.win.menu) {
    await sizeWin(LABELS.menu, { width: box.w, height: box.h });
    await moveWin(LABELS.menu, p);
    return;
  }
  await createWin(LABELS.menu, {
    title: '护眼助手菜单',
    width: box.w,
    height: box.h,
    x: p.x,
    y: p.y,
    focus: true, // so Escape and blur-to-close work like the original
  });
  S.win.menu = true;
}

async function ensureRest() {
  // Read the monitor BEFORE sizing: the resolution or the display scale may have
  // changed since the last break, and the mask has to be built for the screen it
  // is about to cover, not for the one that existed when the plugin activated.
  readArea();
  const f = S.full;
  if (S.win.rest) {
    await applyMaskRect();
    return;
  }
  // A full-screen mask has to be emulated: the window-option allow-list has no
  // `fullscreen`. It is a decoration-less window sized to the WHOLE monitor
  // plus a couple of pixels, so it covers the taskbar as well (see `readArea`).
  await createWin(LABELS.rest, {
    title: '护眼休息',
    width: f.w,
    height: f.h,
    x: f.x,
    y: f.y,
  });
  S.win.rest = true;
  S.maskRect = { ...f };
  // Click-through is the whole point: the mask must never eat a click. Its
  // buttons live in the separate control window, exactly like the original.
  await setThrough(LABELS.rest, true);
}

async function ensureCtl() {
  if (S.win.ctl) return;
  const s = ctlSize();
  const p = ctlPos();
  await createWin(LABELS.ctl, {
    title: '休息控制',
    width: s.w,
    height: s.h,
    x: p.x,
    y: p.y,
  });
  S.win.ctl = true;
}

/** Keep the companion windows glued to the pill, and the mask to the monitor. */
async function syncGeometry() {
  if (!S.win.pill) return;
  await moveWin(LABELS.pill, { x: S.pill.x, y: S.pill.y });
  if (S.win.lock) {
    const r = lockRect();
    await sizeWin(LABELS.lock, { width: r.w, height: r.h });
    await moveWin(LABELS.lock, lockPos());
  }
  if (S.win.menu && S.menuOpen) {
    const box = menuSize();
    await sizeWin(LABELS.menu, { width: box.w, height: box.h });
    await moveWin(LABELS.menu, menuPos());
  }
  if (S.win.ctl) {
    const s = ctlSize();
    await sizeWin(LABELS.ctl, { width: s.w, height: s.h });
    await moveWin(LABELS.ctl, ctlPos());
  }
  // A monitor change moves the break mask too: it is pinned to the screen rather
  // than to the pill. Guarded, because this function is called from paths that
  // have nothing to do with the mask (a lock hit-box report, a menu page
  // switch) and a full-screen resize is the most expensive window op there is.
  if (S.win.rest) await applyMaskRect();
}

/**
 * Put a window back where its own new size says it should be.
 *
 * Deliberately narrow: only what actually depends on that window's size moves.
 * `syncGeometry` would also re-apply the mask rect, and a screen-sized
 * transparent window has no business being resized because a 22 px hit-box
 * reported itself.
 */
async function afterResize(label) {
  if (label === LABELS.pill) {
    await moveWin(LABELS.pill, { x: S.pill.x, y: S.pill.y });
    if (S.win.lock) {
      const r = lockRect();
      await sizeWin(LABELS.lock, { width: r.w, height: r.h });
      await moveWin(LABELS.lock, lockPos());
    }
    if (S.win.menu && S.menuOpen) await moveWin(LABELS.menu, menuPos());
    publishState(true);
  } else if (label === LABELS.menu) {
    if (S.win.menu && S.menuOpen) await moveWin(LABELS.menu, menuPos());
  } else if (label === LABELS.ctl) {
    if (S.win.ctl) await moveWin(LABELS.ctl, ctlPos());
  }
}

/**
 * Pin the mask to the whole monitor, taskbar included.
 *
 * Skipped when the rect has not changed: `move` + `size` on a screen-sized
 * transparent window costs the compositor real work, and `syncGeometry` reaches
 * here from paths that cannot have moved the mask.
 */
async function applyMaskRect() {
  const f = S.full;
  const prev = S.maskRect;
  if (prev && prev.x === f.x && prev.y === f.y && prev.w === f.w && prev.h === f.h) return;
  S.maskRect = { ...f };
  await moveWin(LABELS.rest, { x: f.x, y: f.y });
  await sizeWin(LABELS.rest, { width: f.w, height: f.h });
}

async function showRuntime() {
  await ensurePill();
  reveal(LABELS.pill);
  // Only while locked — see `ensureLock` for why it is not always there.
  if (S.locked) {
    await ensureLock();
    reveal(LABELS.lock);
  }
  if (S.mode === 'rest') await showRest();
  publishState(true);
}

async function hideRuntime() {
  if (S.win.menu) await hideWin(LABELS.menu);
  S.menuOpen = false;
  S.menuPage = 'menu';
  await hideRest(false);
  if (S.win.pill) await hideWin(LABELS.pill);
  if (S.win.lock) await hideWin(LABELS.lock);
  // Disabling the plugin is a deliberate "go away": unlike a break, there is no
  // reason to keep two hidden webviews resident for the next time.
  await closeWin(LABELS.rest);
  await closeWin(LABELS.ctl);
  S.win.rest = false;
  S.win.ctl = false;
  S.maskRect = null;
  publishState(true);
}

async function closeAll() {
  const labels = [LABELS.rest, LABELS.ctl, LABELS.menu, LABELS.lock, LABELS.pill];
  for (const l of labels) {
    clearTimeout(S.revealTimer[l]);
    delete S.revealTimer[l];
    S.reveal.delete(l);
    await closeWin(l);
  }
  S.win = { pill: false, lock: false, menu: false, rest: false, ctl: false };
  S.restShown = false;
  S.menuOpen = false;
  S.maskRect = null;
  publishState(true);
}

/* -------------------------------- the mask -------------------------------- */

async function showRest() {
  await ensureRest();
  await ensureCtl();
  S.restShown = true;
  // `reveal`, not `show`: both windows were created hidden and are shown only
  // once their UI reports in, so the user never sees a blank white webview.
  reveal(LABELS.rest);
  reveal(LABELS.ctl);
  // The mask is created after the pill, and every window here is `alwaysOnTop`,
  // so among themselves the z-order is creation order — the mask would sit on
  // top of the pill. Re-showing raises the pill and its lock box back above it
  // (the original called this `ensureTopmost`): the countdown has to stay
  // readable during the break, and the mask is click-through so the lock box is
  // still the only thing that can be clicked.
  if (S.win.pill) await showWin(LABELS.pill);
  if (S.win.lock) await showWin(LABELS.lock);
  publishState(true);
}

/**
 * Fade out, then HIDE — not close.
 *
 * Closing would throw away a loaded webview, so every break after the first
 * would pay the load time again. Keeping the two windows alive (hidden, so they
 * cost nothing visually) makes every break after the first instant. They are
 * closed in `closeAll()`, i.e. when the plugin is unloaded or the app quits.
 */
async function hideRest(fade = true) {
  if (!S.win.rest && !S.win.ctl) {
    S.restShown = false;
    return;
  }
  S.restShown = false;
  publishState(true);
  if (fade) {
    await S.ctx.bus.publish(TOPIC_CMD, { from: 'main', act: 'fade-rest' }).catch(() => {});
    await new Promise((r) => setTimeout(r, Math.min(num(S.cfg.fadeMs, 1000), 320)));
  }
  if (S.win.rest) await hideWin(LABELS.rest);
  if (S.win.ctl) await hideWin(LABELS.ctl);
}

/* ------------------------------- broadcasting ------------------------------ */

function displayLabel() {
  const head = S.paused ? 'Paused' : S.mode === 'work' ? 'Work' : 'Rest';
  return head + ': ' + clock(S.remaining);
}

/**
 * The widest label the pill can ever show.
 *
 * The pill's window is sized from the text it holds, so measuring the LIVE text
 * would resize the window every time the clock ticked or the mode flipped.
 * "Paused" is the longest of the three heads, so measuring that once yields a
 * width that fits every state the pill can be in.
 */
const WIDEST_LABEL = 'Paused: 00:00';

function snapshot() {
  const t = themeOf(S.cfg.theme);
  const s = pillSize();
  return {
    mode: S.mode,
    paused: S.paused,
    locked: S.locked,
    menuOpen: S.menuOpen,
    menuPage: S.menuPage,
    restShown: S.restShown,
    label: displayLabel(),
    dot: S.paused ? t.dotPause : S.mode === 'rest' ? t.dotRest : t.dotWork,
    theme: S.cfg.theme,
    font: S.cfg.fontFamily,
    alphaNormal: S.cfg.opacityNormal,
    alphaLocked: S.cfg.opacityLocked,
    scrim: S.cfg.restScrim,
    textActive: S.cfg.restTextActiveOpacity,
    fadeMs: S.cfg.fadeMs,
    userActive: S.userActive,
    // The raw capability, not a phase-specific reading of it. It used to be
    // `S.idleOk && S.cfg.pauseOnActive`, which was right when only the break
    // read the helper — but the work phase reads it too now, and folding one
    // phase's switch into a field every phase consumes made "the helper is
    // sampling" indistinguishable from "the break switch is on".
    idleOk: S.idleOk,
    // The work-phase hold, and why the helper is not sampling if it is not.
    workIdlePaused: S.workIdlePaused,
    idleWhy: S.idleWhy,
    pillX: S.pill.x,
    pillY: S.pill.y,
    // The pill's own metrics, so the window can style itself from the same two
    // knobs the main window uses for its clamping and its hit-box fallback.
    pillScale: S.cfg.pillScale,
    pillFontSize: S.cfg.pillFontSize,
    pillW: s.w,
    pillH: s.h,
    cfgRev: S.cfgRev,
    cfg: S.cfg,
  };
}

/**
 * Publish the whole state, deduped.
 *
 * The original pushed per-element patches through `executeJavaScript` and
 * skipped the call when nothing had changed; the equivalent here is one
 * broadcast carrying everything, sent only when the snapshot actually differs.
 * At 1 Hz a tick that changes nothing costs zero IPC.
 */
function publishState(force) {
  if (!S.ready) return;
  const snap = snapshot();
  const key = JSON.stringify(snap);
  if (!force && key === S.lastKey) return;
  S.lastKey = key;
  S.ctx.bus.publish(TOPIC_STATE, snap).catch(() => {});
  paintView();
}

/* --------------------------------- commands -------------------------------- */

async function togglePause() {
  S.paused = !S.paused;
  publishState(true);
}

async function toggleLock() {
  S.locked = !S.locked;
  if (S.locked) {
    // The hit-box has to exist BEFORE the pill goes click-through, or there is
    // a moment where nothing on screen can undo the lock.
    if (S.win.pill) {
      await ensureLock();
      reveal(LABELS.lock);
    }
    await setThrough(LABELS.pill, true);
  } else {
    // The reverse order: make the pill clickable again first, then take the
    // helper window away.
    await setThrough(LABELS.pill, false);
    if (S.win.lock) {
      await closeWin(LABELS.lock);
      S.win.lock = false;
    }
  }
  publishState(true);
}

async function toggleMenu(open) {
  const want = typeof open === 'boolean' ? open : !S.menuOpen;
  if (want === S.menuOpen) return;
  S.menuOpen = want;
  if (want) {
    await ensureMenu();
    reveal(LABELS.menu);
    // Covers the already-mounted case; on the very first open the window is
    // still loading, so the `hello` handler focuses it instead — `focus` on a
    // hidden window is a no-op.
    await S.ctx.windows.control(LABELS.menu, 'focus').catch(() => {});
  } else {
    S.menuPage = 'menu';
    if (S.win.menu) await hideWin(LABELS.menu);
  }
  publishState(true);
}

function setRemaining(sec) {
  S.remaining = Math.max(0, Math.round(sec));
  S.endsAt = Date.now() + S.remaining * 1000;
  S.lastTick = Date.now();
}

async function enterRest(announce) {
  S.mode = 'rest';
  S.paused = false;
  S.userActive = false;
  // A hold belongs to the phase that took it; the work countdown it froze is
  // gone now.
  S.workIdlePaused = false;
  setRemaining(restSec());
  if (announce) S.ctx.ui.notify('🌿 工作时间到！请让双眼休息一下～', 'info');
  S.ctx.log.info('mode -> rest (' + S.cfg.restMinutes + 'm)');
  // Before the mask: the idle value is what the rest countdown consumes, so
  // sampling starts as early as possible and stops as soon as the break ends.
  // Usually a no-op now — the helper keeps running across the flip when both
  // switches are on, which is also what keeps the channel from being reopened.
  S.idleTries = 0;
  syncIdle();
  await showRest();
  publishState(true);
}

async function enterWork(announce) {
  S.mode = 'work';
  S.paused = false;
  S.workIdlePaused = false;
  setRemaining(workSec());
  if (announce) S.ctx.ui.notify('🚀 休息结束，精力充沛地开始工作吧！', 'info');
  S.ctx.log.info('mode -> work (' + S.cfg.workMinutes + 'm)');
  // NOT `stopIdle()`: the work phase reads the helper too when
  // `pauseWorkWhenIdle` is on. `syncIdle` decides, and stops it when neither
  // switch wants it.
  // A fresh phase gets a fresh retry budget: a transient failure in one cycle
  // must not make the next cycle give up before its first attempt.
  S.idleTries = 0;
  syncIdle();
  await hideRest();
  publishState(true);
}

async function recenter() {
  S.pill = defaultPill();
  await syncGeometry();
  await savePosition(S.pill.x, S.pill.y);
}

async function handleCommand(p) {
  if (!p || !p.act) return;
  switch (p.act) {
    case 'hello': {
      // Every window sends this once its UI has mounted. That is the only
      // signal the main window has that a window is safe to show: before it,
      // the window is just the user agent's white page background.
      const from = p.from;
      if (from && from !== 'main') {
        S.mounted.add(from);
        if (S.reveal.delete(from)) {
          clearTimeout(S.revealTimer[from]);
          delete S.revealTimer[from];
          await showWin(from);
          if (from === LABELS.menu && S.menuOpen) {
            await S.ctx.windows.control(LABELS.menu, 'focus').catch(() => {});
          }
        }
      }
      publishState(true);
      break;
    }
    case 'toggle-pause':
      await togglePause();
      break;
    case 'toggle-menu':
      await toggleMenu();
      break;
    case 'close-menu':
      await toggleMenu(false);
      break;
    case 'toggle-lock':
      await toggleLock();
      break;
    case 'menu-page':
      S.menuPage = p.page === 'cfg' ? 'cfg' : 'menu';
      // The settings page needs a bigger window than the action list.
      await syncGeometry();
      publishState(true);
      break;
    case 'rest-now':
      await toggleMenu(false);
      await enterRest(false);
      break;
    case 'reset':
      await toggleMenu(false);
      if (S.mode === 'rest') await enterWork(false);
      else {
        S.paused = false;
        setRemaining(workSec());
        publishState(true);
      }
      break;
    case 'extend':
      await toggleMenu(false);
      if (S.mode === 'rest') {
        await enterWork(false);
        setRemaining(S.cfg.extendMinutes * 60);
      } else {
        setRemaining(S.remaining + S.cfg.extendMinutes * 60);
      }
      publishState(true);
      break;
    case 'skip-rest':
      if (S.mode === 'rest') await enterWork(false);
      break;
    case 'cycle-theme': {
      const i = THEME_NAMES.indexOf(S.cfg.theme);
      await saveConfig({ theme: THEME_NAMES[(i + 1) % THEME_NAMES.length] });
      break;
    }
    case 'recenter':
      await toggleMenu(false);
      await recenter();
      break;
    case 'save-config':
      await saveConfig(p.patch || {});
      await syncGeometry();
      // Deferred: this can arrive from a click inside the view's own tree, and
      // re-rendering would unmount the app that is still dispatching it.
      setTimeout(renderPanel, 0);
      S.ctx.ui.notify('✅ 参数已更新', 'success');
      break;
    case 'set-enabled':
      await saveConfig({ enabled: !!p.value });
      if (S.cfg.enabled) await showRuntime();
      else await hideRuntime();
      setTimeout(renderPanel, 0);
      break;
    case 'lock-rect': {
      // The pill measured its own lock icon. Trust it over anything guessed here.
      const r = p.rect || {};
      const w = Math.round(num(r.w, BOX.lockW));
      const h = Math.round(num(r.h, BOX.lockH));
      if (w > 0 && h > 0) {
        S.lockRect = { x: Math.round(num(r.x, 0)), y: Math.round(num(r.y, 0)), w, h };
        // Only the hit-box follows. This used to call `syncGeometry`, which also
        // re-applied the mask rect — a full-screen move+resize triggered by a
        // 22 px icon, on every state broadcast.
        if (S.win.lock) {
          await sizeWin(LABELS.lock, { width: w, height: h });
          await moveWin(LABELS.lock, lockPos());
        }
      }
      break;
    }
    case 'win-size': {
      // A window measured its own content (see `measure`) — the only reliable
      // source for a size the content decides.
      const from = p.from;
      if (!from || from === 'main') break;
      const rw = Math.round(num(p.w, 0));
      const rh = Math.round(num(p.h, 0));
      if (rw <= 0 && rh <= 0) break;
      const page = typeof p.page === 'string' ? p.page : undefined;
      // A report may carry one axis only, meaning "this axis changed": the other
      // keeps what the window already has. Defaulting it to 0 here collapsed the
      // pill to a zero-height sliver the first time it reported a width.
      const cur = sizeOf(from, page);
      const next = { w: rw > 0 ? rw : cur.w, h: rh > 0 ? rh : cur.h, page };
      const prev = S.winSize[from];
      if (prev && prev.w === next.w && prev.h === next.h && prev.page === next.page) break;
      S.winSize[from] = next;
      if (from === LABELS.pill) {
        S.pillSize = { w: next.w, h: next.h };
        // The pill may have grown past the screen edge it was parked against.
        S.pill = safePill(S.pill.x, S.pill.y);
      }
      await sizeWin(from, { width: next.w, height: next.h });
      await afterResize(from);
      break;
    }
    case 'move': {
      // Absolute, not a delta: a dropped frame can only ever lag, never drift.
      const to = safePill(num(p.x, S.pill.x), num(p.y, S.pill.y));
      S.pill = to;
      // ONLY the pill follows the pointer frame by frame. Every `control` call
      // costs two IPC round trips (`getByLabel` + the setter), so dragging the
      // lock and menu windows along as well tripled the per-frame cost of a
      // drag — that is what made dragging the pill stutter. They are
      // repositioned once, when the drag ends: the lock window is invisible
      // unless it is hovered, and the menu is only open on purpose, so nothing
      // is seen to lag behind.
      moveWin(LABELS.pill, to);
      if (!p.live) {
        if (S.win.lock) moveWin(LABELS.lock, lockPos());
        if (S.win.menu && S.menuOpen) moveWin(LABELS.menu, menuPos());
        await savePosition(to.x, to.y);
      }
      break;
    }
    case 'stop':
      await toggleMenu(false);
      await saveConfig({ enabled: false });
      await hideRuntime();
      setTimeout(renderPanel, 0);
      break;
    default:
      S.ctx.log.warn('unknown command: ' + String(p.act));
  }
}

/* ---------------------------------- ticks --------------------------------- */

/**
 * One tick, deadline-driven.
 *
 * The original decremented a counter, which drifts whenever the loop is
 * throttled or the machine sleeps. Here `endsAt` is the truth and each tick
 * derives the remainder from the wall clock, so a throttled timer can only
 * delay a repaint, never lose or gain time. "Frozen" states (paused, or resting
 * while the user is still typing) push the deadline forward by exactly the
 * elapsed interval.
 */
async function onTick() {
  if (!S.ready) return;
  const now = Date.now();
  const delta = now - S.lastTick;
  S.lastTick = now;

  // A gap this large is not a slow tick: the machine was asleep or suspended.
  if (delta > 3500) {
    await recover(delta);
    return;
  }

  // Cheapest possible display check — six property reads. It only does work on
  // the tick where the resolution, the scale or the work-area origin changed.
  await syncDisplay();

  // Held, not stopped: `endsAt` is pushed forward by exactly the elapsed time,
  // so the countdown resumes from the same value it was showing. Three reasons
  // to hold — the pause button, the work-idle hold, and typing during a break.
  if (S.paused || S.workIdlePaused || (S.mode === 'rest' && S.cfg.pauseOnActive && S.userActive)) {
    S.endsAt += delta;
    publishState();
    return;
  }

  const left = Math.max(0, Math.round((S.endsAt - now) / 1000));
  if (left !== S.remaining) {
    S.remaining = left;
    publishState();
  }
  // Load the break windows a little before they are needed. They are created
  // hidden, so this shows nothing; it just means that when the break starts the
  // mask is already painted instead of appearing a beat late.
  if (S.mode === 'work' && left <= WARM_LEAD_SEC) await warmRest();
  if (left <= 0) {
    if (S.mode === 'work') await enterRest(true);
    else await enterWork(true);
  }
}

/** How long before a break the mask windows are loaded in the background. */
const WARM_LEAD_SEC = 20;

/** Create (hidden) the two break windows so the next break is instant. */
async function warmRest() {
  if (!S.cfg.enabled || (S.win.rest && S.win.ctl)) return;
  try {
    await ensureRest();
    await ensureCtl();
  } catch (e) {
    // Pre-loading is an optimisation: failing it must not break the timer.
    S.ctx.log.warn('could not pre-load the break windows: ' + msg(e));
  }
}

/**
 * Wake / resolution-change recovery.
 *
 * The original also re-created the widget DOM and re-asserted topmost here,
 * because Electron could lose its Win32 mouse hooks. Nothing in the Tauri path
 * has that failure mode, so what is left is the part that is still real:
 * a long sleep means the user was away (start a fresh cycle) and a monitor
 * change can leave a window off screen.
 */
async function recover(sleepMs) {
  S.ctx.log.info('wake detected (' + Math.round(sleepMs / 1000) + 's)');
  readArea();
  // The machine may have woken on another monitor, or with a different scale.
  // Recording the signature here keeps the next tick from repeating this work.
  S.screenSig = screenSig();
  if (sleepMs > 180000) {
    S.mode = 'work';
    S.paused = false;
    // A fresh cycle: whatever hold the helper had taken belongs to the old one.
    S.workIdlePaused = false;
    setRemaining(workSec());
    await hideRest(false);
  } else {
    setRemaining(S.mode === 'rest' ? restSec() : workSec());
  }
  S.pill = safePill(S.pill.x, S.pill.y);
  await syncGeometry();
  // The phase may have changed under the helper's feet (a long sleep can end a
  // break), so re-decide whether it should be running at all.
  syncIdle();
  publishState(true);
}

/* ------------------------------ idle detection ----------------------------- */

/**
 * Whether the idle helper is worth running right now.
 *
 * Two independent reasons to sample, and it runs if EITHER holds:
 *
 *  - a break is on screen and `pauseOnActive` is on — the rest countdown has to
 *    freeze while the user is typing;
 *  - the user is working and `pauseWorkWhenIdle` is on — the focus countdown has
 *    to notice that they walked away.
 *
 * The original ran the helper unconditionally, which cost a process and four
 * envelopes a second for the whole session, most of it consumed by nothing. It
 * is still the plugin's only always-on background cost, so it stays tied to the
 * phases that actually read it: with both switches off it never starts at all.
 */
const wantsIdle = () =>
  S.ready &&
  S.cfg.enabled &&
  ((S.mode === 'rest' && S.cfg.pauseOnActive) ||
    (S.mode === 'work' && S.cfg.pauseWorkWhenIdle));

/** Start or stop the helper to match the current phase. Idempotent. */
function syncIdle() {
  if (wantsIdle()) startIdle().catch(() => {});
  else stopIdle();
}

function stopIdle() {
  clearTimeout(S.retry);
  S.retry = null;
  if (S.idleHandle) {
    S.idleHandle = null;
    // Kept as a promise rather than dropped: closing is an IPC round trip, and
    // `hub.stream` refuses to open a channel that is still registered. A short
    // work period can flip back into a break before the close lands, so the
    // next start has to be able to wait for it — see `startIdle`.
    S.idleClosing = S.ctx.closeStream(SIDE_CH).catch(() => {});
  }
  const changed = S.idleOk || S.userActive || S.workIdlePaused;
  S.idleOk = false;
  S.userActive = false;
  S.idleMs = -1;
  // Nothing is sampling any more, so nothing can release a hold the helper
  // took. Leaving it set would freeze the work countdown for good.
  S.workIdlePaused = false;
  if (changed) publishState(true);
}

/**
 * Start the idle helper.
 *
 * One long-lived process for the whole phase, sampled at 4 Hz by the helper
 * itself — the original spawned a fresh executable every second. The frames are
 * `evt` envelopes, so the same `Kind` vocabulary the host uses applies here.
 */
async function startIdle() {
  if (S.idleHandle || !wantsIdle()) return;
  // Wait out a close that is still in flight before claiming the channel again.
  if (S.idleClosing) {
    const pending = S.idleClosing;
    S.idleClosing = null;
    await pending;
  }
  if (S.idleHandle || !wantsIdle()) return;
  const K = S.ctx.protocol.Kind;
  try {
    S.idleHandle = await S.ctx.sidecar(SIDE_CH, {
      exe: 'idle.exe',
      pollMs: 60,
      timeoutMs: 400,
      onFrame: (env) => {
        if (env.kind !== K.EVT || !env.p || typeof env.p.idleMs !== 'number') return;
        S.idleMs = env.p.idleMs;
        if (!S.idleOk) {
          S.idleOk = true;
          S.idleWhy = null;
          // The helper is demonstrably working, so any earlier failure is over.
          // `retryIdle` gives up permanently after three failures, and this used
          // to be the only place that could ever refund the budget — and it did
          // not, so one bad patch of three failures disabled the feature for the
          // rest of the session with no way back.
          S.idleTries = 0;
          S.ctx.log.info('idle sidecar sampling');
          publishState(true);
        }
        const active = S.idleMs < S.cfg.idleThresholdSec * 1000;
        if (active !== S.userActive) {
          S.userActive = active;
          publishState();
        }
        syncWorkIdle();
      },
      onEnd: (env) => {
        S.idleHandle = null;
        S.idleOk = false;
        S.userActive = false;
        S.workIdlePaused = false;
        S.idleWhy = env && env.kind === K.EXIT ? 'idle.exe 退出（code ' + env.p + '）' : '空闲检测流已结束';
        publishState(true);
        retryIdle(env);
      },
    });
  } catch (e) {
    S.idleOk = false;
    S.idleWhy = msg(e);
    S.ctx.log.warn('idle sidecar unavailable (' + msg(e) + ') — falling back to a plain countdown');
    publishState(true);
    retryIdle(e);
  }
}

/**
 * Work-time idle: reset the focus countdown and hold it while the user is away.
 *
 * Deliberately NOT "pause and resume where it left off". A stretch of work long
 * enough to leave the desk in the middle of is not work, and once the user has
 * been gone for minutes the cycle has stopped meaning anything — so the
 * countdown goes back to the top and the break it was about to earn is not
 * earned. The reset happens ONCE, at the moment the user is judged to have left;
 * coming back only releases the hold, which means the fresh period effectively
 * starts from the moment they return.
 */
function syncWorkIdle() {
  if (S.mode !== 'work' || !S.cfg.pauseWorkWhenIdle) {
    if (S.workIdlePaused) {
      S.workIdlePaused = false;
      publishState(true);
    }
    return;
  }
  const away = S.idleMs >= S.cfg.workIdleResetSec * 1000;
  if (away === S.workIdlePaused) return;
  S.workIdlePaused = away;
  if (away) {
    setRemaining(workSec());
    S.ctx.log.info('work idle for ' + S.cfg.workIdleResetSec + 's — countdown reset and held');
  }
  publishState(true);
}

/**
 * A missing or crashed helper degrades instead of failing.
 *
 * `idle.exe` is part of the plugin folder, so it can genuinely be absent (a
 * partial copy). The plugin still works — it just cannot tell whether the user
 * is still typing, which is exactly what the two switches promise. The reason is
 * kept in `S.idleWhy` and shown in the view: without it the only way to tell a
 * missing binary from a refused permission from a channel collision is to open
 * the webview console, which is where this used to end up.
 */
function retryIdle(why) {
  if (S.idleTries >= 3 || !wantsIdle()) {
    if (S.idleTries >= 3) S.ctx.log.warn('idle sidecar gave up after 3 attempts: ' + msg(why));
    return;
  }
  S.idleTries += 1;
  clearTimeout(S.retry);
  S.retry = setTimeout(() => startIdle().catch(() => {}), 5000);
}

/* ══════════════════════════ 4. main-window view ════════════════════════════ */

function numRow(el, f, onCommit) {
  return el(
    'div',
    { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;' },
    el(
      'div',
      { style: 'display:flex;flex-direction:column;gap:1px;' },
      el('label', { for: 'ec-' + f.key }, f.label),
      el('span', { class: 'tb-hint' }, f.min + ' ~ ' + f.max + (f.unit ? ' ' + f.unit : '')),
    ),
    el('input', {
      id: 'ec-' + f.key,
      type: 'number',
      min: f.min,
      max: f.max,
      step: f.step,
      defaultValue: S.cfg[f.key],
      style: 'width:104px;',
      onChange: (e) => {
        const v = clampNum(num(e.target.value, f.def), f.min, f.max);
        e.target.value = v;
        onCommit(v);
      },
    }),
  );
}

function switchRow(el, spec, onChange) {
  return el(
    'div',
    { style: 'display:flex;gap:10px;align-items:flex-start;' },
    el('switch', {
      id: 'ec-' + spec.key,
      defaultValue: !!S.cfg[spec.key],
      'onUpdate:modelValue': (v) => onChange(!!v),
    }),
    el(
      'div',
      { style: 'display:flex;flex-direction:column;gap:2px;' },
      el('label', { for: 'ec-' + spec.key }, spec.label),
      el('span', { class: 'tb-hint' }, spec.hint),
    ),
  );
}

function renderPanel() {
  const v = S.view;
  if (!v || !v.root) return;
  const { el, render } = S.ctx.ui;

  const patch = (key, value) => {
    saveConfig({ [key]: value }).catch(() => {});
  };

  render(
    v.root,
    el(
      'div',
      { style: 'display:flex;flex-direction:column;gap:14px;max-width:640px;' },
      el(
        'div',
        {},
        el('h2', { style: 'margin:0 0 4px;font-size:16px;font-weight:500;' }, '护眼助手 Eye Care'),
        el(
          'p',
          { class: 'tb-hint', style: 'margin:0;' },
          '定时护眼：一个自绘悬浮胶囊、一个穿透锁定、一个全屏休息遮罩。',
          ' 全部界面由本插件自己的窗口绘制，状态经 event-bus 广播同步。',
        ),
      ),

      el(
        'card',
        {},
        el('card-header', {}, el('card-title', {}, '状态')),
        el(
          'card-content',
          { style: 'display:flex;flex-direction:column;gap:12px;' },
          el(
            'div',
            { class: 'tb-row' },
            el(
              'span',
              { class: 'tb-row-label' },
              el('span', { class: 'ec-dot tb-dot' }),
              el('span', { class: 'ec-mode' }, '—'),
              el('span', { class: 'ec-remain tb-mono' }, '--:--'),
            ),
            el(
              'span',
              { class: 'tb-row-actions' },
              el('span', { class: 'ec-win tb-badge' }, '悬浮窗 —'),
              el('span', { class: 'ec-idle tb-badge' }, '空闲检测 —'),
            ),
          ),
          // Where the helper's failure reason lands. Empty (and therefore
          // invisible) in the normal case — see `paintView`.
          el('p', { class: 'ec-idle-why tb-hint', style: 'margin:0;' }, ''),
          el(
            'div',
            { class: 'tb-toolbar' },
            el(
              'button',
              { variant: 'default', onClick: () => showRuntime().catch((e) => S.ctx.ui.notify('创建失败: ' + msg(e), 'error')) },
              '显示悬浮窗',
            ),
            el('button', { variant: 'outline', onClick: () => hideRuntime().catch(() => {}) }, '隐藏'),
            el('button', { variant: 'outline', onClick: () => enterRest(false).catch(() => {}) }, '预览休息'),
            el('button', { variant: 'outline', onClick: () => recenter().catch(() => {}) }, '复位到右上角'),
            el('button', { variant: 'destructive', onClick: () => closeAll().catch(() => {}) }, '销毁全部窗口'),
          ),
          el(
            'p',
            { class: 'tb-hint', style: 'margin:0;' },
            '全局热键 ',
            el('kbd', { class: 'tb-kbd' }, 'Ctrl+Alt+E'),
            ' 开关菜单；胶囊按住可拖动，拖动结束后位置写入配置。',
          ),
        ),
      ),

      el(
        'card',
        {},
        el('card-header', {}, el('card-title', {}, '计时')),
        el(
          'card-content',
          { style: 'display:flex;flex-direction:column;gap:12px;' },
          numRow(el, fieldOf('workMinutes'), (x) => patch('workMinutes', x)),
          numRow(el, fieldOf('restMinutes'), (x) => patch('restMinutes', x)),
          numRow(el, fieldOf('extendMinutes'), (x) => patch('extendMinutes', x)),
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
            { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;' },
            el(
              'div',
              { style: 'display:flex;flex-direction:column;gap:1px;' },
              el('label', {}, '主题'),
              el('span', { class: 'tb-hint' }, '四个内置调色板，作用于本插件的窗口'),
            ),
            // The real `select` component — a styled trigger plus a portalled
            // popup — rather than `native-select`. Same shape the built-in
            // procman plugin uses, so the control matches the rest of the app
            // instead of looking like a raw OS combo box.
            //
            // `defaultValue`, NOT `modelValue`: reka-ui's SelectRoot switches to
            // controlled mode the moment `modelValue` is passed (`passive:
            // props.modelValue === void 0`), and then the displayed value comes
            // from the prop alone. The panel is deliberately not re-rendered on
            // every edit — that would drop focus in the number inputs — so a
            // controlled Select would appear to refuse the change. Uncontrolled,
            // it owns what it shows and the config is seeded back into it
            // whenever `renderPanel` runs.
            el(
              'div',
              { style: 'width:150px;flex:0 0 auto;' },
              el(
                'select',
                { defaultValue: S.cfg.theme, 'onUpdate:modelValue': (x) => patch('theme', x) },
                el('select-trigger', { class: 'w-full' }, el('select-value', {})),
                el(
                  'select-content',
                  {},
                  THEME_NAMES.map((n) => el('select-item', { value: n }, n)),
                ),
              ),
            ),
          ),
          el(
            'div',
            { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;' },
            el(
              'div',
              { style: 'display:flex;flex-direction:column;gap:1px;' },
              el('label', {}, '字体'),
              el('span', { class: 'tb-hint' }, '仅作用于胶囊 / 菜单 / 遮罩'),
            ),
            el(
              'div',
              { style: 'width:150px;flex:0 0 auto;' },
              el(
                'select',
                {
                  defaultValue: S.cfg.fontFamily,
                  'onUpdate:modelValue': (x) => patch('fontFamily', x),
                },
                el('select-trigger', { class: 'w-full' }, el('select-value', {})),
                el(
                  'select-content',
                  {},
                  FONTS.map((n) => el('select-item', { value: n }, n)),
                ),
              ),
            ),
          ),
          el('separator', {}),
          // The pill's two knobs. Its WIDTH is not here on purpose: it is
          // measured from what the pill holds, so a bigger font simply makes a
          // longer pill instead of clipping the clock or leaving a gap.
          numRow(el, fieldOf('pillScale'), (x) => patch('pillScale', x)),
          numRow(el, fieldOf('pillFontSize'), (x) => patch('pillFontSize', x)),
          el(
            'p',
            { class: 'tb-hint', style: 'margin:0;' },
            '胶囊宽度由内容实测决定：缩放只影响高度与内边距，字号只影响文字。',
          ),
          el('separator', {}),
          el(
            'div',
            { style: 'display:flex;flex-direction:column;gap:8px;' },
            el(
              'span',
              { class: 'tb-label' },
              '悬浮窗透明度 ',
              el('span', { class: 'ec-v-normal tb-t-muted' }, String(S.cfg.opacityNormal)),
            ),
            el('slider', {
              defaultValue: [S.cfg.opacityNormal],
              min: 0.05,
              max: 1,
              step: 0.01,
              'onUpdate:modelValue': (x) => {
                const val = clampNum(num(Array.isArray(x) ? x[0] : x, S.cfg.opacityNormal), 0.05, 1);
                S.cfg.opacityNormal = val;
                const label = v.root.querySelector('.ec-v-normal');
                if (label) label.textContent = String(val);
                publishState(true);
                v.debounce('opacityNormal', val);
              },
            }),
          ),
          el(
            'div',
            { style: 'display:flex;flex-direction:column;gap:8px;' },
            el(
              'span',
              { class: 'tb-label' },
              '锁定透传透明度 ',
              el('span', { class: 'ec-v-locked tb-t-muted' }, String(S.cfg.opacityLocked)),
            ),
            el('slider', {
              defaultValue: [S.cfg.opacityLocked],
              min: 0.05,
              max: 1,
              step: 0.01,
              'onUpdate:modelValue': (x) => {
                const val = clampNum(num(Array.isArray(x) ? x[0] : x, S.cfg.opacityLocked), 0.05, 1);
                S.cfg.opacityLocked = val;
                const label = v.root.querySelector('.ec-v-locked');
                if (label) label.textContent = String(val);
                publishState(true);
                v.debounce('opacityLocked', val);
              },
            }),
          ),
          el(
            'div',
            { style: 'display:flex;flex-direction:column;gap:8px;' },
            el(
              'span',
              { class: 'tb-label' },
              '休息遮罩暗度 ',
              el('span', { class: 'ec-v-scrim tb-t-muted' }, String(S.cfg.restScrim)),
            ),
            el('slider', {
              defaultValue: [S.cfg.restScrim],
              min: 0.05,
              max: 1,
              step: 0.01,
              'onUpdate:modelValue': (x) => {
                const val = clampNum(num(Array.isArray(x) ? x[0] : x, S.cfg.restScrim), 0.05, 1);
                S.cfg.restScrim = val;
                const label = v.root.querySelector('.ec-v-scrim');
                if (label) label.textContent = String(val);
                publishState(true);
                v.debounce('restScrim', val);
              },
            }),
          ),
        ),
      ),

      el(
        'card',
        {},
        el('card-header', {}, el('card-title', {}, '高级')),
        el(
          'card-content',
          { style: 'display:flex;flex-direction:column;gap:14px;' },
          numRow(el, fieldOf('restTextActiveOpacity'), (x) => patch('restTextActiveOpacity', x)),
          numRow(el, fieldOf('fadeMs'), (x) => patch('fadeMs', x)),
          numRow(el, fieldOf('idleThresholdSec'), (x) => patch('idleThresholdSec', x)),
          numRow(el, fieldOf('workIdleResetSec'), (x) => patch('workIdleResetSec', x)),
          el('separator', {}),
          ...SWITCHES.map((spec) =>
            switchRow(el, spec, async (val) => {
              if (spec.key === 'enabled') {
                await handleCommand({ act: 'set-enabled', value: val });
                return;
              }
              await saveConfig({ [spec.key]: val });
              if (spec.key === 'pauseOnActive' || spec.key === 'pauseWorkWhenIdle') {
                S.idleTries = 0;
                // `syncIdle` decides: it starts when either phase wants it.
                syncIdle();
              }
              renderPanel();
            }),
          ),
        ),
      ),
    ),
  );
}

/** Live status text, without re-rendering (a re-render would drop input focus). */
function paintView() {
  const v = S.view;
  if (!v || !v.root) return;
  const set = (sel, text, cls) => {
    const node = v.root.querySelector(sel);
    if (!node) return;
    if (text != null) node.textContent = text;
    if (cls) node.className = cls;
  };
  set(
    '.ec-mode',
    S.paused ? '已暂停' : S.workIdlePaused ? '已离开' : S.mode === 'work' ? '专注中' : '休息中',
  );
  set('.ec-remain', clock(S.remaining));
  const dotCls = S.paused ? 'tb-dot-warn' : S.mode === 'work' ? 'tb-dot-ok' : '';
  set('.ec-dot', null, 'ec-dot tb-dot ' + dotCls);
  const shown = S.win.pill && S.cfg.enabled;
  set('.ec-win', shown ? '悬浮窗 运行中' : '悬浮窗 未显示', 'ec-win tb-badge ' + (shown ? 'tb-badge-ok' : 'tb-badge-warn'));
  // The helper runs in BOTH phases now, so "not sampling" is only normal when
  // neither switch wants it. See `idleBadge`.
  const ib = idleBadge();
  set('.ec-idle', ib.text, ib.cls);
  // The failure reason, when there is one. `ctx.log.warn` only reaches the
  // webview console, which is not somewhere a user can be asked to look; a
  // missing `idle.exe` and a refused permission look identical from outside.
  set('.ec-idle-why', S.idleOk || !S.idleWhy ? '' : '空闲检测失败：' + S.idleWhy);
}

/**
 * The idle badge.
 *
 * Five states, because the helper now serves two phases with two switches:
 * off, not sampling yet, unavailable (with a reason), idle, and active. The
 * important one is the distinction between "待命" (the switch is on and the
 * phase has not started reading it) and "不可用" (it should be sampling and is
 * not) — collapsing those two is what made the original failure so hard to read.
 */
function idleBadge() {
  const wantRest = S.cfg.pauseOnActive && S.mode === 'rest';
  const wantWork = S.cfg.pauseWorkWhenIdle && S.mode === 'work';
  if (!wantRest && !wantWork) return { text: '空闲检测 已关闭', cls: 'ec-idle tb-badge' };
  if (!S.idleOk) {
    return { text: '空闲检测 不可用', cls: 'ec-idle tb-badge tb-badge-bad' };
  }
  if (S.workIdlePaused) {
    return { text: '空闲检测 已离开 · 计时已重置', cls: 'ec-idle tb-badge tb-badge-warn' };
  }
  return {
    text: S.userActive ? '空闲检测 输入中' : '空闲检测 空闲',
    cls: 'ec-idle tb-badge tb-badge-ok',
  };
}

/* ══════════════════════════ 5. plugin-window UIs ═══════════════════════════ */

/** Common reset for every window: no margins, transparent, never selectable. */
const WIN_BASE =
  '*{margin:0;padding:0;box-sizing:border-box;user-select:none;}' +
  'html,body{width:100%;height:100%;overflow:hidden;background:transparent!important;}' +
  'body{font-family:var(--ec-font);color:var(--ec-text);}';

function windowShell(css, html) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  document.body.innerHTML = html;
}

/* --------------------------------- the pill -------------------------------- */

/**
 * No `backdrop-filter` anywhere in this plugin — a deliberate performance
 * decision, not a style one.
 *
 * A `backdrop-filter: blur()` on a transparent always-on-top window asks the
 * compositor to re-blur everything behind that window **every time anything
 * behind it changes** — which includes dragging the window itself, and also
 * dragging any OTHER window that passes under it. The pill is small and always
 * on top, so a plain drag of the main window made the whole desktop feel
 * sticky. The original used the same blur; the frosted look is not worth a
 * laggy window, so the background is a plain `rgba()` and the transparency
 * comes from the opacity settings instead.
 */
const PILL_CSS =
  // Every size comes from a custom property with a fallback equal to the value
  // at scale 1, so the FIRST paint (before the first state broadcast arrives)
  // is already correct and the first measurement is meaningful.
  '#pill{width:100%;height:100%;border-radius:999px;display:flex;align-items:center;' +
  'padding:0 var(--ec-sz-padr,8px) 0 var(--ec-sz-padl,10px);border:1px solid var(--ec-border);' +
  'cursor:grab;background-color:rgba(var(--ec-rgb),var(--ec-alpha));' +
  'transition:background-color .25s ease,border-color .25s ease;}' +
  '#pill.dragging{cursor:grabbing;}' +
  '#dot{width:var(--ec-sz-dot,7px);height:var(--ec-sz-dot,7px);border-radius:50%;' +
  'margin-right:var(--ec-sz-dotgap,6px);flex:0 0 auto;' +
  'background-color:var(--ec-dot);box-shadow:0 0 5px var(--ec-dot);pointer-events:none;' +
  'transition:background-color .3s ease,box-shadow .3s ease;}' +
  // `flex:0 0 auto` + `nowrap`, and no `flex:1`: the clock used to absorb every
  // spare pixel, which is what left a 35 px dead gap between it and the pause
  // button — and a clock that is allowed to shrink is a clock that wraps to one
  // character per line. The window is measured from this text instead, so it is
  // exactly as long as it needs to be.
  '#time{flex:0 0 auto;font-size:var(--ec-fs,12px);font-weight:var(--ec-weight);' +
  'letter-spacing:.02em;white-space:nowrap;pointer-events:none;}' +
  '.ec-btn{width:var(--ec-sz-btn,20px);height:var(--ec-sz-btn,20px);border-radius:50%;display:flex;' +
  'align-items:center;justify-content:center;flex:0 0 auto;font-size:calc(var(--ec-fs,12px) * .85);' +
  'color:var(--ec-text);opacity:.85;cursor:pointer;transition:all .15s ease;}' +
  '.ec-btn:hover{opacity:1;background-color:var(--ec-hover);transform:scale(1.08);}' +
  '.ec-btn:active{transform:scale(.92);}' +
  '#btn-pause{margin-right:var(--ec-sz-btngap,6px);}' +
  // The lock icon is its own hit target while the pill is NOT click-through;
  // the window that takes over once it IS is sized from the rect this element
  // reports (`lock-rect`), so target and icon cannot drift apart.
  '#lock-visual{width:var(--ec-sz-lock,22px);height:var(--ec-sz-lock,22px);border-radius:50%;' +
  'display:flex;align-items:center;justify-content:center;flex:0 0 auto;cursor:pointer;' +
  'transition:background-color .15s ease;}' +
  '#lock-visual:hover{background-color:var(--ec-hover);}' +
  '#lock-icon{width:60%;height:60%;border-radius:50%;border:2px solid var(--ec-icon);' +
  'background-color:var(--ec-icon);box-shadow:0 1px 3px rgba(0,0,0,.4);transition:all .2s ease;}' +
  '#lock-icon.locked{border-color:var(--ec-icon-locked);background-color:transparent;}';

// No ☰ button: the function menu is on the right-click (`contextmenu`), which
// is where a floating widget's menu is expected and frees the width the button
// used to take.
const PILL_HTML =
  '<div id="pill">' +
  '<div id="dot"></div>' +
  '<div id="time">Work: 00:00</div>' +
  '<div class="ec-btn" id="btn-pause" title="暂停/继续倒计时">⏸</div>' +
  '<div id="lock-visual"><div id="lock-icon"></div></div>' +
  '</div>';

/**
 * The pill.
 *
 * Dragging is done by the plugin, not by `bridge.drag()`, and that is a
 * deliberate trade: `startDragging()` is smoother, but it hands the window to
 * the OS compositor and the plugin never learns where the window ended up —
 * `ctx` exposes no position getter, so "remember my position" would be
 * impossible. Tracking the pointer instead costs one broadcast per animation
 * frame and makes the position known exactly. Positions travel as ABSOLUTE
 * coordinates, so a dropped frame can only ever lag, never accumulate drift.
 */
function mountPill(bridge) {
  windowShell(WIN_BASE + PILL_CSS, PILL_HTML);
  const K = bridge.protocol.Kind;
  const pill = document.getElementById('pill');
  const time = document.getElementById('time');
  const dot = document.getElementById('dot');
  const btnPause = document.getElementById('btn-pause');
  const lockVisual = document.getElementById('lock-visual');
  const lockIcon = document.getElementById('lock-icon');

  const pos = { x: 0, y: 0, known: false };
  let drag = null;
  let raf = 0;

  const send = (p) => {
    bridge.publish(TOPIC_CMD, { ...p, from: bridge.label }).catch(() => {});
  };
  // The drag hot path: its own topic, so a per-frame message reaches the main
  // window and nothing else (see TOPIC_DRAG).
  const sendDrag = (p) => {
    bridge.publish(TOPIC_DRAG, { ...p, from: bridge.label }).catch(() => {});
  };

  /**
   * Tell the main window exactly where the lock icon is.
   *
   * Only this window can measure it, and the main window needs it to place the
   * unlock hit-box when the pill goes click-through. Reporting the real rect
   * beats duplicating the pill's padding/box math over there: the two can never
   * disagree about where the button is.
   */
  const reportLockRect = () => {
    const r = lockVisual.getBoundingClientRect();
    send({ act: 'lock-rect', rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
  };

  /**
   * Tell the main window how wide the pill needs to be.
   *
   * Measured, never configured: a fixed 186 px left a 35 px dead gap between the
   * clock and the pause button, and it went stale the moment the font or the
   * scale changed. Measured with the WIDEST label so the window does not resize
   * itself as the clock ticks. `getBoundingClientRect` forces layout
   * synchronously, so swapping the text and the width for the duration of the
   * read is invisible — nothing is painted in between.
   */
  const reportSize = () => {
    const keep = time.textContent;
    time.textContent = WIDEST_LABEL;
    pill.style.width = 'max-content';
    const w = Math.ceil(pill.getBoundingClientRect().width);
    pill.style.width = '';
    time.textContent = keep;
    send({ act: 'win-size', w });
  };

  /**
   * Re-measure and re-report, at most once per painted frame.
   *
   * ## Why the coalescing is load-bearing
   *
   * Both measurements call `getBoundingClientRect()`, which forces a synchronous
   * layout, and both then PUBLISH — and a publish reaches every window, is
   * answered by the main window with `SetWindowPos`, and that `SetWindowPos`
   * produces a fresh `resize` here. So each run of this pair is one turn of a
   * loop that crosses two windows and the native side.
   *
   * Windows sends `WM_SIZE` continuously while a window is dragged or resized,
   * so an uncoalesced handler ran the whole turn once per message — dozens of
   * times a second, each one a forced layout plus an IPC round trip through the
   * main thread, competing with the very drag that produced it. Coalescing caps
   * the loop at the frame rate, which is the most the exchange can usefully do:
   * the next report would measure the same pixels.
   *
   * The dedupe in `sizeReporter` is the second half of this and a different
   * thing — it stops the loop once the value STOPS changing. This stops it from
   * running more often than it can help while the value is still moving.
   */
  let reportRaf = 0;
  const scheduleReports = () => {
    if (reportRaf) return;
    reportRaf = requestAnimationFrame(() => {
      reportRaf = 0;
      reportSize();
      reportLockRect();
    });
  };

  /** The pill's own chrome, from the same two knobs the main window uses. */
  const applyMetrics = (s) => {
    applyVars(
      document.documentElement,
      pillVars(pillMetrics({ pillScale: s.pillScale, pillFontSize: s.pillFontSize })),
    );
  };

  const queueMove = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      sendDrag({ act: 'move', x: pos.x, y: pos.y, live: true });
    });
  };

  pill.addEventListener('pointerdown', (e) => {
    // Buttons and the lock icon act on their own; anything else drags.
    if (e.button !== 0 || e.target.closest('.ec-btn') || e.target.closest('#lock-visual')) return;
    if (!pos.known) return; // no anchor yet: the first state has not arrived
    drag = { px: e.screenX, py: e.screenY, ox: pos.x, oy: pos.y };
    pill.classList.add('dragging');
    if (pill.setPointerCapture) pill.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  pill.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const nx = Math.round(drag.ox + (e.screenX - drag.px));
    const ny = Math.round(drag.oy + (e.screenY - drag.py));
    if (nx === pos.x && ny === pos.y) return;
    pos.x = nx;
    pos.y = ny;
    queueMove();
  });

  const endDrag = () => {
    if (!drag) return;
    drag = null;
    pill.classList.remove('dragging');
    sendDrag({ act: 'move', x: pos.x, y: pos.y, live: false });
  };
  pill.addEventListener('pointerup', endDrag);
  pill.addEventListener('pointercancel', endDrag);
  // A safety net for a `pointerup` that lands outside the pill (it should not
  // happen — the pointer is captured — but a stuck drag would be worse than a
  // redundant listener). Deliberately NOT `blur`: this window is created with
  // `focus: false`, so it never takes focus and a blur would only ever fire
  // spuriously and cut a drag short.
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  btnPause.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    send({ act: 'toggle-pause' });
  });

  // The lock target, for as long as the pill can still be clicked at all. Once
  // it is click-through this element stops receiving anything and the main
  // window's small companion window over this exact rect takes over.
  lockVisual.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    send({ act: 'toggle-lock' });
  });

  // The function menu lives on the right-click now that the ☰ button is gone.
  // The default menu has to be suppressed for the WHOLE document: leaving it on
  // would hand the user WebView2's "reload / inspect" menu, which is not an app
  // menu and cannot be made to look like one.
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    send({ act: 'toggle-menu' });
  });

  // The main window resizes this one from `win-size`, so a resize means the
  // layout moved: the hit-box has to be re-measured against the new one, and
  // re-reporting the size is how the exchange settles (the second measurement
  // is identical, so `sizeReporter`'s dedupe stops it).
  //
  // Coalesced — see `scheduleReports`. This fires once per `WM_SIZE`, and
  // Windows sends those continuously during a drag, so handling each one inline
  // turned a single drag into a burst of measure-publish-resize turns.
  window.addEventListener('resize', scheduleReports);

  bridge.subscribe(TOPIC_STATE, (env) => {
    const s = env.p || {};
    if (typeof s.label === 'string') time.textContent = s.label;
    if (s.dot) {
      dot.style.backgroundColor = s.dot;
      dot.style.boxShadow = '0 0 5px ' + s.dot;
    }
    if (s.theme) {
      applyVars(document.documentElement, themeVars(s.theme, s.font));
      applyMetrics(s);
      // A font, weight or size change moves everything; the window's size and
      // the hit-box both follow it. Through the same coalescer as the resize
      // handler, so a theme change landing in the same frame as a resize is one
      // report rather than two.
      scheduleReports();
    }
    pill.style.setProperty('--ec-alpha', String(s.locked ? s.alphaLocked : s.alphaNormal));
    lockIcon.classList.toggle('locked', !!s.locked);
    btnPause.textContent = s.paused ? '▶' : '⏸';
    btnPause.title = s.paused ? '点击恢复继续' : '点击暂停倒计时';
    // While dragging, the local position is ahead of the broadcast: taking the
    // remote value here would fight the pointer.
    if (!drag && typeof s.pillX === 'number') {
      pos.x = s.pillX;
      pos.y = s.pillY;
      pos.known = true;
    }
  });

  reportSize();
  reportLockRect();
  send({ act: 'hello' });
}

/* -------------------------------- the lock --------------------------------- */

/**
 * The unlock hit-box.
 *
 * It exists because a click-through window cannot receive the click that would
 * turn click-through off, so while the pill is locked a small non-click-through
 * window has to sit over its lock icon — the same reason the original had a
 * second window here. It is only created while locked; see `ensureLock`.
 *
 * The window is exactly the size of that icon, so the target and the thing you
 * see are the same box. The hover cue is an INSET ring on purpose: an outer
 * `box-shadow` is drawn outside the window and gets clipped by it, which is
 * what made the old 28x28 hit-box read as a flat, cut-off ellipse instead of
 * the round button it was sitting on.
 */
const LOCK_CSS =
  'html,body{display:flex;align-items:center;justify-content:center;cursor:pointer!important;}' +
  '#hit{width:100%;height:100%;border-radius:50%;background:transparent;' +
  'transition:background-color .15s ease,box-shadow .15s ease;}' +
  '#hit:hover{background-color:rgba(56,189,248,.28);box-shadow:inset 0 0 0 1px rgba(56,189,248,.6);}';

function mountLock(bridge) {
  windowShell(WIN_BASE + LOCK_CSS, '<div id="hit" title="点击解锁（关闭鼠标穿透）"></div>');
  const hit = document.getElementById('hit');
  hit.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    bridge.publish(TOPIC_CMD, { act: 'toggle-lock', from: bridge.label }).catch(() => {});
  });
  bridge.subscribe(TOPIC_STATE, (env) => {
    const s = env.p || {};
    hit.title = s.locked ? '已开启穿透锁定（点击解锁）' : '点击锁定窗口（开启穿透防误触）';
  });
  // Same handshake as every other window: the main window shows this one only
  // after it reports in, so a blank white hit-box never appears over the pill.
  bridge.publish(TOPIC_CMD, { act: 'hello', from: bridge.label }).catch(() => {});
}

/* -------------------------------- the menu --------------------------------- */

const MENU_CSS =
  '#card{width:100%;height:100%;border-radius:14px;background-color:rgba(var(--ec-rgb),.94);' +
  'border:1px solid var(--ec-border);box-shadow:0 8px 24px rgba(0,0,0,.45);' +
  'padding:8px 6px;display:flex;flex-direction:column;gap:3px;overflow:hidden;}' +
  // `#menu` had NO rule at all, and the page switch set its `display` to `flex`
  // inline — which makes it a flex ROW, not a column. The seven rows were then
  // squeezed into 174 px of width, and a flex row's text runs are anonymous flex
  // items whose minimum size is ONE character for CJK, so every label wrapped to
  // a single character per line. That is the "vertical menu text": not a writing
  // mode, a missing `flex-direction`. The page is switched by a class now, so
  // the container cannot be given a display value without a direction again.
  '#menu{display:flex;flex-direction:column;gap:0;flex:1 1 auto;min-height:0;}' +
  '.item{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;font-size:12px;' +
  'font-weight:500;white-space:nowrap;cursor:pointer;transition:all .12s ease;}' +
  '.item:hover{background-color:var(--ec-hover);transform:translateX(2px);}' +
  '.item:active{transform:scale(.96);}' +
  '.item.danger{color:#f87171;}' +
  '.item.danger:hover{background-color:rgba(239,68,68,.2);}' +
  '.divider{height:1px;background:var(--ec-border);margin:3px 4px;opacity:.6;}' +
  // NOT a scroll container: `overflow-y:auto` makes the box report a max-content
  // height ~16 px SHORT of what it holds (a scroll container's intrinsic height
  // is not its content's), which clipped the save button off the bottom. The
  // window is measured from this content, so the content must be honest about
  // how tall it is; `#card`'s `overflow:hidden` is the backstop.
  '#cfg{display:none;flex-direction:column;gap:5px;padding:0 4px;flex:1 1 auto;min-height:0;}' +
  '#card.cfg #menu{display:none;}' +
  '#card.cfg #cfg{display:flex;}' +
  '#cfg .f{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;}' +
  // The label yields and ellipsizes; the control never shrinks and is never
  // pushed out of the window. Before this the label held its full width and the
  // input was laid out past the right edge, where `#card{overflow:hidden}` ate
  // it — a settings page whose fields were invisible.
  '#cfg .f span{opacity:.8;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;' +
  'white-space:nowrap;}' +
  '#cfg input,#cfg select{width:88px;flex:0 0 auto;font-size:11.5px;padding:3px 6px;border-radius:6px;' +
  'border:1px solid var(--ec-border);background:rgba(127,127,127,.14);color:var(--ec-text);' +
  'font-family:inherit;outline:none;}' +
  '#cfg input[type=checkbox]{width:auto;padding:0;accent-color:#059669;cursor:pointer;}' +
  '#cfg .t{font-size:12px;font-weight:600;padding:2px 6px;opacity:.85;}' +
  '#cfg .row{display:flex;gap:6px;padding:4px 2px 2px;}' +
  '#cfg button{flex:1 1 auto;padding:6px 8px;border-radius:8px;font-size:11.5px;cursor:pointer;' +
  'white-space:nowrap;border:1px solid var(--ec-border);background:transparent;color:var(--ec-text);' +
  'font-family:inherit;}' +
  '#cfg button.p{background-color:#059669;border-color:rgba(52,211,153,.5);color:#fff;font-weight:600;}' +
  '#cfg .n{font-size:11px;opacity:.6;padding:0 6px;}';

function menuHtml() {
  return (
    '<div id="card">' +
    '<div id="menu">' +
    '<div class="item" data-act="rest">☕ 立即进入休息</div>' +
    '<div class="item" data-act="reset">⏱️ 重置专注 (<span id="m-work">25</span>m)</div>' +
    '<div class="item" data-act="extend">➕ 延长 <span id="m-ext">5</span> 分钟</div>' +
    '<div class="divider"></div>' +
    '<div class="item" data-act="cycle-theme">🎨 切换主题 (<span id="m-theme">Dark</span>)</div>' +
    '<div class="item" data-act="recenter">📍 复位到右上角</div>' +
    '<div class="item" data-act="config">⚙️ 集中参数配置</div>' +
    '<div class="divider"></div>' +
    '<div class="item danger" data-act="stop">🚪 停止并隐藏护眼助手</div>' +
    '</div>' +
    '<div id="cfg"></div>' +
    '</div>'
  );
}

/**
 * The menu window — the original's "self-drawn bubble menu", plus the settings
 * page that replaces its `fields()` dialog.
 *
 * The settings page is generated from the SAME `FIELDS` table the main view
 * uses, so the two config surfaces cannot disagree about ranges or defaults.
 * Everything it does is one `save-config` command: the main window owns the
 * config, the windows only render it.
 */
function mountMenu(bridge) {
  windowShell(WIN_BASE + MENU_CSS, menuHtml());
  const card = document.getElementById('card');
  const menu = document.getElementById('menu');
  const cfg = document.getElementById('cfg');
  const mWork = document.getElementById('m-work');
  const mExt = document.getElementById('m-ext');
  const mTheme = document.getElementById('m-theme');

  const send = (p) => {
    bridge.publish(TOPIC_CMD, { ...p, from: bridge.label }).catch(() => {});
  };

  const rows = FIELDS.map(
    (f) =>
      '<div class="f"><span>' +
      esc(f.label) +
      (f.unit ? ' (' + esc(f.unit) + ')' : '') +
      '</span><input data-k="' +
      f.key +
      '" type="number" step="' +
      f.step +
      '" min="' +
      f.min +
      '" max="' +
      f.max +
      '"></div>',
  ).join('');

  // The switches are generated from the same `SWITCHES` table the main view
  // uses, so "随应用一起启动" and friends are reachable from the menu too —
  // they used to be visible only in the main window.
  const switchRows = SWITCHES.map(
    (s) =>
      '<div class="f" title="' +
      esc(s.hint) +
      '"><span>' +
      esc(s.label) +
      '</span><input data-s="' +
      s.key +
      '" type="checkbox"></div>',
  ).join('');

  cfg.innerHTML =
    '<div class="t">集中参数配置</div>' +
    rows +
    '<div class="f"><span>主题</span><select data-k="theme">' +
    THEME_NAMES.map((n) => '<option value="' + n + '">' + n + '</option>').join('') +
    '</select></div>' +
    '<div class="f"><span>字体</span><select data-k="fontFamily">' +
    FONTS.map((n) => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('') +
    '</select></div>' +
    '<div class="t">开关</div>' +
    switchRows +
    '<div class="n">数值超出范围会被自动收敛；改当前阶段的时长会立刻重启倒计时。</div>' +
    '<div class="row"><button class="p" id="cfg-save">保存并应用</button>' +
    '<button id="cfg-back">返回</button></div>';

  let cfgRev = -1;
  let page = 'menu';

  /**
   * Report the height this page needs.
   *
   * Height only, deliberately: a menu whose width changed with its longest row
   * would twitch, so the width stays a design constant and only the height is
   * measured. That alone removes the empty third the settings page used to
   * carry — 566 px of window for 345 px of content, because the height was a
   * guess that nobody ever re-checked.
   *
   * The width is pinned to that constant FOR THE DURATION OF THE READ. The
   * height is width-dependent — the note under the switches wraps to two lines
   * at 276 px and one at 400 — so measuring at whatever width the window
   * happens to have gives a height that is right for some other window.
   */
  const reportSize = sizeReporter(bridge, () => {
    const want = page === 'cfg' ? BOX.cfgW : BOX.menuW;
    const prevW = card.style.width;
    card.style.width = want + 'px';
    const m = measure(card, { h: true }, { h: 120 });
    card.style.width = prevW;
    m.page = page;
    return m;
  });

  const fill = (c) => {
    for (const f of FIELDS) {
      const node = cfg.querySelector('[data-k="' + f.key + '"]');
      if (node) node.value = c[f.key];
    }
    const th = cfg.querySelector('[data-k="theme"]');
    if (th) th.value = c.theme;
    const fo = cfg.querySelector('[data-k="fontFamily"]');
    if (fo) fo.value = c.fontFamily;
    for (const s of SWITCHES) {
      const node = cfg.querySelector('[data-s="' + s.key + '"]');
      if (node) node.checked = !!c[s.key];
    }
  };

  menu.addEventListener('pointerdown', (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    e.stopPropagation();
    const act = item.dataset.act;
    if (act === 'config') {
      send({ act: 'menu-page', page: 'cfg' });
      return;
    }
    send({ act });
  });

  cfg.querySelector('#cfg-save').addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const patch = {};
    for (const f of FIELDS) {
      const node = cfg.querySelector('[data-k="' + f.key + '"]');
      if (node) patch[f.key] = num(node.value, f.def);
    }
    const th = cfg.querySelector('[data-k="theme"]');
    if (th) patch.theme = th.value;
    const fo = cfg.querySelector('[data-k="fontFamily"]');
    if (fo) patch.fontFamily = fo.value;
    for (const s of SWITCHES) {
      const node = cfg.querySelector('[data-s="' + s.key + '"]');
      if (node) patch[s.key] = node.checked;
    }
    send({ act: 'save-config', patch });
  });

  cfg.querySelector('#cfg-back').addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    send({ act: 'menu-page', page: 'menu' });
  });

  // Blur / Escape close the menu, like the original. `close-menu` is a request:
  // this window cannot hide itself (window ops belong to the creating window).
  window.addEventListener('blur', () => {
    setTimeout(() => {
      if (!document.hasFocus()) send({ act: 'close-menu' });
    }, 120);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') send({ act: 'close-menu' });
  });

  bridge.subscribe(TOPIC_STATE, (env) => {
    const s = env.p || {};
    const themed = !!s.theme;
    if (themed) applyVars(document.documentElement, themeVars(s.theme, s.font));
    if (s.cfg) {
      mWork.textContent = s.cfg.workMinutes;
      mExt.textContent = s.cfg.extendMinutes;
      mTheme.textContent = s.cfg.theme;
    }
    const want = s.menuPage === 'cfg' ? 'cfg' : 'menu';
    const switched = want !== page;
    page = want;
    // A class, not `style.display`: the display value lives in the stylesheet
    // next to the `flex-direction` it depends on (see MENU_CSS).
    card.classList.toggle('cfg', page === 'cfg');
    if (page === 'cfg' && s.cfgRev !== cfgRev) {
      cfgRev = s.cfgRev;
      fill(s.cfg);
    }
    // The two pages are different heights, and a font change moves both.
    if (switched || themed) reportSize();
  });

  reportSize();
  send({ act: 'hello' });
}

/* ------------------------------- the mask ---------------------------------- */

/**
 * The mask dims, it does not blur — and it does not animate.
 *
 * The original blurred the whole desktop behind the overlay. That is the most
 * expensive thing this plugin could do: the mask covers the entire monitor, it
 * is click-through so the user keeps working underneath it, and a
 * `backdrop-filter` there means the compositor re-blurs the whole screen on
 * every keystroke, scroll or window move — for the entire break.
 *
 * The ring used to spin, for the same reason and with a smaller bill: an
 * infinite animation on a window this size keeps its surface being re-blended
 * sixty times a second for the whole break, on top of everything the user is
 * still doing underneath it. That is exactly the drag stutter that shows up
 * ONLY while the mask is on screen. A static partial ring says "running" for
 * free, and the countdown says the rest.
 */
const REST_CSS =
  '#mask{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;' +
  'justify-content:center;background-color:rgba(10,10,12,var(--ec-scrim));color:#fff;opacity:0;' +
  'transition:opacity var(--ec-fade) cubic-bezier(.4,0,.2,1);}' +
  '#mask.show{opacity:1;}' +
  '.content{display:flex;flex-direction:column;align-items:center;text-align:center;padding:0 24px;' +
  'opacity:var(--ec-text-active);transform:scale(.97);' +
  'transition:opacity var(--ec-fade) cubic-bezier(.4,0,.2,1),transform var(--ec-fade) cubic-bezier(.4,0,.2,1);}' +
  '.content.idle{opacity:1;transform:scale(1);}' +
  '.ring{width:68px;height:68px;border-radius:50%;margin-bottom:24px;box-sizing:border-box;' +
  'border:4px solid rgba(52,211,153,.22);border-top-color:#34d399;border-right-color:rgba(52,211,153,.65);}' +
  '.title{font-size:40px;font-weight:bold;letter-spacing:.05em;margin-bottom:12px;' +
  'text-shadow:0 4px 16px rgba(0,0,0,.6);}' +
  '.sub{font-size:19px;color:#a7f3d0;margin-bottom:30px;text-shadow:0 2px 8px rgba(0,0,0,.5);}' +
  '.count{font-family:monospace;font-size:72px;font-weight:900;letter-spacing:.1em;margin-bottom:20px;' +
  'text-shadow:0 4px 24px rgba(0,0,0,.7);}' +
  '#tip{font-size:15px;color:#facc15;letter-spacing:.04em;padding:6px 16px;border-radius:999px;' +
  'background:rgba(0,0,0,.45);border:1px solid rgba(250,204,21,.35);transition:all .3s ease;}' +
  '#tip.idle{color:#6ee7b7;border-color:rgba(110,231,183,.35);}';

const REST_HTML =
  '<div id="mask"><div class="content">' +
  '<div class="ring"></div>' +
  '<h1 class="title">👀 护眼休息时间</h1>' +
  '<p class="sub">请离开屏幕，眺望远方或活动身体</p>' +
  '<div id="count" class="count">00:00</div>' +
  '<div id="tip" class="idle">🌿 正在休息放松中... (保持键盘鼠标空闲)</div>' +
  '</div></div>';

/**
 * The full-screen break mask.
 *
 * It is click-through (`clickThrough` set by the main window), so every
 * `pointer-events` concern disappears — the user can keep working "through"
 * it. The countdown pauses while the user is active, and the whole text block
 * fades down to `restTextActiveOpacity`, which is what makes the mask a
 * reminder rather than a hostage situation.
 */
function mountRest(bridge) {
  windowShell(WIN_BASE + REST_CSS, REST_HTML);
  const mask = document.getElementById('mask');
  const content = mask.querySelector('.content');
  const count = document.getElementById('count');
  const tip = document.getElementById('tip');

  const apply = (s) => {
    if (s.theme) applyVars(document.documentElement, themeVars(s.theme, s.font));
    document.documentElement.style.setProperty('--ec-scrim', String(num(s.scrim, 0.86)));
    document.documentElement.style.setProperty('--ec-text-active', String(num(s.textActive, 0.05)));
    document.documentElement.style.setProperty('--ec-fade', num(s.fadeMs, 1000) + 'ms');
    if (typeof s.label === 'string') {
      const parts = s.label.split(': ');
      count.textContent = parts.length > 1 ? parts[1] : s.label;
    }
    const idle = !s.userActive;
    content.classList.toggle('idle', idle);
    tip.classList.toggle('idle', idle);
    tip.textContent = idle
      ? '🌿 正在休息放松中... (保持键盘鼠标空闲)'
      : s.idleOk
        ? '⚠️ 检测到鼠标/键盘输入，倒计时暂停中...'
        : '⏱️ 休息倒计时进行中';
  };

  // Deliberately NOT faded in here. The window is created hidden and is only
  // shown once it has reported in, so the fade has to be driven by the state:
  // `restShown` turns it on, `fade-rest` turns it off. Fading in at mount would
  // be spent while the window is still invisible — the mask would simply pop up
  // at full opacity the moment it is revealed.
  bridge.subscribe(TOPIC_CMD, (env) => {
    const p = env.p || {};
    if (p.act === 'fade-rest') mask.classList.remove('show');
  });

  bridge.subscribe(TOPIC_STATE, (env) => {
    const s = env.p || {};
    if (s.restShown) mask.classList.add('show');
    apply(s);
  });

  bridge.publish(TOPIC_CMD, { act: 'hello', from: bridge.label }).catch(() => {});
}

/* --------------------------- the rest controls ----------------------------- */

const CTL_CSS =
  'html,body{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding-right:8px;}' +
  // `nowrap` + `flex:0 0 auto`: these two labels are wider than the window they
  // used to be given (250 px for 244 px of button plus padding), so they wrapped
  // to two lines inside a 42 px window and the 999 px radius turned each one
  // into a squashed, clipped ellipse. The window is measured from the buttons
  // now, so they never have to shrink.
  '.b{padding:9px 18px;border-radius:999px;font-size:13px;font-weight:600;cursor:pointer;border:none;' +
  'white-space:nowrap;flex:0 0 auto;outline:none;box-shadow:0 4px 14px rgba(0,0,0,.45);' +
  'font-family:inherit;transition:all .2s ease;}' +
  '.b:active{transform:scale(.94);}' +
  '#skip{background-color:rgba(255,255,255,.22);color:#fff;border:1px solid rgba(255,255,255,.35);}' +
  '#skip:hover{background-color:rgba(255,255,255,.35);}' +
  '#ext{background-color:#059669;color:#fff;border:1px solid rgba(52,211,153,.5);}' +
  '#ext:hover{background-color:#10b981;}';

/** Skip / extend, in their own window: the mask itself is click-through. */
function mountRestCtl(bridge) {
  windowShell(
    WIN_BASE + CTL_CSS,
    '<button id="skip" class="b">⏭️ 跳过休息</button>' +
      '<button id="ext" class="b">⏱️ 延长 <span id="ext-n">5</span> 分钟</button>',
  );
  const extN = document.getElementById('ext-n');
  const send = (act) => {
    bridge.publish(TOPIC_CMD, { act, from: bridge.label }).catch(() => {});
  };
  document.getElementById('skip').addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    send('skip-rest');
  });
  document.getElementById('ext').addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    send('extend');
  });

  // Both axes: this window is nothing but its two buttons, so its content
  // decides its size outright. `body` is the flex row that holds them.
  const reportSize = sizeReporter(bridge, () => measure(document.body, { w: true, h: true }));

  bridge.subscribe(TOPIC_STATE, (env) => {
    const s = env.p || {};
    if (s.cfg) {
      const n = String(s.cfg.extendMinutes);
      if (extN.textContent !== n) {
        extN.textContent = n;
        reportSize(); // the label got wider or narrower
      }
    }
    if (s.theme) applyVars(document.documentElement, themeVars(s.theme, s.font));
  });

  reportSize();
  bridge.publish(TOPIC_CMD, { act: 'hello', from: bridge.label }).catch(() => {});
}

/* ════════════════════════════ 6. window entry ══════════════════════════════ */

/**
 * Called by the host's pluginwin page for EVERY window this plugin opens, so
 * the label is what decides which UI to build. The window is a separate
 * document: it renders itself, styles itself and talks to the main window over
 * the bus. It owns no state.
 */
export async function mountWindow(bridge) {
  const label = bridge.label || '';
  if (label === LABELS.pill) return mountPill(bridge);
  if (label === LABELS.lock) return mountLock(bridge);
  if (label === LABELS.menu) return mountMenu(bridge);
  if (label === LABELS.rest) return mountRest(bridge);
  if (label === LABELS.ctl) return mountRestCtl(bridge);
  document.body.innerHTML =
    '<div style="padding:12px;font-size:12px;">unknown window: ' + esc(label) + '</div>';
}

/* ════════════════════════════ 7. lifecycle ═════════════════════════════════ */

export async function activate(ctx) {
  S.ctx = ctx;
  S.cfg = normalizeConfig(await ctx.storage.get('config'));
  S.cfgRev = 1;
  readArea();
  // Record what the geometry above was built from, so the first tick does not
  // treat the initial state as a display change.
  S.screenSig = screenSig();

  // A display-scale change resizes the main window and fires this; a resolution
  // change does not, which is why the tick also polls the signature. This is
  // just the fast path.
  window.addEventListener('resize', () => {
    syncDisplay().catch(() => {});
  });

  ctx.registerView('eyecare', (root) => {
    S.view = {
      root,
      // Slider drags fire per pixel; only the last value is worth a disk write.
      debounce(key, value) {
        clearTimeout(S.view.timer);
        S.view.timer = setTimeout(() => saveConfig({ [key]: value }).catch(() => {}), 150);
      },
      timer: null,
    };
    renderPanel();
    paintView();
    ctx.cleanup(() => {
      S.view = null;
    });
  });

  // Commands from the plugin's own windows. The main window is the only
  // writer, so every state change funnels through here.
  const onCmd = (env) => {
    const p = env.p || {};
    if (p.from === 'main') return;
    handleCommand(p).catch((e) => ctx.log.error('command failed: ' + msg(e)));
  };
  await ctx.bus.subscribe(TOPIC_CMD, onCmd);
  // The drag hot path has its own topic — see TOPIC_DRAG. This window is its
  // only subscriber, which is the point.
  await ctx.bus.subscribe(TOPIC_DRAG, onCmd);

  await ctx.onHotkey('toggle-menu', () => {
    toggleMenu().catch(() => {});
  });

  // Close every window we own when the app is asked to quit, or the transparent
  // always-on-top windows would keep the process alive with no controller.
  await ctx.windows.onCloseRequested(async () => {
    await closeAll();
  });

  S.ready = true;
  setRemaining(S.mode === 'work' ? workSec() : restSec());
  S.tick = setInterval(() => {
    onTick().catch((e) => ctx.log.error('tick failed: ' + msg(e)));
  }, 1000);
  ctx.cleanup(() => clearInterval(S.tick));

  // Slow work goes AFTER the view is registered: bootPlugins awaits activate()
  // serially, so creating five webviews here would delay every later plugin.
  if (S.cfg.enabled && S.cfg.autoStart) {
    showRuntime().catch((e) => ctx.log.warn('runtime start failed: ' + msg(e)));
  }
  // Normally a no-op (a fresh session starts in `work`); it matters when a
  // rescan re-activates this module while a break was on screen.
  syncIdle();

  ctx.log.info('ready — theme=' + S.cfg.theme + ' work=' + S.cfg.workMinutes + 'm rest=' + S.cfg.restMinutes + 'm');
}

export async function deactivate(ctx) {
  S.ready = false;
  clearInterval(S.tick);
  S.tick = null;
  S.view = null;
  // Explicit, not left to the ctx disposer: a sidecar that is only released at
  // the end of the teardown keeps `idle.exe` alive for the whole of it.
  stopIdle();
  await closeAll();
  // The bus subscription and any stream the disposer still tracks are released
  // by the ctx disposer; only what this module created by hand is cleaned up
  // here.
  void ctx;
}

export default { manifest, activate, deactivate };
