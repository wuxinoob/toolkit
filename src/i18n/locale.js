// No Vue or host kernel dependencies: usable by every WebView entry.
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'];

export function resolveSystemLocale(tag = '') {
  try {
    const locale = new Intl.Locale(tag.replaceAll('_', '-'));
    if (locale.language === 'zh' && (locale.script === 'Hans' ||
      (!locale.script && ['CN', 'SG'].includes(locale.region)))) return 'zh-CN';
  } catch { /* Unknown system language uses the English fallback. */ }
  return 'en-US';
}

export function defaultSnapshot(systemLocale = '') {
  return { mode: 'system', locale: 'en-US', resolvedLocale: resolveSystemLocale(systemLocale), revision: 0 };
}
export function isLocaleSnapshot(value) {
  return !!value && SUPPORTED_LOCALES.includes(value.resolvedLocale) &&
    SUPPORTED_LOCALES.includes(value.locale) && ['system', 'manual'].includes(value.mode) &&
    Number.isSafeInteger(value.revision) && value.revision > 0;
}

// Subscribe before reading, then reject stale replies. A delayed read must not
// overwrite a newer native event or write the preference back to the host.
export function createLocaleClient({ read, write, subscribe, initial, changed }) {
  let snapshot = initial;
  let starting;
  let off;
  let stopped = false;
  function accept(next) {
    if (stopped || !isLocaleSnapshot(next) || next.revision <= snapshot.revision) return;
    snapshot = Object.freeze({ ...next });
    changed(snapshot);
  }
  return {
    accept,
    get snapshot() { return snapshot; },
    start() {
      return starting ??= (async () => {
        off = await subscribe(accept);
        if (stopped) { off(); return; }
        accept(await read());
        return snapshot;
      })().catch(error => { off?.(); starting = undefined; throw error; });
    },
    async refresh() { accept(await read()); return snapshot; },
    async set(value) {
      if (value !== 'system' && !SUPPORTED_LOCALES.includes(value)) throw new Error('Unsupported language');
      accept(await write({ mode: value === 'system' ? 'system' : 'manual', locale: value === 'system' ? snapshot.locale : value }));
      return snapshot;
    },
    stop() { stopped = true; off?.(); },
  };
}
