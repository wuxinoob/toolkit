/**
 * Generic plugin-window host page — runs inside a `plugin-*` WebviewWindow,
 * NOT in the main window. `src/main.js` routes here when the URL carries
 * `?mode=pluginwin&plugin=<id>&label=<label>`, so this window skips the plugin
 * host entirely (a second host would double-register shortcuts and selftests).
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
 */

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { hub } from '../protocol/hub.js';
import { protocolContract } from '../protocol/contract.js';

function renderError(title, detail) {
  document.title = title;
  document.body.style.cssText =
    "margin:0;background:#14161c;color:#e8ebf0;font-family:system-ui,'Microsoft YaHei',sans-serif;";
  const box = document.createElement('div');
  box.style.cssText =
    'max-width:520px;margin:48px auto;padding:18px 20px;border:1px solid #3a2a2a;' +
    'border-radius:10px;background:#1d1420;line-height:1.6;font-size:13px;';
  box.innerHTML = `<div style="color:#ff9a9a;font-weight:500;margin-bottom:8px;"></div>
    <div style="opacity:.8;word-break:break-all;"></div>`;
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

    // Resolve the plugin (manifest + dir + entry) through the Rust scanner.
    const list = await invoke('plugin_scan');
    const item = list.find((p) => p.id === pluginId);
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
    window.addEventListener('beforeunload', () => {
      // Let the plugin release its streams/subscriptions on the way out.
      try {
        window.__pluginBridge?.dispose?.();
      } catch {
        /* window is going away regardless */
      }
    });
    const bridge = makeBridge(pluginId, label, item.manifest);
    window.__pluginBridge = bridge;
    await mod.mountWindow(bridge);
  } catch (e) {
    console.error('[pluginwin] load failed', e);
    renderError('插件窗口加载失败', String(e?.message || e));
  }
}
