import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';

import { hub } from '../protocol/hub.js';
import { Capability, assertSupports } from '../protocol/registry.js';
import * as Envelope from '../protocol/envelope.js';
import { events } from './events.js';
import { store, toast } from './store.js';

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
 */
export function buildCtx(plugin, disposer) {
  const { manifest } = plugin;
  const id = manifest.id;
  const prefix = `[plugin:${id}]`;
  const perms = manifest.permissions || [];
  const hasPermission = (perm) => perms.includes(perm);

  /** Gate for every request/response service call. */
  const gatedRpc = (svc, act, params) => {
    if (!hasPermission(`rpc:${svc}`)) {
      return Promise.reject(new Error(`${prefix} missing permission "rpc:${svc}" in manifest`));
    }
    return hub.request(id, svc, act, params);
  };

  /** Gate for the push data plane (channel streams and ptys). */
  const gatedStream = (fn) => gated(fn, 'rpc:stream');

  /** Gate for an arbitrary declared permission. */
  const gated = (fn, perm) => {
    if (!hasPermission(perm)) {
      return Promise.reject(new Error(`${prefix} missing permission "${perm}" in manifest`));
    }
    return fn();
  };

  /** Gate for the multi-window API. */
  const gatedWin = (fn) => {
    if (!hasPermission('win:manage')) {
      return Promise.reject(new Error(`${prefix} missing permission "win:manage" in manifest`));
    }
    return fn();
  };

  /** Streams opened by this plugin, closed on deactivate. */
  const openStreams = new Set();
  const trackStream = (handle) => {
    openStreams.add(handle.ch);
    return handle;
  };

  const ctx = {
    id,
    manifest,

    /**
     * The wire contract, handed to the plugin rather than imported.
     *
     * External plugins are loaded from a Blob URL as a single-file ESM, so
     * they cannot `import` the protocol barrel. Exposing it here means a
     * drop-in plugin builds and inspects envelopes with the same code the host
     * uses, instead of hard-coding the shape and drifting.
     */
    protocol: {
      version: Envelope.PROTOCOL_VERSION,
      broadcastEvent: Envelope.BROADCAST_EVENT,
      Kind: Envelope.Kind,
      req: Envelope.req,
      res: Envelope.res,
      err: Envelope.err,
      evt: Envelope.evt,
      data: Envelope.data,
      end: Envelope.end,
      exit: Envelope.exit,
      validate: Envelope.validate,
      isTerminal: Envelope.isTerminal,
      nextId: Envelope.nextId,
    },

    log: {
      info: (...a) => console.info(prefix, ...a),
      warn: (...a) => console.warn(prefix, ...a),
      error: (...a) => console.error(prefix, ...a),
    },

    /** Namespaced persistent storage (Rust-side, per-plugin data.json). */
    storage: {
      get: (key) => gatedRpc('storage', 'get', { key }),
      set: (key, value) => gatedRpc('storage', 'set', { key, value }),
      remove: (key) => gatedRpc('storage', 'remove', { key }),
      keys: () => gatedRpc('storage', 'keys', {}),
    },

    /**
     * Window-local events (the `in-process` scheme): synchronous, no IPC.
     * Listeners registered here are auto-removed on deactivate.
     */
    events: {
      on: (topic, fn) => {
        const off = events.on(topic, fn);
        disposer.track(off);
        return off;
      },
      once: (topic, fn) => {
        const off = events.once(topic, fn);
        disposer.track(off);
        return off;
      },
      off: events.off,
      emit: events.emit,
    },

    /**
     * Cross-window events (the `event-bus` scheme). The same call works from
     * the main window and from a secondary window, which is what makes a
     * floating widget or an external plugin window possible without polling.
     */
    bus: {
      publish: (topic, payload) => gatedRpc('bus', 'publish', { topic, payload }),
      subscribe: async (topic, fn) => {
        if (!hasPermission('rpc:bus')) {
          throw new Error(`${prefix} missing permission "rpc:bus" in manifest`);
        }
        const off = await hub.subscribe(id, topic, fn);
        disposer.track(off);
        return off;
      },
    },

    /** Permission-gated native service calls, e.g. ctx.rpc('host', 'info'). */
    rpc: gatedRpc,

    ui: {
      notify: (message, type = 'info') => toast(`${manifest.name}: ${message}`, type),
      mountOverlay: (el) => {
        if (store.overlayEl) store.overlayEl.appendChild(el);
        else console.warn(prefix, 'overlay not ready');
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
       * Run `fn` when THIS window is asked to close, so a plugin can tear down
       * a companion window and let the app exit cleanly. Exposed here so a
       * plugin never has to import a Tauri API for window lifecycle.
       */
      onCloseRequested: (fn) =>
        gatedWin(async () => {
          const un = await getCurrentWindow().onCloseRequested(fn);
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

    // ---------------------------- the data plane ----------------------------

    /**
     * A host push stream over the structured codec (channel + json-envelope).
     * Providers are named, so a plugin asks for a capability, not a wire.
     */
    stream: (provider, ch, { params, onFrame, onEnd } = {}) =>
      gatedStream(async () => {
        assertSupports('channel-json', Capability.PUSH);
        const h = await hub.stream(id, 'channel-json', { provider, ch, params, onFrame, onEnd });
        disposer.track(() => h.close().catch(() => {}));
        return trackStream(h);
      }),

    /**
     * The same push stream over the binary codec (channel + raw-binary).
     * Frames arrive as `{kind, ch, p: Uint8Array}` — the same envelope shape,
     * so a consumer can be switched between the two codecs unchanged.
     */
    streamRaw: (provider, ch, { params, onFrame, onEnd } = {}) =>
      gatedStream(async () => {
        assertSupports('channel-raw', Capability.PUSH, Capability.BINARY);
        const h = await hub.stream(id, 'channel-raw', { provider, ch, params, onFrame, onEnd });
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
    pty: (ch, { program, args, cwd, cols, rows, onFrame, onEnd } = {}) =>
      gatedStream(async () => {
        const h = await hub.pty(id, ch, { program, args, cwd, cols, rows, onFrame, onEnd });
        disposer.track(() => h.close().catch(() => {}));
        return trackStream(h);
      }),

    /**
     * Close a stream this plugin opened.
     *
     * Deliberately ungated: opening it already required the capability, and
     * this can only ever touch streams this plugin registered (the hub keys
     * them by plugin id). Closing is strictly weaker than opening, so a gate
     * here would only make the permission model harder to reason about.
     */
    closeStream: (ch) => {
      if (!openStreams.has(ch)) return Promise.resolve(false);
      openStreams.delete(ch);
      return hub.close(id, ch);
    },

    /** Every live endpoint the host knows about, across all transports. */
    sessions: () => gatedRpc('host', 'sessions'),

    /** The scheme table, so a plugin can show which wires it is using. */
    schemes: () => hub.schemes(),

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

  /** React to changes made in the host Settings page for this plugin's form. */
  ctx.onSettingsChanged = (cb) => ctx.events.on(`settings:changed:${id}`, cb);

  /** Register an arbitrary cleanup fn that runs on deactivate. */
  ctx.cleanup = (fn) => disposer.track(fn);

  return ctx;
}
