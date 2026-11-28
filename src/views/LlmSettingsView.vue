<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from 'vue-i18n';
import { addMessages } from '../i18n/vue.js';
import en from '../i18n/locales/en-US/llm.json';
import zh from '../i18n/locales/zh-CN/llm.json';
import { connectionPreset, LLM_CONNECTION_PRESETS } from '../host/llm-presets.js';
import { applyReasoningDeclaration, reasoningConfig, reasoningDiscovery, reasoningUnavailable, setReasoningEnabled, setAllowedEfforts } from '../host/llm-reasoning.js';

addMessages(en, zh);
const { t, n } = useI18n();
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
const status = ref(null);
const statusText = computed(() => status.value ? t(status.value.key, status.value.params ?? {}) : '');
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
  busy.value = true; failure.value = ''; status.value = null;
  try { await action(); } catch (error) { failure.value = String(error); }
  finally { busy.value = false; }
}
async function save() {
  const incomplete = config.profiles.find(profile => profile.reasoning && !profile.reasoning.allowedEfforts.length);
  if (incomplete) throw new Error(t('llm.effortsRequired', { name: incomplete.name }));
  await admin('save', JSON.parse(JSON.stringify(config)));
  for (const connection of config.connections) {
    if (keys[connection.id]) {
      const apiKey = keys[connection.id];
      keys[connection.id] = '';
      await admin('set_key', { connectionId: connection.id, apiKey });
    }
  }
  await load(false); status.value = { key: 'llm.saved' };
}
function addConnection(preset) {
  config.connections.push({
    id: id('connection'),
    name: preset?.name ?? t('llm.newConnection'),
    adapter: preset?.adapter ?? 'openai-chat',
    baseUrl: preset?.baseUrl ?? '',
  });
}
function addProfile(connectionId = config.connections[0]?.id ?? '', model) {
  const connection = config.connections.find(item => item.id === connectionId);
  const profile = { id: id('profile'), name: model?.name || model?.id || (connection ? t('llm.connectionModel', { name: connection.name }) : t('llm.newModel')), connectionId, model: model?.id ?? '', maxOutputTokens: Math.min(2048, model?.maxOutputTokens ?? 2048), timeoutMs: 120000, allowImages: false, reasoning: reasoningConfig(connection, model), allowedPlugins: [] };
  config.profiles.push(profile);
  config.defaultProfile ??= profile.id;
}
function profileConnection(profile) { return config.connections.find(c => c.id === profile.connectionId); }
function profileModel(profile) { return catalogs[profile.connectionId]?.models.find(item => item.id === profile.model); }
function profileDiscovery(profile) { return reasoningDiscovery(profileModel(profile)); }
function enableReasoning(profile, enabled) {
  setReasoningEnabled(profile, enabled, profileConnection(profile), profileModel(profile));
}
function removeConnection(connectionId) {
  if (config.profiles.some(profile => profile.connectionId === connectionId)) { failure.value = t('llm.connectionInUse'); return; }
  config.connections = config.connections.filter(connection => connection.id !== connectionId);
  delete keys[connectionId];
  invalidateConnection(connectionId);
}
function invalidateConnection(connectionId) {
  delete catalogs[connectionId];
  delete modelFilters[connectionId];
}
async function removeKey(connectionId) { await admin('delete_key', { connectionId }); hasKeys.value[connectionId] = false; delete keys[connectionId]; invalidateConnection(connectionId); status.value = { key: 'llm.keyRemoved' }; }
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
  if (model.owner) details.push(t('llm.meta_owner', { value: model.owner }));
  if (model.kind) details.push(t('llm.meta_kind', { value: model.kind }));
  if (model.inputModalities) details.push(t('llm.meta_inputModalities', { value: model.inputModalities.join(', ') || t('llm.none') }));
  if (model.outputModalities) details.push(t('llm.meta_outputModalities', { value: model.outputModalities.join(', ') || t('llm.none') }));
  if (model.contextWindow) details.push(t('llm.meta_contextWindow', { value: n(model.contextWindow) }));
  if (model.maxInputTokens) details.push(t('llm.meta_maxInputTokens', { value: n(model.maxInputTokens) }));
  if (model.maxOutputTokens) details.push(t('llm.meta_maxOutputTokens', { value: n(model.maxOutputTokens) }));
  if (model.declaredCapabilities) details.push(t('llm.metaDeclared', { value: Object.entries(model.declaredCapabilities).map(([name, supported]) => `${name}: ${supported ? t('llm.yes') : t('llm.no')}`).join(', ') }));
  const discovery = reasoningDiscovery(model);
  if (discovery.status === 'declared') details.push(t('llm.metaEffort', { value: discovery.levels.join(', '), detail: discovery.defaultEffort ? t('llm.metaDefault', { value: discovery.defaultEffort }) : '' }));
  else details.push(t(discovery.status === 'unsupported' ? 'llm.metaEffortUnsupported' : 'llm.metaEffortUnknown'));
  return details.join(' · ') || t('llm.metadataUnavailable');
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
    status.value = { key: result.textVerified ? 'llm.testVerified' : 'llm.testNoText', params: { ms: result.elapsedMs, finish: result.finishReason } };
  } finally { testing.value = false; }
}
onMounted(() => work(load));
</script>

<template>
  <main class="mx-auto flex max-w-3xl flex-col gap-5 p-6 text-sm">
    <header>
      <h1 class="text-xl font-semibold"> {{ t('llm.title') }} </h1>
      <p class="mt-1 text-muted-foreground"> {{ t('llm.description') }} </p>
    </header>
    <p v-if="failure" role="alert" class="rounded-md border border-destructive p-3 text-destructive">{{ failure }}</p>
    <p v-if="statusText" role="status" class="rounded-md border p-3">{{ statusText }}</p>
    <fieldset :disabled="busy" class="flex flex-col gap-5 disabled:opacity-70">
      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between"><h2 class="font-semibold"> {{ t('llm.connections') }} </h2><button class="tb-btn" @click="addConnection()"> {{ t('llm.customConnection') }} </button></div>
        <div class="flex flex-wrap items-center gap-2" role="group" :aria-label="t('llm.templatesAria')">
          <span class="text-xs text-muted-foreground"> {{ t('llm.templates') }} </span>
          <button v-for="preset in LLM_CONNECTION_PRESETS" :key="preset.id" class="tb-btn" @click="addConnection(preset)">{{ preset.name }}</button>
        </div>
        <p class="text-xs text-muted-foreground"> {{ t('llm.templateDescription') }} </p>
        <p v-if="!config.connections.length" class="text-muted-foreground"> {{ t('llm.noConnections') }} </p>
        <article v-for="connection in config.connections" :key="connection.id" class="grid grid-cols-2 gap-3 rounded-lg border p-4">
          <label class="flex flex-col gap-1"> {{ t('llm.name') }} <input v-model="connection.name" class="tb-input" /></label>
          <label class="flex flex-col gap-1"> {{ t('llm.format') }} <select v-model="connection.adapter" class="tb-input" @change="invalidateConnection(connection.id)"><option value="openai-chat"> {{ t('llm.chat') }} </option><option value="openai-responses"> {{ t('llm.responses') }} </option></select></label>
          <label class="col-span-2 flex flex-col gap-1"> {{ t('llm.baseUrl') }} <input v-model="connection.baseUrl" class="tb-input" placeholder="https://api.openai.com/v1" spellcheck="false" @input="invalidateConnection(connection.id)" /></label>
          <p v-if="connectionPreset(connection)" class="col-span-2 text-xs text-muted-foreground">{{ t(`llm.preset_${connectionPreset(connection).id}`) }}</p>
          <label class="col-span-2 flex flex-col gap-1"> {{ t('llm.apiKey') }} <span class="text-xs text-muted-foreground">{{ hasKeys[connection.id] ? t('llm.keySaved') : t('llm.keyMissing') }}</span><input v-model="keys[connection.id]" class="tb-input" type="password" autocomplete="off" spellcheck="false" @input="invalidateConnection(connection.id)" /></label>
          <div class="col-span-2 flex flex-wrap justify-end gap-2">
            <button class="tb-btn" @click="work(() => inspectConnection(connection))">{{ inspecting === connection.id ? t('llm.checking') : t('llm.inspect') }}</button>
            <button class="tb-btn" :aria-label="t('llm.addForConnection', { name: connection.name })" @click="addProfile(connection.id)"> {{ t('llm.addModel') }} </button>
            <button v-if="hasKeys[connection.id]" class="tb-btn" @click="work(() => removeKey(connection.id))"> {{ t('llm.removeKey') }} </button>
            <button class="tb-btn" @click="removeConnection(connection.id)"> {{ t('llm.removeConnection') }} </button>
          </div>
          <p class="col-span-2 text-xs text-muted-foreground"> {{ t('llm.inspectDescription') }} </p>
          <section v-if="catalogs[connection.id]" class="col-span-2 flex flex-col gap-2 border-t pt-3" aria-live="polite">
            <p v-if="catalogs[connection.id].status === 'unsupported'" class="text-xs text-muted-foreground">{{ t('llm.catalogUnsupported', { status: catalogs[connection.id].httpStatus }) }}</p>
            <template v-else>
              <p class="text-xs">{{ t('llm.catalogReceived', { count: catalogs[connection.id].models.length, ms: catalogs[connection.id].elapsedMs }) }}</p>
              <p v-if="catalogs[connection.id].hasMore" class="text-xs text-muted-foreground"> {{ t('llm.partialCatalog') }} </p>
              <label class="flex flex-col gap-1 text-xs"> {{ t('llm.filter') }} <input v-model="modelFilters[connection.id]" class="tb-input" :placeholder="t('llm.filterPlaceholder')" /></label>
              <datalist :id="`models-${connection.id}`"><option v-for="model in catalogs[connection.id].models" :key="model.id" :value="model.id">{{ model.name }}</option></datalist>
              <ul class="max-h-64 overflow-auto rounded border" :aria-label="t('llm.discoveredAria')">
                <li v-for="model in filteredModels(connection.id).slice(0, 100)" :key="model.id" class="flex items-start gap-3 border-b p-2 last:border-0">
                  <div class="min-w-0 flex-1"><p class="break-all font-mono text-xs">{{ model.id }}</p><p v-if="model.name" class="text-xs">{{ model.name }}</p><p class="text-xs text-muted-foreground">{{ modelMetadata(model) }}</p></div>
                  <button class="tb-btn shrink-0" @click="addProfile(connection.id, model)"> {{ t('llm.useModel') }} </button>
                </li>
              </ul>
              <p class="text-xs text-muted-foreground">{{ t('llm.catalogMatches', { count: filteredModels(connection.id).length }) }}</p>
            </template>
          </section>
        </article>
      </section>
      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between"><h2 class="font-semibold"> {{ t('llm.models') }} </h2><button class="tb-btn" :disabled="!config.connections.length" @click="addProfile()"> {{ t('llm.addModel') }} </button></div>
        <article v-for="profile in config.profiles" :key="profile.id" class="grid grid-cols-2 gap-3 rounded-lg border p-4">
          <label class="flex flex-col gap-1"> {{ t('llm.name') }} <input v-model="profile.name" class="tb-input" /></label>
          <label class="flex flex-col gap-1"> {{ t('llm.connection') }} <select v-model="profile.connectionId" class="tb-input"><option v-for="connection in config.connections" :key="connection.id" :value="connection.id">{{ connection.name }}</option></select></label>
          <label class="col-span-2 flex flex-col gap-1"> {{ t('llm.modelId') }} <input v-model="profile.model" :list="`models-${profile.connectionId}`" class="tb-input" :placeholder="t('llm.modelPlaceholder')" spellcheck="false" /></label>
          <label class="flex flex-col gap-1"> {{ t('llm.maxTokens') }} <input v-model.number="profile.maxOutputTokens" class="tb-input" type="number" min="1" max="32768" /></label>
          <label class="flex flex-col gap-1"> {{ t('llm.timeout') }} <input v-model.number="profile.timeoutMs" class="tb-input" type="number" min="1000" max="600000" /></label>
          <label class="col-span-2 flex items-center gap-2"><input v-model="profile.allowImages" type="checkbox"> {{ t('llm.allowImages') }} </label>
          <div class="col-span-2 flex flex-col gap-2 rounded border p-3">
            <label class="flex items-center gap-2"><input type="checkbox" :checked="!!profile.reasoning" :disabled="reasoningUnavailable(profileConnection(profile)) && !profile.reasoning" @change="enableReasoning(profile, $event.target.checked)"> {{ t('llm.reasoning') }} </label>
            <p v-if="profileDiscovery(profile).status === 'declared'" class="text-xs text-muted-foreground">{{ t('llm.effortsDeclared', { levels: profileDiscovery(profile).levels.join(', '), default: profileDiscovery(profile).defaultEffort ?? t('llm.defaultUnknown') }) }}</p>
            <p v-else class="text-xs text-muted-foreground">{{ t(profileDiscovery(profile).status === 'unsupported' ? 'llm.effortsUnsupported' : 'llm.effortsUnknown') }}</p>
            <div class="flex flex-wrap gap-2">
              <button v-if="profileConnection(profile)" class="tb-btn" @click="work(() => inspectConnection(profileConnection(profile)))">{{ t('llm.refreshEfforts') }}</button>
              <button v-if="profileDiscovery(profile).status === 'declared' && !reasoningUnavailable(profileConnection(profile))" class="tb-btn" @click="applyReasoningDeclaration(profile, profileConnection(profile), profileModel(profile))">{{ t('llm.applyEfforts') }}</button>
            </div>
            <p class="text-xs text-muted-foreground">{{ t('llm.reasoningSource') }}</p>
            <p class="text-xs text-muted-foreground"> {{ t('llm.reasoningDescription') }} </p>
            <p v-if="reasoningUnavailable(profileConnection(profile))" class="text-xs text-muted-foreground"> {{ t('llm.claudeReasoning') }} </p>
            <template v-if="profile.reasoning">
              <label class="flex flex-col gap-1"> {{ t('llm.allowedEfforts') }} <input class="tb-input" :value="profile.reasoning.allowedEfforts.join(', ')" :placeholder="t('llm.effortsPlaceholder')" :aria-invalid="!profile.reasoning.allowedEfforts.length" @change="setAllowedEfforts(profile, $event.target.value)"></label>
              <p v-if="!profile.reasoning.allowedEfforts.length" class="text-xs text-destructive">{{ t('llm.effortsRequired', { name: profile.name }) }}</p>
              <label class="flex flex-col gap-1"> {{ t('llm.defaultEffort') }} <select v-model="profile.reasoning.defaultEffort" class="tb-input"><option :value="null"> {{ t('llm.apiDefault') }} </option><option v-for="effort in profile.reasoning.allowedEfforts" :key="effort" :value="effort">{{ effort }}</option></select></label>
              <p class="text-xs text-muted-foreground">{{ t('llm.apiDefaultHint') }}</p>
              <label v-if="profileConnection(profile)?.adapter === 'openai-chat'" class="flex flex-col gap-1"> {{ t('llm.chatTokens') }} <select v-model="profile.reasoning.chatOutputTokens" class="tb-input"><option value="max_completion_tokens"> {{ t('llm.completionTokens') }} </option><option value="max_tokens"> {{ t('llm.compatibleTokens') }} </option></select></label>
            </template>
          </div>
          <div class="col-span-2 flex flex-col gap-2"><span> {{ t('llm.allowedPlugins') }} </span><p v-if="!plugins.length" class="text-xs text-muted-foreground"> {{ t('llm.noPlugins') }} </p><label v-for="plugin in plugins" :key="plugin" class="flex items-center gap-2"><input v-model="profile.allowedPlugins" type="checkbox" :value="plugin" />{{ plugin }}</label><p class="text-xs text-muted-foreground"> {{ t('llm.permissionDescription') }} </p></div>
          <label class="flex items-center gap-2"><input v-model="config.defaultProfile" type="radio" :value="profile.id" /> {{ t('llm.defaultModel') }} </label>
          <div class="flex flex-wrap justify-end gap-2"><button class="tb-btn" :disabled="!isModelSaved(profile)" @click="work(() => test(profile))"> {{ t('llm.testModel') }} </button><button class="tb-btn" @click="config.profiles = config.profiles.filter(item => item.id !== profile.id); if (config.defaultProfile === profile.id) config.defaultProfile = config.profiles[0]?.id ?? null"> {{ t('llm.removeModel') }} </button></div>
          <p v-if="!isModelSaved(profile)" class="col-span-2 text-xs text-muted-foreground"> {{ t('llm.saveBeforeTest') }} </p>
          <p v-if="modelTests[profile.id] && isModelSaved(profile)" class="col-span-2 break-words text-xs">{{ t('llm.responseSummary', { verified: modelTests[profile.id].textVerified ? t('llm.textVerified') : t('llm.noText'), ms: modelTests[profile.id].elapsedMs, effort: modelTests[profile.id].reasoningEffort ?? t('llm.default'), finish: modelTests[profile.id].finishReason, response: modelTests[profile.id].previewTruncated ? t('llm.responseTruncated') : t('llm.response'), text: modelTests[profile.id].text || t('llm.empty'), usage: JSON.stringify(modelTests[profile.id].usage) }) }}</p>
        </article>
      </section>
      <div class="sticky bottom-0 flex items-center gap-3 border-t bg-background py-3"><button class="tb-btn" @click="work(save)"> {{ t('llm.save') }} </button><button class="tb-btn" @click="work(load)"> {{ t('llm.reload') }} </button><span class="text-xs text-muted-foreground"> {{ t('llm.testDescription') }} </span></div>
    </fieldset>
    <button v-if="testing" class="tb-btn self-start" @click="admin('cancel_test').catch(error => failure = String(error))"> {{ t('llm.cancel') }} </button>
  </main>
</template>
