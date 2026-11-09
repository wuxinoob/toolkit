import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';

import { Capability, assertSupports } from '../protocol/registry.js';
import { createPluginSdk } from './plugin-sdk.js';
import { store, toast, sortViewList, closeToTray } from './store.js';
import { DROP_TOPIC } from './events.js';
import { PLUGIN_ATTR } from './pluginTheme.js';
import { createUiKit } from './ui.js';

/**
 * Build the Host SDK object ("ctx") handed to each plugin on activate.
 *
 * Everything a plugin can do flows through ctx — no plugin imports a Tauri
 * API, and no plugin chooses a wire format. Each capability is expressed as a
 * DECLARATION ("I need a control call / a pushed stream / a broadcast") and the
 * hub resolves the scheme from the transport registry.
 *
 * Two gates apply to every native path, and both must pass:
 *   1. this JS gate, which fails fast with a readable message
 *   2. the Rust permission registry, which is authoritative and cannot be
 *      bypassed by calling invoke() directly
 *
 * API shape rule: **the scheme never changes the shape of a call.** `subscribe`
 * and `publish` are async on every scheme (even the synchronous in-process one),
 * and `ctx.events` / `ctx.bus` differ only in their default scheme — so a caller
 * can move between them, or be pointed at another scheme entirely, without
 * rewriting the call site.
 */

/**
 * The window URL, normalized. Only the plugin-window page is accepted.
 *
 * `pluginwin.html` and `index.html` are two different applications, not two
 * modes of one:
 *
 *   index.html      the SHELL. Links the shell's stylesheet (Tailwind
 *                   utilities + sonner), boots the plugin host, mounts
 *                   `App.vue`. It knows nothing about `mountWindow`.
 *   pluginwin.html  a plugin's OWN window. Links the plugin stylesheet (tokens
 *                   + `.tb-*` only), imports the plugin host page, and calls
 *                   the plugin's `mountWindow(bridge)`.
 *
 * Handing the shell page to a plugin window is what used to boot a whole second
 * plugin host inside it — see `src/main.js` for the blast radius. That is
 * unreachable now, but the mistake should still fail HERE, at the call site the
 * author is looking at.
 *
 * ## The legacy shape is accepted, and REWRITTEN
 *
 * A plugin window's URL used to be `index.html?mode=pluginwin&…`, and it was
 * documented that way. When the two windows became two pages that shape was
 * refused — which broke every plugin already installed, and the symptom was
 * nothing at all: `create` rejected the URL, every caller had a `catch` around
 * it, so the plugin loaded, activated, showed up in Settings, and its windows
 * simply never appeared. A third-party plugin cannot be edited (one asks for
 * the old URL in five places), and the copy in the plugins directory is a COPY,
 * so fixing `tests/fixtures/` does not fix what is installed.
 *
 * So the old shape is translated rather than rejected. Translating HERE, at the
 * boundary, is what makes it free: the window is created with the right URL, so
 * it never loads the shell's 166 KB stylesheet only to navigate away from it.
 * (`src/main.js` still redirects a legacy URL, as a net for a window that came
 * from somewhere other than this function.)
 *
 * Returns the canonical URL, or `null` if this is not one. The caller owns
 * the error message, because only it knows which plugin is asking.
 *
 * Anything that is not a LOCAL page is refused: no scheme (`https:`), no
 * root-relative path (`/x`), no traversal (`../x`). A remote page would carry
 * no IPC (no capability declares a remote origin, so Tauri denies it by
 * default), but it would still replace the host page and skip the loader that
 * hands the plugin its `bridge`.
 */
export function normalizePluginWindowUrl(url) {
  if (/^pluginwin\.html(\?|#|$)/.test(url)) return url;

  const legacy = url.match(/^index\.html\?(.*)$/);
  if (legacy) {
    const params = new URLSearchParams(legacy[1].split('#')[0]);
    if (params.get('mode') === 'pluginwin') {
      params.delete('mode'); // the page IS the mode now
      const q = params.toString();
      return q ? `pluginwin.html?${q}` : 'pluginwin.html';
    }
  }

  return null;
}

/**
 * This window's label, or `null` when there is no Tauri (a browser, `node
 * --test`).
 *
 * `getCurrentWindow()` reads `__TAURI_INTERNALS__.metadata`, which does not
 * exist outside a Tauri webview — and it is a synchronous read, not an IPC, so
 * this is safe to call from inside an event handler.
 */
export function currentWindowLabel() {
  try {
    return getCurrentWindow().label;
  } catch {
    return null;
  }
}

export function buildCtx(plugin, disposer) {
  const { manifest } = plugin;
  const id = manifest.id;
  const prefix = `[plugin:${id}]`;

  /**
   * The window options a plugin may set.
   *
   * `options` used to go straight into `new WebviewWindow(label, options)`, which
   * made it the one surface here with no allow-list — everything else (service
   * actions, capabilities, the component vocabulary) is an explicit, fail-closed
   * list. The blast radius was small, because Tauri matches capabilities by
   * window LABEL and the only labels a plugin can reach (`plugin-*`) grant three
   * permissions each; so no option could escalate. What it could do is surprise.
   */

  const PREFIX_NEEDS_LABEL = 'windows.create needs a non-empty label';
  const PREFIX_LABEL_DENIED =
    'window label "%L" matches no capability, so the window would have no ' +
    'permissions (it could not be dragged, and its close button would fail ' +
    'with an ACL denial). Use "%S" instead.';

  const WINDOW_OPTIONS = new Set([
    'url',
    'title',
    'width',
    'height',
    'x',
    'y',
    'center',
    'transparent',
    'decorations',
    'shadow',
    'alwaysOnTop',
    'skipTaskbar',
    'resizable',
    'maximizable',
    'minimizable',
    'closable',
    'focus',
    'visible',
  ]);


  /**
   * A window label must be one the native ACL can match.
   *
   * Tauri matches capabilities by window LABEL, and the only file that grants a
   * plugin window anything is:
   *
   *   pluginwin.json  ->  ["plugin-*"]   drag + close + core:default
   *
   * A label like `my-win` matches NOTHING, so the window comes up with no
   * permissions at all — it cannot be dragged and its close button silently
   * fails with an ACL denial. That is a confusing way to fail, and it is
   * entirely predictable from the label, so it is refused here instead.
   *
   * This used to have a second arm: `builtin.floatwin` owned a bespoke
   * `floatwin.json` capability for the label `floatwin`, so that one label was
   * allowed through. Both the plugin and its capability are gone, and the arm
   * with them — which is the point of having the check here rather than in a
   * doc: the list of reachable labels is now exactly one pattern.
   */
  function assertWindowLabel(label) {
    if (typeof label !== 'string' || !label) {
      throw new Error(PREFIX_NEEDS_LABEL);
    }
    if (label.startsWith('plugin-')) return label;
    const suggestion = 'plugin-' + label.replace(/[^a-zA-Z0-9_-]/g, '-');
    throw new Error(
      PREFIX_LABEL_DENIED.replace('%L', label).replace('%S', suggestion),
    );
  }

  function sanitizeWindowOptions(options) {
    const unknown = Object.keys(options).filter((k) => !WINDOW_OPTIONS.has(k));
    if (unknown.length) {
      throw new Error(`${prefix} window option(s) not allowed: ${unknown.join(', ')}`);
    }
    const clean = { ...options };
    if (clean.url !== undefined) {
      // Normalized, not merely checked: a caller may still be passing the legacy
      // shape, and the window must be CREATED with the canonical one — that is
      // what keeps the translation free.
      const normalized = normalizePluginWindowUrl(String(clean.url));
      if (normalized === null) {
        throw new Error(
          `${prefix} window url must be the plugin-window page ` +
            `(pluginwin.html?plugin=<id>&label=<label>), got "${clean.url}"`,
        );
      }
      clean.url = normalized;
    }
    return clean;
  }

  const { request: rpc, ...sdk } = createPluginSdk(id, manifest, disposer);
  const gatedWin = (fn) => manifest.permissions?.includes('win:manage')
    ? fn()
    : Promise.reject(new Error(`${prefix} missing permission "win:manage" in manifest`));

  const ctx = {
    id,
    ...sdk,
    rpc,
    focusView: (viewId) => {
      const full = `${id}/${viewId}`;
      const own = store.views.some((v) => v.viewId === full);
      if (!own) {
        // Refuse rather than silently doing nothing: a typo here would look
        // like "the hotkey stopped working".
        throw new Error(`${prefix} focusView("${viewId}") — no such view of yours`);
      }
      store.activeViewId = full;
      return full;
    },

    /**
     * Files dropped onto the window, while one of YOUR views is showing.
     *
     * `fn(paths, info)` — `info` is `{ viewId }`.
     *
     * **Routed to the ACTIVE view only.** A drop lands on what the user is
     * looking at, so delivering it to every plugin would let one silently
     * harvest paths meant for another. That routing is also why there is no
     * drop permission: you only ever see drops the user aimed at your view.
     *
     * Window-local (the `in-process` scheme) — plugin views live in the main
     * window, so a drop needs no IPC. The host listens once; see `watchDrops`
     * in `boot.js`.
     *
     * **Ownership is resolved when the drop arrives, not when this is called.**
     * That distinction is the whole bug this used to have: a plugin's views are
     * registered by `ctx.registerView`, and calling `ctx.onDrop` first is the
     * natural order (wire up your inputs in `activate`, mount the view later).
     * Snapshotting the view ids here therefore captured an EMPTY set, so the
     * filter below rejected every drop for the lifetime of the plugin — silently,
     * because a drop that is declined on purpose and one that is declined by a
     * bug look identical from the outside. The drop really did arrive, and the
     * log really did say "3 listener(s)": it was counting the wrappers that ran,
     * not the plugins that acted.
     */
    onDrop: (fn) =>
      sdk.events.on(DROP_TOPIC, (payload) => {
        const viewId = payload?.viewId;
        if (!viewId) return;
        if (!store.views.some((v) => v.viewId === viewId && v.pluginId === id)) return;
        fn(payload.paths ?? [], { viewId });
      }),

    ui: {
      /**
       * The in-app toast. Right for "saved" — the user is looking at the app.
       *
       * For anything they might need while the window is behind something else,
       * use `notifyOS` instead (or as well). A toast only exists inside a
       * window; an OS notification does not.
       */
      notify: (message, type = 'info') => toast(`${manifest.name}: ${message}`, type),

      /**
       * An OS notification — the Windows action centre, macOS Notification
       * Center, a Linux daemon. **Permission: `rpc:notify`.**
       *
       * ```js
       * await ctx.ui.notifyOS('Build finished', { title: 'procman' });
       * ```
       *
       * Goes through `ctx.rpc`, so it is validated, permission-gated and shows
       * up in the communication trace like every other call.
       *
       * `title` defaults to the plugin's name: an OS notification is
       * out-of-band, and the user has no other way to tell which plugin raised
       * it.
       *
       * Resolves `false` when it could not be sent (permission off, OS
       * notifications disabled) instead of throwing — a missing notification
       * must not break whatever the plugin was doing.
       */
      notifyOS: (body, options = {}) =>
        ctx
          .rpc('notify', 'send', { title: options.title ?? manifest.name, body })
          .then((res) => !!res?.sent)
          .catch((e) => {
            // Not fatal, but never silent: a notification that quietly does
            // nothing is the kind of bug nobody reports.
            console.warn(prefix, 'OS notification failed:', e?.message ?? e);
            return false;
          }),
      mountOverlay: (el) => {
        if (!store.overlayEl) {
          console.warn(prefix, 'overlay not ready');
          return;
        }
        // The overlay lives outside the view container, so it needs the theme
        // scope applied here too — otherwise a plugin's `contributes.theme`
        // would style its view but not its own break screen.
        el.setAttribute(PLUGIN_ATTR, id);
        store.overlayEl.appendChild(el);
      },
      unmountOverlay: (el) => el?.remove(),

      // The component factory (see host/ui.js). Spread last so a future kit
      // method cannot be shadowed by the three above by accident.
      ...createUiKit({ track: (fn) => disposer.track(fn) }),
    },

    /** Multi-window control (second layer of enforcement: the Tauri ACL). */
    windows: {
      create: (label, options = {}) =>
        gatedWin(async () => {
          // Validated before the lookup, so a bad option fails the same way
          // whether or not a window with that label already exists.
          assertWindowLabel(label);
          const clean = sanitizeWindowOptions(options);
          const existing = await WebviewWindow.getByLabel(label);
          if (existing) {
            await existing.show();
            await existing.setFocus();
            return 'exists';
          }
          // Created by the HOST, not by `new WebviewWindow(label, clean)`.
          //
          // WebView2 runs ONE browser process per user-data folder, and that
          // process's command line is fixed by the first window that started it.
          // wry builds a fresh environment per webview, so a window created from
          // JS — which carries no `additionalBrowserArgs` — asks for a different
          // command line and is refused with `0x8007139F` (ERROR_INVALID_STATE):
          // "failed to create webview: WebView2 error: WindowsError(…)".
          // `host_window_create` copies the main window's arguments into every
          // window it makes, and it is the only creator (the ACL permission was
          // revoked in `capabilities/default.json`).
          try {
            await invoke('host_window_create', { label, options: clean });
          } catch (e) {
            throw new Error(`window "${label}" create failed: ${e}`);
          }
          // A handle without creating anything: `skip` is what the API's own
          // `getByLabel` uses to wrap an existing window.
          const win = new WebviewWindow(label, { skip: true });
          /**
           * Closing it is the HOST's job from here on.
           *
           * Every other resource a plugin acquires is tracked for teardown —
           * streams, sidecars, ptys, subscriptions, hotkeys, views — and windows
           * were the one that was not. So disabling a plugin left its windows on
           * screen with nobody able to close them: the plugin's JS context is
           * gone, and the tray only knows about `main`. A plugin that closes its
           * own windows in `deactivate()` still does; this is the backstop for
           * one that forgets, and it makes "disable" mean the same thing for
           * every resource.
           *
           * Only what THIS call created is tracked. A label that already existed
           * may belong to another plugin, and closing someone else's window on
           * teardown would be a bug in the other direction.
           */
          disposer.track(() => win.close().catch(() => {}));
          return 'created';
        }),

      exists: (label) => gatedWin(async () => !!(await WebviewWindow.getByLabel(label))),

      /**
       * Run `fn` when THIS window is asked to close, so a plugin can tear down a
       * companion window and let the app exit cleanly. Exposed here so a plugin
       * never has to import a Tauri API for window lifecycle.
       */
      onCloseRequested: (fn) =>
        gatedWin(async () => {
          const un = await getCurrentWindow().onCloseRequested(async (event) => {
            /**
             * The MAIN window does not close — it hides (see
             * `installCloseToTray` in `boot.js`), so a plugin must not be told
             * the app is going away, because it is not.
             *
             * This is the reason the handler goes through the host instead of a
             * plugin listening for `tauri://close-requested` itself: the host is
             * the only party that knows whether a close request means "gone". A
             * plugin that tore its windows down here would have no signal on the
             * way back to rebuild them — the tray would restore a window whose
             * widgets had been destroyed.
             */
            if (closeToTray() && currentWindowLabel() === 'main') return;

            // Contain a handler failure. Tauri's own implementation calls
            // `destroy()` only AFTER the handler resolves, so a throw here would
            // leave the window impossible to close — a plugin bug must not wedge
            // the window. The handler still runs; only its failure is contained.
            try {
              await fn(event);
            } catch (e) {
              console.error(`${prefix} onCloseRequested handler failed`, e);
            }
          });
          disposer.track(() => un());
          return un;
        }),

      control: (label, op, value) =>
        gatedWin(async () => {
          const win = await WebviewWindow.getByLabel(label);
          if (!win) throw new Error(`window "${label}" not found`);
          switch (op) {
            case 'size': return win.setSize(new LogicalSize(value.width, value.height));
            case 'position': return win.setPosition(new LogicalPosition(value.x, value.y));
            case 'clickThrough': return win.setIgnoreCursorEvents(!!value);
            case 'alwaysOnTop': return win.setAlwaysOnTop(!!value);
            case 'skipTaskbar': return win.setSkipTaskbar(!!value);
            case 'show': return win.show();
            case 'hide': return win.hide();
            case 'focus': return win.setFocus();
            case 'unminimize': return win.unminimize();
            case 'isMinimized': return win.isMinimized();

            /**
             * Bring a window to the front — the three calls a "summon" needs,
             * in the order that actually works.
             *
             * `focus` alone is not enough, and the failure is silent: on Windows
             * `setFocus` on a MINIMISED window does not restore it, so a hotkey
             * meant to summon the window does nothing visible, and the plugin
             * looks broken while every call returned Ok. `unminimize` first, then
             * `show`, then `focus`.
             *
             * Worth having as ONE op rather than three the caller sequences:
             * getting the order wrong is easy, and the symptom is "nothing
             * happens" rather than an error.
             */
            case 'raise': {
              // Best-effort: a window that is not minimised rejects this on some
              // platforms, and that is not a failure worth propagating.
              await win.unminimize().catch(() => {});
              await win.show().catch(() => {});
              return win.setFocus();
            }
            case 'close': return win.close();
            default: throw new Error(`${prefix} unknown window op "${op}"`);
          }
        }),
    },

    registerView: (viewId, render) => {
      const declared = (manifest.contributes?.views || []).some((v) => v.id === viewId);
      if (!declared) {
        throw new Error(`${prefix} view "${viewId}" not declared in manifest.contributes.views`);
      }
      const existing = store.views.find((v) => v.viewId === `${id}/${viewId}`);
      if (existing) existing.render = render;
      else {
        const decl = manifest.contributes.views.find((v) => v.id === viewId);
        store.views.push({
          viewId: `${id}/${viewId}`,
          pluginId: id,
          slot: decl.slot || 'tool',
          title: decl.title || manifest.name,
          icon: decl.icon || '🧩',
          // The view carries its own ordering key, so the list can be re-sorted
          // without looking the plugin up again. `manifest.builtin` is set by
          // `loadPlugin` before `activate()` runs, so it is already correct here.
          builtin: Boolean(manifest.builtin),
          render,
        });
        sortViewList();
      }
    },
  };
  return ctx;
}
