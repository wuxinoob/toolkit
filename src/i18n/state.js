import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createLocaleClient, defaultSnapshot } from './locale.js';

const listeners = new Set();
const initial = defaultSnapshot(globalThis.navigator?.language);
const PREVIEW_KEY = 'toolkit.preview.language';
const native = isTauri();
function previewRead() {
  let pref;
  try { pref = JSON.parse(localStorage.getItem(PREVIEW_KEY) || 'null'); } catch { /* Preview only. */ }
  const current = client.snapshot;
  return { ...initial, ...pref, resolvedLocale: pref?.mode === 'manual' ? pref.locale : defaultSnapshot(globalThis.navigator?.language).resolvedLocale, revision: current.revision + 1 };
}
const client = createLocaleClient({
  initial,
  read: () => native ? invoke('host_locale_get') : Promise.resolve(previewRead()),
  write: async preference => {
    if (native) return invoke('host_locale_set', { preference });
    localStorage.setItem(PREVIEW_KEY, JSON.stringify(preference));
    return previewRead();
  },
  subscribe: native ? async accept => listen('host:locale-changed', event => accept(event.payload)) : async accept => {
    const handler = event => { if (event.key === PREVIEW_KEY) accept(previewRead()); };
    globalThis.addEventListener?.('storage', handler);
    return () => globalThis.removeEventListener?.('storage', handler);
  },
  changed(snapshot) {
    paint(snapshot);
    for (const fn of [...listeners]) {
      try { fn(snapshot); } catch (error) { console.error('[locale] listener failed', error); }
    }
  },
});
function paint(snapshot) {
  if (globalThis.document?.documentElement) document.documentElement.lang = snapshot.resolvedLocale;
}
export const getLocaleSnapshot = () => client.snapshot;
export const acceptLocaleSnapshot = snapshot => client.accept(snapshot);
export const setLocale = value => client.set(value);
export function onLocaleChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let initialized;
let lifecycleInstalled = false;
export function initLocale() {
  paint(client.snapshot);
  if (!lifecycleInstalled) {
    const refresh = () => client.refresh().catch(error => console.warn('[locale] refresh failed', error));
    globalThis.addEventListener?.('languagechange', refresh);
    globalThis.addEventListener?.('beforeunload', () => { client.stop(); globalThis.removeEventListener?.('languagechange', refresh); }, { once: true });
    lifecycleInstalled = true;
  }
  return initialized ??= client.start().catch(error => { initialized = undefined; console.warn('[locale] initialization failed', error); });
}
