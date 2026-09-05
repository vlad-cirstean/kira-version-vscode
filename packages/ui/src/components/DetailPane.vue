<script setup lang="ts">
/**
 * `docs/plans/P5.md` W11: composes `CommitMeta.vue` (twice — see its own doc comment on why),
 * `FileTree.vue` and `DiffView.vue` over one `DetailState`, replacing both of `App.vue`'s P4
 * placeholder blocks (the docked pane and the overlay drawer share this one component). Owns no
 * `ResizeObserver` and takes no `breakpoint` prop — the one presentation difference the plan's
 * own breakpoint table adds beyond §6.3's existing pane-width handling (the diff's *full*-width
 * overlay at the `< 600` breakpoint, vs. the tree/meta drawer's narrower one) is, per W11's own
 * words, "a class on the wrapper" — `App.vue`'s own drawer `<div>`, driven by `detailState.mode`
 * it already holds — rather than a layout fact threaded down into this component. That keeps this
 * component entirely layout-agnostic, which is if anything a *better* fit for "the component P7
 * will mount in a sidebar" than a breakpoint prop it would have had to ignore there.
 *
 * Does not call `detailState.select` itself for a parent-commit pick (`CommitMeta.vue`'s own
 * `selectParentCommit` emit) — that emit only bubbles further up, to `App.vue`, which also owns
 * `SelectionState` and the grid ref neither this component nor `DetailState` has access to; a
 * parent commit whose row is already loaded needs the grid's own selection/scroll updated to
 * match, exactly as a normal row click would, and only `App.vue` can do that.
 */
import type { CommitStore } from "@kira-version/core";
import { computed, nextTick, ref, watch } from "vue";
import type { DetailState } from "../state/detail.ts";
import type { DetailActions } from "../state/detailActions.ts";
import CommitMeta from "./CommitMeta.vue";
import DiffView from "./DiffView.vue";
import FileTree from "./FileTree.vue";

const props = defineProps<{
  detailState: DetailState;
  store: CommitStore;
  actions: DetailActions;
}>();

const emit = defineEmits<(e: "selectParentCommit", sha: string) => void>();

const detail = computed(() => props.detailState.detail.value);

function onSelectParentCommit(sha: string): void {
  emit("selectParentCommit", sha);
}

/** P5 W14: "leaving the diff returns focus to the file it was showing, not to the top of the
 *  tree" — the tree unmounts entirely while the diff is showing (this component's own `v-if`/
 *  `v-else-if`), so there is no DOM node to hold onto across the transition; this watches
 *  `mode` itself and re-focuses the tree's own cursor row once it is back in the DOM. Both ways
 *  back to `"detail"` (the diff's own back affordance, and `App.vue`'s `closeDetail` on `Esc`)
 *  go through `DetailState.showTree()`, so watching `mode` here covers both without either of
 *  those callers needing to know this component exists. */
const fileTreeRef = ref<InstanceType<typeof FileTree> | null>(null);
watch(
  () => props.detailState.mode.value,
  (mode, previous) => {
    if (mode === "detail" && previous === "diff")
      void nextTick(() => fileTreeRef.value?.focusTree());
  },
);
</script>

<template>
  <div class="kv-detail-pane">
    <p v-if="detailState.error.value" class="kv-detail-pane-error">
      Couldn't load this commit — {{ detailState.error.value }}
    </p>

    <DiffView
      v-if="detailState.mode.value === 'diff' && detail"
      class="kv-detail-pane-diff"
      :diff="detailState.diff.value"
      :diff-error="detailState.diffError.value"
      :file-index="detailState.selectedFile.value"
      :total-files="detail.files.length"
      :actions="actions"
      @select-file="detailState.selectFile($event)"
      @back="detailState.showTree()"
    />

    <template v-else-if="detail">
      <CommitMeta
        section="message"
        :detail="detail"
        :store="store"
        :actions="actions"
        @select-parent-commit="onSelectParentCommit"
      />
      <FileTree
        ref="fileTreeRef"
        class="kv-detail-pane-tree"
        :files="detail.files"
        :selected-file="detailState.selectedFile.value"
        :list-mode="detailState.listMode.value"
        :filter="detailState.filter.value"
        :parents="detail.parents"
        :parent-index="detailState.parentIndex.value"
        :store="store"
        :actions="actions"
        @select-file="detailState.selectFile($event)"
        @update:list-mode="detailState.setListMode($event)"
        @update:filter="detailState.setFilter($event)"
        @update:parent-index="detailState.setParentIndex($event)"
      />
      <CommitMeta
        section="details"
        :detail="detail"
        :store="store"
        :actions="actions"
        @select-parent-commit="onSelectParentCommit"
      />
    </template>

    <p v-else-if="!detailState.error.value" class="kv-detail-pane-loading">Loading…</p>
  </div>
</template>

<style>
.kv-detail-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.kv-detail-pane-diff {
  height: 100%;
}

.kv-detail-pane-tree {
  border-top: 1px solid var(--kv-panel-border);
  border-bottom: 1px solid var(--kv-panel-border);
}

.kv-detail-pane-error {
  margin: 0;
  padding: var(--kv-space-4);
  color: var(--kv-error-fg);
}

.kv-detail-pane-loading {
  margin: 0;
  padding: var(--kv-space-4);
  color: var(--kv-description-fg);
}
</style>
