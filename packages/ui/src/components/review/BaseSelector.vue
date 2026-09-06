<script setup lang="ts">
/**
 * `docs/plans/P7.md` W12 — §6.8: "shown in the view's header as a picker — never as static text —
 * naming the base and how it was resolved ('upstream', 'default branch')." The trigger names the
 * current base (or "Choose a base…" while `reason: "none"`) plus a quiet reason label; the
 * dropdown has two sections — Suggested (`resolution.candidates`, each carrying its own reason)
 * and All branches (`refsState`'s own branches/remote-tracking branches, through the same
 * `refListModel.ts` fold `BranchPicker.vue` uses, so the two lists sort/filter/cap identically).
 * Tags are never offered here — `<base>..<branch>` is a question about two branches (§6.8),
 * mirroring W14's "not offered for tags" rule on the row menu's own entry.
 */
import type { BaseCandidate, BaseResolution, BaseResolutionReason } from "@kira-version/ipc";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { RefsState } from "../../state/refs.ts";
import { STATE_ICONS } from "../../icons/index.ts";
import { useModalFocus } from "../dialogs/modalFocus.ts";
import { buildRefListSections } from "../refListModel.ts";

const props = defineProps<{
  resolution: BaseResolution | undefined;
  refsState: RefsState;
}>();

const emit = defineEmits<(e: "select-base", ref: string) => void>();

/** `"override"` and `"none"` both render nothing — an overridden base needs no explanation of
 *  where it came from, and `reason: "none"` never reaches this (paired only with `base: null`,
 *  which the trigger already renders as the placeholder text rather than a labelled name). */
function reasonLabel(reason: BaseResolutionReason): string | undefined {
  switch (reason) {
    case "upstream":
      return "upstream";
    case "defaultBranch":
      return "default branch";
    case "override":
    case "none":
      return undefined;
  }
}

const triggerLabel = computed(() => props.resolution?.base ?? "Choose a base…");
const triggerReason = computed(() => {
  const resolution = props.resolution;
  if (!resolution || resolution.base === null) return undefined;
  return reasonLabel(resolution.reason);
});

const isOpen = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const triggerEl = ref<HTMLButtonElement | null>(null);
const filter = ref("");

// W17: focus returns to the header trigger when the panel closes, whichever way it closed
// (Escape, an outside click, or picking a row) — `modalFocus.ts`'s own invoker-capture
// composable, reused rather than hand-rolled (the plan's own wording for this bullet).
// `rootEl` wraps the trigger button itself, so the invoker `useModalFocus` captures the instant
// `isOpen` flips true is always the trigger — exactly what should get focus back on close.
const { onKeydown: onModalKeydown } = useModalFocus(isOpen, rootEl);

function close(): void {
  isOpen.value = false;
  filter.value = "";
}

function toggle(): void {
  isOpen.value = !isOpen.value;
  if (!isOpen.value) filter.value = "";
}

const sections = computed(() =>
  buildRefListSections(
    {
      branches: props.refsState.branches.value,
      remoteBranches: props.refsState.remoteBranches.value,
      tags: [],
    },
    filter.value,
  ),
);

/** The candidate shortlist minus whichever entry is already the current base — picking it again
 *  would be a no-op re-resolve for nothing the user could see change. */
const suggested = computed<readonly BaseCandidate[]>(() => {
  const current = props.resolution?.base;
  return (props.resolution?.candidates ?? []).filter((c) => c.ref !== current);
});

function candidateReason(candidate: BaseCandidate): string {
  return reasonLabel(candidate.reason) ?? "";
}

function pick(ref: string): void {
  close();
  emit("select-base", ref);
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!isOpen.value) return;
  if (rootEl.value && event.target instanceof Node && rootEl.value.contains(event.target)) return;
  close();
}

watch(isOpen, (open) => {
  if (open) document.addEventListener("pointerdown", onDocumentPointerDown);
  else document.removeEventListener("pointerdown", onDocumentPointerDown);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown);
});
</script>

<template>
  <div ref="rootEl" class="kv-base-selector" @keydown="onModalKeydown" @keydown.escape="close">
    <button
      ref="triggerEl"
      type="button"
      class="kv-base-trigger"
      aria-haspopup="true"
      :aria-expanded="isOpen"
      data-testid="base-selector-trigger"
      @click="toggle"
    >
      <span class="kv-base-trigger-label">{{ triggerLabel }}</span>
      <span v-if="triggerReason" class="kv-base-trigger-reason">{{ triggerReason }}</span>
      <span class="codicon" :class="STATE_ICONS.chevronDown" aria-hidden="true"></span>
    </button>

    <div v-if="isOpen" class="kv-base-panel" role="dialog" aria-label="Choose a comparison base">
      <input
        type="text"
        class="kv-base-filter"
        placeholder="Filter branches"
        aria-label="Filter branches"
        v-model="filter"
      />
      <div class="kv-base-panel-scroll">
        <div v-if="suggested.length > 0" class="kv-base-section" aria-label="Suggested">
          <div class="kv-base-section-title">Suggested</div>
          <button
            v-for="candidate in suggested"
            :key="candidate.ref"
            type="button"
            class="kv-base-row"
            @click="pick(candidate.ref)"
          >
            <span class="kv-base-row-name">{{ candidate.ref }}</span>
            <span class="kv-base-row-reason">{{ candidateReason(candidate) }}</span>
          </button>
        </div>

        <div class="kv-base-section" aria-label="All branches">
          <div class="kv-base-section-title">All branches</div>
          <button
            v-for="row in sections.branches.visible"
            :key="row.refname"
            type="button"
            class="kv-base-row"
            @click="pick(row.shortName)"
          >
            <span class="kv-base-row-name">{{ row.shortName }}</span>
          </button>
          <button
            v-for="row in sections.remoteBranches.visible"
            :key="row.refname"
            type="button"
            class="kv-base-row"
            @click="pick(row.shortName)"
          >
            <span class="codicon codicon-cloud" aria-hidden="true"></span>
            <span class="kv-base-row-name">{{ row.shortName }}</span>
          </button>
          <div
            v-if="sections.branches.visible.length === 0 && sections.remoteBranches.visible.length === 0"
            class="kv-base-empty"
          >
            No matching branches
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
.kv-base-selector {
  position: relative;
}

.kv-base-trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--kv-space-2);
  height: 24px;
  padding: 0 var(--kv-space-2);
  border: 1px solid var(--kv-panel-border);
  border-radius: var(--kv-radius);
  background: transparent;
  color: var(--kv-app-fg);
  font-family: inherit;
  font-size: inherit;
  max-width: 100%;
  cursor: pointer;
}

.kv-base-trigger:hover {
  background-color: var(--kv-row-hover-bg);
}

.kv-base-trigger:focus-visible {
  outline: 1px solid var(--kv-focus-border);
  outline-offset: -1px;
}

.kv-base-trigger-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.kv-base-trigger-reason {
  color: var(--kv-description-fg);
  font-size: 0.85em;
}

.kv-base-panel {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  z-index: 10;
  width: min(280px, 90vw);
  max-height: 320px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--kv-panel-border);
  border-radius: var(--kv-radius);
  background: var(--kv-panel-bg);
  box-shadow: 0 2px 8px var(--kv-widget-shadow);
}

.kv-base-filter {
  margin: var(--kv-space-2);
  background: var(--kv-app-bg);
  color: var(--kv-row-fg);
  border: 1px solid var(--kv-panel-border);
  padding: var(--kv-space-1) var(--kv-space-2);
}

.kv-base-panel-scroll {
  overflow: auto;
  min-height: 0;
}

.kv-base-section-title {
  padding: var(--kv-space-1) var(--kv-space-3);
  color: var(--kv-description-fg);
  font-size: 0.8em;
  text-transform: uppercase;
}

.kv-base-row {
  display: flex;
  align-items: center;
  gap: var(--kv-space-2);
  width: 100%;
  text-align: left;
  padding: var(--kv-space-1) var(--kv-space-3);
  border: none;
  background: transparent;
  color: var(--kv-app-fg);
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}

.kv-base-row:hover {
  background-color: var(--kv-row-hover-bg);
}

.kv-base-row:focus-visible {
  outline: 1px solid var(--kv-focus-border);
  outline-offset: -1px;
}

.kv-base-row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kv-base-row-reason {
  margin-left: auto;
  color: var(--kv-description-fg);
  font-size: 0.85em;
}

.kv-base-empty {
  padding: var(--kv-space-2) var(--kv-space-3);
  color: var(--kv-description-fg);
}
</style>
