import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';

import { hub } from '../protocol/hub.js';
import { Capability, assertSupports } from '../protocol/registry.js';
import { protocolContract } from '../protocol/contract.js';
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

  const perms = manifest.permissions || [];
  const hasPermission = (perm) => perms.includes(perm);

  /** Gate for an arbitrary declared permission. */
  const gated = (fn, perm) => {
    if (!hasPermission(perm)) {
      return Promise.reject(new Error(`${prefix} missing permission "${perm}" in manifest`));
    }
    return fn();
  };

  /** Gate for the push data plane (channel streams and ptys). */
  const gatedStream = (fn) => gated(fn, 'rpc:stream');

  /** Gate for the multi-window API. */
  const gatedWin = (fn) => gated(fn, 'win:manage');

  /** Streams opened by this plugin, closed on deactivate. */
  const openStreams = new Set();
  const trackStream = (handle) => {
    openStreams.add(handle.ch);
    return handle;
  };

  /**
   * Release a stream when the plugin goes away.
   *
   * `hub.close`, NOT `handle.close`. Both tell the host to stop, but only
   * `hub.close` also clears the hub's own registry — the map that answers
   * "stream `plugin/ch` is already open". Waiting for a terminal `end` frame to
   * clear it is not the same thing: when that frame does not arrive (a producer
   * that was killed, a shimmed host, a close during teardown), the slot stays
   * taken and the plugin can never reopen that channel id — it gets
   * "already open" for a stream that no longer exists.
   */
  const trackStreamClose = (ch) => disposer.track(() => hub.close(id, ch));

  // ------------------------------- events ------------------------------------

  /**
   * The one subscribe path. Async on every scheme, and the returned function is
   * tracked for auto-cleanup on deactivate.
   *
   * Receiving is deliberately NOT gated: a passive listener costs nothing and
   * cannot affect another window. Publishing is the privileged act and carries
   * the permission (see `publishBroadcast`).
   */
  const subscribeWith = (scheme, topic, fn) => {
    const p = hub.subscribe(id, topic, fn, { scheme });
    p.then((off) => disposer.track(off)).catch(() => {});
    return p;
  };

  const onceWith = (scheme, topic, fn) => {
    const p = hub.once(id, topic, fn, { scheme });
    p.then((off) => disposer.track(off)).catch(() => {});
    return p;
  };

  const publishWith = (scheme, topic, payload) => hub.publish(id, topic, payload, { scheme });

  /** Publishing reaches other windows, so that is the capability which is gated. */
  const publishBroadcast = (topic, payload) =>
    gated(() => publishWith('event-bus', topic, payload), 'rpc:bus');

  // -------------------------------- streams ----------------------------------

  const streamVia = (scheme, capabilities, provider, ch, handlers) =>
    gatedStream(async () => {
      assertSupports(scheme, Capability.PUSH, ...capabilities);
      const h = await hub.stream(id, scheme, { provider, ch, ...handlers });
      trackStreamClose(ch);
      return trackStream(h);
    });

  const ctx = {
    id,
    manifest,

    /**
     * The wire contract, handed over rather than imported.
     *
     * External plugins are loaded from a Blob URL as a single-file ESM, so they
     * cannot `import` the protocol barrel. Exposing it here means a drop-in
     * plugin builds and inspects envelopes with the same code the host uses,
     * instead of hard-coding the shape and drifting.
     */
    protocol: protocolContract(),

    log: {
      info: (...a) => console.info(prefix, ...a),
      warn: (...a) => console.warn(prefix, ...a),
      error: (...a) => console.error(prefix, ...a),
    },

    /**
     * Permission-gated native service call, e.g. `ctx.rpc('host', 'info')`.
     * `opts.timeoutMs` bounds how long THIS caller waits (0 = forever); the host
     * cannot be cancelled, so a timeout means "I stopped waiting".
     */
    rpc: (svc, act, params = null, opts = {}) => gated(() => hub.request(id, svc, act, params, opts), `rpc:${svc}`),

    /** Namespaced persistent storage (Rust-side, per-plugin data.json). */
    storage: {
      get: (key) => ctx.rpc('storage', 'get', { key }),
      set: (key, value) => ctx.rpc('storage', 'set', { key, value }),
      remove: (key) => ctx.rpc('storage', 'remove', { key }),
      keys: () => ctx.rpc('storage', 'keys', {}),
    },

    /**
     * Clipboard: read, write, and watch for changes.
     *
     * Sugar over `ctx.rpc` / `ctx.stream`, exactly like `storage` — named so a
     * plugin author does not have to know that "read" is a request and "watch"
     * is a stream. The distinction is real, though, and worth knowing:
     *
     *   read / write   one answer to one question   → a service action
     *   watch          the host pushes on change    → a stream provider
     *
     * `watch(ch, …)` polls on the host side (`intervalMs`, default 500, clamped
     * to 100–10000) and pushes a `data` frame only when the text actually
     * changes — so an idle clipboard costs nothing. The first frame is the
     * CURRENT value, so a subscriber does not have to change the clipboard to
     * learn what is on it.
     *
     * Needs `rpc:stream` (it is a stream) **and** `rpc:clipboard`: watching the
     * clipboard means reading everything the user copies, which is not what
     * `rpc:stream` says.
     */
    clipboard: {
      read: () => ctx.rpc('clipboard', 'read', {}),
      write: (text) => ctx.rpc('clipboard', 'write', { text }),
      watch: (ch, handlers = {}) => ctx.stream('clipboard', ch, handlers),
    },

    /**
     * Screen: enumerate monitors and capture one.
     *
     * Both are requests — a capture is one answer to one question, not a push —
     * so this is `ctx.rpc` twice. `capture()` returns
     * `{ png, width, height, monitor, name, bytes }` where `png` is base64: the
     * heaviest payload the gateway carries, which is why it is a one-shot.
     *
     * `capture({ monitor })` picks by index from `monitors()`; with no argument
     * it captures the PRIMARY monitor, because "capture the screen" almost
     * always means the one the user is looking at, and the order of the OS's
     * list is the OS's.
     */
    screen: {
      monitors: () => ctx.rpc('screen', 'monitors', {}),
      capture: (opts = {}) => ctx.rpc('screen', 'capture', opts),
    },

    // ---------------- events: one shape, the scheme picks the wire ----------------

    /** Subscribe on the cross-window bus (default scheme `event-bus`). */
    subscribe: (topic, fn, { scheme = 'event-bus' } = {}) => subscribeWith(scheme, topic, fn),
    /** Subscribe for exactly one delivery. Same shape as `subscribe`. */
    once: (topic, fn, { scheme = 'event-bus' } = {}) => onceWith(scheme, topic, fn),
    /** Publish to every window (default `event-bus`, needs `rpc:bus`). */
    publish: (topic, payload = null, { scheme = 'event-bus' } = {}) =>
      scheme === 'event-bus' ? publishBroadcast(topic, payload) : publishWith(scheme, topic, payload),

    /** Window-local events (`in-process`): the same async shape, zero IPC. */
    events: {
      on: (topic, fn) => subscribeWith('in-process', topic, fn),
      once: (topic, fn) => onceWith('in-process', topic, fn),
      emit: (topic, payload = null) => publishWith('in-process', topic, payload),
    },

    /** Cross-window events (`event-bus`): the same calls, a different default. */
    bus: {
      subscribe: (topic, fn) => subscribeWith('event-bus', topic, fn),
      once: (topic, fn) => onceWith('event-bus', topic, fn),
      publish: publishBroadcast,
    },

    /**
     * A global hotkey declared in `contributes.hotkeys`, delivered as an `evt`
     * envelope on `hotkey:<action>`. The host registers it at activate, so the
     * plugin never touches the shortcut API; receiving is ungated like any other
     * subscription.
     */
    onHotkey: (action, fn) =>
      subscribeWith('event-bus', `hotkey:${action}`, (env) => {
        // the owner travels with the event: ignore another plugin's hotkey that
        // happens to use the same action name
        if (env.svc && env.svc !== id) return;
        fn(env);
      }),

    /**
     * Native dialogs, opened by the HOST on your behalf.
     *
     * You cannot import `@tauri-apps/plugin-dialog` (a Blob-URL plugin imports
     * nothing), so the host opens it for you. **Permission: `rpc:dialog`.**
     *
     * Why a raw command and not a gateway action: the gateway is synchronous,
     * so it runs on the main thread, and a native modal dialog would deadlock
     * there. See `plugin_dialog` in `lib.rs`.
     *
     * **What you get back is a path the USER picked, in a dialog they could see
     * and cancel.** That is the point: the grant is the user's action, not your
     * declaration. There is no `ctx.fs` — read the file with your own sidecar
     * (`ctx.sidecar`), which is a capability you do declare.
     */
    files: {
      /** Pick file(s). Resolves `[]` when the user cancels — not an error. */
      pick: (options = {}) =>
        gated(
          () =>
            invoke('plugin_dialog', {
              pluginId: id,
              action: 'open',
              params: {
                title: options.title ?? null,
                multiple: !!options.multiple,
                folder: !!options.folder,
                directory: options.directory ?? null,
                filters: options.filters ?? null,
              },
            }),
          'rpc:dialog',
        ).then((r) => r?.paths ?? []),

      /** Ask where to save. Resolves `null` when the user cancels. */
      save: (options = {}) =>
        gated(
          () =>
            invoke('plugin_dialog', {
              pluginId: id,
              action: 'save',
              params: {
                title: options.title ?? null,
                defaultPath: options.defaultPath ?? null,
              },
            }),
          'rpc:dialog',
        ).then((r) => r?.path ?? null),

      /** A native message box. */
      message: (message, options = {}) =>
        gated(
          () =>
            invoke('plugin_dialog', {
              pluginId: id,
              action: 'message',
              params: { message, title: options.title ?? null },
            }),
          'rpc:dialog',
        ),
    },

    /**
     * Bring one of YOUR views to the front.
     *
     * This is what makes "a hotkey opens my plugin" work:
     *
     * ```js
     * ctx.onHotkey('open', () => ctx.focusView('main'));
     * ```
     *
     * **Only your own views.** Focusing someone else's is not a thing you can
     * express here, which is what keeps this from being a way to hijack the UI.
     *
     * **No permission.** The action is the plugin's own view becoming visible —
     * something the user sees and can undo with one click on the sidebar. The
     * case worth worrying about is a plugin focusing itself at boot to grab
     * attention, and the answer to that is not a permission: it is that a
     * hotkey has to be enabled by the user before it can fire at all
     * (see `contributes.hotkeys`), so the consented path is the normal one.
     */
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
      subscribeWith('in-process', DROP_TOPIC, (payload) => {
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
          const win = new WebviewWindow(label, clean);
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
          return new Promise((resolve, reject) => {
            win.once('tauri://created', () => resolve('created'));
            win.once('tauri://error', (e) =>
              reject(new Error(`window "${label}" create failed: ${e?.payload ?? e}`)),
            );
          });
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

    // ----------------------------- the data plane -----------------------------

    /** A host push stream over the structured codec (channel + json-envelope). */
    stream: (provider, ch, handlers = {}) => streamVia('channel-json', [], provider, ch, handlers),

    /**
     * The same push stream over the binary codec (channel + raw-binary). Frames
     * arrive as `{kind, ch, p: Uint8Array}` — the same envelope shape, so a
     * consumer can be switched between the two codecs unchanged.
     */
    streamRaw: (provider, ch, handlers = {}) =>
      streamVia('channel-raw', [Capability.BINARY], provider, ch, handlers),

    /**
     * Open an UPLINK stream: push frames TO the host, in batches.
     *
     * Every other method here receives. This one sends, which is what the
     * downlink-only data plane was missing: feeding a backend used to cost one
     * `rpc` per frame, so a 1000-frame burst cost 1000 round trips. `sendBatch`
     * makes it one per batch, and the host routes the frames to a named sink.
     *
     * Gated by `rpc:stream`: it is the same push data plane, just the other way.
     */
    uplink: (ch, { sink, params = null } = {}) =>
      gatedStream(async () => {
        assertSupports('channel-in', Capability.UPLINK);
        const h = await hub.uplink(id, ch, { sink, params });
        trackStreamClose(ch);
        return trackStream(h);
      }),

    /**
     * Talk to a helper executable shipped inside this plugin's folder.
     *
     * Gated by `rpc:proc` rather than `rpc:stream`: running a binary that the
     * plugin shipped is a distinct (stronger) capability than opening a stream,
     * and it is the `proc` service that backs it. One capability, one permission.
     */
    sidecar: (ch, { exe, args, pollMs, timeoutMs, onFrame, onEnd } = {}) =>
      gated(async () => {
        const h = await hub.sidecar(id, ch, { exe, args, pollMs, timeoutMs, onFrame, onEnd });
        trackStreamClose(ch);
        return trackStream(h);
      }, 'rpc:proc'),

    /** Run a command-line subprocess in a pseudo-terminal. */
    pty: (ch, { program, args, cwd, env, cols, rows, onFrame, onEnd } = {}) =>
      gatedStream(async () => {
        const h = await hub.pty(id, ch, { program, args, cwd, env, cols, rows, onFrame, onEnd });
        trackStreamClose(ch);
        return trackStream(h);
      }),

    /**
     * Close a stream this plugin opened.
     *
     * Deliberately ungated: opening it already required the capability, and this
     * can only ever touch streams this plugin registered (the hub keys them by
     * plugin id). Closing is strictly weaker than opening, so a gate here would
     * only make the permission model harder to reason about.
     */
    closeStream: (ch) => {
      if (!openStreams.has(ch)) return Promise.resolve(false);
      openStreams.delete(ch);
      return hub.close(id, ch);
    },

    /** Every live endpoint the host knows about, across all transports. */
    sessions: () => ctx.rpc('host', 'sessions', {}),

    /**
     * The host's own folders and the user's well-known folders, as absolute
     * paths — plus `platform` / `arch` / `appVersion` / `sep`.
     *
     * Read-only knowledge, NOT a grant: knowing where `documentsDir` is does not
     * let a plugin read it (there is no `ctx.fs` — see
     * `docs/plugin-dev/FILE-ACCESS-PLAN.md`). What it buys is that a plugin stops
     * GUESSING where its own data lives and starts naming the folder the host
     * actually uses. A folder the platform cannot answer for is `null`, not an
     * error.
     *
     * `pluginDataDir` is the same directory `ctx.rpc('host', 'info')` reports as
     * `dataDir`; the two names exist because from the outside one is "my data"
     * and from here it is one entry in a list of places.
     */
    paths: () => ctx.rpc('host', 'paths', {}),

    /** The scheme table (local knowledge, no IPC). */
    schemes: () => hub.schemes(),

    /**
     * What this host supports: protocol version, services + actions, stream
     * providers and the scheme table. Ask instead of guessing — this is the
     * negotiation surface.
     *
     * The native side supplies services/actions/providers; the hub adds the
     * scheme table, which only the frontend knows.
     */
    schema: () => gated(() => hub.schema(id), 'rpc:host'),

    /** Register render functions for views declared in contributes.views. */
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

  // `ctx.onSettingsChanged` used to live here: it subscribed to a
  // `settings:changed:<id>` event that the host's "Plugin settings" card emitted
  // after saving a `contributes.settings` form. Both are gone — see the note in
  // `views/SettingsView.vue` — and nothing emitted the event, so the method was
  // a subscription that could never fire.
  //
  // A plugin that wants configurable settings owns them: `ctx.storage` is
  // namespaced per plugin and always available, so the plugin renders its own
  // controls and persists them itself.

  /** Register an arbitrary cleanup fn that runs on deactivate. */
  ctx.cleanup = (fn) => disposer.track(fn);

  return ctx;
}
