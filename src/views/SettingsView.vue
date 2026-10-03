<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';

import { store, saveSettings, toast } from '../host/store.js';
import { setHotkey } from '../host/lifecycle.js';
import { applySummonShortcut } from '../host/boot.js';
import { activate, deactivate, saveEnabled } from '../host/lifecycle.js';
import { Origin, originOf, pluginModule, reconcilePlugins, reloadPlugin } from '../host/plugins.js';
import { hub } from '../protocol/hub.js';
import { getResolvedTheme, getThemePref, onThemeChange, setTheme } from '../host/theme.js';
import { checkForUpdate, installUpdate, updateState } from '../host/updater.js';

import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
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
/** id of the plugin whose reload is in flight, so its button can show it. */
const reloading = ref(null);
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
    /**
     * Where this plugin came from — the catalogue's answer, not the row's.
     *
     * `manifest.builtin` and this agree by construction (both are derived from
     * the same load path), but the catalogue is the authority, and it is what
     * decides whether the reload below can re-read anything.
     */
    // Fallback for a row whose plugin never loaded (a failed external plugin has
    // a row but no catalogue entry): the row's own flag still says which kind it
    // is, so the label stays right and the click produces a real error instead
    // of a wrong-looking one.
    origin: originOf(p.id) ?? (p.manifest.builtin ? 'builtin' : 'external'),
    status: p.status,
    error: p.error,
    enabled: p.status === 'active',
    permissions: (p.manifest.permissions || []).join(', ') || '—',
    /**
     * How many endpoints this plugin currently has open — sidecars, streams and
     * ptys alike, from the host's unified registry.
     *
     * `active` says the plugin's code is running; this says what it is RUNNING.
     * A plugin can be active with nothing open, and a plugin that was just
     * disabled should read zero here — which is also how a leak becomes visible:
     * disable it, and anything still listed belongs to a teardown that missed.
     */
    sessions: liveSessions.value.filter((s) => s.plugin === p.manifest.id).length,
  })),
);

/**
 * Status reads as a badge variant, so a broken plugin is visible without
 * reading text — and the variant is the library's, not a hand-rolled class.
 */
const statusVariant = (status) =>
  status === 'active' ? 'secondary' : status === 'error' ? 'destructive' : 'outline';

async function togglePlugin(row) {
  const mod = pluginModule(row.id);
  if (!mod) {
    toast('Plugin not loaded yet — use Rescan first', 'error');
    return;
  }
  if (row.enabled) await deactivate(mod);
  else await activate(mod);
  saveEnabled(store.plugins.filter((p) => p.status === 'active').map((p) => p.manifest.id));
  // The session list is the evidence that teardown actually happened: disabling a
  // plugin should take its row's "Running" count to zero, and a count that stays
  // put is how a leak becomes visible instead of invisible.
  await refreshSessions();
}

/**
 * Load one plugin again.
 *
 * The button says two different things on purpose, because the two plugins can
 * do two different things: an **external** plugin is re-read from disk (its
 * bytes, whatever the digest says), while a **built-in** lives in the bundle and
 * can only be restarted. Calling both "Reload" would imply the built-in picks up
 * source edits, which it does not — in dev Vite has already done that.
 */
async function reloadRow(row) {
  reloading.value = row.id;
  try {
    const r = await reloadPlugin(row.id, { silent: false });
    toast(`${row.name} restarted (${r.origin})`, 'info');
    await refreshSessions();
  } catch (e) {
    toast(`${row.name}: ${e?.message ?? e}`, 'error');
  } finally {
    reloading.value = null;
  }
}

async function rescan() {
  scanning.value = true;
  try {
    // The summary says what CHANGED, not just how many folders exist — that was
    // the same number whether the rescan did anything or not.
    //
    // `sources: [EXTERNAL]` because that is what this button means: rescan the
    // plugins DIRECTORY. The built-ins have no directory to rescan.
    const { external: r } = await reconcilePlugins({ silent: false, sources: [Origin.EXTERNAL] });
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

const stopping = ref('');

/**
 * Stop ONE session, whoever owns it.
 *
 * The host action, not `stream/close`: that one is keyed by the CALLER's plugin
 * id, so this page (asking as `__host__`) would never match a plugin's session.
 * That keying is the right default for plugins — one plugin must not stop
 * another's work — which is exactly why the host needs its own door, and why
 * `host/stop_session` is host-only.
 *
 * A miss is reported rather than swallowed: "already gone" is normal (the plugin
 * closed it between the list and the click) and saying so beats a button that
 * appears to do nothing.
 */
async function stopSession(s) {
  stopping.value = s.id;
  try {
    const r = await hub.request('__host__', 'host', 'stop_session', {
      plugin: s.plugin,
      ch: s.ch,
    });
    if (!r?.stopped) toast(`${s.id} was already gone`, 'info', 2000);
    await refreshSessions();
  } catch (e) {
    toast(`Could not stop ${s.id}: ${e.message ?? e}`, 'error');
  } finally {
    stopping.value = '';
  }
}

/* ---------- contributed settings forms: REMOVED ---------- */

/*
 * There used to be a "Plugin settings" card here that rendered a form from a
 * plugin's `contributes.settings` declaration, and saved the values into that
 * plugin's own `storage` under `settings`.
 *
 * It is gone because it was never a feature — it was a demo. Checked before
 * removing: no plugin in this repo declares `contributes.settings`, no doc
 * mentions it, and the plugin-facing half (`ctx.onSettingsChanged`, which
 * listened for the `settings:changed:<id>` event this file emitted) had zero
 * users. The only declaration anywhere was in an installed `hello.demo` — a
 * leftover from an earlier round whose source is no longer in the repo — so the
 * card existed to render a form for a plugin that no longer ships.
 *
 * A plugin's own settings belong to the plugin: `ctx.storage` is namespaced per
 * plugin and always available, so a plugin that wants configurable settings
 * renders its own controls in its own view and persists them itself. That is
 * what `eyecare` does, and it needs nothing from the host.
 */

onMounted(() => {
  refreshSessions();
});

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

/** The row currently capturing a keystroke, or ''. */
const capturing = ref('');

/**
 * Turn a keydown into a Tauri `Shortcut` string, or null if it is not one yet.
 *
 * Modifier-only presses return null: the user is on the way to a combination,
 * and committing "ctrl" the moment they press it would make the field useless.
 * The combination is committed on the first NON-modifier key.
 *
 * Key names follow Tauri's `Code` enum (`ArrowUp`, `Space`, `Enter`, `F1`…),
 * which is what `parse_shortcut` on the Rust side accepts.
 */
function comboFrom(e) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;

  const parts = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey) parts.push('super');

  // A printable key arrives as the character; everything else as its code name.
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toLowerCase();

  parts.push(key);
  return parts.join('+');
}

/**
 * Handle a keystroke while the field is capturing.
 *
 * Escape leaves WITHOUT changing anything — the way out of a capture you did not
 * mean to start. Backspace/Delete clears the binding, which is how a user gets
 * rid of one they cannot press any more.
 *
 * **A caveat worth knowing**: a key that is already registered as a GLOBAL
 * hotkey will still fire at the OS level while you are capturing it — the
 * webview never sees that event, so nothing here can prevent it. Rebind the
 * offending hotkey from a field that does not use that key, or disable it
 * first.
 */
function onCaptureKey(row, event) {
  if (event.key === 'Escape') {
    capturing.value = '';
    event.target.blur();
    return;
  }
  if (event.key === 'Backspace' || event.key === 'Delete') {
    event.preventDefault();
    capturing.value = '';
    applyHotkey(row, { key: '' });
    return;
  }

  const combo = comboFrom(event);
  if (!combo) return; // still assembling modifiers

  event.preventDefault();
  capturing.value = '';
  event.target.blur();
  applyHotkey(row, { key: combo });
}

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

/* ---------------------------------- updates ---------------------------------- */

/**
 * 更新检查在启动时已经静默跑过一次（见 `host/boot.js`），这里只负责"再问一次"
 * 与"装不装"。装是全局且不可逆的动作（会停掉所有子进程、替换应用并重启），
 * 确认框在 `installUpdate` 里，界面这一层绕不过去。
 */
const updateResult = ref(updateState.result);
const updateBusy = ref(false);
// `updateState` 是普通对象，模板读它不会触发重渲染 —— 失败信息必须自己拿一份 ref。
const updateError = ref(updateState.error);

async function checkUpdates() {
  updateBusy.value = true;
  try {
    // 手动点的时候不静默：失败要说出来，否则按钮看起来像没反应。
    updateResult.value = (await checkForUpdate({ silent: false })) ?? updateResult.value;
    updateError.value = updateState.error;
  } finally {
    updateBusy.value = false;
  }
}

async function installUpdateNow() {
  updateBusy.value = true;
  try {
    const result = await installUpdate();
    if (result?.cancelled) return;
    updateError.value = updateState.error;
    if (result?.installed === false && result.reason === 'up to date') {
      toast('已经是最新版本');
      updateResult.value = { ...(updateResult.value ?? {}), available: false };
    }
    // 安装成功后进程会被替换并重启，通常执行不到这里。
    updateResult.value = updateState.result;
  } finally {
    updateBusy.value = false;
  }
}
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
        <CardTitle>Updates</CardTitle>
        <CardDescription>
          Toolbox checks the release feed quietly on startup and says nothing unless there is
          something new. Installing stops every running process first, then replaces the app and
          restarts it.
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-sm text-muted-foreground">
            Version <span class="font-mono">{{ updateResult?.current ?? '—' }}</span>
          </span>
          <Button variant="outline" size="sm" :disabled="updateBusy" @click="checkUpdates">
            {{ updateBusy ? 'Working…' : 'Check for updates' }}
          </Button>
          <Button
            v-if="updateResult?.available"
            variant="default"
            size="sm"
            :disabled="updateBusy"
            @click="installUpdateNow"
          >
            Install {{ updateResult.version }} and restart
          </Button>
        </div>
        <p class="text-xs text-muted-foreground">
          <template v-if="updateError">Last check failed: {{ updateError }}</template>
          <template v-else-if="updateResult?.available">
            {{ updateResult.version }} is available.
            <template v-if="updateResult.notes">{{ updateResult.notes }}</template>
          </template>
          <template v-else-if="updateResult">Up to date.</template>
          <template v-else>Not checked yet.</template>
        </p>
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
          <!--
            Click to capture. Typing a combination binds it; Escape leaves it
            alone. `readonly` while capturing so the browser cannot insert the
            characters into the field — the value shown is the binding, not what
            was typed.
          -->
          <input
            class="tb-input tb-mono w-[190px] text-xs"
            :class="capturing === row.composite ? 'ring-2 ring-primary/40' : ''"
            :value="capturing === row.composite ? '' : row.key"
            :placeholder="capturing === row.composite ? 'press a combination…' : 'click to set'"
            :readonly="capturing === row.composite"
            :disabled="hotkeyBusy === row.composite"
            spellcheck="false"
            autocomplete="off"
            @focus="capturing = row.composite"
            @blur="capturing = ''"
            @keydown="onCaptureKey(row, $event)"
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

        <div v-if="liveSessions.length" class="flex flex-col gap-1 rounded-md border p-2">
          <div v-for="s in liveSessions" :key="s.id" class="flex items-center gap-3 text-xs">
            <Badge variant="outline">{{ s.kind }}</Badge>
            <code class="font-mono">{{ s.id }}</code>
            <span class="text-muted-foreground">pid {{ s.pid ?? '—' }}</span>
            <span class="text-muted-foreground">{{ s.bytesOut }} B</span>
            <Button
              variant="outline"
              size="sm"
              class="ml-auto"
              :disabled="stopping === s.id"
              @click="stopSession(s)"
            >
              Stop
            </Button>
          </div>
        </div>
        <p v-else class="text-xs text-muted-foreground">
          Nothing running. A live sidecar, stream or pty appears here, whichever transport opened it.
        </p>
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
                <TableHead>Running</TableHead>
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
                <TableCell class="text-xs text-muted-foreground">
                  {{ row.sessions ? `${row.sessions} live` : '—' }}
                </TableCell>
                <TableCell class="text-xs text-muted-foreground">{{ row.permissions }}</TableCell>
                <TableCell class="text-right">
                  <!--
                    Two labels, one action: an external plugin is re-read from
                    disk; a built-in lives in the bundle and can only be
                    restarted. See reloadRow().
                  -->
                  <Button
                    variant="ghost"
                    size="sm"
                    class="mr-2"
                    :disabled="reloading === row.id"
                    @click="reloadRow(row)"
                  >
                    {{ reloading === row.id ? '…' : row.origin === 'external' ? 'Reload' : 'Restart' }}
                  </Button>
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
