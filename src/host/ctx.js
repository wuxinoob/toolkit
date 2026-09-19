import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';

import { hub } from '../protocol/hub.js';
import { Capability, assertSupports } from '../protocol/registry.js';
import { protocolContract } from '../protocol/contract.js';
import { store, toast } from './store.js';
import { PLUGIN_ATTR } from './pluginTheme.js';

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

    ui: {
      notify: (message, type = 'info') => toast(`${manifest.name}: ${message}`, type),
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
    },

    /** Multi-window control (second layer of enforcement: the Tauri ACL). */
    windows: {
      create: (label, options = {}) =>
        gatedWin(async () => {
          const existing = await WebviewWindow.getByLabel(label);
          if (existing) {
            await existing.show();
            await existing.setFocus();
            return 'exists';
          }
          const win = new WebviewWindow(label, options);
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
