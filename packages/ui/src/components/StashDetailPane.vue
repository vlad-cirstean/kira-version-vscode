<script setup lang="ts">
/**
 * `docs/plans/P9.md` W14 (OQ4): "selecting a stash node or list row loads `stash.show` into the
 * existing `FileTree.vue`/`DiffView.vue` — no stash-specific diff view." Mirrors `DetailPane.vue`'s
 * own composition (tree, then diff-takes-over-the-pane) but keyed off `StashState` rather than
 * `DetailState` — a stash entry has none of `CommitDetail`'s richer shape (body/trailers/
 * signature/multiple parents), so `CommitMeta.vue` is not reused here; this file's own small header
 * says the one thing worth saying about a stash (message, base commit, date, `-u` marker) instead.
 */
import type { CommitStore } from "@kira-version/core";
import { computed } from "vue";
import type { DetailActions } from "../state/detailActions.ts";
import type { StashState } from "../state/stash.ts";
import { formatAbsoluteDate, formatRelativeDate } from "./dateFormat.ts";
import DiffView from "./DiffView.vue";
import FileTree from "./FileTree.vue";

const props = defineProps<{
  stash: StashState;
  store: CommitStore;
  actions: DetailActions;
}>();

const entry = computed(() => props.stash.selected.value);
const files = computed(() => props.stash.changes.value ?? []);
/** Single-element — `FileTree.vue`'s own merge-parent picker only renders past `length > 1`, so
 *  this never shows one (a stash entry is never a merge from the UI's point of view: §7.6 truncates
 *  its parent list to `[baseSha]` in the graph, and the detail pane matches that). */
const parents = computed(() => (entry.value ? [entry.value.baseSha] : []));
</script>

<template>
  <div class="kv-stash-detail-pane">
    <p v-if="stash.error.value" class="kv-detail-pane-error">
      Couldn't load this stash — {{ stash.error.value }}
    </p>

    <DiffView
      v-if="stash.mode.value === 'diff' && entry"
      class="kv-detail-pane-diff"
      :diff="stash.diff.value"
      :diff-error="stash.diffError.value"
      :file-index="stash.selectedFile.value"
      :total-files="files.length"
      :actions="actions"
      @select-file="stash.selectFile($event)"
      @back="stash.showTree()"
    />

    <template v-else-if="entry">
      <div class="kv-stash-detail-header">
        <p class="kv-stash-detail-message">{{ entry.message }}</p>
        <p class="kv-stash-detail-facts">
          <span :title="formatAbsoluteDate(entry.timestamp)">{{
            formatRelativeDate(entry.timestamp)
          }}</span>
          <span> · based on <code>{{ entry.baseSha.slice(0, 7) }}</code></span>
          <span v-if="entry.baseSubject"> {{ entry.baseSubject }}</span>
          <span v-if="entry.includedUntracked" class="kv-stash-detail-untracked">-u</span>
        </p>
      </div>
      <FileTree
        class="kv-detail-pane-tree"
        :files="files"
        :selected-file="stash.selectedFile.value"
        :list-mode="stash.listMode.value"
        :filter="stash.filter.value"
        :parents="parents"
        :parent-index="0"
        :store="store"
        :actions="actions"
        @select-file="stash.selectFile($event)"
        @update:list-mode="stash.setListMode($event)"
        @update:filter="stash.setFilter($event)"
      />
    </template>

    <p v-else-if="!stash.error.value" class="kv-detail-pane-loading">Loading…</p>
  </div>
</template>

<style>
.kv-stash-detail-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.kv-stash-detail-header {
  padding: var(--kv-space-3) var(--kv-space-4);
  border-bottom: 1px solid var(--kv-panel-border);
}

.kv-stash-detail-message {
  margin: 0 0 var(--kv-space-1);
  font-weight: 600;
  overflow-wrap: break-word;
}

.kv-stash-detail-facts {
  margin: 0;
  font-size: 0.85em;
  color: var(--kv-description-fg);
}

.kv-stash-detail-untracked {
  margin-left: var(--kv-space-2);
  font-family: var(--kv-mono-font-family);
  opacity: 0.8;
}

/* `.kv-detail-pane-diff`/`.kv-detail-pane-tree`/`.kv-detail-pane-error`/`.kv-detail-pane-loading`
 * used above are `DetailPane.vue`'s own — this file is unscoped CSS, same as that one, and
 * `App.vue` always imports both, so reusing rather than redeclaring them is safe and DRY. */
</style>
