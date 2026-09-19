/**
 * Theme: which colour tokens are in force, and who decides.
 *
 * The whole look is driven by the `@theme` tokens in `assets/app.css`. A theme
 * is therefore not a stylesheet swap — it is one attribute on `<html>`, and CSS
 * does the rest:
 *
 *     :root[data-theme='light'] { --color-canvas: #f4f6fa; … }
 *
 * That is deliberate. External plugins are Blob-URL single-file ESM and cannot
 * import anything, so they cannot be handed a different stylesheet at runtime.
 * They *can* inherit CSS custom properties, which means a plugin written against
 * the tokens (`var(--color-surface)`, `.tb-card`, …) is themed for free — no
 * plugin code, no reload, nothing to opt into.
 *
 * The preference is one of 'system' | 'light' | 'dark'. 'system' follows
 * `prefers-color-scheme` live, so changing the OS theme changes the app.
 *
 * Persistence is localStorage, matching `store.settings`. This is NOT the
 * cross-window sync the project forbids via storage polling: the `storage`
 * event is pushed by the browser when another document writes the key, and the
 * read happens once at boot. Nothing polls.
 */

/** Kept in sync with the inline no-flash script in index.html. */
export const THEME_KEY = 'toolbox.theme';

/** @typedef {'system'|'light'|'dark'} ThemePref */

const VALID = new Set(['system', 'light', 'dark']);
const listeners = new Set();

/** The OS preference. Older webviews may not implement matchMedia. */
const lightQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null;

/** @type {ThemePref} */
let pref = readPref();

/** @type {'light'|'dark'} */
let resolved = resolve(pref);

function readPref() {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return VALID.has(raw) ? /** @type {ThemePref} */ (raw) : 'system';
  } catch {
    // A locked-down or partitioned profile must not break the app over a colour.
    return 'system';
  }
}

/** Turn a preference into the theme actually in force. */
function resolve(p) {
  if (p === 'light' || p === 'dark') return p;
  return lightQuery?.matches ? 'light' : 'dark';
}

function emit() {
  for (const fn of listeners) {
    try {
      fn(pref, resolved);
    } catch (err) {
      console.error('[theme] listener failed', err);
    }
  }
}

function paint() {
  if (typeof document === 'undefined') return;
  // Set on <html>, not <body>: the attribute has to exist before the first
  // paint of every window, including the plugin windows.
  document.documentElement.dataset.theme = resolved;
  // Native widgets (scrollbars, <select> popups, form control defaults) follow
  // this, and it is the one part of theming CSS cannot reach.
  document.documentElement.style.colorScheme = resolved;
}

/**
 * Apply the stored preference. Called once per window, before the app mounts.
 * Safe to call more than once.
 */
export function initTheme() {
  pref = readPref();
  resolved = resolve(pref);
  paint();

  // Follow the OS while the preference is 'system'.
  lightQuery?.addEventListener?.('change', () => {
    if (pref !== 'system') return;
    resolved = resolve(pref);
    paint();
    emit();
  });

  // Another window changed it. Pushed, not polled.
  window.addEventListener('storage', (ev) => {
    if (ev.key !== THEME_KEY) return;
    pref = readPref();
    resolved = resolve(pref);
    paint();
    emit();
  });

  return resolved;
}

/** @returns {ThemePref} */
export function getThemePref() {
  return pref;
}

/** @returns {'light'|'dark'} */
export function getResolvedTheme() {
  return resolved;
}

/**
 * Choose a theme. Persists, repaints, and lets the other windows know.
 * @param {ThemePref} next
 */
export function setTheme(next) {
  if (!VALID.has(next)) throw new Error(`unknown theme preference: ${next}`);
  pref = next;
  resolved = resolve(pref);
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // Non-fatal: the theme still applies to this window for this session.
  }
  paint();
  emit();
  return resolved;
}

/**
 * Subscribe to changes. Fires on an explicit change, on an OS change while
 * following the system, and when another window changes it.
 * @param {(pref: ThemePref, resolved: 'light'|'dark') => void} fn
 */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
