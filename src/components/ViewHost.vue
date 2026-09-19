<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { store } from '../host/store.js';
import { PLUGIN_ATTR } from '../host/pluginTheme.js';

const props = defineProps({ viewId: String });
const mountEl = ref(null);

onMounted(() => renderCurrent());
onBeforeUnmount(() => teardown());
watch(
  () => props.viewId,
  () => {
    teardown();
    renderCurrent();
  },
);

function currentView() {
  return store.views.find((v) => v.viewId === props.viewId);
}

function renderCurrent() {
  const view = currentView();
  if (!view || !mountEl.value) return;
  // The scope for this plugin's `contributes.theme` overrides. Set before
  // render so the plugin's first paint is already themed; it costs nothing for
  // a plugin that declares none.
  mountEl.value.setAttribute(PLUGIN_ATTR, view.pluginId);
  try {
    view.render(mountEl.value);
  } catch (e) {
    mountEl.value.innerHTML = `<p style="color:var(--color-danger)">View render error: ${e}</p>`;
    console.error('[ViewHost] render failed', view.viewId, e);
  }
}

function teardown() {
  // Views are plain DOM renders; clearing the container releases their nodes.
  if (mountEl.value) mountEl.value.innerHTML = '';
}
</script>

<template>
  <div ref="mountEl" class="view-host" style="height: 100%;"></div>
</template>
