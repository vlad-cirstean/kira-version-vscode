<script setup lang="ts">
import type { Transport } from "@kira-version/ipc";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { BridgeClient } from "./bridge/client.ts";
import { ACTION_ICONS } from "./icons/index.ts";

const props = defineProps<{ transport: Transport }>();

const bridge = new BridgeClient(props.transport);
const connectionState = bridge.connectionState;

const detailOpen = ref(true);

onMounted(() => {
  // requestAnimationFrame so the mark lands after the browser has actually painted this
  // frame, not merely after Vue's synchronous mount work.
  requestAnimationFrame(() => {
    performance.mark("kira:first-paint");
    performance.measure("kira:first-paint", undefined, "kira:first-paint");
    // P0 has no real graph layout (§5.2 lands from P4) — this marks the placeholder shell
    // as "laid out" so the perf harness has a real third point to measure from day one.
    performance.mark("kira:layout-complete");
    performance.measure("kira:layout-complete", undefined, "kira:layout-complete");
  });
});

onBeforeUnmount(() => {
  bridge.dispose();
});
</script>

<template>
  <div class="kv-app" :data-connection-state="connectionState">
    <header class="kv-toolbar" role="toolbar" aria-label="Kira Version toolbar">
      <button type="button" class="kv-icon-button" aria-label="Refresh">
        <span class="codicon" :class="ACTION_ICONS.refresh" aria-hidden="true"></span>
      </button>
      <button type="button" class="kv-icon-button" aria-label="Search">
        <span class="codicon" :class="ACTION_ICONS.search" aria-hidden="true"></span>
      </button>
      <span class="kv-connection-state" data-testid="connection-state">{{ connectionState }}</span>
    </header>

    <main class="kv-body">
      <section class="kv-graph-region" data-testid="graph-region" aria-label="Commit graph"></section>
      <aside
        v-if="detailOpen"
        class="kv-detail-region"
        data-testid="detail-region"
        aria-label="Commit detail"
      ></aside>
    </main>
  </div>
</template>

<style>
.kv-app {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background-color: var(--kv-app-bg);
  color: var(--kv-app-fg);
  font-family: var(--kv-font-family);
  font-size: var(--kv-font-size);
}

.kv-toolbar {
  display: flex;
  align-items: center;
  gap: var(--kv-space-2);
  height: var(--kv-toolbar-height);
  padding: 0 var(--kv-space-3);
  background-color: var(--kv-toolbar-bg);
  border-bottom: 1px solid var(--kv-toolbar-border);
  flex-shrink: 0;
}

.kv-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--kv-radius);
  background: transparent;
  color: var(--kv-app-fg);
  cursor: pointer;
}

.kv-icon-button:hover {
  background-color: var(--kv-row-hover-bg);
}

.kv-icon-button:focus-visible {
  outline: 1px solid var(--kv-focus-border);
  outline-offset: -1px;
}

.kv-connection-state {
  margin-left: auto;
  font-size: var(--kv-mono-font-size);
  color: var(--kv-app-fg);
  opacity: 0.7;
}

.kv-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.kv-graph-region {
  flex: 1;
  min-width: 0;
  background-color: var(--kv-panel-bg);
}

.kv-detail-region {
  width: 380px;
  flex-shrink: 0;
  border-left: 1px solid var(--kv-panel-border);
  background-color: var(--kv-panel-bg);
}
</style>
