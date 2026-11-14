import { invoke } from '@tauri-apps/api/core';
import { hub } from '../protocol/hub.js';
import { protocolContract } from '../protocol/contract.js';
import { Code } from '../protocol/codes.js';
import { ProtocolError } from '../protocol/errors.js';
import { openBinaryTransfer } from '../protocol/transports/binaryTransfer.js';
import { fileAccess } from './file-access.js';

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
    binary: { open: openBinary },
    fs: {
      open: (options) => selectFile(false, options),
      createWriter: (options) => selectFile(true, options),
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
      capture: (opts = {}) => bytes('screen', 'capture', opts),
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
