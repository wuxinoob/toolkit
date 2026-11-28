import { createI18n } from 'vue-i18n';
import { getLocaleSnapshot, onLocaleChange } from './state.js';
import en from './locales/en-US/shell.json';
import zh from './locales/zh-CN/shell.json';

export const i18n = createI18n({
  legacy: false,
  locale: getLocaleSnapshot().resolvedLocale,
  fallbackLocale: 'en-US',
  messages: { 'en-US': en, 'zh-CN': zh },
  missingWarn: import.meta.env.DEV,
  fallbackWarn: import.meta.env.DEV,
});
onLocaleChange(snapshot => { i18n.global.locale.value = snapshot.resolvedLocale; });

// Page dictionaries stay in that page's async chunk, rather than in the shell.
export function addMessages(en, zh) {
  i18n.global.mergeLocaleMessage('en-US', en);
  i18n.global.mergeLocaleMessage('zh-CN', zh);
}
