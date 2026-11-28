import { Code } from '../protocol/codes.js';
import { ProtocolError } from '../protocol/errors.js';
import { acceptLocaleSnapshot, getLocaleSnapshot, onLocaleChange } from '../i18n/state.js';
import { translate } from '../i18n/messages.js';
import { isLocaleSnapshot } from '../i18n/locale.js';

export function createPluginI18n(manifest, disposer, read) {
  const handlers = new Set();
  let stop;
  let tracked = false;
  const check = () => {
    if (disposer.closed) throw new ProtocolError(Code.NOT_FOUND, 'plugin scope is closed');
    if (!manifest.permissions?.includes('rpc:i18n')) throw new ProtocolError(Code.DENIED, 'missing permission "rpc:i18n" in manifest');
  };
  function translator(messages, fallbackLocale = 'en-US') {
    return (key, params = {}) => {
      check();
      return translate(messages, getLocaleSnapshot().resolvedLocale, key, params, fallbackLocale);
    };
  }
  return Object.freeze({
    get resolvedLocale() { check(); return getLocaleSnapshot().resolvedLocale; },
    async get() {
      check();
      const snapshot = await read();
      check();
      if (!isLocaleSnapshot(snapshot)) throw new ProtocolError(Code.PROTOCOL, 'invalid host language snapshot');
      acceptLocaleSnapshot(snapshot);
      // An event may already have delivered a newer revision than this reply.
      return getLocaleSnapshot();
    },
    t: translator(manifest.i18n?.messages, manifest.i18n?.fallbackLocale),
    createTranslator(messages, { fallbackLocale = 'en-US' } = {}) {
      check();
      return translator(messages, fallbackLocale);
    },
    onChange(fn) {
      check();
      if (typeof fn !== 'function') throw new ProtocolError(Code.BAD_PARAMS, 'i18n.onChange requires a function');
      const entry = { fn };
      handlers.add(entry);
      stop ??= onLocaleChange(snapshot => {
        for (const handler of [...handlers]) {
          if (disposer.closed || !handlers.has(handler)) continue;
          const failed = error => console.error(`[plugin:${manifest.id}] i18n listener failed`, error);
          try { Promise.resolve(handler.fn(snapshot)).catch(failed); } catch (error) { failed(error); }
        }
      });
      if (!tracked) {
        tracked = true;
        disposer.track(() => { stop?.(); stop = null; handlers.clear(); });
      }
      return () => {
        handlers.delete(entry);
        if (!handlers.size) { stop?.(); stop = null; }
      };
    },
  });
}
