<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { store } from '../host/store.js';
import { PLUGIN_ATTR } from '../host/pluginTheme.js';

/**
 * One container PER VIEW, keyed by viewId — not one reused container.
 *
 * This is not tidiness, it fixes a real bug: a plugin that redraws on its own
 * schedule (a log panel appending a line, a terminal resizing) keeps a
 * reference to the element it was handed, and with a SHARED container that
 * reference stays live after the user switches away. The next redraw then
 * writes into the container that now belongs to a different plugin, so the view
 * the user is looking at gets replaced by the one they left. It reads as
 * "the app jumped back to that page", which is a confusing way to learn about
 * a shared mutable reference.
 *
 * With a keyed element Vue discards the old node on switch, so a stale
 * reference points at a DETACHED element: the write still happens, and it is
 * invisible. No plugin needs to know it was unmounted, which matters because
 * there is no such notification to give it.
 */
const props = defineProps({ viewId: String });
const mountEl = ref(null);

onMounted(() => renderCurrent());
onBeforeUnmount(() => teardown());

watch(
  () => props.viewId,
  async () => {
    // The element is keyed, so Vue replaces it rather than reusing it. Wait for
    // the swap, then render into the NEW one — `mountEl.value` is stale until
    // the patch lands.
    await nextTick();
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
  // Only the CURRENT container — the previous ones were discarded by Vue when
  // the key changed, and anything still pointing at them is already detached.
  if (mountEl.value) mountEl.value.innerHTML = '';
}
</script>

<template>
  <div :key="viewId" ref="mountEl" class="view-host" style="height: 100%;"></div>
</template>
