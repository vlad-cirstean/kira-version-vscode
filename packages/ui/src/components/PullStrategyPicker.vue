<script setup lang="ts">
/**
 * `docs/plans/P8.md` W17: the toolbar's Pull control — a split button, `[Pull] [▾]`, mirroring
 * `BranchPicker.vue`'s own trigger/panel shape but at toolbar scale. The main button runs Pull
 * following the resolved default (§7.3's ladder, no override); the chevron opens a small popover
 * offering the three explicit strategies plus that same default, each running Pull immediately
 * on selection rather than staging a separate confirm step — a second click to *run* what the
 * user just picked would be friction §7.3 never asked for (only "show it before it runs", which
 * `OpsState.runPull` already guarantees by resolving-then-announcing before `remote.run`).
 *
 * The popover's own "Default" row previews the ladder's live resolution (`previewPullStrategy`)
 * the moment it opens — a read, not a commitment — so a user who has never run Pull this session
 * still sees "rebase, from your pull.rebase setting" before choosing anything.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { PullStrategy, PullStrategySource } from "@kira-version/ipc";
import type { OpsState } from "../state/ops.ts";
import { describePullStrategySource, PULL_STRATEGY_LABELS } from "./pullStrategyModel.ts";

const props = defineProps<{
  ops: OpsState;
  remote: string;
  branch: string;
  disabled: boolean;
}>();

const isOpen = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const preview = ref<{ strategy: PullStrategy; source: PullStrategySource } | undefined>(undefined);
const previewLoading = ref(false);

const lastRun = computed(() => props.ops.pullStrategy.value);
const mainLabel = computed(() => "Pull");
const mainTitle = computed(() => {
  const last = lastRun.value;
  return last
    ? `Pull — last ran ${PULL_STRATEGY_LABELS[last.strategy]} (${describePullStrategySource(last.source)})`
    : "Pull — resolves a strategy from your git configuration before running (§7.3)";
});

const STRATEGIES: readonly PullStrategy[] = ["ff-only", "merge", "rebase"];

function onDocumentClick(event: MouseEvent): void {
  if (rootEl.value && !rootEl.value.contains(event.target as Node)) close();
}

function close(): void {
  isOpen.value = false;
  document.removeEventListener("mousedown", onDocumentClick);
}

async function toggle(): Promise<void> {
  if (isOpen.value) {
    close();
    return;
  }
  isOpen.value = true;
  document.addEventListener("mousedown", onDocumentClick);
  previewLoading.value = true;
  try {
    const pre = await props.ops.previewPullStrategy(props.branch);
    if (pre) preview.value = { strategy: pre.strategy, source: pre.source };
  } finally {
    previewLoading.value = false;
  }
}

watch(
  () => props.branch,
  () => {
    preview.value = undefined;
  },
);

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocumentClick);
});

async function runDefault(): Promise<void> {
  close();
  await props.ops.runPull(props.remote, props.branch);
}

async function runWith(strategy: PullStrategy): Promise<void> {
  close();
  await props.ops.runPull(props.remote, props.branch, strategy);
}
</script>

<template>
  <div ref="rootEl" class="kv-pull-picker">
    <button
      type="button"
      class="kv-toolbar-button kv-pull-picker-main"
      :disabled="disabled"
      :title="mainTitle"
      data-testid="pull-button"
      @click="runDefault"
    >
      <span class="codicon codicon-repo-pull" aria-hidden="true"></span>
      <span>{{ mainLabel }}</span>
    </button>
    <button
      type="button"
      class="kv-toolbar-button kv-pull-picker-chevron"
      :disabled="disabled"
      aria-label="Pull strategy options"
      :aria-expanded="isOpen"
      data-testid="pull-strategy-trigger"
      @click="toggle"
    >
      <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
    </button>

    <div v-if="isOpen" class="kv-pull-picker-panel" role="menu" aria-label="Pull strategy">
      <button
        type="button"
        class="kv-pull-picker-item"
        role="menuitem"
        data-testid="pull-strategy-default"
        @click="runDefault"
      >
        <span class="kv-pull-picker-item-label">Follow your configuration</span>
        <span class="kv-pull-picker-item-detail">
          <template v-if="previewLoading">resolving…</template>
          <template v-else-if="preview">
            {{ PULL_STRATEGY_LABELS[preview.strategy] }} — {{ describePullStrategySource(preview.source) }}
          </template>
        </span>
      </button>
      <button
        v-for="strategy in STRATEGIES"
        :key="strategy"
        type="button"
        class="kv-pull-picker-item"
        role="menuitem"
        :data-testid="`pull-strategy-${strategy}`"
        @click="runWith(strategy)"
      >
        <span class="kv-pull-picker-item-label">{{ PULL_STRATEGY_LABELS[strategy] }}</span>
      </button>
    </div>
  </div>
</template>

<style>
/* Shared with `AppToolbar.vue`'s own Fetch/Push buttons — a bordered, labelled toolbar button,
   distinct from `BranchPicker.vue`'s borderless `.kv-icon-button` (a chevron/kebab glyph with no
   label). Defined in both files (matching the dialogs' own redundant-but-identical convention,
   e.g. `.kv-modal-backdrop` in every `dialogs/*.vue`) so neither file depends on load order. */
.kv-toolbar-button {
  display: inline-flex;
  align-items: center;
  gap: var(--kv-space-1);
  height: 22px;
  padding: 0 var(--kv-space-2);
  background: transparent;
  color: var(--kv-app-fg);
  border: 1px solid var(--kv-panel-border);
  border-radius: var(--kv-radius);
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}

.kv-toolbar-button:hover:not(:disabled) {
  background-color: var(--kv-row-hover-bg);
}

.kv-toolbar-button:disabled {
  opacity: 0.6;
  cursor: default;
}

.kv-pull-picker {
  position: relative;
  display: inline-flex;
}

.kv-pull-picker-main {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}

.kv-pull-picker-chevron {
  padding: 0 var(--kv-space-1);
  border-left: none;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

.kv-pull-picker-panel {
  position: absolute;
  top: calc(100% + var(--kv-space-1));
  left: 0;
  z-index: 30;
  min-width: 260px;
  padding: var(--kv-space-1);
  background-color: var(--kv-panel-bg);
  color: var(--kv-app-fg);
  border: 1px solid var(--kv-panel-border);
  border-radius: var(--kv-radius);
  box-shadow: 0 4px 16px var(--kv-widget-shadow);
}

.kv-pull-picker-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  padding: var(--kv-space-1) var(--kv-space-2);
  background: transparent;
  color: inherit;
  border: none;
  border-radius: var(--kv-radius);
  font-family: inherit;
  font-size: inherit;
  text-align: left;
  cursor: pointer;
}

.kv-pull-picker-item:hover {
  background-color: var(--kv-row-hover-bg);
}

.kv-pull-picker-item-detail {
  color: var(--kv-description-fg);
  font-size: 0.85em;
}
</style>
