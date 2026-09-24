/**
 * Entry for `pluginwin.html` — a plugin's OWN window.
 *
 * ## Why this is a separate page and not a branch in `main.js`
 *
 * The two windows are two different applications and they used to share one
 * entry, which meant sharing one stylesheet and one module graph. The graph was
 * already fixed (the shell is a dynamic import now), but the STYLESHEET could
 * not be: a page's `<link>` applies before any module runs, so no amount of
 * branching in JS could keep 122 KB of Tailwind utilities out of a plugin
 * window — and a plugin cannot use those utilities at all (it is a Blob-URL ESM
 * outside this project, so Tailwind never scans it).
 *
 * So each page links what it needs:
 *
 *   index.html      -> src/main.js      -> app.css     shell + utilities + sonner
 *   pluginwin.html  -> src/pluginwin.js -> plugin.css  tokens + `.tb-*` only
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
 */

import './assets/plugin.css';
import { initTheme } from './host/theme.js';
import { mountPluginWindow } from './host/pluginwin-host.js';

// Before anything renders: the theme is one attribute on <html>, and
// `pluginwin.html` sets it even earlier (inline, pre-paint) to avoid a flash.
initTheme();

mountPluginWindow();
