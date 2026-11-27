import { createApp } from 'vue';
import { initTheme } from './host/theme.js';
import LlmSettingsView from './views/LlmSettingsView.vue';

// This entry deliberately never loads plugin discovery, activation or the hub.
initTheme();
createApp(LlmSettingsView).mount('#app');
