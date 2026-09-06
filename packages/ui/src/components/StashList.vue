<script setup lang="ts">
/**
 * `docs/plans/P9.md` W14 (§3.1, §7.6's "dedicated stash list"; OQ3 puts it beside `TagList.vue`,
 * inside `BranchPicker.vue`). One row per `StashEntry`: message, relative date, base commit short
 * sha + subject (`baseSubject`, W14's own gap-fix — see `core`'s `StashEntry` doc comment), file
 * count and a `-u` marker. Built on `refListModel.ts`'s own `capItems` cap (split out from
 * `capSection` for exactly this reuse) rather than a second list implementation — there is no
 * filter box here (unlike `TagList.vue`): a stash stack is rarely more than a handful of entries
 * and §7.6 names no search requirement for it.
 *
 * A row click selects the entry (`StashState.select`, OQ4) — it does not apply/pop it; that is
 * what the row's own menu (`buildStashMenu`) is for, mirroring `TagList.vue`'s own "click checks
 * out, menu does everything else" split as closely as a non-checkout row can.
 */
import type { InProgressOperation, StashEntry } from "@kira-version/ipc";
import { computed, ref } from "vue";
import type { OpsState } from "../state/ops.ts";
import type { StashState } from "../state/stash.ts";
import { capItems } from "./refListModel.ts";
import { buildStashMenu } from "./rowMenuModel.ts";
import RowContextMenu from "./RowContextMenu.vue";
import { formatRelativeDate } from "./dateFormat.ts";

const props = defineProps<{
  stash: StashState;
  ops: OpsState;
  inProgress: InProgressOperation | null;
}>();

/** Bubbled to `BranchPicker.vue` → `App.vue`, which owns `StashDialog.vue`'s branch-mode state —
 *  mirroring `createBranchHere`'s own App.vue-owned dialog state (this component has nowhere of
 *  its own to render a name-entry dialog into). */
const emit = defineEmits<(e: "branchFromStash", entry: StashEntry) => void>();

const section = computed(() => capItems(props.stash.entries.value));

function select(entry: StashEntry): void {
  props.stash.select(entry.sha);
}

const stashMenu = ref<{ entry: StashEntry; x: number; y: number } | undefined>(undefined);

function openMenu(entry: StashEntry, event: MouseEvent): void {
  event.preventDefault();
  stashMenu.value = { entry, x: event.clientX, y: event.clientY };
}

function openMenuFromButton(entry: StashEntry, event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  stashMenu.value = { entry, x: rect.left, y: rect.bottom };
}

const stashMenuSections = computed(() => buildStashMenu(props.inProgress));

async function onMenuSelect(id: string): Promise<void> {
  const entry = stashMenu.value?.entry;
  stashMenu.value = undefined;
  if (!entry) return;
  switch (id) {
    case "stashApply":
      await props.ops.runStashApply(entry);
      return;
    case "stashPop":
      await props.ops.runStashPop(entry);
      return;
    case "stashDrop":
      await props.ops.runStashDrop(entry);
      return;
    case "stashBranch":
      emit("branchFromStash", entry);
      return;
    case "stashShow":
      select(entry);
      return;
    default:
      return;
  }
}
</script>

<template>
  <div class="kv-branch-section" aria-label="Stashes">
    <div class="kv-branch-section-title">Stashes</div>
    <div
      v-for="entry in section.visible"
      :key="entry.sha"
      class="kv-branch-row"
      :class="{ 'kv-stash-row--selected': stash.selectedSha.value === entry.sha }"
    >
      <button type="button" class="kv-branch-row-main" @click="select(entry)">
        <span class="codicon codicon-archive" aria-hidden="true"></span>
        <span class="kv-stash-index">{{ `stash@{${entry.index}}` }}</span>
        <span class="kv-stash-message" :title="entry.message">{{ entry.message }}</span>
        <span class="kv-stash-base" :title="entry.baseSubject">
          <code>{{ entry.baseSha.slice(0, 7) }}</code> {{ entry.baseSubject }}
        </span>
        <span v-if="entry.includedUntracked" class="kv-stash-untracked" title="Includes untracked files">-u</span>
        <span class="kv-stash-filecount">{{ entry.fileCount }} file{{ entry.fileCount === 1 ? "" : "s" }}</span>
        <span class="kv-stash-date">{{ formatRelativeDate(entry.timestamp) }}</span>
      </button>
      <button
        type="button"
        class="kv-icon-button"
        title="More actions"
        aria-label="More actions"
        @click="openMenuFromButton(entry, $event)"
        @contextmenu="openMenu(entry, $event)"
      >
        <span class="codicon codicon-ellipsis" aria-hidden="true"></span>
      </button>
    </div>
    <div v-if="section.hiddenCount > 0" class="kv-branch-more">
      {{ section.hiddenCount }} more — apply, pop or drop some to see the rest
    </div>
    <div v-if="section.visible.length === 0" class="kv-branch-empty">No stashes</div>

    <RowContextMenu
      v-if="stashMenu"
      :sections="stashMenuSections"
      :x="stashMenu.x"
      :y="stashMenu.y"
      :label="`stash@{${stashMenu.entry.index}} actions`"
      @select="onMenuSelect"
      @close="stashMenu = undefined"
    />
  </div>
</template>

<style>
.kv-stash-row--selected {
  background-color: var(--kv-row-hover-bg);
}

.kv-stash-index {
  white-space: nowrap;
  font-family: var(--kv-mono-font-family);
}

.kv-stash-message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kv-stash-base {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 12em;
  font-size: 0.85em;
  color: var(--kv-description-fg);
}

.kv-stash-untracked {
  font-family: var(--kv-mono-font-family);
  font-size: 0.85em;
  opacity: 0.8;
}

.kv-stash-filecount,
.kv-stash-date {
  font-size: 0.85em;
  color: var(--kv-description-fg);
  white-space: nowrap;
}
</style>
