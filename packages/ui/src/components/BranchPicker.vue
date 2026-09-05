<script setup lang="ts">
/**
 * `docs/plans/P6.md` W13: §6.2's `[branch ▾]` toolbar slot. One dropdown, three sections
 * (Branches / Remote branches / Tags — judgment call 5); `refListModel.ts` owns the filter, sort
 * and cap, this file only renders. `TagList.vue` renders the third section as a real component
 * (its own doc comment says why), reusing the same filter text this file's own input owns rather
 * than a second box (§13's "one filter box, matching across all three sections").
 *
 * Every row also carries `RowContextMenu.vue`'s ref-scoped menu (W14: "every row also carries the
 * context menu W14 builds, which is where the destructive actions live") — a kebab button (mouse
 * *and* keyboard reachable) plus a plain right-click, both opening the same menu.
 */
import type { RefRow } from "@kira-version/ipc";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { STATE_ICONS } from "../icons/index.ts";
import type { OpsState } from "../state/ops.ts";
import type { RefsState } from "../state/refs.ts";
import {
  buildRefListSections,
  formatTrack,
  remoteCheckoutLabel,
  remoteCheckoutTarget,
} from "./refListModel.ts";
import { buildRefMenu, remoteNamesFrom } from "./rowMenuModel.ts";
import RowContextMenu from "./RowContextMenu.vue";
import TagList from "./TagList.vue";

const props = defineProps<{ refs: RefsState; ops: OpsState }>();

const isOpen = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const triggerEl = ref<HTMLButtonElement | null>(null);
const filter = ref("");

const triggerLabel = computed(() => {
  const head = props.refs.head.value;
  if (!head) return "…";
  if (head.kind === "branch") return head.name;
  if (head.kind === "unborn") return `${head.name} (unborn)`;
  return head.sha.slice(0, 7);
});

const sections = computed(() =>
  buildRefListSections(
    {
      branches: props.refs.branches.value,
      remoteBranches: props.refs.remoteBranches.value,
      tags: props.refs.tags.value,
    },
    filter.value,
  ),
);

const knownRemotes = computed(() =>
  remoteNamesFrom(props.refs.remoteBranches.value.map((row) => row.shortName)),
);

function close(): void {
  isOpen.value = false;
  refMenu.value = undefined;
  renaming.value = undefined;
  forceDeleteCandidate.value = undefined;
}

function toggle(): void {
  isOpen.value = !isOpen.value;
  if (!isOpen.value) close();
}

/** W20: `close()` unmounts the whole panel, including whatever row button the click just
 *  focused — by the time `runCheckout` might open `CheckoutDialog.vue`, that button is gone and
 *  `useModalFocus`'s own invoker capture would land on nothing (the browser's own fallback,
 *  `<body>`). Moving focus to the trigger *first* — a stable control that survives the panel's
 *  own close — gives that capture something real to return to, the same "make sure a persisting
 *  anchor holds focus before the invoking control disappears" fix `RowContextMenu.vue`'s own W20
 *  change makes for the row menu. */
function closeForCheckout(): void {
  triggerEl.value?.focus();
  close();
}

async function checkoutBranch(row: RefRow): Promise<void> {
  closeForCheckout();
  await props.ops.runCheckout(row.shortName, "switch");
}

async function checkoutRemote(row: RefRow): Promise<void> {
  closeForCheckout();
  await props.ops.runCheckout(remoteCheckoutTarget(row, props.refs.branches.value), "switch");
}

// ---------------------------------------------------------------------------------------
// The ref-scoped context menu (W14) — one instance, shared by every branch/remote row (TagList
// opens its own for tag rows, since its rows are not in this file's own DOM).
// ---------------------------------------------------------------------------------------
const refMenu = ref<{ row: RefRow; x: number; y: number } | undefined>(undefined);
const renaming = ref<{ name: string; value: string } | undefined>(undefined);
const forceDeleteCandidate = ref<string | undefined>(undefined);

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
    kind: entry.row.kind,
    shortName: entry.row.shortName,
    isHead: entry.row.isHead,
    knownRemotes: entry.row.kind === "tag" ? knownRemotes.value : [],
    inProgress: props.ops.statusSummary.value?.inProgress ?? null,
  });
});

async function onRefMenuSelect(id: string): Promise<void> {
  const entry = refMenu.value;
  refMenu.value = undefined;
  if (!entry) return;
  const { row } = entry;
  if (id === "checkoutRef") {
    await (row.kind === "remoteBranch" ? checkoutRemote(row) : checkoutBranch(row));
    return;
  }
  if (id === "renameRef") {
    renaming.value = { name: row.shortName, value: row.shortName };
    return;
  }
  if (id === "deleteRef") {
    if (row.kind === "tag") {
      await props.ops.tagDelete(row.shortName);
      return;
    }
    const result = await props.ops.branchDelete(row.shortName, false);
    if (!result.ok && result.error?.kind === "NotFullyMerged") {
      forceDeleteCandidate.value = row.shortName;
    }
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

async function confirmForceDelete(): Promise<void> {
  const name = forceDeleteCandidate.value;
  forceDeleteCandidate.value = undefined;
  if (name !== undefined) await props.ops.branchDelete(name, true);
}

async function submitRename(): Promise<void> {
  const pending = renaming.value;
  renaming.value = undefined;
  if (!pending) return;
  const to = pending.value.trim();
  if (to === "" || to === pending.name) return;
  await props.ops.branchRename(pending.name, to);
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
  <div ref="rootEl" class="kv-branch-picker" @keydown.escape="close">
    <button
      ref="triggerEl"
      type="button"
      class="kv-branch-trigger"
      aria-haspopup="true"
      :aria-expanded="isOpen"
      :title="refs.head.value?.kind === 'detached' ? refs.head.value.sha : triggerLabel"
      @click="toggle"
    >
      <span class="codicon codicon-git-branch" aria-hidden="true"></span>
      <span class="kv-branch-trigger-label">{{ triggerLabel }}</span>
      <span class="codicon" :class="STATE_ICONS.chevronDown" aria-hidden="true"></span>
    </button>

    <div v-if="isOpen" class="kv-branch-panel" role="dialog" aria-label="Branches and tags">
      <input
        type="text"
        class="kv-branch-filter"
        placeholder="Filter branches and tags"
        aria-label="Filter branches and tags"
        v-model="filter"
      />

      <div class="kv-branch-panel-scroll">
        <div class="kv-branch-section" aria-label="Branches">
          <div class="kv-branch-section-title">Branches</div>
          <div
            v-for="row in sections.branches.visible"
            :key="row.refname"
            class="kv-branch-row"
            :class="{ 'kv-branch-row--current': row.isHead }"
          >
            <template v-if="renaming?.name === row.shortName">
              <input
                type="text"
                class="kv-branch-rename-input"
                v-model="renaming.value"
                autofocus
                @keydown.enter="submitRename"
                @keydown.escape="renaming = undefined"
              />
              <button type="button" class="kv-icon-button" @click="submitRename">
                <span class="codicon codicon-check" aria-hidden="true"></span>
              </button>
            </template>
            <template v-else>
              <button type="button" class="kv-branch-row-main" @click="checkoutBranch(row)">
                <span
                  class="kv-branch-current-dot"
                  role="img"
                  :aria-label="row.isHead ? 'current branch' : undefined"
                  >{{ row.isHead ? "●" : "" }}</span
                >
                <span class="kv-branch-row-name">{{ row.shortName }}</span>
                <span v-if="row.checkedOutIn" class="kv-branch-badge" :title="`Checked out in ${row.checkedOutIn}`">
                  worktree
                </span>
                <span v-if="formatTrack(row.track)" class="kv-branch-track">{{ formatTrack(row.track) }}</span>
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
            </template>
          </div>
          <div v-if="forceDeleteCandidate" class="kv-branch-force-delete">
            <span>“{{ forceDeleteCandidate }}” is not fully merged.</span>
            <button type="button" @click="confirmForceDelete">Force delete</button>
            <button type="button" @click="forceDeleteCandidate = undefined">Cancel</button>
          </div>
          <div v-if="sections.branches.hiddenCount > 0" class="kv-branch-more">
            {{ sections.branches.hiddenCount }} more — refine your filter
          </div>
          <div v-if="sections.branches.visible.length === 0" class="kv-branch-empty">No branches</div>
        </div>

        <div class="kv-branch-section" aria-label="Remote branches">
          <div class="kv-branch-section-title">Remote branches</div>
          <div v-for="row in sections.remoteBranches.visible" :key="row.refname" class="kv-branch-row">
            <button type="button" class="kv-branch-row-main" @click="checkoutRemote(row)">
              <span class="codicon codicon-cloud" aria-hidden="true"></span>
              <span class="kv-branch-row-name">{{ row.shortName }}</span>
              <span class="kv-branch-remote-action">{{ remoteCheckoutLabel(row, refs.branches.value) }}</span>
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
          <div v-if="sections.remoteBranches.hiddenCount > 0" class="kv-branch-more">
            {{ sections.remoteBranches.hiddenCount }} more — refine your filter
          </div>
          <div v-if="sections.remoteBranches.visible.length === 0" class="kv-branch-empty">
            No remote branches
          </div>
        </div>

        <TagList
          :section="sections.tags"
          :ops="ops"
          :known-remotes="knownRemotes"
          :in-progress="ops.statusSummary.value?.inProgress ?? null"
          @checked-out="close"
        />
      </div>
    </div>

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
.kv-branch-picker {
  position: relative;
}

.kv-branch-trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--kv-space-2);
  height: 22px;
  padding: 0 var(--kv-space-2);
  border: none;
  border-radius: var(--kv-radius);
  background: transparent;
  color: var(--kv-app-fg);
  font-family: inherit;
  font-size: inherit;
  max-width: 200px;
  cursor: pointer;
}

.kv-branch-trigger:hover {
  background-color: var(--kv-row-hover-bg);
}

.kv-branch-trigger:focus-visible {
  outline: 1px solid var(--kv-focus-border);
  outline-offset: -1px;
}

.kv-branch-trigger-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kv-branch-panel {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  z-index: 10;
  width: 320px;
  max-height: 420px;
  display: flex;
  flex-direction: column;
  background-color: var(--kv-panel-bg);
  border: 1px solid var(--kv-panel-border);
  border-radius: var(--kv-radius);
  box-shadow: 0 2px 8px var(--kv-widget-shadow);
}

.kv-branch-filter {
  margin: var(--kv-space-2);
  padding: var(--kv-space-1) var(--kv-space-2);
  background: var(--kv-panel-bg);
  color: var(--kv-row-fg);
  border: 1px solid var(--kv-panel-border);
}

.kv-branch-panel-scroll {
  overflow-y: auto;
}

.kv-branch-section-title {
  padding: var(--kv-space-1) var(--kv-space-3);
  font-size: 0.85em;
  font-weight: 600;
  color: var(--kv-description-fg);
}

.kv-branch-row {
  display: flex;
  align-items: center;
  gap: var(--kv-space-1);
  padding: 0 var(--kv-space-2);
}

.kv-branch-row--current {
  font-weight: 600;
}

.kv-branch-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--kv-space-2);
  padding: var(--kv-space-1) var(--kv-space-1);
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.kv-branch-row-main:hover {
  background-color: var(--kv-row-hover-bg);
}

.kv-branch-current-dot {
  width: 0.9em;
  color: var(--kv-focus-border);
}

.kv-branch-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kv-branch-badge {
  font-size: 0.8em;
  padding: 0 var(--kv-space-1);
  border: 1px dashed var(--kv-panel-border);
  border-radius: var(--kv-radius);
  color: var(--kv-description-fg);
}

.kv-branch-track {
  font-size: 0.85em;
  color: var(--kv-description-fg);
}

.kv-branch-remote-action {
  font-size: 0.85em;
  color: var(--kv-description-fg);
}

.kv-icon-button {
  background: transparent;
  border: none;
  color: var(--kv-app-fg);
  cursor: pointer;
  padding: var(--kv-space-1);
}

.kv-icon-button:hover {
  background-color: var(--kv-row-hover-bg);
}

.kv-branch-rename-input {
  flex: 1;
  padding: var(--kv-space-1);
  background: var(--kv-panel-bg);
  color: var(--kv-row-fg);
  border: 1px solid var(--kv-focus-border);
}

.kv-branch-more,
.kv-branch-empty {
  padding: var(--kv-space-1) var(--kv-space-3);
  color: var(--kv-description-fg);
  font-size: 0.85em;
}

.kv-branch-force-delete {
  display: flex;
  align-items: center;
  gap: var(--kv-space-2);
  padding: var(--kv-space-2) var(--kv-space-3);
  background: var(--kv-overlay-bg);
  font-size: 0.85em;
}
</style>
