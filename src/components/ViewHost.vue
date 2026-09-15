<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { store } from '../host/store.js';

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
  try {
    view.render(mountEl.value);
  } catch (e) {
    mountEl.value.innerHTML = `<p style="color:#ff9aa8">View render error: ${e}</p>`;
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
