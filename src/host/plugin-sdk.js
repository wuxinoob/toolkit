import { invoke } from '@tauri-apps/api/core';
import { hub } from '../protocol/hub.js';
import { protocolContract } from '../protocol/contract.js';
import { Code } from '../protocol/codes.js';
import { ProtocolError } from '../protocol/errors.js';
import { openBinaryTransfer, attachBinaryTransfer } from '../protocol/transports/binaryTransfer.js';
import { fileAccess } from './file-access.js';
import { createLlmClient } from './llm-client.js';
import { createPluginI18n } from './plugin-i18n.js';

/** Shared capabilities; window UI, view routing and window ownership stay out. */
export function createPluginSdk(id, manifest, disposer) {
  const prefix = `[plugin:${id}]`;
  const permissions = manifest.permissions ?? [];
  const gate = (service, fn) => permissions.includes(`rpc:${service}`)
    ? fn()
    : Promise.reject(new Error(`${prefix} missing permission "rpc:${service}" in manifest`));
  const request = (service, action, params = null, opts = {}) =>
    gate(service, () => hub.request(id, service, action, params, opts));
  const bytes = (service, action, params = null, opts = {}) =>
    gate(service, () => hub.requestBytes(id, service, action, params, opts));

  // Register ownership BEFORE awaiting: disabling a plugin while an open or
  // subscription is pending must still release the eventual resource.
  function own(pending, release) {
    disposer.track(async () => {
      let resource;
      try { resource = await pending; } catch { return; }
      await release(resource);
    });
    return pending;
  }

  const streams = new Set();
  const open = (service, start) => gate(service, () => {
    const pending = start();
    own(pending, (handle) => {
      streams.delete(handle.ch);
      return hub.close(id, handle.ch);
    });
    return pending.then((handle) => {
      if (!disposer.closed) streams.add(handle.ch);
      return handle;
    });
  });
  const subscribe = (scheme, topic, fn, once = false) =>
    own(hub[once ? 'once' : 'subscribe'](id, topic, fn, { scheme }), (off) => off());
  const publish = (scheme, topic, payload) => scheme === 'event-bus'
    ? gate('bus', () => hub.publish(id, topic, payload, { scheme }))
    : hub.publish(id, topic, payload, { scheme });
  const stream = (scheme, provider, ch, handlers) =>
    open('stream', () => hub.stream(id, scheme, { provider, ch, ...handlers }));

  const pickFile = (action, options) => gate('dialog', () => invoke('plugin_dialog', {
    pluginId: id, action, params: {
      title: options.title ?? null, multiple: !!options.multiple, folder: !!options.folder,
      directory: options.directory ?? null, filters: options.filters ?? null,
    },
  }));

  let binaryClosers;
  const openBinary = (size, opts) => gate('binary', async () => {
    if (disposer.closed) throw new ProtocolError(Code.NOT_FOUND, 'plugin scope is closed');
    if (!binaryClosers) {
      binaryClosers = new Set();
      disposer.track(() => Promise.all([...binaryClosers].map((close) => close())));
    }
    const pending = openBinaryTransfer(id, size, opts);
    const close = () => pending.then((transfer) => transfer.close(), () => false).then((result) => {
      binaryClosers.delete(close);
      return result;
    });
    binaryClosers.add(close);
    const transfer = await pending.catch((error) => {
      binaryClosers.delete(close);
      throw error;
    });
    if (disposer.closed) {
      await close();
      throw new ProtocolError(Code.NOT_FOUND, 'plugin scope closed during binary open');
    }
    return Object.freeze({ ...transfer, close });
  });

  let openFile;
  const selectFile = (write, options) => gate('fs', () => (openFile ??= fileAccess(id, disposer))(write, options));

  let resourcesTracked = false;
  const closeResource = (resourceId) => request('binary', 'close', { id: resourceId });
  function trackResources() {
    if (resourcesTracked) return;
    resourcesTracked = true;
    disposer.track(() => request('binary', 'close_all', {}));
  }

  return {
    manifest,
    protocol: protocolContract(),
    log: {
      info: (...args) => console.info(prefix, ...args),
      warn: (...args) => console.warn(prefix, ...args),
      error: (...args) => console.error(prefix, ...args),
    },
    request,
    bytes,
    i18n: createPluginI18n(manifest, disposer, () => request('i18n', 'get', {})),
    binary: {
      open: openBinary,
      async upload(raw, opts) {
        if (!(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw)) throw new ProtocolError(Code.BAD_PARAMS, 'upload requires a byte buffer');
        const bytes = new Uint8Array(raw.buffer ?? raw, raw.byteOffset ?? 0, raw.byteLength);
        const resource = await openBinary(bytes.byteLength, opts);
        try {
          for (let offset = 0; offset < bytes.length; offset += resource.maxChunkBytes) await resource.write(offset, bytes.subarray(offset, offset + resource.maxChunkBytes));
          const source = await resource.seal();
          return Object.freeze({ ...resource, source });
        } catch (error) { await resource.close().catch(() => {}); throw error; }
      },
      close: closeResource,
      identity: () => request('binary', 'identity', {}),
      export: (resourceId, {to}) => request('binary', 'export', {id:resourceId,to}),
      revoke: ({token}) => request('binary', 'revoke', {token}),
      async import({token}, opts = {}) {
        if (disposer.closed) throw new ProtocolError(Code.NOT_FOUND, 'plugin scope is closed');
        trackResources();
        const result = await request('binary','import',{token},{timeoutMs:0});
        const resource = attachBinaryTransfer(id,{id:result.source.id,maxChunkBytes:result.maxChunkBytes},opts);
        if (disposer.closed) { await resource.close(); throw new ProtocolError(Code.NOT_FOUND, 'plugin scope closed during import'); }
        return Object.freeze({...resource,source:result.source});
      },
    },
    fs: {
      open: (options) => selectFile(false, options),
      createWriter: (options) => selectFile(true, options),
    },
    llm: createLlmClient((action, params) => request('llm', action, params), disposer),
    sidecars: {
      start: ({ key, exe, args = [], hostRpc = true }) => disposer.closed
        ? Promise.reject(new ProtocolError(Code.NOT_FOUND, 'plugin scope is closed'))
        : request('proc', 'spawn', { key, exe, args, hostRpc, background: true }),
      stop: (key) => request('proc', 'kill', { key }),
      list: () => request('proc', 'list', {}),
    },
    storage: {
      get: (key) => request('storage', 'get', { key }),
      set: (key, value) => request('storage', 'set', { key, value }),
      remove: (key) => request('storage', 'remove', { key }),
      keys: () => request('storage', 'keys', {}),
    },
    clipboard: {
      read: () => request('clipboard', 'read', {}),
      write: (text) => request('clipboard', 'write', { text }),
      watch: (ch, handlers = {}) => stream('channel-json', 'clipboard', ch, handlers),
      formats: () => request('clipboard', 'formats', {}),
      readImage: (params = {}, opts = {}) => bytes('clipboard', 'readImage', params, opts),
      watchFormats: (ch, handlers = {}) => stream('channel-json', 'clipboard', ch, {
        ...handlers, params: { ...handlers.params, mode: 'formats' },
      }),
    },
    screen: {
      monitors: () => request('screen', 'monitors', {}),
      windows: (selector = {}) => request('screen', 'windows', selector),
      pointer: () => request('screen', 'pointer', {}),
      capture: (opts = {}) => bytes('screen', 'capture', opts),
      captureResource: (opts = {}) => gate('binary', () => {
        if (disposer.closed) return Promise.reject(new ProtocolError(Code.NOT_FOUND, 'plugin scope is closed'));
        trackResources();
        const pending = request('screen', 'capture_resource', opts, { timeoutMs: 0 });
        return pending.then(async result => {
          const resourceId = (result.source ?? result).id;
          if (disposer.closed) { await closeResource(resourceId); throw new ProtocolError(Code.NOT_FOUND, 'plugin scope closed during capture'); }
          return result;
        });
      }),
    },
    subscribe: (topic, fn, { scheme = 'event-bus' } = {}) => subscribe(scheme, topic, fn),
    once: (topic, fn, { scheme = 'event-bus' } = {}) => subscribe(scheme, topic, fn, true),
    publish: (topic, payload = null, { scheme = 'event-bus' } = {}) => publish(scheme, topic, payload),
    events: {
      on: (topic, fn) => subscribe('in-process', topic, fn),
      once: (topic, fn) => subscribe('in-process', topic, fn, true),
      emit: (topic, payload = null) => publish('in-process', topic, payload),
    },
    bus: {
      subscribe: (topic, fn) => subscribe('event-bus', topic, fn),
      once: (topic, fn) => subscribe('event-bus', topic, fn, true),
      publish: (topic, payload = null) => publish('event-bus', topic, payload),
    },
    onHotkey: (action, fn) => subscribe('event-bus', `hotkey:${action}`, (env) => {
      if (!env.svc || env.svc === id) fn(env);
    }),
    files: {
      pick: (options = {}) => pickFile('open', options).then((result) => result?.paths ?? []),
      sha256: (options = {}) => pickFile('sha256', options),
      save: (options = {}) => gate('dialog', () => invoke('plugin_dialog', {
        pluginId: id, action: 'save', params: {
          title: options.title ?? null, defaultPath: options.defaultPath ?? null,
        },
      })).then((result) => result?.path ?? null),
      message: (message, options = {}) => gate('dialog', () => invoke('plugin_dialog', {
        pluginId: id, action: 'message', params: { message, title: options.title ?? null },
      })),
    },
    stream: (provider, ch, handlers = {}) => stream('channel-json', provider, ch, handlers),
    streamRaw: (provider, ch, handlers = {}) => stream('channel-raw', provider, ch, handlers),
    uplink: (ch, { sink, params = null } = {}) => open('stream', () => hub.uplink(id, ch, { sink, params })),
    sidecar: (ch, opts = {}) => open('proc', () => hub.sidecar(id, ch, opts)),
    pty: (ch, opts = {}) => open('stream', () => hub.pty(id, ch, opts)),
    closeStream: (ch) => {
      if (!streams.delete(ch)) return Promise.resolve(false);
      return hub.close(id, ch);
    },
    sessions: () => request('host', 'sessions', {}),
    paths: () => request('host', 'paths', {}),
    schemes: () => hub.schemes(),
    schema: () => gate('host', () => hub.schema(id)),
    cleanup: (fn) => disposer.track(fn),
  };
}
