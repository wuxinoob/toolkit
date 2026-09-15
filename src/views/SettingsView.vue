<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';

import { store, saveSettings, toast } from '../host/store.js';
import { applySummonShortcut } from '../host/boot.js';
import { activate, deactivate, enabledIds, saveEnabled } from '../host/lifecycle.js';
import { resolveBuiltin } from '../host/registry.js';
import { scanExternalPlugins, getExternal } from '../host/external.js';
import { events } from '../host/events.js';
import { hub } from '../protocol/hub.js';

const shortcut = ref(store.settings.summonShortcut);
const saved = ref(false);
const scanning = ref(false);
const liveSessions = ref([]);

async function saveHotkey() {
  store.settings.summonShortcut = shortcut.value.trim();
  saveSettings();
  await applySummonShortcut();
  saved.value = true;
  setTimeout(() => (saved.value = false), 1500);
}

const pluginRows = computed(() =>
  store.plugins.map((p) => ({
    id: p.manifest.id,
    name: p.manifest.name,
    version: p.manifest.version,
    builtin: p.manifest.builtin,
    status: p.status,
    error: p.error,
    enabled: p.status === 'active',
    permissions: (p.manifest.permissions || []).join(', ') || '—',
  })),
);

async function togglePlugin(row) {
  const mod = resolveBuiltin(row.id) || getExternal(row.id);
  if (!mod) {
    toast('Plugin not loaded yet — use Rescan first', 'error');
    return;
  }
  if (row.enabled) await deactivate(mod);
  else await activate(mod);
  saveEnabled(store.plugins.filter((p) => p.status === 'active').map((p) => p.manifest.id));
}

async function rescan() {
  scanning.value = true;
  try {
    const n = (await scanExternalPlugins({ silent: false })).length;
    toast(`Scan complete: ${n} external plugin(s) found`, 'info');
  } finally {
    scanning.value = false;
  }
}

function openPluginsDir() {
  invoke('plugin_open_dir').catch((e) => toast(String(e), 'error'));
}

/** The host's unified session registry — one list for every transport. */
async function refreshSessions() {
  try {
    liveSessions.value = await hub.request('__host__', 'host', 'sessions');
  } catch (e) {
    liveSessions.value = [];
    console.error('[settings] session list failed', e);
  }
}

/* ---------- contributed settings forms (manifest.contributes.settings) ---------- */

const forms = ref({}); // pluginId -> { schema, values }

async function loadForms() {
  for (const p of store.plugins) {
    const schema = p.manifest?.contributes?.settings;
    if (!schema?.length || forms.value[p.manifest.id]) continue;
    let current = null;
    try {
      current = await hub.request(p.manifest.id, 'storage', 'get', { key: 'settings' });
    } catch {
      /* plugin storage may not exist yet */
    }
    const values = {};
    for (const f of schema) values[f.key] = current?.[f.key] ?? f.default ?? null;
    forms.value[p.manifest.id] = { schema, values };
  }
}

function saveField(pluginId, field, value) {
  const form = forms.value[pluginId];
  form.values[field.key] = value;
  hub
    .request(pluginId, 'storage', 'set', { key: 'settings', value: { ...form.values } })
    .then(() => events.emit(`settings:changed:${pluginId}`))
    .catch((e) => toast(`Settings save failed: ${e}`, 'error'));
}

const pluginsWithForms = computed(() =>
  store.plugins.filter((p) => p.manifest?.contributes?.settings?.length),
);

function optionValue(opt) {
  return typeof opt === 'string' ? opt : opt.value;
}
function optionLabel(opt) {
  return typeof opt === 'string' ? opt : opt.label;
}

onMounted(() => {
  loadForms();
  refreshSessions();
});
watch(() => store.plugins.length, loadForms);
</script>

<template>
  <div class="settings">
    <h2>Settings</h2>

    <section>
      <h3>Global hotkey</h3>
      <p class="hint">Summon the main window, e.g. Ctrl+Alt+T (uses the global-shortcut plugin).</p>
      <div class="row">
        <input v-model="shortcut" placeholder="Ctrl+Alt+T" spellcheck="false" />
        <button @click="saveHotkey">Apply</button>
        <span v-if="saved" class="ok">saved</span>
      </div>
    </section>

    <section>
      <h3>Message plane</h3>
      <p class="hint">
        Every scheme the host has registered. A plugin declares <em>what</em> it needs; the hub
        resolves the transport and codec from this table.
      </p>
      <table>
        <thead>
          <tr><th>id</th><th>transport · codec</th><th>Direction</th><th>Capabilities</th><th>Note</th></tr>
        </thead>
        <tbody>
          <tr v-for="s in store.schemes" :key="s.id">
            <td><code>{{ s.id }}</code></td>
            <td>{{ s.label }}</td>
            <td class="dim">{{ s.direction }}</td>
            <td class="dim">{{ s.capabilities }}</td>
            <td class="dim">{{ s.note }}</td>
          </tr>
        </tbody>
      </table>
      <div class="row" style="margin-top:10px;">
        <button @click="refreshSessions">Refresh live sessions</button>
        <span class="dim">{{ liveSessions.length }} live endpoint(s)</span>
      </div>
      <div v-if="liveSessions.length" class="sessions">
        <div v-for="s in liveSessions" :key="s.id" class="session-row">
          <code>{{ s.id }}</code>
          <span class="dim">{{ s.kind }}</span>
          <span class="dim">pid={{ s.pid ?? '—' }}</span>
          <span class="dim">{{ s.bytesOut }}B</span>
        </div>
      </div>
    </section>

    <section>
      <h3>External plugins</h3>
      <p class="hint">
        Drop a folder containing <code>plugin.json</code> + a single-file ESM entry into the plugins
        directory, then rescan. No host code changes needed.
      </p>
      <div class="row">
        <button :disabled="scanning" @click="rescan">{{ scanning ? 'Scanning…' : 'Rescan plugins' }}</button>
        <button @click="openPluginsDir">Open plugins directory</button>
      </div>
    </section>

    <section v-if="pluginsWithForms.length">
      <h3>Plugin settings</h3>
      <div v-for="p in pluginsWithForms" :key="p.manifest.id" class="form-card">
        <div class="form-title">{{ p.manifest.name }}</div>
        <template v-if="p.status === 'active'">
          <label v-for="f in forms[p.manifest.id]?.schema || []" :key="f.key" class="form-field">
            <span>{{ f.label }}</span>
            <select
              v-if="f.type === 'select'"
              :value="forms[p.manifest.id].values[f.key]"
              @change="saveField(p.manifest.id, f, $event.target.value)"
            >
              <option v-for="opt in f.options || []" :key="optionValue(opt)" :value="optionValue(opt)">
                {{ optionLabel(opt) }}
              </option>
            </select>
            <input
              v-else-if="f.type === 'boolean'"
              type="checkbox"
              :checked="!!forms[p.manifest.id].values[f.key]"
              @change="saveField(p.manifest.id, f, $event.target.checked)"
            />
            <input
              v-else
              :type="f.type === 'number' ? 'number' : 'text'"
              :value="forms[p.manifest.id].values[f.key]"
              :min="f.min"
              :max="f.max"
              @change="saveField(p.manifest.id, f, f.type === 'number' ? Number($event.target.value) : $event.target.value)"
            />
          </label>
        </template>
        <p v-else class="hint">Enable this plugin to edit its settings.</p>
      </div>
    </section>

    <section>
      <h3>Plugins</h3>
      <p class="hint">Enable/disable installed plugins. Disabled plugins release all listeners, streams and DOM.</p>
      <table>
        <thead>
          <tr><th>Plugin</th><th>Version</th><th>Type</th><th>Status</th><th>Permissions</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="row in pluginRows" :key="row.id">
            <td>
              {{ row.name }}
              <span v-if="row.error" class="err"> — {{ row.error }}</span>
            </td>
            <td>{{ row.version }}</td>
            <td class="dim">{{ row.builtin ? 'built-in' : 'external' }}</td>
            <td>{{ row.status }}</td>
            <td class="dim">{{ row.permissions }}</td>
            <td><button @click="togglePlugin(row)">{{ row.enabled ? 'Disable' : 'Enable' }}</button></td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.settings { max-width: 820px; display: flex; flex-direction: column; gap: 22px; }
h2 { margin: 0; }
h3 { margin: 0 0 4px; }
.hint { opacity: .6; font-size: 12.5px; margin: 0 0 10px; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
input, select {
  background: #111318; color: #dfe3ea; border: 1px solid #2a2f3a;
  border-radius: 6px; padding: 6px 10px;
}
button { cursor: pointer; padding: 5px 12px; background: #1d2230; color: #dfe3ea; border: 1px solid #2a2f3a; border-radius: 6px; }
button:disabled { opacity: .5; cursor: default; }
.ok { color: #9fe8a9; font-size: 12px; }
.err { color: #ff9aa8; font-size: 12px; }
.dim { opacity: .55; font-size: 11.5px; }
code { background: #1a1f2d; padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #232838; }
th { opacity: .6; font-weight: 400; font-size: 12px; }
.sessions { margin-top: 8px; background: #0d0f13; border: 1px solid #2a2f3a; border-radius: 6px; padding: 6px; }
.session-row { display: flex; gap: 12px; align-items: center; padding: 3px 4px; font-size: 12px; }
.form-card {
  background: #12161f; border: 1px solid #232838; border-radius: 10px;
  padding: 14px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 10px;
}
.form-title { font-weight: 500; }
.form-field { display: flex; align-items: center; gap: 12px; }
.form-field span { min-width: 160px; opacity: .85; }
</style>
