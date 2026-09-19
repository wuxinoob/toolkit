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

/** Status reads as a badge, so a broken plugin is visible without reading text. */
const statusClass = (status) =>
  status === 'active'
    ? 'tb-badge tb-badge-ok'
    : status === 'error'
      ? 'tb-badge tb-badge-bad'
      : 'tb-badge';

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
    // The summary says what CHANGED, not just how many folders exist — that was
    // the same number whether the rescan did anything or not.
    const r = await scanExternalPlugins({ silent: false });
    const parts = [];
    if (r.added.length) parts.push(`${r.added.length} added`);
    if (r.reloaded.length) parts.push(`${r.reloaded.length} reloaded`);
    if (r.removed.length) parts.push(`${r.removed.length} removed`);
    if (r.failed.length) parts.push(`${r.failed.length} failed`);
    const detail = parts.length ? ` — ${parts.join(', ')}` : ' — no changes';
    toast(`Scan: ${r.found} external plugin(s)${detail}`, r.failed.length ? 'error' : 'info');
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
  <div class="mx-auto flex max-w-[900px] flex-col gap-4">
    <header class="flex items-end gap-3">
      <h1 class="m-0 text-[17px] font-semibold">Settings</h1>
      <span class="tb-hint pb-[2px]">{{ store.plugins.length }} plugin(s) installed</span>
    </header>

    <section class="tb-card">
      <div class="tb-card-head">Global hotkey</div>
      <div class="tb-card-body flex flex-col gap-3">
        <p class="tb-hint m-0">
          Summons the main window from anywhere, e.g. <span class="tb-kbd">Ctrl+Alt+T</span>.
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <input v-model="shortcut" class="tb-input max-w-[220px]" placeholder="Ctrl+Alt+T" spellcheck="false" />
          <button class="tb-btn tb-btn-primary" @click="saveHotkey">Apply</button>
          <span v-if="saved" class="text-[12px]" style="color: var(--color-success)">saved</span>
        </div>
      </div>
    </section>

    <section class="tb-card">
      <div class="tb-card-head">
        Message plane
        <button class="tb-btn tb-btn-sm ml-auto" @click="refreshSessions">Refresh sessions</button>
        <span class="tb-badge">{{ liveSessions.length }} live</span>
      </div>
      <div class="tb-card-body flex flex-col gap-3">
        <p class="tb-hint m-0">
          Every scheme the host has registered. A plugin declares <em>what</em> it needs; the hub
          resolves the transport and codec from this table.
        </p>
        <div class="overflow-x-auto">
          <table class="tb-table">
            <thead>
              <tr>
                <th>id</th>
                <th>transport · codec</th>
                <th>Direction</th>
                <th>Capabilities</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in store.schemes" :key="s.id">
                <td><code class="tb-mono" style="color: var(--color-brand)">{{ s.id }}</code></td>
                <td>{{ s.label }}</td>
                <td class="tb-hint">{{ s.direction }}</td>
                <td class="tb-hint">{{ s.capabilities }}</td>
                <td class="tb-hint">{{ s.note }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div
          v-if="liveSessions.length"
          class="flex flex-col gap-1 rounded-md border p-2"
          style="border-color: var(--color-line)"
        >
          <div v-for="s in liveSessions" :key="s.id" class="flex items-center gap-3 text-[12px]">
            <code class="tb-mono">{{ s.id }}</code>
            <span class="tb-badge">{{ s.kind }}</span>
            <span class="tb-hint">pid {{ s.pid ?? '—' }}</span>
            <span class="tb-hint">{{ s.bytesOut }} B</span>
          </div>
        </div>
      </div>
    </section>

    <section class="tb-card">
      <div class="tb-card-head">External plugins</div>
      <div class="tb-card-body flex flex-col gap-3">
        <p class="tb-hint m-0">
          Drop a folder with <code class="tb-mono">plugin.json</code> + a single-file ESM entry into
          the plugins directory, then rescan. A rescan reloads what changed and unloads what was
          deleted — no restart, no host code changes.
        </p>
        <div class="flex flex-wrap gap-2">
          <button class="tb-btn tb-btn-primary" :disabled="scanning" @click="rescan">
            {{ scanning ? 'Scanning…' : 'Rescan plugins' }}
          </button>
          <button class="tb-btn" @click="openPluginsDir">Open plugins directory</button>
        </div>
      </div>
    </section>

    <section v-if="pluginsWithForms.length" class="tb-card">
      <div class="tb-card-head">Plugin settings</div>
      <div class="tb-card-body flex flex-col gap-4">
        <div v-for="p in pluginsWithForms" :key="p.manifest.id" class="flex flex-col gap-2">
          <div class="text-[12.5px] font-medium">{{ p.manifest.name }}</div>
          <template v-if="p.status === 'active'">
            <label
              v-for="f in forms[p.manifest.id]?.schema || []"
              :key="f.key"
              class="tb-field max-w-[420px]"
            >
              <span class="tb-label">{{ f.label }}</span>
              <select
                v-if="f.type === 'select'"
                class="tb-select"
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
                class="tb-input"
                :type="f.type === 'number' ? 'number' : 'text'"
                :value="forms[p.manifest.id].values[f.key]"
                :min="f.min"
                :max="f.max"
                @change="
                  saveField(
                    p.manifest.id,
                    f,
                    f.type === 'number' ? Number($event.target.value) : $event.target.value,
                  )
                "
              />
            </label>
          </template>
          <p v-else class="tb-hint m-0">Enable this plugin to edit its settings.</p>
          <div class="tb-divider"></div>
        </div>
      </div>
    </section>

    <section class="tb-card">
      <div class="tb-card-head">Plugins</div>
      <div class="tb-card-body flex flex-col gap-3">
        <p class="tb-hint m-0">
          Enable or disable an installed plugin. A disabled plugin releases its listeners, streams
          and DOM.
        </p>
        <div class="overflow-x-auto">
          <table class="tb-table">
            <thead>
              <tr>
                <th>Plugin</th>
                <th>Version</th>
                <th>Type</th>
                <th>Status</th>
                <th>Permissions</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in pluginRows" :key="row.id">
                <td>
                  {{ row.name }}
                  <span v-if="row.error" class="text-[11.5px]" style="color: var(--color-danger)">
                    — {{ row.error }}
                  </span>
                </td>
                <td class="tb-hint">{{ row.version }}</td>
                <td class="tb-hint">{{ row.builtin ? 'built-in' : 'external' }}</td>
                <td><span :class="statusClass(row.status)">{{ row.status }}</span></td>
                <td class="tb-hint">{{ row.permissions }}</td>
                <td class="text-right">
                  <button class="tb-btn tb-btn-sm" @click="togglePlugin(row)">
                    {{ row.enabled ? 'Disable' : 'Enable' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  </div>
</template>
