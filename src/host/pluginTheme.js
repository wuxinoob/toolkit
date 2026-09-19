/**
 * Plugin-declared token overrides — the "this plugin is purple" extension point.
 *
 * A plugin may describe how it wants the design tokens to look *inside itself*:
 *
 *     "contributes": {
 *       "theme": {
 *         "dark":  { "--color-brand": "#c49bff" },
 *         "light": { "--color-brand": "#7a3fd1" }
 *       }
 *     }
 *
 * The host turns that into one scoped rule per theme:
 *
 *     :root[data-theme='dark'] [data-plugin='x'] { --color-brand: #c49bff; }
 *
 * Four properties make this worth having rather than just letting a plugin ship
 * its own CSS (which is Level 3 in docs/UI.md, and a footgun):
 *
 * 1. **Scoped.** The rule targets the plugin's own container, so a plugin cannot
 *    restyle the shell, another plugin, or the settings page. Over-declaring is
 *    not a way to break out.
 * 2. **No JS at runtime.** Both themes are emitted up front and the theme
 *    attribute picks between them — exactly how the app's own tokens work. No
 *    re-injection when the theme changes, nothing to keep in sync.
 * 3. **It composes.** The plugin only sets the tokens it cares about; everything
 *    else keeps inheriting, so a plugin that overrides one colour still follows
 *    the app for the rest.
 * 4. **Validated, not sanitised.** Values are accepted only if they cannot
 *    escape a CSS declaration (see `validValue`). A plugin supplies a *colour*,
 *    never CSS.
 */

/** The attribute that scopes a contribution to one plugin's subtree. */
export const PLUGIN_ATTR = 'data-plugin';

const STYLE_ID = 'tb-plugin-themes';
const MAX_TOKENS = 64;
const MAX_NAME_LEN = 48;
const MAX_VALUE_LEN = 120;

/** A custom property name, spelled in full (`--color-brand`). */
const NAME_RE = /^--[a-z][a-z0-9-]*$/;

/**
 * Characters a colour value may use. Deliberately excludes `;`, `{`, `}`, `<`,
 * `>`, `\` and `@`.
 *
 * This is the whole security story: a CSS declaration ends at `;` or `}`, and a
 * `<style>` element ends at `<`. Without those characters there is no way to
 * terminate the declaration and start writing rules of your own, so the value
 * can only ever be a value. Everything else (hex, `rgb()`, `oklch()`,
 * `color-mix()`, `var()`) is then fine to allow.
 */
const VALUE_RE = /^[#a-zA-Z0-9 ,.%/()-]+$/;

/**
 * Functions a *colour* has no business calling, even though their syntax would
 * pass the character check above.
 *
 * `url()` is the one that matters: it turns a colour token into a request to an
 * arbitrary host, which is a tracking beacon with extra steps, and it is not
 * something a theme needs. The others are legacy script/load vectors.
 */
const FORBIDDEN_FN = /\b(?:url|image-set|element|expression|-moz-binding)\s*\(/i;

function balancedParens(s) {
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** @returns {string|null} the value if it is a safe CSS value, else null. */
function validValue(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.length > MAX_VALUE_LEN) return null;
  if (!VALUE_RE.test(v)) return null;
  if (FORBIDDEN_FN.test(v)) return null;
  if (!balancedParens(v)) return null;
  return v;
}

/** @returns {string|null} the name if it is a safe custom property name. */
function validName(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.trim();
  if (!n || n.length > MAX_NAME_LEN) return null;
  return NAME_RE.test(n) ? n : null;
}

/**
 * Normalise a `contributes.theme` block.
 *
 * Returns `{ dark, light, rejected }` where `rejected` lists what was dropped
 * and why — surfaced in the boot log rather than swallowed, because a typo'd
 * token name would otherwise be invisible (the plugin just looks normal).
 *
 * @returns {{dark: Record<string,string>|null, light: Record<string,string>|null, rejected: string[]}}
 */
export function normalizeThemeContribution(raw) {
  const rejected = [];
  if (raw == null) return { dark: null, light: null, rejected };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    rejected.push('contributes.theme must be an object');
    return { dark: null, light: null, rejected };
  }

  const out = { dark: null, light: null, rejected };
  for (const theme of ['dark', 'light']) {
    const block = raw[theme];
    if (block == null) continue;
    if (typeof block !== 'object' || Array.isArray(block)) {
      rejected.push(`theme.${theme} must be an object`);
      continue;
    }
    const decls = {};
    let n = 0;
    for (const [name, value] of Object.entries(block)) {
      if (n >= MAX_TOKENS) {
        rejected.push(`theme.${theme}: more than ${MAX_TOKENS} tokens, the rest ignored`);
        break;
      }
      const okName = validName(name);
      if (!okName) {
        rejected.push(`theme.${theme}: "${name}" is not a valid token name (want --color-…)`);
        continue;
      }
      const okValue = validValue(value);
      if (!okValue) {
        rejected.push(`theme.${theme}: ${okName} = ${JSON.stringify(value)} is not a usable value`);
        continue;
      }
      decls[okName] = okValue;
      n += 1;
    }
    if (Object.keys(decls).length) out[theme] = decls;
  }
  return out;
}

/** pluginId -> { dark?, light? }. Rebuilt into one stylesheet on every change. */
const registry = new Map();

function styleEl() {
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    // Plugins load and unload at runtime, so this sheet is never part of the
    // bundle; a stable id keeps it findable and keeps it out of the way.
    document.head.appendChild(el);
  }
  return el;
}

/**
 * Serialise contributions to CSS. Both themes are emitted for every plugin, so
 * the `data-theme` attribute alone selects the right one — no listener, no
 * rebuild when the theme changes.
 *
 * Exported so tooling (the theme preview) renders from the SAME code the app
 * runs, instead of a re-implementation that can drift.
 *
 * @param {Iterable<[string, {dark?: object, light?: object}]>} entries
 */
export function serializeThemeCss(entries) {
  const rules = [];
  for (const [pluginId, contrib] of entries) {
    // pluginId is validated by the native side (`validate_plugin_id`), but strip
    // quotes anyway: this string is interpolated into a CSS selector.
    const id = String(pluginId).replace(/['"\\]/g, '');
    for (const theme of ['dark', 'light']) {
      const decls = contrib[theme];
      if (!decls) continue;
      const body = Object.entries(decls)
        .map(([name, value]) => `${name}:${value}`)
        .join(';');
      // `[data-plugin='x']` also matches <html>, which is how a plugin window
      // (a whole document belonging to one plugin) gets its overrides.
      rules.push(`:root[data-theme='${theme}'] [${PLUGIN_ATTR}='${id}']{${body}}`);
    }
  }
  return rules.join('\n');
}

function flush() {
  if (typeof document === 'undefined') return;
  styleEl().textContent = serializeThemeCss(registry);
}

/**
 * Register (or replace) a plugin's overrides.
 * @returns {{applied: number, rejected: string[]}}
 */
export function applyPluginTheme(pluginId, rawContribution) {
  const { dark, light, rejected } = normalizeThemeContribution(rawContribution);
  const applied = (dark ? Object.keys(dark).length : 0) + (light ? Object.keys(light).length : 0);
  if (!applied) {
    registry.delete(pluginId);
    flush();
    return { applied: 0, rejected };
  }
  registry.set(pluginId, { dark, light });
  flush();
  return { applied, rejected };
}

/** Drop a plugin's overrides (deactivate, uninstall, reload). */
export function clearPluginTheme(pluginId) {
  if (!registry.delete(pluginId)) return false;
  flush();
  return true;
}

/** Diagnostics: what is currently overriding what. */
export function listPluginThemes() {
  return [...registry.entries()].map(([pluginId, c]) => ({
    pluginId,
    dark: c.dark ? Object.keys(c.dark) : [],
    light: c.light ? Object.keys(c.light) : [],
  }));
}
