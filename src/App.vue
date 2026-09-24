<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { toast as sonner } from 'vue-sonner';

import { store, setToastSink } from './host/store.js';
import { resolveIcon } from './host/icons.js';
import ViewHost from './components/ViewHost.vue';
import SettingsView from './views/SettingsView.vue';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Toaster } from '@/components/ui/sonner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const overlayEl = ref(null);
onMounted(() => {
  store.overlayEl = overlayEl.value;
});

/**
 * Route every toast through the shadcn toaster.
 *
 * The store owns *when* a message is raised (plugins call `ctx.ui.notify`), and
 * the shell owns *how* it is shown — so the store hands the message to whatever
 * sink is installed. That keeps `store.js` free of a renderer, which is what
 * lets the plugin/kernel tests import it under plain Node with no DOM.
 */
const previousSink = setToastSink(({ message, type }) => {
  if (type === 'error') sonner.error(message);
  else if (type === 'success') sonner.success(message);
  else sonner(message);
});
onUnmounted(() => setToastSink(previousSink));

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

/** The shell's own icons, resolved the same way a plugin's are. */
const shellIcon = (name) => resolveIcon(`lucide:${name}`);

/**
 * viewId → resolved icon component, or null meaning "render the raw glyph".
 *
 * Resolved once per render rather than inside the template: `resolveIcon` warns
 * on an unknown name, and calling it twice per row would warn twice. A plugin
 * may write `"lucide:terminal"` or keep using an emoji — both work, and an
 * unknown name falls back to a generic icon rather than leaving a hole.
 */
const viewIcons = computed(() => {
  const m = new Map();
  for (const v of store.views) m.set(v.viewId, resolveIcon(v.icon));
  return m;
});

/**
 * A nav row. `ghost` for the resting state and a tinted variant when active —
 * expressed with token utilities rather than a bespoke class, so it follows the
 * theme and `contributes.theme` overrides like everything else.
 */
const navClass = (active) =>
  cn(
    'w-full justify-start gap-2.5 px-2.5 font-normal',
    active
      ? 'bg-primary/10 text-foreground ring-1 ring-primary/30 hover:bg-primary/15'
      : 'text-muted-foreground',
  );
</script>

<template>
  <TooltipProvider :delay-duration="400">
    <div class="relative flex h-full">
      <aside class="flex w-[216px] shrink-0 flex-col border-r bg-card">
        <div class="flex items-center gap-2 px-4 pt-4 pb-3 font-medium tracking-wide">
          <span class="size-2.5 rounded-[3px] bg-primary shadow-[0_0_12px] shadow-primary/60"></span>
          Toolbox
        </div>

        <ScrollArea class="min-h-0 flex-1">
          <nav class="flex flex-col gap-0.5 px-2 pb-2">
            <!-- Where the plugin rows will appear. Saying nothing here while
                 they load looks like an empty list rather than a pending one. -->
            <div v-if="!store.booted" class="px-2.5 py-2 text-xs text-muted-foreground">
              Loading plugins…
            </div>

            <template v-for="[slot, views] in grouped" :key="slot">
              <div class="px-2.5 pt-3 pb-1 text-[10.5px] tracking-[0.6px] text-muted-foreground uppercase">
                {{ label(slot) }}
              </div>
              <Tooltip v-for="v in views" :key="v.viewId">
                <TooltipTrigger as-child>
                  <Button
                    variant="ghost"
                    size="sm"
                    :class="navClass(store.activeViewId === v.viewId)"
                    :aria-current="store.activeViewId === v.viewId"
                    @click="store.activeViewId = v.viewId"
                  >
                    <span class="flex size-[18px] shrink-0 items-center justify-center" aria-hidden="true">
                      <component :is="viewIcons.get(v.viewId)" v-if="viewIcons.get(v.viewId)" class="size-4" />
                      <span v-else>{{ v.icon }}</span>
                    </span>
                    <span class="truncate">{{ v.title }}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">{{ v.title }} — {{ v.pluginId }}</TooltipContent>
              </Tooltip>
            </template>

            <!-- The empty state lives in the content area; repeating it here
                 would just be the same sentence twice on one screen. -->
          </nav>
        </ScrollArea>

        <Separator />
        <nav class="flex flex-col p-2">
          <Button
            variant="ghost"
            size="sm"
            :class="navClass(store.activeViewId === '__settings')"
            :aria-current="store.activeViewId === '__settings'"
            @click="store.activeViewId = '__settings'"
          >
            <span class="flex size-[18px] shrink-0 items-center justify-center" aria-hidden="true">
              <component :is="shellIcon('settings')" class="size-4" />
            </span>
            <span class="truncate">Settings</span>
          </Button>
        </nav>
      </aside>

      <!--
        `relative` is load-bearing, not decoration.

        `overflow-auto` alone does NOT clip absolutely-positioned descendants:
        per spec a scroller only clips them if it is also their containing
        block, which requires `position` to be something other than `static`.
        So any `position: absolute` element a plugin view renders (reka-ui puts
        several in every slider / switch / hidden label) escaped this box,
        positioned against the `relative` wrapper instead, and grew the
        DOCUMENT's scroll height. The result was two scrollbars and a page that
        scrolled out from under the sidebar — measured at 4830px of document
        height inside a 720px viewport. With `relative`, it is 720.
      -->
      <main class="relative min-w-0 flex-1 overflow-auto p-3.5">
        <SettingsView v-if="store.activeViewId === '__settings'" />
        <ViewHost v-else-if="store.activeViewId" :view-id="store.activeViewId" />
        <!--
          Booting and empty are different states, and saying "no plugin views
          yet" while the plugins are still activating is simply wrong — it reads
          as a failure. The window is revealed as soon as the shell has painted,
          so this is on screen for the whole of `boot()`.
        -->
        <div v-else-if="!store.booted" class="flex h-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
          <component :is="shellIcon('timer')" class="size-6 opacity-50" />
          <div class="text-sm">Starting up…</div>
          <div class="text-xs">Loading plugins.</div>
        </div>
        <div v-else class="flex h-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
          <component :is="shellIcon('puzzle')" class="size-6 opacity-50" />
          <div class="text-sm">No plugin views yet</div>
          <div class="text-xs">Drop a plugin folder into the plugins directory and press Rescan.</div>
        </div>
      </main>

      <!-- Layer plugins mount overlay content into (a full-window takeover of
           their own — a reminder, a blocking prompt). -->
      <div ref="overlayEl" class="tb-overlay"></div>
      <Toaster position="bottom-right" rich-colors close-button />
    </div>
  </TooltipProvider>
</template>
