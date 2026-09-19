<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { store } from './host/store.js';
import ViewHost from './components/ViewHost.vue';
import SettingsView from './views/SettingsView.vue';

const overlayEl = ref(null);
onMounted(() => {
  store.overlayEl = overlayEl.value;
});

watch(
  () => store.views.length,
  (n) => {
    if (!store.activeViewId && n > 0) store.activeViewId = store.views[0].viewId;
  },
);

/** Views grouped by the slot they declared, so the sidebar can label them. */
const grouped = computed(() => {
  const bySlot = new Map();
  for (const v of store.views) {
    const slot = v.slot || 'tool';
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(v);
  }
  return [...bySlot.entries()];
});

const SLOT_LABEL = { tool: 'Tools', panel: 'Panels', system: 'System' };
const label = (slot) => SLOT_LABEL[slot] ?? slot;
</script>

<template>
  <div class="tb-shell">
    <aside class="tb-sidebar">
      <div class="tb-brand">Toolbox</div>

      <nav class="tb-nav">
        <template v-for="[slot, views] in grouped" :key="slot">
          <div class="tb-nav-group">{{ label(slot) }}</div>
          <button
            v-for="v in views"
            :key="v.viewId"
            class="tb-nav-item"
            :aria-current="store.activeViewId === v.viewId"
            :title="`${v.title} — ${v.pluginId}`"
            @click="store.activeViewId = v.viewId"
          >
            <span class="tb-icon">{{ v.icon }}</span>
            <span>{{ v.title }}</span>
          </button>
        </template>
      </nav>

      <nav class="tb-nav" style="margin-top: auto">
        <button
          class="tb-nav-item"
          :aria-current="store.activeViewId === '__settings'"
          @click="store.activeViewId = '__settings'"
        >
          <span class="tb-icon">⚙</span>
          <span>Settings</span>
        </button>
      </nav>
    </aside>

    <main class="tb-content">
      <SettingsView v-if="store.activeViewId === '__settings'" />
      <ViewHost v-else-if="store.activeViewId" :view-id="store.activeViewId" />
      <div v-else class="tb-empty">
        <div style="font-size: 22px; opacity: 0.5">🧩</div>
        <div>No plugin views yet</div>
        <div class="tb-hint">Drop a plugin folder into the plugins directory and press Rescan.</div>
      </div>
    </main>

    <div class="tb-toasts">
      <div
        v-for="t in store.toasts"
        :key="t.id"
        class="tb-toast"
        :class="t.type === 'error' ? 'tb-toast-error' : t.type === 'success' ? 'tb-toast-success' : ''"
      >
        {{ t.message }}
      </div>
    </div>

    <!-- Layer plugins mount overlay content into (eyecare's break screen, …). -->
    <div ref="overlayEl" class="tb-overlay"></div>
  </div>
</template>
