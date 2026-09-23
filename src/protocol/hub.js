/**
 * MessageHub — the single front door for every kind of traffic.
 *
 * Plugins never pick a wire format by hand and never call a Tauri API. They
 * state WHAT they need; the hub resolves the scheme from the registry:
 *
 *   hub.request(...)    one control round trip           (scheme: rpc)
 *   hub.stream(...)     a host push stream               (scheme: channel-json | channel-raw)
 *   hub.sidecar(...)    talk to a plugin-shipped backend (scheme: stdio-line)
 *   hub.pty(...)        run a command-line subprocess    (scheme: pty-stream)
 *   hub.publish(...)    broadcast to every window        (scheme: event-bus)
 *   hub.subscribe(...)  receive broadcasts anywhere      (scheme: event-bus)
 *   hub.local(...)      same-window events, zero IPC     (scheme: in-process)
 *
 * Every one of those resolves to the SAME envelope type, so a consumer can be
 * written once and pointed at a different scheme when an experiment says so.
 */

import * as Envelope from './envelope.js';
import { Capability, assertSupports, describeSchemes, descriptor } from './registry.js';
import { ProtocolError } from './errors.js';
import { transport, transportIds } from './transports/index.js';

/**
 * Communication tracing — off by default, one switch to turn on.
 *
 * Why it exists: without it, "did my `ctx.rpc` go out, and what came back?" has
 * no answer. The debug log only carried lines a plugin wrote itself, so the
 * gateway layer — where permission and identity problems actually live — was
 * invisible. That is a large part of why the identity hole in
 * `docs/COMMS-AUDIT-2026-09-23.md` went unnoticed.
 *
 * Turn it on with either:
 *
 *   localStorage.setItem('toolbox.traceRpc', '1')   // then reload
 *   window.__toolbox.hub.setTrace(true)             // this session only
 *
 * **The identity printed is the one the CALLER CLAIMED.** Deliberate: a
 * `__host__` showing up in a plugin's call is the exact shape of the forgery
 * described in that audit, and printing it is what would make it obvious.
 */
let TRACE = false;
try {
  TRACE = globalThis.localStorage?.getItem('toolbox.traceRpc') === '1';
} catch {
  /* no localStorage (node --test) — tracing stays off */
}

/**
 * Where trace lines go.
 *
 * A sink, not a direct call: `hub` is the bottom of the stack and must not
 * import the boot path (that would be circular, and it would put a webview-side
 * concern inside the protocol layer). `boot.js` installs a sink that writes to
 * the debug log — the same shape as `setToastSink` in `store.js`: the lower
 * layer owns *when*, the shell owns *how*.
 */
let traceSink = (line) => console.info('[trace]', line);

export function setTraceSink(fn) {
  const previous = traceSink;
  traceSink = typeof fn === 'function' ? fn : (line) => console.info('[trace]', line);
  return previous;
}

/** Avoid a feedback loop: the sink writes through the gateway. */
const TRACE_EXEMPT = (svc, act) => svc === 'host' && act === 'write_debug_log';

export class MessageHub {
  constructor() {
    /** `${pluginId}/${ch}` -> live stream handle, so a leak is visible. */
    this.streams = new Map();
    /** `${pluginId}` -> unsubscribe fns, torn down with the plugin. */
    this.subscriptions = new Map();
  }

  // ------------------------------ control plane ------------------------------

  /**
   * One request/response round trip through the gateway.
   * `opts.timeoutMs` bounds how long the CALLER waits (0 = forever); it cannot
   * cancel the host, which is why the timeout lives here and not in the envelope.
   */
  request(pluginId, svc, act, params = null, opts = {}) {
    const p = transport('rpc').request({ pluginId, svc, act, params, ...opts });
    if (!TRACE || TRACE_EXEMPT(svc, act)) return p;

    const t0 = performance.now();
    return p.then(
      (res) => {
        traceSink(`rpc -> ${pluginId} ${svc}/${act} ${Math.round(performance.now() - t0)}ms ok`);
        return res;
      },
      (err) => {
        // A denial arrives as a REJECTED promise carrying the service's own
        // message, so the outcome is the interesting half of the line.
        traceSink(
          `rpc -> ${pluginId} ${svc}/${act} ${Math.round(performance.now() - t0)}ms ` +
            `err: ${err?.message ?? err}`,
        );
        throw err;
      },
    );
  }

  /**
   * Point the trace somewhere else.
   *
   * Exposed as a METHOD (not just the module function) so it can be reached
   * from `window.__toolbox.hub` — otherwise verifying the trace means importing
   * the module a second time, which under Vite yields a DIFFERENT instance and
   * silently observes nothing. That cost an hour once; it will not again.
   */
  setTraceSink(fn) {
    return setTraceSink(fn);
  }

  /** Turn tracing on/off for this session. See `TRACE` above. */
  setTrace(on) {
    TRACE = !!on;
    try {
      globalThis.localStorage?.setItem('toolbox.traceRpc', TRACE ? '1' : '0');
    } catch {
      /* node --test */
    }
    return TRACE;
  }

  get tracing() {
    return TRACE;
  }

  // ------------------------------- data plane --------------------------------

  /**
   * Open a push stream over an explicit scheme. Callers normally use the
   * `sidecar()` / `pty()` helpers; this is the escape hatch for experiments.
   */
  async stream(
    pluginId,
    schemeId,
    { provider, ch, params = null, onFrame, onEnd, requires = Capability.PUSH } = {},
  ) {
    assertSupports(schemeId, requires);
    if (!ch) throw ProtocolError.protocol('stream requires a channel id');

    const key = `${pluginId}/${ch}`;
    if (this.streams.has(key)) {
      throw ProtocolError.protocol(`stream \`${key}\` is already open`);
    }

    const t = transport(schemeId);
    // A fast producer can emit its terminal frame WHILE `open` is still
    // awaiting (a short-lived pty, a sidecar that exits immediately). Track
    // that, or the entry re-added below would leak forever.
    let settled = false;
    const finish = (env) => {
      settled = true;
      this.streams.delete(key);
      onEnd?.(env);
    };
    const handle = await t.open({ pluginId, provider, ch, params, onFrame, onEnd: finish });
    if (!settled) this.streams.set(key, handle);
    return handle;
  }

  /** Talk to a helper executable shipped inside the plugin folder. */
  sidecar(pluginId, ch, { exe, args, pollMs, timeoutMs, onFrame, onEnd } = {}) {
    return this.stream(pluginId, 'stdio-line', {
      provider: 'sidecar',
      ch,
      params: { exe, args, pollMs, timeoutMs },
      onFrame,
      onEnd,
    });
  }

  /** Run a command-line subprocess in a pseudo-terminal. */
  /**
   * Open an UPLINK stream: the plugin pushes frames to a host-side sink.
   *
   * The handle has the same shape as every other stream (`send` / `close`),
   * plus `sendBatch` — which is the point: the old way to feed a backend was one
   * `rpc` per frame. See transports/channelIn.js for why the carrier is batched
   * invoke rather than a Channel.
   */
  uplink(pluginId, ch, { sink, params = null, onEnd } = {}) {
    return this.stream(pluginId, 'channel-in', {
      provider: 'plugin',
      ch,
      params: { sink, params },
      onEnd,
      requires: Capability.UPLINK,
    });
  }

  pty(pluginId, ch, { program, args, cwd, env, cols, rows, onFrame, onEnd } = {}) {
    return this.stream(pluginId, 'pty-stream', {
      provider: 'pty',
      ch,
      params: { program, args, cwd, env, cols, rows },
      onFrame,
      onEnd,
    });
  }

  /** Explicitly cancel a stream (also happens automatically on its terminal frame). */
  async close(pluginId, ch) {
    const key = `${pluginId}/${ch}`;
    const handle = this.streams.get(key);
    if (!handle) return false;
    await handle.close?.();
    this.streams.delete(key);
    return true;
  }

  /** Live endpoints the host knows about — sidecars, streams and ptys alike. */
  sessions(pluginId) {
    return this.request(pluginId, 'host', 'sessions');
  }

  // ------------------------------- broadcast ---------------------------------

  /**
   * Publish to every window. `scheme` defaults to the cross-window bus; pass
   * 'in-process' when the message genuinely cannot leave this window.
   */
  publish(pluginId, topic, payload = null, { scheme = 'event-bus' } = {}) {
    return transport(scheme).publish({ pluginId, topic, payload });
  }

  /**
   * Subscribe. Defaults to the cross-window bus so the same code works in the
   * main window and in a secondary window.
   */
  async subscribe(pluginId, topic, onEvent, { scheme = 'event-bus' } = {}) {
    assertSupports(scheme, Capability.PUSH);
    const sub = await transport(scheme).subscribe({ pluginId, topic, onEvent });
    if (!this.subscriptions.has(pluginId)) this.subscriptions.set(pluginId, []);
    this.subscriptions.get(pluginId).push(sub.unsubscribe);
    return sub.unsubscribe;
  }

  /** Same-window, zero-IPC event (a thin alias that makes the intent explicit). */
  local(pluginId, topic, onEvent) {
    return this.subscribe(pluginId, topic, onEvent, { scheme: 'in-process' });
  }

  /**
   * Subscribe for exactly one delivery. Same signature as `subscribe`, so a
   * caller can swap between them — and between schemes — without changing shape.
   */
  async once(pluginId, topic, onEvent, { scheme = 'event-bus' } = {}) {
    let off;
    off = await this.subscribe(
      pluginId,
      topic,
      (payload) => {
        off?.();
        onEvent(payload);
      },
      { scheme },
    );
    return off;
  }

  /**
   * What the host supports: protocol version, every service with its actions,
   * and the stream providers (from the native side) plus the scheme table (from
   * here). This is the negotiation surface — a plugin asks what exists instead
   * of discovering the surface by failing.
   */
  async schema(pluginId) {
    const host = await this.request(pluginId, 'host', 'schema');
    return { ...host, schemes: describeSchemes(), transports: transportIds() };
  }

  /** Drop every subscription a plugin registered. */
  dropSubscriptions(pluginId) {
    const fns = this.subscriptions.get(pluginId) ?? [];
    for (const off of fns) {
      try {
        off();
      } catch {
        /* already gone */
      }
    }
    this.subscriptions.delete(pluginId);
  }

  // ------------------------------ introspection -------------------------------

  /** The scheme table, for the diagnostics view. */
  schemes() {
    return describeSchemes();
  }

  /** Descriptor of the scheme a given helper would use (used by tests/docs). */
  schemeFor(kind) {
    const map = {
      request: 'rpc',
      sidecar: 'stdio-line',
      pty: 'pty-stream',
      broadcast: 'event-bus',
      local: 'in-process',
    };
    return descriptor(map[kind] ?? kind);
  }

  openStreamKeys() {
    return [...this.streams.keys()];
  }

  transports() {
    return transportIds();
  }
}

export const hub = new MessageHub();
export { Envelope, ProtocolError };
