/**
 * Entry for `pluginwin.html` — a plugin's OWN window.
 *
 * ## Why this is a separate page and not a branch in `main.js`
 *
 * A page's `<link>` applies before any module runs, so the stylesheet a window
 * gets can only be decided HERE, at the page level — no amount of branching in
 * JS can add or remove it in time. That is the whole reason the two windows are
 * two pages, and it is what makes the rule below enforceable rather than
 * aspirational.
 *
 * ## A plugin window gets NO stylesheet, and that is deliberate
 *
 *   index.html      -> src/main.js      -> app.css   shell + tokens + `.tb-*` + utilities
 *   pluginwin.html  -> src/pluginwin.js -> (nothing)
 *
 * A plugin's window is a blank document: no reset, no tokens, no `.tb-*`, no
 * utilities. The window belongs to ONE plugin, so there is no shared vocabulary
 * to agree on and no host chrome to blend into — the plugin decides everything.
 *
 * The one CSS the host still contributes is the plugin's OWN
 * `contributes.theme`: a handful of custom properties, injected as
 * `[data-plugin='<id>']` (which matches `<html>` here, so the whole window
 * inherits them) and split by `data-theme`. That is not host styling — it is the
 * plugin's own declaration, and it is how a hand-written window gets a
 * light/dark palette without duplicating both by hand. Everything else is the
 * plugin's `<style>`.
 *
 * This replaced a `plugin.css` (theme + preflight + `.tb-*`, ~19 KB) that the
 * window used to link. Two things were wrong with it:
 *
 *   - Its preflight landed UNLAYERED, while the design system's rules are in
 *     `@layer base` / `@layer components`. Unlayered declarations outrank every
 *     layer, so the reset silently beat both the `.tb-*` vocabulary and the
 *     project's own default-border-colour fix. The window got LESS than the
 *     stylesheet promised.
 *   - Nothing in the repo needed it. Both shipped window examples
 *     (`tests/fixtures/calc-plugin`, `tests/fixtures/plugins/eyecare`) bring their own reset
 *     and palette, so the host was paying 19 KB per window to fight them.
 *
 * **The consequence to know when authoring a window**: there is no
 * `box-sizing: border-box`, no `body { margin: 0 }`, and no visible focus ring
 * unless you write them. `tests/window-options.test.mjs` enforces the host side
 * of this — the plugin-window host code must not rely on a class name at all.
 *
 * The URL a plugin passes is `pluginwin.html?plugin=<id>&label=<label>`; the
 * host validates that shape in `ctx.windows.create`, so a window can never end
 * up here without the parameters this needs.
 *
 * ## What is deliberately missing
 *
 * `initTheme()` is here and the plugin host is not. A plugin window is entitled
 * to the theme (it is one attribute on `<html>`, and a plugin's
 * `contributes.theme` overrides sit inside it), but a second plugin HOST would
 * double-register global shortcuts, re-activate every plugin, and run the
 * startup selftest again — see the note in `main.js` for what that cost.
 *
 * The theme script also sets `color-scheme`, which is the ONE style a window
 * keeps: it decides how the OS draws what CSS cannot reach (scrollbars, the
 * `<select>` popup, date pickers). Without it a dark-themed widget gets
 * light-coloured native widgets.
 */

import { initTheme } from './host/theme.js';
import { mountPluginWindow } from './host/pluginwin-host.js';

// Before anything renders: the theme is one attribute on <html>, and
// `pluginwin.html` sets it even earlier (inline, pre-paint) to avoid a flash.
initTheme();

mountPluginWindow();
