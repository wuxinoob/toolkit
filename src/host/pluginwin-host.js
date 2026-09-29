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
 *   - that page links NO stylesheet, and that is the project's decision, not an
 *     oversight: a plugin's window is a blank document. The host's own UI in
 *     here (the failure page below) is therefore styled inline, and everything a
 *     plugin renders is its own business. See the note in `src/pluginwin.js`.
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
 * ## Styles: the plugin owns this document
 *
 * Nothing is linked here — no reset, no tokens, no `.tb-*`, no utilities — so a
 * plugin window is a blank canvas and the plugin's own `<style>` is the only CSS
 * in the document. (The single exception is the plugin's own
 * `contributes.theme` below: the host injects the custom properties the plugin
 * declared, scoped to `[data-plugin='<id>']`, which matches `<html>` here.) And
 * because this is a separate `document`, that `<style>` **cannot reach the main
 * window**: a structural guarantee rather than a policy, which is why
 * self-styling needs no sandbox and no review.
 *
 * Three consequences worth stating out loud, because their absence is silent:
 *
 *   - **no `box-sizing: border-box`** — `width: 100%` plus padding overflows;
 *   - **no `body { margin: 0 }`** — the 8px browser margin is back;
 *   - **no focus ring** — `:focus-visible` has to be yours, or the window is
 *     unusable from the keyboard.
 *
 * `color-scheme` (set by the inline theme script, one property) is the single
 * exception, and it exists because it is the only way to make the OS-drawn parts
 * — scrollbars, the `<select>` popup, date pickers — follow the theme. No CSS
 * can reach those, so it is not part of "the host's stylesheet".
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
  /**
   * Styled INLINE, because a plugin window now ships no stylesheet at all —
   * there is no `.tb-card` to lean on, and this page has to be readable in a
   * window whose plugin never got the chance to render its own CSS.
   *
   * This is the host's own fault-reporting UI, so it must not depend on the
   * things the host gives to plugins. `color-scheme` is set by the inline theme
   * script, so the system colours below still follow the user's theme.
   */
  box.style.cssText = [
    'max-width:520px',
    'margin:48px auto',
    'padding:16px 18px',
    'line-height:1.6',
    'font-size:13px',
    'font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
    'color:canvastext',
    'background:canvas',
    'border:1px solid color-mix(in srgb, canvastext 25%, transparent)',
    'border-radius:10px',
  ].join(';');
  const heading = document.createElement('div');
  heading.style.cssText = 'font-weight:500;margin-bottom:8px;color:#c93a52';
  heading.textContent = `⚠ ${title}`;
  const body = document.createElement('div');
  body.style.cssText = 'word-break:break-all;opacity:.7';
  body.textContent = detail;
  // `appendChild`, not `append`: the headless test shims provide the former.
  box.appendChild(heading);
  box.appendChild(body);
  document.body.appendChild(box);
}

/**
 * Files dropped on THIS window, for the one plugin that owns it.
 *
 * ## Why there is no routing here
 *
 * The main window needs a router because ONE window holds many plugins' views:
 * boot.js watches the OS once and republishes on the window-local bus, tagging
 * the drop with the active view id, and `ctx.onDrop` accepts only its own views.
 * A plugin window is the opposite situation — the URL says `?plugin=<id>`, so
 * ownership is known before the drop happens and the routing layer simply does
 * not exist. Whoever receives the event IS the owner.
 *
 * That is also why this needs no permission, matching `ctx.onDrop`: you only
 * ever see drops the user aimed at your own window.
 *
 * ## Why the set is module-level
 *
 * One window is one realm with one bridge, so this is the same shape (and the
 * same justification) as the listener map in `host/events.js`. `dispose()`
 * clears it, which matters because a window that is torn down deliberately can
 * outlive its document.
 */
const dropHandlers = new Set();

/**
 * Deliver a dropped set of paths to every handler this window registered.
 *
 * Exported because it is the testable half: the OS subscription below needs a
 * real webview, but the delivery contract (paths + info, one bad handler must
 * not stop the others) can be driven under `node --test`.
 */
export function deliverWindowDrop(paths, info) {
  let delivered = 0;
  for (const fn of [...dropHandlers]) {
    try {
      fn(paths, info);
      delivered += 1;
    } catch (e) {
      // One plugin's bad handler is not the next one's problem.
      console.error('[pluginwin] onDrop handler failed', e);
    }
  }
  return delivered;
}

/**
 * Watch THIS window's own drag-and-drop, and hand `drop` to the bridge.
 *
 * `onDragDropEvent` is core (`@tauri-apps/api/webview`) and needs no
 * permission. Tauri has `dragDropEnabled` on by default, which is what
 * suppresses the browser's HTML5 `ondrop` — so a plugin window that wants drops
 * must use `bridge.onDrop`, exactly like a view must use `ctx.onDrop`.
 *
 * Every phase is logged except `over`, which fires continuously while the
 * pointer moves and would be a flood rather than a signal. This mirrors
 * `watchDrops` in boot.js: "the drop never arrived" and "the drop arrived and
 * nobody was listening" must not look the same in the log.
 *
 * NOT fatal: a window that cannot report drops is still a usable window, and on
 * a platform without the event this is the only symptom.
 */
async function watchWindowDrops(label) {
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event?.payload;
      const type = payload?.type ?? 'unknown';
      if (type !== 'over') console.info(`[pluginwin] file drop: ${type}`);
      if (type !== 'drop') return;
      deliverWindowDrop(payload.paths ?? [], { label });
    });
  } catch (e) {
    console.warn('[pluginwin] file drop watch unavailable:', e?.message ?? e);
  }
}

/**
 * Window-scoped SDK. Mirrors `ctx` exactly — same method names, same async
 * shapes, same permission rules — so `ctx.js` and this file stay two views of
 * one contract rather than two dialects.
 */
export function makeBridge(pluginId, label, manifest) {
  const prefix = `[plugin:${pluginId}]`;
  const perms = manifest?.permissions ?? [];
  const has = (perm) => perms.includes(perm);
  const gate = (svc, fn) =>
    has(`rpc:${svc}`) ? fn() : Promise.reject(new Error(`${prefix} missing permission "rpc:${svc}"`));

  const disposer = [];
  const track = (off) => {
    disposer.push(off);
    return off;
  };

  /**
   * Streams this window opened.
   *
   * Same bookkeeping as `ctx`, and for the same two reasons:
   *
   *   - `closeStream(ch)` must be able to say "not mine" without asking the host.
   *     Closing is deliberately ungated (it is strictly weaker than opening), so
   *     the local set is what keeps it honest.
   *   - `dispose()` has to release them. This window owns a real host-side
   *     session for every `pty` / `sidecar` / `stream` it opened, and this window
   *     is the only thing that will ever close them — the plugin's JS context is
   *     gone the moment the window goes. Without this, closing a plugin window
   *     left its helper PROCESSES running until the next app start.
   */
  const openStreams = new Set();
  const trackStream = (handle) => {
    openStreams.add(handle.ch);
    return handle;
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

    /**
     * Window-local logging. `console.*` in this window, with the plugin's id
     * prefixed — the same shape as `ctx.log`.
     *
     * It does NOT reach `debug.log`: only the host's own logger writes that file.
     * A plugin whose failure is only visible here is a plugin the user cannot
     * debug, so surface anything that matters in the UI as well.
     */
    log: {
      info: (...a) => console.info(prefix, ...a),
      warn: (...a) => console.warn(prefix, ...a),
      error: (...a) => console.error(prefix, ...a),
    },

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
        gate('stream', async () => {
          const h = await hub.stream(pluginId, 'channel-json', {
            provider: 'clipboard',
            ch,
            ...handlers,
          });
          track(() => hub.close(pluginId, ch));
          return trackStream(h);
        }),
    },

    screen: {
      monitors: () => gate('screen', () => hub.request(pluginId, 'screen', 'monitors', {})),
      capture: (opts = {}) => gate('screen', () => hub.request(pluginId, 'screen', 'capture', opts)),
    },

    /**
     * Native dialogs, opened by the HOST on your behalf — same shape and the
     * same `rpc:dialog` permission as `ctx.files`.
     *
     * A raw command, not a gateway action: the gateway is synchronous and would
     * deadlock waiting on a modal. See `plugin_dialog` in `lib.rs`.
     *
     * **What you get back is a path the USER picked**, in a dialog they could see
     * and cancel. That is the grant — there is no `bridge.fs`.
     */
    files: {
      /** Pick file(s). Resolves `[]` when the user cancels — not an error. */
      pick: (options = {}) =>
        gate('dialog', () =>
          invoke('plugin_dialog', {
            pluginId,
            action: 'open',
            params: {
              title: options.title ?? null,
              multiple: !!options.multiple,
              folder: !!options.folder,
              directory: options.directory ?? null,
              filters: options.filters ?? null,
            },
          }),
        ).then((r) => r?.paths ?? []),

      /** Ask where to save. Resolves `null` when the user cancels. */
      save: (options = {}) =>
        gate('dialog', () =>
          invoke('plugin_dialog', {
            pluginId,
            action: 'save',
            params: {
              title: options.title ?? null,
              defaultPath: options.defaultPath ?? null,
            },
          }),
        ).then((r) => r?.path ?? null),

      /** A native message box. */
      message: (message, options = {}) =>
        gate('dialog', () =>
          invoke('plugin_dialog', {
            pluginId,
            action: 'message',
            params: { message, title: options.title ?? null },
          }),
        ),
    },

    /** Hotkeys are registered by the host at activate; this only listens. */
    onHotkey: (action, fn) =>
      subscribeWith('event-bus', `hotkey:${action}`, (env) => {
        if (env.svc && env.svc !== pluginId) return;
        fn(env);
      }),

    /**
     * Files dropped on THIS window. `fn(paths, info)` with `info = { label }`.
     *
     * Same shape as `ctx.onDrop` — including the returned Promise of a cancel
     * function — with one difference in the second argument: a view gets
     * `{ viewId }` (which view the user aimed at) and a window gets
     * `{ label }` (there is only one possible target, so there is nothing to
     * route and nothing to disambiguate).
     *
     * **No permission**, for the same reason as `ctx.onDrop`: a drop lands on
     * the window the user aimed at, so a plugin can only ever see its own.
     *
     * **Do not write an HTML5 `ondrop` instead** — Tauri's `dragDropEnabled`
     * is on by default and silently suppresses the browser's drag events, which
     * looks like "nothing happened" with no error.
     */
    onDrop: (fn) => {
      if (typeof fn !== 'function') {
        return Promise.reject(new Error(`${prefix} onDrop(fn): fn must be a function`));
      }
      dropHandlers.add(fn);
      return Promise.resolve(() => dropHandlers.delete(fn));
    },

    // Every stream creator registers the handle for teardown, exactly like
    // `ctx` does. The close is fire-and-forget because `dispose()` runs on
    // `beforeunload`, where nothing can be awaited — but it IS issued, which is
    // what stops a plugin window from leaving a helper process behind.
    stream: (provider, ch, handlers = {}) =>
      gate('stream', async () => {
        const h = await hub.stream(pluginId, 'channel-json', { provider, ch, ...handlers });
        track(() => hub.close(pluginId, ch));
        return trackStream(h);
      }),
    streamRaw: (provider, ch, handlers = {}) =>
      gate('stream', async () => {
        const h = await hub.stream(pluginId, 'channel-raw', { provider, ch, ...handlers });
        track(() => hub.close(pluginId, ch));
        return trackStream(h);
      }),
    sidecar: (ch, opts) =>
      gate('proc', async () => {
        const h = await hub.sidecar(pluginId, ch, opts);
        track(() => hub.close(pluginId, ch));
        return trackStream(h);
      }),
    /** Uplink: push frames to a host-side sink (same shape as ctx.uplink). */
    uplink: (ch, opts = {}) =>
      gate('stream', async () => {
        const h = await hub.uplink(pluginId, ch, { sink: opts.sink, params: opts.params });
        track(() => hub.close(pluginId, ch));
        return trackStream(h);
      }),
    pty: (ch, opts) =>
      gate('stream', async () => {
        const h = await hub.pty(pluginId, ch, opts);
        track(() => hub.close(pluginId, ch));
        return trackStream(h);
      }),

    /**
     * Close a stream this window opened.
     *
     * Deliberately ungated, like `ctx.closeStream`: opening it already required
     * the capability, and this can only touch streams this window registered.
     * Closing is strictly weaker than opening, so a gate here would only make
     * the permission model harder to reason about.
     */
    closeStream: (ch) => {
      if (!openStreams.has(ch)) return Promise.resolve(false);
      openStreams.delete(ch);
      return hub.close(pluginId, ch);
    },

    sessions: () => gate('host', () => hub.sessions(pluginId)),
    schemes: () => hub.schemes(),
    schema: () => gate('host', () => hub.schema(pluginId)),

    close: () => getCurrentWindow().close(),
    drag: () => getCurrentWindow().startDragging(),
    cleanup: (fn) => track(fn),
    /**
     * Release everything this window acquired.
     *
     * Returns a promise (it did not before) so a caller that CAN wait — a test,
     * or a plugin that closes itself deliberately — can. `beforeunload` ignores
     * the result, which is why the stream closes above are fire-and-forget.
     */
    dispose: () => {
      // Drops first: it is the one input that is not a `hub` subscription, so
      // nothing else in this teardown would release it.
      dropHandlers.clear();
      // `[...disposer]`, not `disposer`: `reverse()` returns the SAME array, so
      // clearing `disposer.length` below would empty the list we are about to
      // run and turn this whole method into a no-op. (It did exactly that until
      // a test noticed nothing was being released.)
      const fns = [...disposer].reverse();
      disposer.length = 0;
      const results = fns.map((off) => {
        try {
          return off?.();
        } catch {
          return undefined; // already gone
        }
      });
      return Promise.allSettled(results);
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

    // This window watches its OWN drag-and-drop. Not awaited into the failure
    // path: a window that cannot report drops is still a usable window.
    await watchWindowDrops(label);

    await mod.mountWindow(bridge);
  } catch (e) {
    console.error('[pluginwin] load failed', e);
    renderError('插件窗口加载失败', String(e?.message || e));
  }
}
