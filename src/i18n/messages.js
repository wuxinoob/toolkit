// Plugin dictionaries contain plain strings, not Vue/compiler output or HTML.
export function translate(messages, locale, key, params = {}, fallbackLocale = 'en-US', fallback = key) {
  const locales = [...new Set([locale, locale.split('-')[0], fallbackLocale])];
  let message;
  for (const language of locales) {
    const candidate = messages?.[language]?.[key];
    if (typeof candidate === 'string') { message = candidate; break; }
  }
  if (message === undefined) return fallback;
  return message.replace(/\{([a-zA-Z0-9_]+)\}/g, (placeholder, name) =>
    Object.hasOwn(params, name) ? String(params[name] ?? '') : placeholder);
}

export function manifestText(manifest, key, locale, fallback) {
  if (!key) return fallback;
  return translate(manifest.i18n?.messages, locale, key, {}, manifest.i18n?.fallbackLocale ?? 'en-US', fallback);
}
