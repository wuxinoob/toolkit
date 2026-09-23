import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';

import { hub } from '../protocol/hub.js';
import { Capability, assertSupports } from '../protocol/registry.js';
import { protocolContract } from '../protocol/contract.js';
import { store, toast } from './store.js';
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
   * window LABEL and the only labels a plugin can reach (`plugin-*`, `floatwin`)
   * grant three permissions each; so no option could escalate. What it could do
   * is surprise.
   */
  /** The window-local topic the host publishes OS file drops on. */
  const DROP_TOPIC = 'host:drop';

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
   * A plugin window may only load the app's OWN entry page.
   *
   * Both built-ins pass `index.html?mode=…`, which is how the host page decides
   * what to render. An arbitrary URL would replace the host page with remote
   * content and skip `pluginwin-host.js` — the documented loader that hands the
   * plugin its `bridge`. The window would carry no IPC (no capability declares a
   * remote origin, so Tauri denies it by default), so this is not an escalation;
   * it is an undeclared capability that breaks the one contract the window host
   * has.
   */
  /**
   * A window label must be one the native ACL can match.
   *
   * Tauri matches capabilities by window LABEL, and the only files that grant a
   * plugin window anything are:
   *
   *   pluginwin.json  ->  ["plugin-*"]   drag + close + core:default
   *   floatwin.json   ->  ["floatwin"]   drag + close + core:default
   *
   * A label like `my-win` matches NEITHER, so the window comes up with no
   * permissions at all — it cannot be dragged and its close button silently
   * fails with an ACL denial. That is a confusing way to fail, and it is
   * entirely predictable from the label, so it is refused here instead.
   *
   * `builtin.floatwin` is the one plugin that owns a bespoke capability file;
   * everything else uses the shared `plugin-*` one.
   */
  function assertWindowLabel(label) {
    if (typeof label !== 'string' || !label) {
      throw new Error(PREFIX_NEEDS_LABEL);
    }
    if (label.startsWith('plugin-') || label === 'floatwin') return label;
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
    if (options.url !== undefined && !/^index\.html(\?|$)/.test(String(options.url))) {
      throw new Error(
        `${prefix} window url must be the app's own entry page (index.html?…), got "${options.url}"`,
      );
    }
    return { ...options };
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
      disposer.track(() => h.close().catch(() => {}));
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
     */
    onDrop: (fn) => {
      const mine = new Set(
        store.views.filter((v) => v.pluginId === id).map((v) => v.viewId),
      );
      return subscribeWith('in-process', DROP_TOPIC, (payload) => {
        if (!payload || !mine.has(payload.viewId)) return;
        fn(payload.paths ?? [], { viewId: payload.viewId });
      });
    },

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
          // Contain a handler failure. Tauri's own implementation calls
          // `destroy()` only AFTER the handler resolves, so a throw here would
          // leave the window impossible to close — a plugin bug must not wedge
          // the window. The handler still runs; only its failure is contained.
          const un = await getCurrentWindow().onCloseRequested(async (event) => {
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
        disposer.track(() => h.close().catch(() => {}));
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
        disposer.track(() => h.close().catch(() => {}));
        return trackStream(h);
      }, 'rpc:proc'),

    /** Run a command-line subprocess in a pseudo-terminal. */
    pty: (ch, { program, args, cwd, env, cols, rows, onFrame, onEnd } = {}) =>
      gatedStream(async () => {
        const h = await hub.pty(id, ch, { program, args, cwd, env, cols, rows, onFrame, onEnd });
        disposer.track(() => h.close().catch(() => {}));
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
          render,
        });
      }
    },
  };

  /**
   * React to changes made in the host Settings page for this plugin's form.
   * Async, like every other subscription.
   */
  ctx.onSettingsChanged = (cb) => ctx.events.on(`settings:changed:${id}`, cb);

  /** Register an arbitrary cleanup fn that runs on deactivate. */
  ctx.cleanup = (fn) => disposer.track(fn);

  return ctx;
}
