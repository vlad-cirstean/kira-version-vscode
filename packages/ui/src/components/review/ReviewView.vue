<script setup lang="ts">
/**
 * `docs/plans/P7.md` W11 — the sidebar view's whole root, mounted by `main.ts` in place of
 * `App.vue` when `view === "review"` (§6.8/D41: same bundle, a different root, selected from the
 * host's own injected initial state). Five real states, never a blank panel: no branch, ask for a
 * base, unrelated histories, nothing to review, and the list — plus two states the plan's own text
 * does not name but a real host can reach: `"resolving"` (a brief request in flight) and
 * `"error"` (`review.resolveBase` itself failed — a genuine transport/host error, not one of
 * §6.8's four *answers*, still needs a real rendering rather than nothing at all).
 *
 * `NullViewStateStore` (W9) is what the mount call site hands this component's `viewState` prop —
 * accepted here only because `AppRoot` and `ReviewView` share one `MountOptions` shape; this
 * component never reads or writes it (§6.8: "the view persists nothing at all").
 *
 * How the view learns which branch to review (D40's three arms, all handled here):
 * 1. `props.target` — the cold-bootstrap arm, read once at mount from `html.ts`'s bootstrap
 *    island (a `review.open`/the palette command revealed a *new* webview with a target already
 *    pending).
 * 2. The `review.target` event — pushed to an *already-open* view by the same `review.open` call,
 *    or by the palette command's own `reviewBranch(repoId, undefined)` — handled for the whole
 *    life of this component, not just at mount.
 * 3. The "no branch" state's own branch picker — the user picks one directly, no host round trip.
 */
import { SETTINGS } from "@kira-version/core";
import type { HostKind, Transport } from "@kira-version/ipc";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { BridgeClient } from "../../bridge/client.ts";
import { RefsState } from "../../state/refs.ts";
import { ReviewSessionState, type ReviewTarget } from "../../state/review.ts";
import type { ViewStateStore } from "../../state/viewState.ts";
import { useModalFocus } from "../dialogs/modalFocus.ts";
import DiffView from "../DiffView.vue";
import { buildRefListSections } from "../refListModel.ts";
import BaseSelector from "./BaseSelector.vue";
import ReviewCommitRow from "./ReviewCommitRow.vue";

const props = defineProps<{
  transport: Transport;
  viewState: ViewStateStore;
  host: HostKind;
  target?: ReviewTarget | null;
}>();

const bridge = new BridgeClient(props.transport);
const connectionState = bridge.connectionState;
const refsState = new RefsState(bridge);
const review = shallowRef<ReviewSessionState | undefined>(undefined);

const repoId = ref<string | undefined>(undefined);
const noActiveRepo = ref(false);

watch(repoId, (id) => refsState.setRepoId(id));

let unsubscribeTarget: (() => void) | undefined;

async function applyTarget(nextRepoId: string, branch: string): Promise<void> {
  repoId.value = nextRepoId;
  await review.value?.setTarget(nextRepoId, branch);
}

async function bootstrap(): Promise<void> {
  const init = await bridge.init();
  review.value = new ReviewSessionState(bridge, init.capabilities);

  unsubscribeTarget = bridge.on("review.target", (event) => {
    void applyTarget(event.repoId, event.branch);
  });

  if (props.target) {
    await applyTarget(props.target.repoId, props.target.branch);
    return;
  }
  const list = await bridge.request("repo.list", {});
  if (list.activeRepoId) {
    repoId.value = list.activeRepoId;
  } else {
    noActiveRepo.value = true;
  }
}

onMounted(() => {
  // Mirrors `App.vue`'s own first-paint mark (§5.1 — W18's review-view perf metric measures from
  // this, not merely from `kira:page-parsed`). Unlike the graph panel there is no lane-layout
  // worker to wait a frame for, so this can mark right after mount rather than waiting on a
  // `CommitGrid.vue`-equivalent chunk-applied event.
  requestAnimationFrame(() => {
    performance.mark("kira:first-paint");
    performance.measure("kira:first-paint", undefined, "kira:first-paint");
  });
  void bootstrap();
});

onBeforeUnmount(() => {
  unsubscribeTarget?.();
  review.value?.dispose();
  refsState.dispose();
  bridge.dispose();
  document.removeEventListener("keydown", onDocumentKeydown);
});

// ---------------------------------------------------------------------------------------
// The "no branch" state's own branch picker (§6.8 state 1) — `refListModel.ts`'s fold over
// `refs.list`, tags excluded (a tag is a point, not a line of development — matches W14's own
// rule on the row menu's "Review branch changes" entry).
// ---------------------------------------------------------------------------------------
const branchFilter = ref("");
const branchSections = computed(() =>
  buildRefListSections(
    {
      branches: refsState.branches.value,
      remoteBranches: refsState.remoteBranches.value,
      tags: [],
    },
    branchFilter.value,
  ),
);

function pickBranch(name: string): void {
  const id = repoId.value;
  if (!id) return;
  void applyTarget(id, name);
}

// ---------------------------------------------------------------------------------------
// The commit list — `PackedStreamState`'s own `store`/`loadedRows`/`generation`: `generation` is
// read (not merely as a dependency of `loadedRows`) so a reset that happens to land on the same
// row count (a `setBase` override back to an equally-sized range) still recomputes this list
// rather than reusing stale row identities (`packedStream.ts`'s own doc comment on why
// `generation` exists at all).
// ---------------------------------------------------------------------------------------
const shas = computed<readonly string[]>(() => {
  const r = review.value;
  if (!r) return [];
  void r.generation.value;
  const out: string[] = [];
  for (let i = 0; i < r.loadedRows.value; i++) out.push(r.store.shaAt(i));
  return out;
});

const commitCountFormatter = new Intl.NumberFormat();
const commitCountLabel = computed(() => {
  const resolution = review.value?.resolution.value;
  if (resolution?.range.kind !== "ready") return "";
  const count = resolution.range.commitCount;
  return `${commitCountFormatter.format(count)} ${count === 1 ? "commit" : "commits"}`;
});

const FALLBACK_PAGE_SIZE = SETTINGS["kiraVersion.graph.pageSize"].default;

function loadMoreLabel(): string {
  const r = review.value;
  if (!r) return "Load more";
  if (r.isLoadingMore.value) return "Loading…";
  const remaining = r.remaining.value;
  return remaining < FALLBACK_PAGE_SIZE
    ? `Load the last ${commitCountFormatter.format(remaining)}`
    : `Load more (${commitCountFormatter.format(remaining)} remaining)`;
}

function handleLoadMore(): void {
  if (review.value?.isLoadingMore.value) return;
  void review.value?.loadMore();
}

// ---------------------------------------------------------------------------------------
// Row expansion, the roving-tabindex cursor, and the diff overlay — one keydown handler at the
// root (§6.8 step 3's Esc ordering: the diff first, then the row), rather than three components
// each guessing whether it is the innermost.
// ---------------------------------------------------------------------------------------
const rowsEl = ref<HTMLDivElement | null>(null);
const focusedRow = ref(0);

watch(shas, (list) => {
  if (focusedRow.value >= list.length) focusedRow.value = Math.max(0, list.length - 1);
});

function rowElId(sha: string): string {
  return `kv-review-row-${sha}`;
}

function focusRow(index: number): void {
  focusedRow.value = index;
  const sha = shas.value[index];
  if (!sha) return;
  void nextTick(() => {
    rowsEl.value?.querySelector<HTMLElement>(`#${rowElId(sha)}`)?.focus({ preventScroll: true });
  });
}

function onRowsKeydown(event: KeyboardEvent): void {
  const list = shas.value;
  if (list.length === 0) return;
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      focusRow(Math.min(focusedRow.value + 1, list.length - 1));
      break;
    case "ArrowUp":
      event.preventDefault();
      focusRow(Math.max(focusedRow.value - 1, 0));
      break;
    case "Home":
      event.preventDefault();
      focusRow(0);
      break;
    case "End":
      event.preventDefault();
      focusRow(list.length - 1);
      break;
    default:
      break;
  }
}

function toggleRow(sha: string): void {
  review.value?.toggle(sha);
}

/** The single row (of possibly several expanded at once) currently showing its diff as the
 *  full-height overlay — at most one, since opening a file anywhere replaces whichever overlay
 *  was already showing. */
const activeDiffSha = computed<string | undefined>(() => {
  const r = review.value;
  if (!r) return undefined;
  for (const sha of r.expandedShas.value) {
    if (r.expansionFor(sha)?.detail.mode.value === "diff") return sha;
  }
  return undefined;
});

const activeDiffExpansion = computed(() => {
  const sha = activeDiffSha.value;
  return sha ? review.value?.expansionFor(sha) : undefined;
});

// W17: focus returns to the row's disclosure control when the diff overlay closes —
// `modalFocus.ts`'s own invoker-capture composable, reused. Whatever had focus the instant the
// overlay opened (in practice, the file the user clicked to get here, which is still the row's
// own disclosure element for a keyboard user who reached it via Enter on the row itself) is what
// gets it back, the same guarantee `RevertDialog.vue`/`CheckoutDialog.vue` already give a
// dialog's own invoking control.
const diffOverlayActive = computed(() => activeDiffSha.value !== undefined);
const diffOverlayEl = ref<HTMLDivElement | null>(null);
const { onKeydown: onDiffOverlayKeydown } = useModalFocus(diffOverlayActive, diffOverlayEl);

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  const diffSha = activeDiffSha.value;
  if (diffSha) {
    review.value?.expansionFor(diffSha)?.detail.showTree();
    return;
  }
  const sha = shas.value[focusedRow.value];
  if (sha && review.value?.expandedShas.value.has(sha)) review.value.collapse(sha);
}

onMounted(() => {
  document.addEventListener("keydown", onDocumentKeydown);
});

// ---------------------------------------------------------------------------------------
// The one polite live region — the shared per-row announcement (copy/open-in-editor/go-to-file
// outcomes, `ReviewSessionState.announcement`) and, additionally, an announcement each time the
// four non-list states are *entered* (W17: "a screen-reader user learns 'nothing to review'
// rather than meeting silence").
// ---------------------------------------------------------------------------------------
const liveAnnouncement = ref("");

watch(
  () => review.value?.announcement.value,
  (text) => {
    if (text !== undefined) liveAnnouncement.value = text;
  },
);

watch(
  () => review.value?.phase.value,
  (phase) => {
    const r = review.value;
    if (!r) return;
    const branch = r.branch.value ?? "";
    const base = r.resolution.value?.base ?? "";
    switch (phase) {
      case "ask":
        liveAnnouncement.value = `No base detected for ${branch}. Choose one to compare against.`;
        break;
      case "unrelated":
        liveAnnouncement.value = `${branch} and ${base} share no common history.`;
        break;
      case "empty":
        liveAnnouncement.value = `${branch} adds no commits to ${base}.`;
        break;
      case "listing":
        liveAnnouncement.value = `Comparing ${branch} to ${base}: ${commitCountLabel.value}.`;
        break;
      case "error":
        liveAnnouncement.value = `Couldn't compare ${branch} — ${r.resolveError.value ?? ""}`;
        break;
      default:
        break;
    }
  },
);
</script>

<template>
  <div class="kv-review-view" :data-connection-state="connectionState">
    <span class="kv-visually-hidden" data-testid="connection-state">{{ connectionState }}</span>
    <div class="kv-visually-hidden" role="status" aria-live="polite" data-testid="live-announcements">
      {{ liveAnnouncement }}
    </div>

    <template v-if="!review">
      <p class="kv-review-loading">Loading…</p>
    </template>

    <template v-else-if="noActiveRepo">
      <div class="kv-review-empty-state">
        <h2>Review branch changes</h2>
        <p>Open a repository first, then pick a branch to review.</p>
      </div>
    </template>

    <template v-else-if="!review.branch.value">
      <div class="kv-review-picker" data-testid="review-no-branch">
        <h2>Review branch changes</h2>
        <p class="kv-review-picker-copy">
          Pick a branch to compare its commits against a base you choose or one we detect.
        </p>
        <input
          type="text"
          class="kv-review-picker-filter"
          placeholder="Filter branches"
          aria-label="Filter branches"
          v-model="branchFilter"
          autofocus
        />
        <div class="kv-review-picker-scroll">
          <div class="kv-review-picker-section">
            <div class="kv-review-picker-section-title">Branches</div>
            <button
              v-for="row in branchSections.branches.visible"
              :key="row.refname"
              type="button"
              class="kv-review-picker-row"
              @click="pickBranch(row.shortName)"
            >
              {{ row.shortName }}
            </button>
            <div v-if="branchSections.branches.visible.length === 0" class="kv-review-picker-empty">
              No matching branches
            </div>
          </div>
          <div class="kv-review-picker-section">
            <div class="kv-review-picker-section-title">Remote branches</div>
            <button
              v-for="row in branchSections.remoteBranches.visible"
              :key="row.refname"
              type="button"
              class="kv-review-picker-row"
              @click="pickBranch(row.shortName)"
            >
              {{ row.shortName }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <template v-else>
      <header class="kv-review-header">
        <span class="codicon codicon-git-branch" aria-hidden="true"></span>
        <span class="kv-review-branch-name" data-testid="review-branch-name">{{
          review.branch.value
        }}</span>
        <BaseSelector
          :resolution="review.resolution.value"
          :refs-state="refsState"
          @select-base="review.setBase($event)"
        />
        <span v-if="review.phase.value === 'listing'" class="kv-review-commit-count">{{
          commitCountLabel
        }}</span>
      </header>

      <div class="kv-review-body">
        <p v-if="review.phase.value === 'resolving'" class="kv-review-status">
          Resolving comparison…
        </p>

        <p v-else-if="review.phase.value === 'error'" class="kv-review-status kv-review-error">
          Couldn't compare — {{ review.resolveError.value }}
        </p>

        <div v-else-if="review.phase.value === 'ask'" class="kv-review-status" data-testid="review-ask">
          <p>Nothing was detected for <strong>{{ review.branch.value }}</strong> — pick a base above. We won't guess.</p>
        </div>

        <p
          v-else-if="review.phase.value === 'unrelated'"
          class="kv-review-status"
          data-testid="review-unrelated"
        >
          “{{ review.branch.value }}” and “{{ review.resolution.value?.base }}” share no common
          history.
        </p>

        <p
          v-else-if="review.phase.value === 'empty'"
          class="kv-review-status"
          data-testid="review-empty"
        >
          “{{ review.branch.value }}” adds no commits to “{{ review.resolution.value?.base }}”.
        </p>

        <template v-else-if="review.phase.value === 'listing'">
          <div
            v-if="review.staleReview.value"
            class="kv-review-stale-banner"
            role="status"
            data-testid="review-stale-banner"
          >
            <span>This comparison has changed.</span>
            <button type="button" @click="review.acknowledgeStaleReview()">Refresh</button>
          </div>

          <div
            ref="rowsEl"
            class="kv-review-rows"
            role="tree"
            aria-label="Commits"
            @keydown="onRowsKeydown"
          >
            <ReviewCommitRow
              v-for="(sha, index) in shas"
              :id="rowElId(sha)"
              :key="sha"
              :sha="sha"
              :store="review.store"
              :expanded="review.expandedShas.value.has(sha)"
              :expansion="review.expansionFor(sha)"
              :focused="index === focusedRow"
              @toggle="toggleRow(sha)"
              @focus-row="focusRow(index)"
            />
          </div>

          <div v-if="!review.exhausted.value" class="kv-review-load-more">
            <button
              type="button"
              class="kv-review-load-more-button"
              :disabled="review.isLoadingMore.value"
              @click="handleLoadMore"
            >
              {{ loadMoreLabel() }}
            </button>
          </div>
        </template>
      </div>
    </template>

    <div
      v-if="activeDiffExpansion"
      ref="diffOverlayEl"
      class="kv-review-diff-overlay"
      @keydown="onDiffOverlayKeydown"
    >
      <DiffView
        class="kv-review-diff-overlay-view"
        :diff="activeDiffExpansion.detail.diff.value"
        :diff-error="activeDiffExpansion.detail.diffError.value"
        :file-index="activeDiffExpansion.detail.selectedFile.value"
        :total-files="activeDiffExpansion.detail.detail.value?.files.length ?? 0"
        :actions="activeDiffExpansion.actions"
        @select-file="activeDiffExpansion.detail.selectFile($event)"
        @back="activeDiffExpansion.detail.showTree()"
      />
    </div>
  </div>
</template>

<style>
.kv-review-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  position: relative;
  background-color: var(--kv-app-bg);
  color: var(--kv-app-fg);
  font-family: var(--kv-font-family);
  font-size: var(--kv-font-size);
  overflow: hidden;
}

.kv-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.kv-review-loading {
  padding: var(--kv-space-4);
  color: var(--kv-description-fg);
}

.kv-review-empty-state,
.kv-review-picker {
  display: flex;
  flex-direction: column;
  gap: var(--kv-space-2);
  padding: var(--kv-space-4);
  min-height: 0;
}

.kv-review-picker {
  height: 100%;
}

.kv-review-empty-state h2,
.kv-review-picker h2 {
  margin: 0;
  font-size: 1.1em;
}

.kv-review-picker-copy {
  margin: 0;
  color: var(--kv-description-fg);
}

.kv-review-picker-filter {
  background: var(--kv-panel-bg);
  color: var(--kv-row-fg);
  border: 1px solid var(--kv-panel-border);
  padding: var(--kv-space-1) var(--kv-space-2);
}

.kv-review-picker-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.kv-review-picker-section-title {
  padding: var(--kv-space-2) 0 var(--kv-space-1);
  color: var(--kv-description-fg);
  font-size: 0.8em;
  text-transform: uppercase;
}

.kv-review-picker-row {
  display: block;
  width: 100%;
  text-align: left;
  padding: var(--kv-space-1) var(--kv-space-2);
  border: none;
  background: transparent;
  color: var(--kv-app-fg);
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}

.kv-review-picker-row:hover {
  background-color: var(--kv-row-hover-bg);
}

.kv-review-picker-empty {
  color: var(--kv-description-fg);
  padding: var(--kv-space-1) var(--kv-space-2);
}

.kv-review-header {
  display: flex;
  align-items: center;
  gap: var(--kv-space-2);
  padding: var(--kv-space-2) var(--kv-space-3);
  border-bottom: 1px solid var(--kv-panel-border);
  flex-shrink: 0;
  min-width: 0;
}

.kv-review-branch-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kv-review-commit-count {
  margin-left: auto;
  color: var(--kv-description-fg);
  font-size: 0.85em;
  flex-shrink: 0;
}

.kv-review-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.kv-review-status {
  margin: 0;
  padding: var(--kv-space-4);
  color: var(--kv-description-fg);
}

.kv-review-error {
  color: var(--kv-error-fg);
}

.kv-review-stale-banner {
  display: flex;
  align-items: center;
  gap: var(--kv-space-2);
  padding: var(--kv-space-2) var(--kv-space-3);
  background: var(--kv-row-hover-bg);
  border-bottom: 1px solid var(--kv-panel-border);
  flex-shrink: 0;
}

.kv-review-rows {
  flex: 1;
  min-height: 0;
  overflow: auto;
  outline: none;
}

.kv-review-load-more {
  display: flex;
  justify-content: center;
  padding: var(--kv-space-2) var(--kv-space-3);
  flex-shrink: 0;
}

.kv-review-load-more-button {
  padding: var(--kv-space-2) var(--kv-space-3);
  border: 1px solid var(--kv-toolbar-border);
  border-radius: var(--kv-radius);
  background: transparent;
  color: var(--kv-app-fg);
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}

.kv-review-load-more-button:hover:not(:disabled) {
  background-color: var(--kv-row-hover-bg);
}

.kv-review-load-more-button:disabled {
  cursor: default;
  opacity: 0.7;
}

.kv-review-diff-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  background-color: var(--kv-app-bg);
  z-index: 20;
}

.kv-review-diff-overlay-view {
  width: 100%;
  height: 100%;
}
</style>
