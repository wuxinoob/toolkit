import { createApp } from 'vue';
import { initTheme } from './host/theme.js';
import { initLocale } from './i18n/state.js';
import { i18n } from './i18n/vue.js';
import LlmSettingsView from './views/LlmSettingsView.vue';

// This entry deliberately never loads plugin discovery, activation or the hub.
initTheme();
initLocale();
createApp(LlmSettingsView).use(i18n).mount('#app');
