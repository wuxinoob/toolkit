<script setup>
import { onMounted, ref, watch } from 'vue';
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
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">Toolbox</div>
      <nav>
        <button
          v-for="v in store.views"
          :key="v.viewId"
          class="nav-item"
          :class="{ active: store.activeViewId === v.viewId }"
          :title="`${v.title} — ${v.pluginId}`"
          @click="store.activeViewId = v.viewId"
        >
          <span class="icon">{{ v.icon }}</span>
          <span>{{ v.title }}</span>
        </button>
        <button
          class="nav-item"
          :class="{ active: store.activeViewId === '__settings' }"
          @click="store.activeViewId = '__settings'"
        >
          <span class="icon">⚙</span>
          <span>Settings</span>
        </button>
      </nav>
    </aside>

    <main class="content">
      <SettingsView v-if="store.activeViewId === '__settings'" />
      <ViewHost v-else-if="store.activeViewId" :view-id="store.activeViewId" />
      <div v-else class="empty">No plugin views enabled yet</div>
    </main>

    <div class="toasts">
      <div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.type">
        {{ t.message }}
      </div>
    </div>

    <!-- top overlay layer reserved for plugins (eyecare break screen, ...) -->
    <div ref="overlayEl" class="plugin-overlay"></div>
  </div>
</template>

<style>
* { box-sizing: border-box; }
html, body, #app { height: 100%; margin: 0; }
body {
  background: #0d1017;
  color: #dfe3ea;
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 14px;
}
.shell { display: flex; height: 100%; position: relative; }
.sidebar {
  width: 200px;
  background: #10131b;
  border-right: 1px solid #232838;
  display: flex;
  flex-direction: column;
}
.brand { font-weight: 500; letter-spacing: .5px; padding: 16px 16px 12px; color: #8ab4ff; }
.sidebar nav { display: flex; flex-direction: column; gap: 2px; padding: 0 8px; }
.nav-item {
  display: flex; align-items: center; gap: 10px;
  background: none; border: none; color: #b7bfd0;
  padding: 9px 10px; border-radius: 8px; cursor: pointer; text-align: left; font-size: 14px;
}
.nav-item:hover { background: #1a1f2d; }
.nav-item.active { background: #232b42; color: #fff; }
.icon { width: 20px; text-align: center; }
.content { flex: 1; min-width: 0; padding: 18px; overflow: auto; }
.empty { opacity: .5; display: grid; place-items: center; height: 100%; }
.toasts {
  position: fixed; right: 16px; bottom: 16px; z-index: 10000;
  display: flex; flex-direction: column; gap: 8px; max-width: 380px;
}
.toast {
  background: #1c2230; border: 1px solid #2c3450; border-radius: 8px;
  padding: 10px 14px; font-size: 13px;
}
.toast.error { border-color: #7a3040; color: #ff9aa8; }
.toast.info { color: #cdd6e4; }
.plugin-overlay { position: relative; z-index: 9999; }
</style>
