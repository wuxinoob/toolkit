<script setup>
import { onMounted, reactive, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { connectionPreset, LLM_CONNECTION_PRESETS } from '../host/llm-presets.js';
import { reasoningConfig, reasoningUnavailable, setReasoningEnabled, setAllowedEfforts } from '../host/llm-reasoning.js';

const config = reactive({ connections: [], profiles: [], defaultProfile: null });
const keys = reactive({});
const hasKeys = ref({});
const plugins = ref([]);
const catalogs = reactive({});
const modelFilters = reactive({});
const modelTests = reactive({});
const savedConnections = ref({});
const savedProfiles = ref({});
const inspecting = ref(null);
const busy = ref(false);
const testing = ref(false);
const status = ref('');
const failure = ref('');
const admin = (action, params = {}) => invoke('host_llm_admin', { action, params });
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;
async function load(clearCatalogs = true) {
  const result = await admin('load');
  Object.assign(config, result.config);
  hasKeys.value = result.hasKeys;
  plugins.value = result.plugins.filter(plugin => plugin !== '__host__');
  savedConnections.value = Object.fromEntries(result.config.connections.map(connection => [connection.id, JSON.stringify(connection)]));
  savedProfiles.value = Object.fromEntries(result.config.profiles.map(profile => [profile.id, JSON.stringify(profile)]));
  for (const key of Object.keys(keys)) delete keys[key];
  for (const key of Object.keys(modelTests)) delete modelTests[key];
  if (clearCatalogs) for (const key of Object.keys(catalogs)) invalidateConnection(key);
}
async function work(action) {
  busy.value = true; failure.value = ''; status.value = '';
  try { await action(); } catch (error) { failure.value = String(error); }
  finally { busy.value = false; }
}
async function save() {
  await admin('save', JSON.parse(JSON.stringify(config)));
  for (const connection of config.connections) {
    if (keys[connection.id]) {
      const apiKey = keys[connection.id];
      keys[connection.id] = '';
      await admin('set_key', { connectionId: connection.id, apiKey });
    }
  }
  await load(false); status.value = 'Saved.';
}
function addConnection(preset) {
  config.connections.push({
    id: id('connection'),
    name: preset?.name ?? 'New connection',
    adapter: preset?.adapter ?? 'openai-chat',
    baseUrl: preset?.baseUrl ?? '',
  });
}
function addProfile(connectionId = config.connections[0]?.id ?? '', model) {
  const connection = config.connections.find(item => item.id === connectionId);
  const profile = { id: id('profile'), name: model?.name || model?.id || (connection ? `${connection.name} model` : 'New model'), connectionId, model: model?.id ?? '', maxOutputTokens: Math.min(2048, model?.maxOutputTokens ?? 2048), timeoutMs: 120000, allowImages: false, reasoning: reasoningConfig(connection, model), allowedPlugins: [] };
  config.profiles.push(profile);
  config.defaultProfile ??= profile.id;
}
function profileConnection(profile) { return config.connections.find(c => c.id === profile.connectionId); }
function enableReasoning(profile, enabled) {
  const model = catalogs[profile.connectionId]?.models.find(item => item.id === profile.model);
  setReasoningEnabled(profile, enabled, profileConnection(profile), model);
}
function removeConnection(connectionId) {
  if (config.profiles.some(profile => profile.connectionId === connectionId)) { failure.value = 'Remove or reassign the models using this connection first.'; return; }
  config.connections = config.connections.filter(connection => connection.id !== connectionId);
  delete keys[connectionId];
  invalidateConnection(connectionId);
}
function invalidateConnection(connectionId) {
  delete catalogs[connectionId];
  delete modelFilters[connectionId];
}
async function removeKey(connectionId) { await admin('delete_key', { connectionId }); hasKeys.value[connectionId] = false; delete keys[connectionId]; invalidateConnection(connectionId); status.value = 'API key removed.'; }
async function inspectConnection(connection) {
  inspecting.value = connection.id;
  invalidateConnection(connection.id);
  try {
    const params = { connection: JSON.parse(JSON.stringify(connection)) };
    if (keys[connection.id]) params.apiKey = keys[connection.id];
    catalogs[connection.id] = await admin('inspect_connection', params);
  } finally { inspecting.value = null; }
}
function filteredModels(connectionId) {
  const query = (modelFilters[connectionId] ?? '').trim().toLowerCase();
  return (catalogs[connectionId]?.models ?? []).filter(model =>
    [model.id, model.name, model.owner].some(value => value?.toLowerCase().includes(query)),
  );
}
function modelMetadata(model) {
  const details = [];
  if (model.owner) details.push(`Owner: ${model.owner}`);
  if (model.kind) details.push(`Type: ${model.kind}`);
  if (model.inputModalities) details.push(`Input: ${model.inputModalities.join(', ') || 'none'}`);
  if (model.outputModalities) details.push(`Output: ${model.outputModalities.join(', ') || 'none'}`);
  if (model.contextWindow) details.push(`Context: ${model.contextWindow.toLocaleString()} tokens`);
  if (model.maxInputTokens) details.push(`Input limit: ${model.maxInputTokens.toLocaleString()} tokens`);
  if (model.maxOutputTokens) details.push(`Output limit: ${model.maxOutputTokens.toLocaleString()} tokens`);
  if (model.declaredCapabilities) details.push(`Declared: ${Object.entries(model.declaredCapabilities).map(([name, supported]) => `${name}: ${supported ? 'yes' : 'no'}`).join(', ')}`);
  if (model.reasoningEfforts) details.push(`Effort: ${model.reasoningEfforts.join(', ') || 'none'}${model.defaultReasoningEffort ? ` (default: ${model.defaultReasoningEffort})` : ''}`);
  return details.join(' · ') || 'Capability metadata is unavailable or not recognized';
}
function isModelSaved(profile) {
  const connection = config.connections.find(item => item.id === profile.connectionId);
  return savedProfiles.value[profile.id] === JSON.stringify(profile) &&
    savedConnections.value[profile.connectionId] === JSON.stringify(connection) && !keys[profile.connectionId];
}
async function test(profile) {
  testing.value = true;
  try {
    const result = await admin('test', { profile: profile.id });
    modelTests[profile.id] = result;
    status.value = result.textVerified
      ? `Text generation verified in ${result.elapsedMs} ms.`
      : `Request completed in ${result.elapsedMs} ms without visible text (finish: ${result.finishReason}). Text output has not been verified.`;
  } finally { testing.value = false; }
}
onMounted(() => work(load));
</script>

<template>
  <main class="mx-auto flex max-w-3xl flex-col gap-5 p-6 text-sm">
    <header>
      <h1 class="text-xl font-semibold">Language models</h1>
      <p class="mt-1 text-muted-foreground">Share model connections with plugins and their Sidecars. API keys are stored in Windows Credential Manager.</p>
    </header>
    <p v-if="failure" role="alert" class="rounded-md border border-destructive p-3 text-destructive">{{ failure }}</p>
    <p v-if="status" role="status" class="rounded-md border p-3">{{ status }}</p>
    <fieldset :disabled="busy" class="flex flex-col gap-5 disabled:opacity-70">
      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between"><h2 class="font-semibold">Connections</h2><button class="tb-btn" @click="addConnection()">Custom connection</button></div>
        <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Quick connection templates">
          <span class="text-xs text-muted-foreground">Quick templates</span>
          <button v-for="preset in LLM_CONNECTION_PRESETS" :key="preset.id" class="tb-btn" @click="addConnection(preset)">{{ preset.name }}</button>
        </div>
        <p class="text-xs text-muted-foreground">Choose a template to prefill the API format and base URL, then enter your API key and add a model. All fields remain editable.</p>
        <p v-if="!config.connections.length" class="text-muted-foreground">Add an API connection or a local OpenAI-compatible server.</p>
        <article v-for="connection in config.connections" :key="connection.id" class="grid grid-cols-2 gap-3 rounded-lg border p-4">
          <label class="flex flex-col gap-1">Name<input v-model="connection.name" class="tb-input" /></label>
          <label class="flex flex-col gap-1">API format<select v-model="connection.adapter" class="tb-input" @change="invalidateConnection(connection.id)"><option value="openai-chat">OpenAI-compatible Chat Completions</option><option value="openai-responses">OpenAI Responses</option></select></label>
          <label class="col-span-2 flex flex-col gap-1">API base URL<input v-model="connection.baseUrl" class="tb-input" placeholder="https://api.openai.com/v1" spellcheck="false" @input="invalidateConnection(connection.id)" /></label>
          <p v-if="connectionPreset(connection)" class="col-span-2 text-xs text-muted-foreground">{{ connectionPreset(connection).note }}</p>
          <label class="col-span-2 flex flex-col gap-1">API key <span class="text-xs text-muted-foreground">{{ hasKeys[connection.id] ? 'A key is saved. Leave blank to keep it.' : 'No key saved. Local HTTP servers may use no key.' }}</span><input v-model="keys[connection.id]" class="tb-input" type="password" autocomplete="off" spellcheck="false" @input="invalidateConnection(connection.id)" /></label>
          <div class="col-span-2 flex flex-wrap justify-end gap-2">
            <button class="tb-btn" @click="work(() => inspectConnection(connection))">{{ inspecting === connection.id ? 'Checking…' : 'Test API & discover models' }}</button>
            <button class="tb-btn" :aria-label="`Add model for ${connection.name}`" @click="addProfile(connection.id)">Add model</button>
            <button v-if="hasKeys[connection.id]" class="tb-btn" @click="work(() => removeKey(connection.id))">Remove saved key</button>
            <button class="tb-btn" @click="removeConnection(connection.id)">Remove connection</button>
          </div>
          <p class="col-span-2 text-xs text-muted-foreground">API check reads the model catalog using the current fields, including an unsaved key. Save settings to keep your changes.</p>
          <section v-if="catalogs[connection.id]" class="col-span-2 flex flex-col gap-2 border-t pt-3" aria-live="polite">
            <p v-if="catalogs[connection.id].status === 'unsupported'" class="text-xs text-muted-foreground">The models endpoint is unavailable (HTTP {{ catalogs[connection.id].httpStatus }}). Authentication and model access have not been verified; enter a model ID manually and run a saved model test.</p>
            <template v-else>
              <p class="text-xs">Model catalog received · {{ catalogs[connection.id].models.length }} models · {{ catalogs[connection.id].elapsedMs }} ms. Generation access requires a model test.</p>
              <p v-if="catalogs[connection.id].hasMore" class="text-xs text-muted-foreground">This is a partial catalog. You can enter other model IDs manually.</p>
              <label class="flex flex-col gap-1 text-xs">Filter models<input v-model="modelFilters[connection.id]" class="tb-input" placeholder="Model ID, name or owner" /></label>
              <datalist :id="`models-${connection.id}`"><option v-for="model in catalogs[connection.id].models" :key="model.id" :value="model.id">{{ model.name }}</option></datalist>
              <ul class="max-h-64 overflow-auto rounded border" aria-label="Discovered models">
                <li v-for="model in filteredModels(connection.id).slice(0, 100)" :key="model.id" class="flex items-start gap-3 border-b p-2 last:border-0">
                  <div class="min-w-0 flex-1"><p class="break-all font-mono text-xs">{{ model.id }}</p><p v-if="model.name" class="text-xs">{{ model.name }}</p><p class="text-xs text-muted-foreground">{{ modelMetadata(model) }}</p></div>
                  <button class="tb-btn shrink-0" @click="addProfile(connection.id, model)">Use model</button>
                </li>
              </ul>
              <p class="text-xs text-muted-foreground">{{ filteredModels(connection.id).length }} matches; showing up to 100. Capabilities come from the API, not a model name guess. Catalog metadata initializes new profiles only. Configure effort defaults and plugin choices on the model card; support depends on the API and model.</p>
            </template>
          </section>
        </article>
      </section>
      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between"><h2 class="font-semibold">Models and plugin access</h2><button class="tb-btn" :disabled="!config.connections.length" @click="addProfile()">Add model</button></div>
        <article v-for="profile in config.profiles" :key="profile.id" class="grid grid-cols-2 gap-3 rounded-lg border p-4">
          <label class="flex flex-col gap-1">Name<input v-model="profile.name" class="tb-input" /></label>
          <label class="flex flex-col gap-1">Connection<select v-model="profile.connectionId" class="tb-input"><option v-for="connection in config.connections" :key="connection.id" :value="connection.id">{{ connection.name }}</option></select></label>
          <label class="col-span-2 flex flex-col gap-1">Model ID<input v-model="profile.model" :list="`models-${profile.connectionId}`" class="tb-input" placeholder="Model identifier supplied by your API service" spellcheck="false" /></label>
          <label class="flex flex-col gap-1">Maximum output tokens<input v-model.number="profile.maxOutputTokens" class="tb-input" type="number" min="1" max="32768" /></label>
          <label class="flex flex-col gap-1">Request timeout (ms)<input v-model.number="profile.timeoutMs" class="tb-input" type="number" min="1000" max="600000" /></label>
          <label class="col-span-2 flex items-center gap-2"><input v-model="profile.allowImages" type="checkbox">Allow image input (requires a vision-capable model; selected images are sent to this API)</label>
          <div class="col-span-2 flex flex-col gap-2 rounded border p-3">
            <label class="flex items-center gap-2"><input type="checkbox" :checked="!!profile.reasoning" :disabled="reasoningUnavailable(profileConnection(profile)) && !profile.reasoning" @change="enableReasoning(profile, $event.target.checked)">Configure reasoning effort for plugins</label>
            <p v-if="reasoningUnavailable(profileConnection(profile))" class="text-xs text-muted-foreground">Claude's official OpenAI-compatible endpoint ignores reasoning_effort. Keep this disabled for that connection.</p>
            <template v-if="profile.reasoning">
              <label class="flex flex-col gap-1">Allowed plugin efforts<input class="tb-input" :value="profile.reasoning.allowedEfforts.join(', ')" placeholder="low, medium, high" @change="setAllowedEfforts(profile, $event.target.value)"></label>
              <label class="flex flex-col gap-1">Default effort<select v-model="profile.reasoning.defaultEffort" class="tb-input"><option :value="null">API default (omit parameter)</option><option v-for="effort in profile.reasoning.allowedEfforts" :key="effort" :value="effort">{{ effort }}</option></select></label>
              <label v-if="profileConnection(profile)?.adapter === 'openai-chat'" class="flex flex-col gap-1">Chat output-token parameter<select v-model="profile.reasoning.chatOutputTokens" class="tb-input"><option value="max_completion_tokens">max_completion_tokens (OpenAI reasoning)</option><option value="max_tokens">max_tokens (compatible APIs, e.g. DeepSeek)</option></select></label>
              <p class="text-xs text-muted-foreground">Plugins receive these choices and inherit the default. Enable only levels supported by your API/model; configured choices do not prove remote support.</p>
            </template>
          </div>
          <div class="col-span-2 flex flex-col gap-2"><span>Allowed plugins</span><p v-if="!plugins.length" class="text-xs text-muted-foreground">No plugins are registered. Enable the plugins you want to use first.</p><label v-for="plugin in plugins" :key="plugin" class="flex items-center gap-2"><input v-model="profile.allowedPlugins" type="checkbox" :value="plugin" />{{ plugin }}</label><p class="text-xs text-muted-foreground">Access also applies to the plugin's native Sidecars. Plugins must declare rpc:llm.</p></div>
          <label class="flex items-center gap-2"><input v-model="config.defaultProfile" type="radio" :value="profile.id" />Default model</label>
          <div class="flex flex-wrap justify-end gap-2"><button class="tb-btn" :disabled="!isModelSaved(profile)" @click="work(() => test(profile))">Test saved model</button><button class="tb-btn" @click="config.profiles = config.profiles.filter(item => item.id !== profile.id); if (config.defaultProfile === profile.id) config.defaultProfile = config.profiles[0]?.id ?? null">Remove model</button></div>
          <p v-if="!isModelSaved(profile)" class="col-span-2 text-xs text-muted-foreground">Save the connection, key and model settings before testing generation.</p>
          <p v-if="modelTests[profile.id] && isModelSaved(profile)" class="col-span-2 break-words text-xs">{{ modelTests[profile.id].textVerified ? 'Text verified' : 'No visible text received' }} · {{ modelTests[profile.id].elapsedMs }} ms · Requested effort: {{ modelTests[profile.id].reasoningEffort ?? 'API default' }} · Finish: {{ modelTests[profile.id].finishReason }} · Response{{ modelTests[profile.id].previewTruncated ? ' preview (truncated)' : '' }}: {{ modelTests[profile.id].text || '(empty)' }} · Usage: {{ JSON.stringify(modelTests[profile.id].usage) }}</p>
        </article>
      </section>
      <div class="sticky bottom-0 flex items-center gap-3 border-t bg-background py-3"><button class="tb-btn" @click="work(save)">Save settings</button><button class="tb-btn" @click="work(load)">Reload saved settings</button><span class="text-xs text-muted-foreground">Save before testing. A test sends a small request to your configured service.</span></div>
    </fieldset>
    <button v-if="testing" class="tb-btn self-start" @click="admin('cancel_test').catch(error => failure = String(error))">Cancel test</button>
  </main>
</template>
