<script setup lang="ts">
/**
 * `docs/plans/P6.md` W13: the picker's tags section, as its own component (judgment call 5's own
 * words: "a real component… not a sibling dropdown"). Renders exactly what `BranchPicker.vue`
 * hands it (already filtered/sorted/capped by `refListModel.ts`'s shared fold) plus its own
 * annotated/lightweight distinction (§7.9) and its own ref-scoped context menu (W14) — the same
 * menu shape `BranchPicker.vue`'s branch/remote rows use, built here because tag rows live in
 * this file's own template, not that one's.
 */
import type { InProgressOperation, RefRow } from "@kira-version/ipc";
import { computed, ref } from "vue";
import type { OpsState } from "../state/ops.ts";
import type { RefListSection } from "./refListModel.ts";
import { buildRefMenu } from "./rowMenuModel.ts";
import RowContextMenu from "./RowContextMenu.vue";

const props = defineProps<{
  section: RefListSection;
  ops: OpsState;
  knownRemotes: readonly string[];
  inProgress: InProgressOperation | null;
}>();

const emit = defineEmits<(e: "checked-out") => void>();

async function checkout(row: RefRow): Promise<void> {
  emit("checked-out");
  await props.ops.runCheckout(row.shortName, "switch");
}

/** §7.9: the commit a tag ultimately resolves to — the peeled commit for an annotated tag (whose
 *  own `objectId` is the TAG OBJECT's sha, not a commit's), the ref's own `objectId` for a
 *  lightweight one. Mirrors `core`'s `tagTargetCommit`, adapted to the wire's `RefRow` rather than
 *  a full `RefRecord` (this file has no need for `objectType`). */
function targetCommit(row: RefRow): string {
  return (row.peeledObjectId ?? row.objectId).slice(0, 7);
}

const refMenu = ref<{ row: RefRow; x: number; y: number } | undefined>(undefined);

function openRefMenu(row: RefRow, event: MouseEvent): void {
  event.preventDefault();
  refMenu.value = { row, x: event.clientX, y: event.clientY };
}

function openRefMenuFromButton(row: RefRow, event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  refMenu.value = { row, x: rect.left, y: rect.bottom };
}

const refMenuSections = computed(() => {
  const entry = refMenu.value;
  if (!entry) return [];
  return buildRefMenu({
    kind: "tag",
    shortName: entry.row.shortName,
    isHead: false,
    knownRemotes: props.knownRemotes,
    inProgress: props.inProgress,
  });
});

async function onRefMenuSelect(id: string): Promise<void> {
  const entry = refMenu.value;
  refMenu.value = undefined;
  if (!entry) return;
  const { row } = entry;
  if (id === "checkoutRef") {
    await checkout(row);
    return;
  }
  if (id === "deleteRef") {
    await props.ops.tagDelete(row.shortName);
    return;
  }
  if (id.startsWith("pushRef:")) {
    await props.ops.tagPush(id.slice("pushRef:".length), [row.shortName]);
    return;
  }
  if (id.startsWith("deleteRemoteRef:")) {
    await props.ops.tagDeleteRemote(id.slice("deleteRemoteRef:".length), row.shortName);
  }
}
</script>

<template>
  <div class="kv-branch-section" aria-label="Tags">
    <div class="kv-branch-section-title">Tags</div>
    <div v-for="row in section.visible" :key="row.refname" class="kv-branch-row">
      <button type="button" class="kv-branch-row-main" @click="checkout(row)">
        <span
          class="codicon codicon-tag"
          :class="{ 'kv-tag-lightweight': !row.annotation }"
          aria-hidden="true"
        ></span>
        <span class="kv-branch-row-name">{{ row.shortName }}</span>
        <span class="kv-tag-kind">{{ row.annotation ? "annotated" : "lightweight" }}</span>
        <span v-if="row.annotation" class="kv-tag-subject" :title="row.annotation.subject">
          {{ row.annotation.subject }}
        </span>
        <span class="kv-tag-target">{{ targetCommit(row) }}</span>
      </button>
      <button
        type="button"
        class="kv-icon-button"
        title="More actions"
        aria-label="More actions"
        @click="openRefMenuFromButton(row, $event)"
        @contextmenu="openRefMenu(row, $event)"
      >
        <span class="codicon codicon-ellipsis" aria-hidden="true"></span>
      </button>
    </div>
    <div v-if="section.hiddenCount > 0" class="kv-branch-more">
      {{ section.hiddenCount }} more — refine your filter
    </div>
    <div v-if="section.visible.length === 0" class="kv-branch-empty">No tags</div>

    <RowContextMenu
      v-if="refMenu"
      :sections="refMenuSections"
      :x="refMenu.x"
      :y="refMenu.y"
      :label="`${refMenu.row.shortName} actions`"
      @select="onRefMenuSelect"
      @close="refMenu = undefined"
    />
  </div>
</template>

<style>
.kv-tag-kind {
  font-size: 0.75em;
  color: var(--kv-description-fg);
}

.kv-tag-lightweight {
  opacity: 0.6;
}

.kv-tag-subject {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.85em;
  color: var(--kv-description-fg);
}

.kv-tag-target {
  font-family: var(--kv-mono-font-family);
  font-size: 0.85em;
  color: var(--kv-description-fg);
}
</style>
