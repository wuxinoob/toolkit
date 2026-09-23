<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';

import { store, saveSettings, toast } from '../host/store.js';
import { setHotkey } from '../host/lifecycle.js';
import { applySummonShortcut } from '../host/boot.js';
import { activate, deactivate, saveEnabled } from '../host/lifecycle.js';
import { resolveBuiltin } from '../host/registry.js';
import { scanExternalPlugins, getExternal } from '../host/external.js';
import { events } from '../host/events.js';
import { hub } from '../protocol/hub.js';
import { getResolvedTheme, getThemePref, onThemeChange, setTheme } from '../host/theme.js';

import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const shortcut = ref(store.settings.summonShortcut);
const saved = ref(false);
const scanning = ref(false);
const liveSessions = ref([]);

/* --------------------------------- appearance -------------------------------- */

const THEMES = [
  { value: 'system', label: 'System', icon: '🖥' },
  { value: 'light', label: 'Light', icon: '☀' },
  { value: 'dark', label: 'Dark', icon: '🌙' },
];

const themePref = ref(getThemePref());
const resolvedTheme = ref(getResolvedTheme());
// Keeps the control honest when the OS flips while on "System", or when another
// window changes the preference.
const offTheme = onThemeChange((pref, resolved) => {
  themePref.value = pref;
  resolvedTheme.value = resolved;
});
onUnmounted(offTheme);

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

/**
 * Status reads as a badge variant, so a broken plugin is visible without
 * reading text — and the variant is the library's, not a hand-rolled class.
 */
const statusVariant = (status) =>
  status === 'active' ? 'secondary' : status === 'error' ? 'destructive' : 'outline';

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

/**
 * Every hotkey any plugin has DECLARED, with the user's state for it.
 *
 * A plugin's `contributes.hotkeys` entry is a request, not a registration —
 * nothing reaches the OS until the switch below is on. That is why this list is
 * built from the MANIFESTS rather than from what is registered: an action that
 * is declared-but-off must still be visible, or the user could never turn it on.
 */
const declaredHotkeys = computed(() => {
  const rows = [];
  for (const p of store.plugins) {
    for (const hk of p.manifest?.contributes?.hotkeys ?? []) {
      if (!hk?.action) continue;
      const composite = `${p.manifest.id}:${hk.action}`;
      const entry = store.settings.hotkeys[composite] ?? { key: hk.key, enabled: false };
      rows.push({
        composite,
        pluginId: p.manifest.id,
        pluginName: p.manifest.name ?? p.manifest.id,
        action: hk.action,
        key: entry.key ?? hk.key ?? '',
        enabled: !!entry.enabled,
        error: entry.error ?? null,
      });
    }
  }
  return rows;
});

/** Per-row busy flag, so one slow registration does not disable every row. */
const hotkeyBusy = ref('');

/**
 * Apply a change and show what ACTUALLY happened.
 *
 * `setHotkey` can fail — the OS refuses a key another application already owns.
 * The entry keeps the user's choice either way and reports the failure, because
 * silently showing "on" for a shortcut that never registered is the worst of
 * both worlds: the user waits for a hotkey that will never fire.
 */
async function applyHotkey(row, { key = null, enabled = null }) {
  hotkeyBusy.value = row.composite;
  try {
    await setHotkey(row.pluginId, row.action, { key, enabled });
    toast(key !== null ? `Bound ${row.action} to ${key}` : `${row.action} ${enabled ? 'on' : 'off'}`);
  } catch (e) {
    toast(`Hotkey failed: ${e?.message ?? e}`, 'error');
  } finally {
    hotkeyBusy.value = '';
  }
}

/** Commit a typed key on blur or Enter — not on every keystroke. */
function commitKey(row, event) {
  const next = String(event.target.value ?? '').trim();
  if (!next || next === row.key) return;
  applyHotkey(row, { key: next });
}

/**
 * Autostart lives in the OS, not in our settings.
 *
 * The registry is the source of truth — a user can turn the entry off from Task
 * Manager without telling us — so this is read back rather than remembered.
 * `null` means "not asked yet", which is different from `false`.
 */
const autostart = ref(null);
const autostartBusy = ref(false);

async function loadAutostart() {
  try {
    const state = await invoke('host_autostart_get');
    // Anything that is not a real boolean is a failed read, not a "false".
    // In a plain browser (no host) invoke resolves with undefined, and showing
    // "does not start with the system" for that would be a confident lie.
    autostart.value = typeof state === 'boolean' ? state : null;
  } catch (e) {
    // A dev run without the plugin, or a policy that blocks the query. Not
    // worth a toast; the row just says it could not be read.
    console.warn('[settings] autostart query failed', e);
    autostart.value = null;
  }
}

async function setAutostart(enabled) {
  autostartBusy.value = true;
  try {
    // The command re-reads the OS state and returns THAT, because enabling can
    // fail silently under some Windows policies. Showing the requested value
    // would be a lie the user only discovers at the next reboot.
    const state = await invoke('host_autostart_set', { enabled });
    autostart.value = typeof state === 'boolean' ? state : null;
    toast(autostart.value ? 'Toolbox will start with the system' : 'Autostart off');
  } catch (e) {
    toast(`Autostart failed: ${e?.message ?? e}`, 'error');
    await loadAutostart();
  } finally {
    autostartBusy.value = false;
  }
}

onMounted(loadAutostart);
</script>

<template>
  <div class="mx-auto flex max-w-[900px] flex-col gap-4">
    <header class="flex items-end gap-3">
      <h1 class="m-0 text-[17px] font-medium">Settings</h1>
      <span class="pb-[2px] text-xs text-muted-foreground">
        {{ store.plugins.length }} plugin(s) installed
      </span>
    </header>

    <Card>
      <CardHeader>
        <CardTitle>Startup</CardTitle>
        <CardDescription>
          Whether Toolbox launches with the system. This is an OS setting, not an app setting — it is
          read back from the system each time, so turning it off elsewhere shows up here too.
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-wrap items-center gap-3">
        <Switch
          :model-value="autostart === true"
          :disabled="autostart === null || autostartBusy"
          aria-label="Start Toolbox with the system"
          @update:model-value="setAutostart"
        />
        <span class="text-sm">
          <template v-if="autostart === null">Could not read the autostart state</template>
          <template v-else-if="autostart">Starts with the system</template>
          <template v-else>Does not start with the system</template>
        </span>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Hotkeys</CardTitle>
        <CardDescription>
          What each plugin has asked for. A declaration is only a request — nothing is bound to the
          system until you switch it on here, so a plugin cannot take a global shortcut just by being
          installed. Edit a key and press Enter to rebind it.
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-2">
        <div
          v-if="!declaredHotkeys.length"
          class="text-xs text-muted-foreground"
        >
          No plugin has declared a hotkey.
        </div>
        <div
          v-for="row in declaredHotkeys"
          :key="row.composite"
          class="flex flex-wrap items-center gap-3 rounded-md border p-2"
        >
          <Switch
            :model-value="row.enabled"
            :disabled="hotkeyBusy === row.composite"
            :aria-label="`Enable ${row.action} for ${row.pluginName}`"
            @update:model-value="(v) => applyHotkey(row, { enabled: v })"
          />
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm">{{ row.action }}</div>
            <div class="truncate text-xs text-muted-foreground">{{ row.pluginName }}</div>
          </div>
          <input
            class="tb-input tb-mono w-[190px] text-xs"
            :value="row.key"
            :disabled="hotkeyBusy === row.composite"
            spellcheck="false"
            placeholder="ctrl+alt+k"
            @blur="commitKey(row, $event)"
            @keydown.enter="commitKey(row, $event)"
          />
          <span v-if="row.error" class="w-full text-xs text-destructive">Not registered: {{ row.error }}</span>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>
          A theme is one attribute on the root element, so it reaches everything at once — the shell,
          the built-in views, and any external plugin that styles itself with the shared tokens.
          Nothing reloads.
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-wrap items-center gap-2">
        <Button
          v-for="t in THEMES"
          :key="t.value"
          :variant="themePref === t.value ? 'default' : 'outline'"
          size="sm"
          :aria-pressed="themePref === t.value"
          @click="setTheme(t.value)"
        >
          <span aria-hidden="true">{{ t.icon }}</span>
          {{ t.label }}
        </Button>
        <span class="ml-1 text-xs text-muted-foreground">
          showing <strong class="text-foreground">{{ resolvedTheme }}</strong>
        </span>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Global hotkey</CardTitle>
        <CardDescription>
          Summons the main window from anywhere, e.g.
          <kbd
            class="rounded border border-b-2 bg-secondary px-1.5 py-px font-mono text-[11px] text-muted-foreground"
            >Ctrl+Alt+T</kbd
          >.
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-wrap items-center gap-2">
        <Input v-model="shortcut" class="max-w-[220px]" placeholder="Ctrl+Alt+T" spellcheck="false" />
        <Button @click="saveHotkey">Apply</Button>
        <span v-if="saved" class="text-xs text-primary">saved</span>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Message plane</CardTitle>
        <CardDescription>
          Every scheme the host has registered. A plugin declares <em>what</em> it needs; the hub
          resolves the transport and codec from this table.
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-3">
        <div class="flex items-center gap-2">
          <Button variant="outline" size="sm" @click="refreshSessions">Refresh sessions</Button>
          <Badge variant="outline">{{ liveSessions.length }} live</Badge>
        </div>

        <div class="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>id</TableHead>
                <TableHead>transport · codec</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>Capabilities</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="s in store.schemes" :key="s.id">
                <TableCell><code class="font-mono text-xs text-primary">{{ s.id }}</code></TableCell>
                <TableCell>{{ s.label }}</TableCell>
                <TableCell class="text-xs text-muted-foreground">{{ s.direction }}</TableCell>
                <TableCell class="text-xs text-muted-foreground">{{ s.capabilities }}</TableCell>
                <TableCell class="text-xs text-muted-foreground">{{ s.note }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <div v-if="liveSessions.length" class="flex flex-col rounded-md border p-2">
          <div v-for="s in liveSessions" :key="s.id" class="flex items-center gap-3 text-xs">
            <code class="font-mono">{{ s.id }}</code>
            <Badge variant="outline">{{ s.kind }}</Badge>
            <span class="text-muted-foreground">pid {{ s.pid ?? '—' }}</span>
            <span class="text-muted-foreground">{{ s.bytesOut }} B</span>
          </div>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>External plugins</CardTitle>
        <CardDescription>
          Drop a folder with <code class="font-mono text-xs">plugin.json</code> + a single-file ESM
          entry into the plugins directory, then rescan. A rescan reloads what changed and unloads
          what was deleted — no restart, no host code changes.
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-wrap gap-2">
        <Button :disabled="scanning" @click="rescan">
          {{ scanning ? 'Scanning…' : 'Rescan plugins' }}
        </Button>
        <Button variant="outline" @click="openPluginsDir">Open plugins directory</Button>
      </CardContent>
    </Card>

    <Card v-if="pluginsWithForms.length">
      <CardHeader>
        <CardTitle>Plugin settings</CardTitle>
        <CardDescription>
          Forms declared by plugins via <code class="font-mono text-xs">contributes.settings</code>.
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <template v-for="(p, i) in pluginsWithForms" :key="p.manifest.id">
          <Separator v-if="i > 0" />
          <div class="flex flex-col gap-2">
            <div class="text-[12.5px] font-medium">{{ p.manifest.name }}</div>
            <template v-if="p.status === 'active'">
              <div
                v-for="f in forms[p.manifest.id]?.schema || []"
                :key="f.key"
                class="flex max-w-[420px] flex-col gap-1.5"
              >
                <Label :for="`${p.manifest.id}-${f.key}`">{{ f.label }}</Label>

                <Select
                  v-if="f.type === 'select'"
                  :model-value="forms[p.manifest.id].values[f.key]"
                  @update:model-value="saveField(p.manifest.id, f, $event)"
                >
                  <SelectTrigger :id="`${p.manifest.id}-${f.key}`" class="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      v-for="opt in f.options || []"
                      :key="optionValue(opt)"
                      :value="optionValue(opt)"
                    >
                      {{ optionLabel(opt) }}
                    </SelectItem>
                  </SelectContent>
                </Select>

                <div v-else-if="f.type === 'boolean'" class="flex items-center gap-2">
                  <Checkbox
                    :id="`${p.manifest.id}-${f.key}`"
                    :model-value="!!forms[p.manifest.id].values[f.key]"
                    @update:model-value="saveField(p.manifest.id, f, $event)"
                  />
                  <span class="text-xs text-muted-foreground">
                    {{ forms[p.manifest.id].values[f.key] ? 'on' : 'off' }}
                  </span>
                </div>

                <Input
                  v-else
                  :id="`${p.manifest.id}-${f.key}`"
                  :type="f.type === 'number' ? 'number' : 'text'"
                  :model-value="forms[p.manifest.id].values[f.key]"
                  :min="f.min"
                  :max="f.max"
                  @update:model-value="
                    saveField(p.manifest.id, f, f.type === 'number' ? Number($event) : $event)
                  "
                />
              </div>
            </template>
            <p v-else class="m-0 text-xs text-muted-foreground">
              Enable this plugin to edit its settings.
            </p>
          </div>
        </template>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Plugins</CardTitle>
        <CardDescription>
          Enable or disable an installed plugin. A disabled plugin releases its listeners, streams
          and DOM.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div class="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plugin</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Permissions</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="row in pluginRows" :key="row.id">
                <TableCell>
                  {{ row.name }}
                  <span v-if="row.error" class="text-xs text-destructive">— {{ row.error }}</span>
                </TableCell>
                <TableCell class="text-xs text-muted-foreground">{{ row.version }}</TableCell>
                <TableCell class="text-xs text-muted-foreground">
                  {{ row.builtin ? 'built-in' : 'external' }}
                </TableCell>
                <TableCell>
                  <Badge :variant="statusVariant(row.status)">{{ row.status }}</Badge>
                </TableCell>
                <TableCell class="text-xs text-muted-foreground">{{ row.permissions }}</TableCell>
                <TableCell class="text-right">
                  <Button variant="outline" size="sm" @click="togglePlugin(row)">
                    {{ row.enabled ? 'Disable' : 'Enable' }}
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
