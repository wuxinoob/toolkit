/**
 * Generic plugin-window host page — runs inside a `plugin-*` WebviewWindow,
 * NOT in the main window.
 *
 * It is loaded by `pluginwin.html` → `src/pluginwin.js`, which is a PAGE of its
 * own rather than a mode of the shell's page. That matters twice over:
 *
 *   - the shell never boots here. This window does not load `src/main.js` at all,
 *     so a second plugin host (double-registered shortcuts, every plugin
 *     activated twice, a second selftest) is not something a URL can cause.
 *   - the plugin stylesheet is linked by that page, not the shell's. This window
 *     gets the tokens and the `.tb-*` vocabulary and nothing else — see
 *     `src/assets/plugin.css` for why that is the right set.
 *
 * The window Blob-imports the plugin's entry module (single-file ESM, the same
 * constraint as the main-window loader) and calls its `mountWindow(bridge)`
 * export. The bridge is a window-scoped SDK built on the SAME protocol hub and
 * the SAME contract as `ctx`, so plugin code ports between the two contexts:
 *
 *   bridge.request(...)   control calls           (rpc)
 *   bridge.subscribe/...  cross-window events     (event-bus)
 *   bridge.events.*       window-local events     (in-process)
 *   bridge.sidecar/pty/stream(...)                (stdio-line / pty-stream / channel)
 *
 * A fatal load error renders inline (no host chrome exists in this window).
 *
 * ## Styles: this window belongs to the plugin
 *
 * The plugin stylesheet is loaded here like in any window, so the design tokens
 * and `.tb-*` classes work and a plugin can look native for free. But a plugin
 * that wants its own look just injects a `<style>` and wins — unlayered CSS
 * beats anything in `@layer`, and this is a separate `document`, so it **cannot
 * reach the main window**. That is a structural guarantee rather than a policy,
 * which is why self-styling needs no sandbox and no review.
 *
 * ⚠️ **This window has no Tailwind utilities.** `flex`, `gap-2`, `text-sm` and
 * friends produce no CSS here — Tailwind never scans a plugin's source, and the
 * page does not link the utilities layer. Use `.tb-*` (see `docs/UI.md`) or
 * inline styles. A utility class fails SILENTLY: the element is simply unstyled,
 * and `tests/plugin-window-css.test.mjs` fails the build rather than let that
 * reach a plugin author.
 *
 * See `docs/UI.md` → "Where each half of the app gets its styles", and
 * `examples/calc-plugin` for a window that takes this path.
 */

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { hub } from '../protocol/hub.js';
import { protocolContract } from '../protocol/contract.js';
import { PLUGIN_ATTR, applyPluginTheme } from './pluginTheme.js';

function renderError(title, detail) {
  document.title = title;
  const box = document.createElement('div');
  // Design-system classes and tokens, so the failure page follows the theme like
  // everything else. main.js imports the stylesheet before it branches on
  // ?mode=, so it is present even on this path.
  box.className = 'tb-card tb-card-body';
  box.style.cssText = 'max-width:520px;margin:48px auto;line-height:1.6;font-size:13px;';
  box.innerHTML = `<div class="tb-t-bad" style="font-weight:500;margin-bottom:8px;"></div>
    <div class="tb-hint" style="word-break:break-all;"></div>`;
  box.firstElementChild.textContent = `⚠ ${title}`;
  box.lastElementChild.textContent = detail;
  document.body.appendChild(box);
}

/**
 * Window-scoped SDK. Mirrors `ctx` exactly — same method names, same async
 * shapes, same permission rules — so `ctx.js` and this file stay two views of
 * one contract rather than two dialects.
 */
function makeBridge(pluginId, label, manifest) {
  const perms = manifest?.permissions ?? [];
  const has = (perm) => perms.includes(perm);
  const gate = (svc, fn) =>
    has(`rpc:${svc}`)
      ? fn()
      : Promise.reject(new Error(`[plugin:${pluginId}] missing permission "rpc:${svc}"`));

  const disposer = [];
  const track = (off) => {
    disposer.push(off);
    return off;
  };

  const subscribeWith = (scheme, topic, fn) => {
    const p = hub.subscribe(pluginId, topic, fn, { scheme });
    p.then(track).catch(() => {});
    return p;
  };
  const publishWith = (scheme, topic, payload) => hub.publish(pluginId, topic, payload, { scheme });

  return {
    pluginId,
    label,
    manifest,

    /** The same wire contract `ctx.protocol` exposes. */
    protocol: protocolContract(),

    request: (svc, act, params = null, opts = {}) =>
      gate(svc, () => hub.request(pluginId, svc, act, params, opts)),

    storage: {
      get: (key) => gate('storage', () => hub.request(pluginId, 'storage', 'get', { key })),
      set: (key, value) => gate('storage', () => hub.request(pluginId, 'storage', 'set', { key, value })),
      remove: (key) => gate('storage', () => hub.request(pluginId, 'storage', 'remove', { key })),
      keys: () => gate('storage', () => hub.request(pluginId, 'storage', 'keys', {})),
    },

    // same three shapes as ctx: subscribe / once / publish
    subscribe: (topic, fn, { scheme = 'event-bus' } = {}) => subscribeWith(scheme, topic, fn),
    once: (topic, fn, { scheme = 'event-bus' } = {}) => hub.once(pluginId, topic, fn, { scheme }).then(track),
    publish: (topic, payload = null, { scheme = 'event-bus' } = {}) =>
      scheme === 'event-bus'
        ? gate('bus', () => publishWith('event-bus', topic, payload))
        : publishWith(scheme, topic, payload),

    events: {
      on: (topic, fn) => subscribeWith('in-process', topic, fn),
      once: (topic, fn) => hub.once(pluginId, topic, fn, { scheme: 'in-process' }).then(track),
      emit: (topic, payload = null) => publishWith('in-process', topic, payload),
    },

    bus: {
      subscribe: (topic, fn) => subscribeWith('event-bus', topic, fn),
      once: (topic, fn) => hub.once(pluginId, topic, fn, { scheme: 'event-bus' }).then(track),
      publish: (topic, payload = null) => gate('bus', () => publishWith('event-bus', topic, payload)),
    },

    /**
     * The host's sensing surface — the same shapes and the same permissions as
     * `ctx.clipboard` / `ctx.screen`.
     *
     * These reached the main window first, which made "read the clipboard" a
     * capability that quietly depended on WHERE a plugin put its UI: the same
     * code worked in a view and failed with `undefined is not a function` in the
     * plugin's own window. A window-scoped plugin hits the same gateway and the
     * same registry, so there is nothing to decide here — only to mirror.
     */
    clipboard: {
      read: () => gate('clipboard', () => hub.request(pluginId, 'clipboard', 'read', {})),
      write: (text) => gate('clipboard', () => hub.request(pluginId, 'clipboard', 'write', { text })),
      // `watch` is a stream, so it needs `rpc:stream`; the `clipboard` provider
      // then adds `rpc:clipboard` of its own, natively. Declare both.
      watch: (ch, handlers = {}) =>
        gate('stream', () =>
          hub.stream(pluginId, 'channel-json', { provider: 'clipboard', ch, ...handlers }),
        ),
    },

    screen: {
      monitors: () => gate('screen', () => hub.request(pluginId, 'screen', 'monitors', {})),
      capture: (opts = {}) => gate('screen', () => hub.request(pluginId, 'screen', 'capture', opts)),
    },

    /** Hotkeys are registered by the host at activate; this only listens. */
    onHotkey: (action, fn) =>
      subscribeWith('event-bus', `hotkey:${action}`, (env) => {
        if (env.svc && env.svc !== pluginId) return;
        fn(env);
      }),

    stream: (provider, ch, handlers = {}) =>
      gate('stream', () => hub.stream(pluginId, 'channel-json', { provider, ch, ...handlers })),
    streamRaw: (provider, ch, handlers = {}) =>
      gate('stream', () => hub.stream(pluginId, 'channel-raw', { provider, ch, ...handlers })),
    sidecar: (ch, opts) => gate('proc', () => hub.sidecar(pluginId, ch, opts)),
    /** Uplink: push frames to a host-side sink (same shape as ctx.uplink). */
    uplink: (ch, opts = {}) =>
      gate('stream', () => hub.uplink(pluginId, ch, { sink: opts.sink, params: opts.params })),
    pty: (ch, opts) => gate('stream', () => hub.pty(pluginId, ch, opts)),

    sessions: () => gate('host', () => hub.sessions(pluginId)),
    schemes: () => hub.schemes(),
    schema: () => gate('host', () => hub.schema(pluginId)),

    close: () => getCurrentWindow().close(),
    drag: () => getCurrentWindow().startDragging(),
    cleanup: (fn) => track(fn),
    dispose: () => {
      for (const off of disposer.reverse()) {
        try {
          off?.();
        } catch {
          /* already gone */
        }
      }
      disposer.length = 0;
    },
  };
}

export async function mountPluginWindow() {
  const q = new URLSearchParams(window.location.search);
  const pluginId = q.get('plugin');
  const label = q.get('label') || `plugin-${pluginId}`;
  try {
    if (!pluginId) throw new Error('missing ?plugin=<id> in the window URL');

    // Resolve ONE plugin's location.
    //
    // This used to call `plugin_scan` and `.find()` the one it wanted, which made
    // opening a window read every manifest AND every entry file in the plugins
    // directory — ~900 KB of I/O on this repo, to learn a `dir` and an
    // `entry_file` the main window already knew at boot. `plugin_info` reads
    // manifests only and stops at the match.
    const item = await invoke('plugin_info', { id: pluginId });
    if (!item) {
      throw new Error(`plugin "${pluginId}" not found in the plugins root — reinstall it or click Rescan`);
    }

    // Load the entry exactly like the main-window external loader does.
    const code = await invoke('plugin_read_entry', {
      dir: item.dir,
      entryFile: item.entry_file,
    });
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const mod = await import(/* @vite-ignore */ url);
    if (typeof mod.mountWindow !== 'function') {
      throw new Error('plugin entry must export mountWindow(bridge) to open a window');
    }

    if (item.manifest?.name) document.title = item.manifest.name;

    // This whole document belongs to one plugin, so the theme scope goes on
    // <html> — the rule `[data-plugin='x']` matches any element, root included.
    // Applied before mountWindow so the first paint is already themed.
    document.documentElement.setAttribute(PLUGIN_ATTR, pluginId);
    const { applied, rejected } = applyPluginTheme(pluginId, item.manifest?.contributes?.theme);
    if (applied) console.info(`[pluginwin] ${applied} theme token override(s) applied`);
    for (const why of rejected) console.warn(`[pluginwin] theme ignored — ${why}`);

    window.addEventListener('beforeunload', () => {
      // Let the plugin release its streams/subscriptions on the way out.
      try {
        window.__pluginBridge?.dispose?.();
      } catch {
        /* window is going away regardless */
      }
    });
    // This page has no `<div id="app">` — that node belongs to `index.html` (the
    // main window), where `app.css` gives it `height: 100%`. It used to be here
    // too, because both windows shared one page, and the leftover occupied the
    // full viewport: a plugin appending its own container to `document.body`
    // landed BELOW the fold and the window looked blank (the DOM was all there,
    // just off-screen). Reported by a plugin author who spent hours on it.
    //
    // Now that the two windows are two pages, the node is simply absent and the
    // pitfall cannot recur. Kept as a no-op so a future edit that adds the node
    // back does not silently reintroduce it.
    document.getElementById('app')?.remove();

    const bridge = makeBridge(pluginId, label, item.manifest);
    window.__pluginBridge = bridge;
    await mod.mountWindow(bridge);
  } catch (e) {
    console.error('[pluginwin] load failed', e);
    renderError('插件窗口加载失败', String(e?.message || e));
  }
}
