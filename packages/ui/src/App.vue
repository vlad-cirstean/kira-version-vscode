<script setup lang="ts">
/**
 * `docs/plans/P4.md` W11: the real shell. P0 sketched two empty regions and P3 hung a live-data
 * strip on them "replaced by P4's real list and toolbar" (that comment's own words) — this file
 * is that replacement. `AppToolbar.vue`/`CommitGrid.vue`/`LoadMoreButton.vue` (W6-W10) are wired
 * together here for the first time; everything above this file in the dependency order was
 * deliberately dead code in the production bundle until now.
 *
 * The live-data strip and its `data-testid`s are deleted, not hidden, except one: `chunk-source`
 * stays on the list region, because it is a real field of the stream chunk (§5.4) with no other
 * visible surface — everything else the strip showed now has a real UI equivalent (the repo
 * picker's own label, the rendered rows themselves).
 */
import { SETTINGS } from "@kira-version/core";
import type { HostKind, Transport } from "@kira-version/ipc";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { BridgeClient } from "./bridge/client.ts";
import AppToolbar from "./components/AppToolbar.vue";
import CommitGrid from "./components/CommitGrid.vue";
import ConflictBanner from "./components/ConflictBanner.vue";
import BranchDialog from "./components/dialogs/BranchDialog.vue";
import CheckoutDialog from "./components/dialogs/CheckoutDialog.vue";
import RevertDialog from "./components/dialogs/RevertDialog.vue";
import TagDialog from "./components/dialogs/TagDialog.vue";
import EmptyRepositoryPanel from "./components/EmptyRepositoryPanel.vue";
import GitBlockedPanel from "./components/GitBlockedPanel.vue";
import LoadMoreButton from "./components/LoadMoreButton.vue";
import NoRepositoryPanel from "./components/NoRepositoryPanel.vue";
import DetailPane from "./components/DetailPane.vue";
import RowContextMenu from "./components/RowContextMenu.vue";
import { buildRowMenu, type MenuSection } from "./components/rowMenuModel.ts";
import { DetailState } from "./state/detail.ts";
import { type DetailActions, createDetailActions } from "./state/detailActions.ts";
import { GraphViewState } from "./state/graphView.ts";
import {
  composeLoadMoreAnnouncement,
  composeRefreshAnnouncement,
} from "./state/liveAnnouncements.ts";
import { OpsState } from "./state/ops.ts";
import { RefsState } from "./state/refs.ts";
import { RepoState } from "./state/repo.ts";
import { SelectionState } from "./state/selection.ts";
import { SettingsState } from "./state/settings.ts";
import {
  type ColumnWidths,
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_DETAIL_WIDTH,
  type DateFormat,
  type PersistedViewState,
  type ViewStateStore,
} from "./state/viewState.ts";

const props = defineProps<{
  transport: Transport;
  viewState: ViewStateStore;
  host: HostKind;
}>();

const bridge = new BridgeClient(props.transport);
const connectionState = bridge.connectionState;
const graphView = new GraphViewState(bridge);
// A fresh CommitStore for the life of this component (graphView is never swapped out from under
// it — a repo switch resets the same GraphViewState instance rather than replacing it, matching
// CommitGrid.vue's own documented assumption), so this can be constructed once, directly.
const selection = new SelectionState(graphView.store);
// `docs/plans/P5.md` W7/W11: one `DetailState` for the life of this component, exactly like
// `graphView`/`selection` above — a repo switch resets it (via `setRepoId` below) rather than
// replacing the instance. `actions` starts `undefined` and is built once, in `bootstrap()`, the
// moment `capabilities` comes back from `app.init` — every template site that reads it is inside
// the same `v-if="repoState"`/`v-else` branches that only render once a repo has actually opened,
// which cannot happen before that same `bootstrap()` call has already resolved `capabilities`.
const detailState = new DetailState(bridge);
const actions = shallowRef<DetailActions | undefined>(undefined);

// `docs/plans/P6.md` W12: one `RefsState`/`OpsState` for the life of this component, exactly like
// `graphView`/`selection`/`detailState` above — `handleRepoOpened`/the active-repo watch below
// reset them via `setRepoId` rather than replacing either instance.
const refsState = new RefsState(bridge);
const opsState = new OpsState(bridge, refsState);

const repoState = shallowRef<RepoState | undefined>(undefined);
const settingsState = shallowRef<SettingsState | undefined>(undefined);

const detailOpen = ref(true);
const columnWidths = ref<ColumnWidths>(DEFAULT_COLUMN_WIDTHS);
const dateFormat = ref<DateFormat>("relative");
const detailWidth = ref(DEFAULT_DETAIL_WIDTH);
const scrollRow = ref(0);
/** First-mount-only rehydration target for `CommitGrid.vue`'s own `initialScrollRow` prop (see
 *  that component's doc comment on why it is one-shot) — `undefined` until `bootstrap()` reads a
 *  persisted value, so a first-ever mount (nothing persisted yet) passes nothing and scrolls
 *  nowhere in particular, which is correct: there is no prior position to restore. */
const initialScrollRow = ref<number | undefined>(undefined);

// `settingsState` is always populated by the time this is actually read in practice
// (`bootstrap()` sets it synchronously, well before any repo-dependent UI — including this
// value's only consumer, `LoadMoreButton.vue` — can mount), so this fallback is never really
// exercised; it just needs to exist for the type. Sourced from the schema's own default rather
// than a hand-copied literal, so it cannot drift.
const FALLBACK_PAGE_SIZE = SETTINGS["kiraVersion.graph.pageSize"].default;

const pageSize = computed(
  () => settingsState.value?.settings.value["kiraVersion.graph.pageSize"] ?? FALLBACK_PAGE_SIZE,
);

const commitGridRef = ref<InstanceType<typeof CommitGrid> | null>(null);
const toolbarRef = ref<InstanceType<typeof AppToolbar> | null>(null);

function triggerRefresh(): void {
  toolbarRef.value?.refresh();
}

async function handleRepoOpened(repoId: string): Promise<void> {
  // §6.2: switching repos resets GraphViewState, clears selection, and (via the persistence
  // watch below) writes the new repoId — a genuinely different repo has no sha/scroll position
  // worth re-resolving, unlike a refresh's re-walk of the *same* history.
  pendingSelectionSha.value = null;
  selection.clear();
  graphView.reset();
  await graphView.openStream(repoId);
}

// ---------------------------------------------------------------------------------------
// §6.2 / W5: re-resolving selection by sha once a reset's rows are loaded again — shared by
// both the boot-time rehydration path (bootstrap(), below) and every later refresh
// (GraphViewState.generation bumps on every re-walk reset, §6.2's own doc comment on `refresh`).
// A *speculative* SelectionState.selectBySha on every partial chunk would be wrong: on a miss it
// clears selection immediately (by design — see SelectionState's own doc comment), so calling it
// before the target's row has actually streamed back in would discard a selection that was
// really still pending, not actually gone. `CommitStore.rowOfSha` is checked first, non-
// destructively, and the real (clearing-on-miss) call only happens once the row is either found
// or the stream is exhausted, at which point a miss is a real answer.
// ---------------------------------------------------------------------------------------
const pendingSelectionSha = ref<string | null>(null);

watch(graphView.generation, () => {
  const sha = selection.sha.value;
  pendingSelectionSha.value = sha;
});

watch(graphView.loadedRows, () => {
  const sha = pendingSelectionSha.value;
  if (sha === null) return;
  const found = graphView.store.rowOfSha(sha) !== -1;
  if (!found && !graphView.exhausted.value) return;
  pendingSelectionSha.value = null;
  if (selection.selectBySha(sha)) commitGridRef.value?.scrollToRow(selection.row.value);
});

// ---------------------------------------------------------------------------------------
// P5 W11's "selection wiring": `DetailState` does not watch `SelectionState` itself (it is kept
// decoupled from it, matching `SelectionState`'s own doc comment on staying decoupled from
// `GraphViewState` — a component wires the two together, per that comment's own precedent), so
// this is that wiring. `selection.sha` only actually *changes* value (Vue's ref setter is a
// no-op on an unchanged primitive) on a genuine selection change — including to `null` on a
// clear — which is exactly `DetailState.select`'s own precondition ("callers only invoke it on
// an actual change"). A refresh that re-resolves the *same* sha via `selectBySha` above therefore
// never re-triggers this watch at all, which is how W11's "a refresh must not flicker the pane"
// requirement is satisfied — there is no special-case caching to write, the cache is simply never
// invalidated because nothing here re-requests when nothing has actually changed.
// ---------------------------------------------------------------------------------------
watch(
  () => selection.sha.value,
  (sha) => detailState.select(sha),
);

watch(
  () => repoState.value?.activeRepo.value?.repoId,
  (repoId) => {
    detailState.setRepoId(repoId);
    refsState.setRepoId(repoId);
    opsState.setRepoId(repoId);
  },
  { immediate: true },
);

watch(detailState.announcement, (text) => {
  liveAnnouncement.value = text;
});

watch(opsState.announcement, (text) => {
  liveAnnouncement.value = text;
});

/**
 * `CommitMeta.vue`'s "select this parent commit" affordance, bubbled up through
 * `DetailPane.vue`'s own `selectParentCommit` emit. Mirrors a normal row click when the parent's
 * row is already loaded (updates `SelectionState` and scrolls the grid to it — the same two
 * calls a real click makes, so the grid's own highlight and the pane agree); when it is not
 * loaded (a parent outside the currently streamed window), there is no row to select or scroll
 * to, so only `detailState.select` runs — the pane still follows the parent commit, `selection`
 * is deliberately left as it was rather than cleared, since clearing it here would race this
 * same call's own `detailState.select` against the `selection.sha` watch above (a clear fires
 * that watch asynchronously, and its `null` would land *after* this function's own direct
 * `select(sha)` call, wiping the very detail this action just asked to show).
 */
function selectCommitFromDetail(sha: string): void {
  const row = graphView.store.rowOfSha(sha);
  if (row !== -1) {
    selection.select(row);
    commitGridRef.value?.scrollToRow(row);
    return;
  }
  detailState.select(sha);
}

function handleCopySha(fullSha: string): void {
  actions.value?.copy(fullSha, "full SHA");
}

// ---------------------------------------------------------------------------------------
// `docs/plans/P6.md` W14: the per-commit context menu. `CommitGrid.vue` only ever reports which
// row and where to open it (own doc comment on its `contextMenu` emit) — this is the one place
// with both `opsState` and the commit store's own decorations at hand to build the menu itself.
// ---------------------------------------------------------------------------------------
const contextMenuState = ref<{ row: number; x: number; y: number } | undefined>(undefined);
const tagDialogState = ref<{ open: boolean; target: string }>({ open: false, target: "" });
const branchDialogState = ref<{ open: boolean; startPoint: string }>({
  open: false,
  startPoint: "",
});

function handleGridContextMenu(detail: { row: number; x: number; y: number }): void {
  contextMenuState.value = detail;
}

const commitMenuSections = computed<MenuSection[]>(() => {
  const state = contextMenuState.value;
  if (!state) return [];
  const commit = graphView.store.commitAt(state.row);
  return buildRowMenu({
    sha: commit.sha,
    decorations: commit.decoration,
    inProgress: opsState.statusSummary.value?.inProgress ?? null,
    clipboardEnabled: actions.value?.capabilities.clipboard ?? false,
  });
});

async function onCommitMenuSelect(id: string): Promise<void> {
  const state = contextMenuState.value;
  contextMenuState.value = undefined;
  if (!state) return;
  const commit = graphView.store.commitAt(state.row);
  switch (id) {
    case "checkoutDetached":
      await opsState.runCheckout(commit.sha, "detach");
      return;
    case "createBranchHere":
      branchDialogState.value = { open: true, startPoint: commit.sha };
      return;
    case "createTagHere":
      tagDialogState.value = { open: true, target: commit.sha };
      return;
    case "revertThisCommit":
      await opsState.runRevert([commit.sha]);
      return;
    case "copySha":
      actions.value?.copy(commit.sha, "full SHA");
      return;
    case "copyMessage":
      // The subject line only — available synchronously from the store. `CommitMeta.vue`'s own
      // dedicated button (P5) copies the full trailer-joined message once its detail has loaded;
      // duplicating that async fetch here for a context-menu convenience is not worth the race.
      actions.value?.copy(commit.subject, "commit message");
      return;
    default:
      return;
  }
}

async function resolveConflictInEditor(path: string): Promise<void> {
  const repoId = repoState.value?.activeRepo.value?.repoId;
  if (!repoId) return;
  await bridge.request("editor.resolveConflict", { repoId, path });
}

// ---------------------------------------------------------------------------------------
// W14's own live region: "the Load-more result and Refresh completion are announced through one
// polite live region" — deferred here from W9 (`LoadMoreButton.vue`'s own doc comment: "a second
// region [t]here would fight it"), since both events are really about `GraphViewState.loading`
// leaving `"loadingMore"`/`"refreshing"`, which this file is already the one place watching. The
// row count *before* the operation started is captured on the way *into* one of those two states
// so the completion message can report how many rows the operation itself actually added, not
// just the total the store now holds.
// ---------------------------------------------------------------------------------------
const liveAnnouncement = ref("");
let loadedRowsBeforeLoad = 0;

watch(graphView.loading, (state, previous) => {
  if (state === "loadingMore" || state === "refreshing") {
    loadedRowsBeforeLoad = graphView.loadedRows.value;
    return;
  }
  if (state !== "idle") return;
  if (previous === "loadingMore") {
    const added = graphView.loadedRows.value - loadedRowsBeforeLoad;
    liveAnnouncement.value = composeLoadMoreAnnouncement(
      added,
      graphView.remaining.value,
      graphView.exhausted.value,
    );
  } else if (previous === "refreshing") {
    liveAnnouncement.value = composeRefreshAnnouncement(graphView.loadedRows.value);
  }
});

onMounted(() => {
  // requestAnimationFrame so the mark lands after the browser has actually painted this
  // frame, not merely after Vue's synchronous mount work.
  requestAnimationFrame(() => {
    performance.mark("kira:first-paint");
    performance.measure("kira:first-paint", undefined, "kira:first-paint");
  });

  // W15: `kira:layout-complete` used to be marked right here, in the same frame as
  // `kira:first-paint` — correct only while this shell had no real grid to wait on (P0-P3, per
  // this block's own git history). Now that one exists, marking it here would always measure
  // ~0ms and hide the exact cost §5.1's budget separates out: `GraphViewState`'s own doc comment
  // on `generation` names the reason first-paint and layout-complete are two different budgets
  // at all — "text first, graph a frame later, never a blank list waiting on a worker". This
  // mark now means what W15 needs it to mean: the *first* `LayoutChunk` has actually been
  // applied and the rows it covers re-rendered with their lanes, not merely that the shell
  // mounted. `CommitGrid.vue`'s own `handleChunkLayout` — the one place that event fires — marks
  // it, once, the first time that happens; nothing here needs to know when that is.
  void bootstrap();
});

let lastPersisted: PersistedViewState = {
  version: 3,
  repoId: null,
  loadedRows: 0,
  detailOpen: true,
  scrollRow: 0,
  selectedSha: null,
  columnWidths: DEFAULT_COLUMN_WIDTHS,
  dateFormat: "relative",
  detailWidth: DEFAULT_DETAIL_WIDTH,
  fileListMode: "tree",
};

async function bootstrap(): Promise<void> {
  const init = await bridge.init();
  settingsState.value = new SettingsState(bridge, init.settings);
  const repo = new RepoState(bridge, init.git);
  repoState.value = repo;
  // W10/W11: `capabilities` never changes after `app.init` resolves (see `DetailActions`'s own
  // doc comment), so `actions` is built exactly once, here, rather than reactively re-derived.
  actions.value = createDetailActions(
    bridge,
    detailState,
    init.capabilities,
    () => repoState.value?.activeRepo.value?.repoId,
  );

  const persisted = props.viewState.read();
  if (persisted) {
    lastPersisted = persisted;
    detailOpen.value = persisted.detailOpen;
    columnWidths.value = persisted.columnWidths;
    dateFormat.value = persisted.dateFormat;
    detailWidth.value = persisted.detailWidth;
    initialScrollRow.value = persisted.scrollRow;
    detailState.setListMode(persisted.fileListMode);

    // §6.3's "collapsed by default" below `wide`: a persisted `detailOpen: true` from an earlier,
    // wider session must not reopen the pane/drawer over a mount that starts narrower — without
    // this, the line above would silently clobber the collapse the mount-time `breakpoint` watch
    // (below) already applied moments earlier, since that watch runs synchronously during mount
    // while this restore only lands later, after `bridge.init()`'s own await. Not gated on
    // `breakpoint`'s *previous* value the way that watch is (there is no real "previous" at boot,
    // only that watch's own initial-ref placeholder) — mounting directly into a narrow layout is
    // exactly the case §6.3 describes, not merely a special case of resizing into one. A real
    // selection still reopens it once `pendingSelectionSha` resolves, via the selection watch
    // below — nothing here treats a boot with a pending selection any differently.
    collapseIfNarrowWithNoSelection();

    if (persisted.repoId) {
      const outcome = await repo.open(persisted.repoId);
      if (outcome.kind === "ok") {
        if (persisted.selectedSha) pendingSelectionSha.value = persisted.selectedSha;
        // §5.4: a freshly (re)mounted GraphViewState's own `loadedRows` starts at 0, so the
        // default `resumeThroughRow` asks the host to replay every row it still has cached —
        // that single round trip is the whole of "rehydrates without re-running git".
        await graphView.openStream(outcome.repo.repoId);
      }
    }
  }

  watch(
    [
      () => repoState.value?.activeRepo.value?.repoId ?? null,
      graphView.loadedRows,
      detailOpen,
      scrollRow,
      () => selection.sha.value,
      columnWidths,
      dateFormat,
      detailWidth,
      detailState.listMode,
    ],
    ([repoId, loadedRows, isDetailOpen, row, selectedSha, widths, format, dWidth, listMode]) => {
      lastPersisted = {
        ...lastPersisted,
        repoId,
        loadedRows,
        detailOpen: isDetailOpen,
        scrollRow: row,
        selectedSha,
        columnWidths: widths,
        dateFormat: format,
        detailWidth: dWidth,
        fileListMode: listMode,
      };
      props.viewState.write(lastPersisted);
    },
  );
}

// ---------------------------------------------------------------------------------------
// §6.3's breakpoints — measured on the webview's own width via ResizeObserver on the root, not
// `window.matchMedia` (which reports the *window's* width and would be wrong the moment the
// panel is docked to the side or split with another editor group).
// ---------------------------------------------------------------------------------------
type Breakpoint = "wide" | "narrow" | "overlay";

function breakpointFor(width: number): Breakpoint {
  if (width >= 900) return "wide";
  if (width >= 600) return "narrow";
  return "overlay";
}

const rootEl = ref<HTMLDivElement | null>(null);
const breakpoint = ref<Breakpoint>("wide");
let breakpointObserver: ResizeObserver | undefined;
let breakpointRaf = 0;

/** §6.3's "collapsed by default" below `wide`, with nothing selected — shared by the mount-time
 *  restore in `bootstrap()` (see its own call site's comment) and the live-resize watch just
 *  below, so both a fresh mount into a narrow layout and a later resize into one agree. */
function collapseIfNarrowWithNoSelection(): void {
  if (breakpoint.value !== "wide" && selection.row.value < 0) detailOpen.value = false;
}

// Entering a narrower breakpoint with nothing selected collapses the pane (§6.3's "collapsed by
// default"); entering it *with* a selection, or widening back past 900px, leaves `detailOpen` as
// it is — there is nothing in §6.3 asking a widen to force it back open, and forcing it closed
// on every narrow-to-wide crossing would fight a user who just opened it deliberately.
watch(breakpoint, (kind, previous) => {
  if (kind !== "wide" && previous === "wide") collapseIfNarrowWithNoSelection();
});

// §6.3: "collapsed by default, opens on selection" for both sub-900px bands — at the wide
// breakpoint, selecting a row does not by itself open the pane (only CommitGrid.vue's own
// toggle/close events do, §6.4's second-click/Enter/Esc model), so this only applies below it.
watch(
  () => selection.row.value,
  (row) => {
    if (row >= 0 && breakpoint.value !== "wide") detailOpen.value = true;
  },
);

function toggleDetail(): void {
  detailOpen.value = !detailOpen.value;
}

/** §6.6's Esc ordering: the diff view (P5 W9) first, then the detail pane/drawer. Kept as the
 *  one handler both `CommitGrid.vue`'s own `closeDetail` emit (when the grid has focus) and this
 *  file's own document-level listener (when focus is inside the detail pane/drawer itself, which
 *  is outside the grid's host and so outside its own keydown listener's reach) call — "the
 *  ordering lives in one handler in App.vue" (§6.6's own words), not duplicated per input
 *  source. */
function closeDetail(): void {
  if (detailState.mode.value === "diff") {
    detailState.showTree();
    return;
  }
  detailOpen.value = false;
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && detailOpen.value) closeDetail();
}

function onDocumentPointerDown(event: PointerEvent): void {
  // The overlay drawer's own "dismissible... on a click outside" (§6.3) — only listened for
  // while the drawer is actually showing, and only at the overlay breakpoint (the docked pane at
  // wide/narrow has no such behaviour; clicking the grid to select a different row is normal use
  // there, not a dismissal).
  if (breakpoint.value !== "overlay" || !detailOpen.value) return;
  const drawer = document.querySelector('[data-testid="detail-region"]');
  if (drawer && event.target instanceof Node && drawer.contains(event.target)) return;
  closeDetail();
}

function scheduleBreakpointUpdate(): void {
  if (breakpointRaf !== 0) return;
  breakpointRaf = requestAnimationFrame(() => {
    breakpointRaf = 0;
    if (rootEl.value) breakpoint.value = breakpointFor(rootEl.value.clientWidth);
  });
}

// ---------------------------------------------------------------------------------------
// The detail pane's own resize handle (≥900px only, §6.3's table) — the same drag-and-clamp
// shape `CommitGrid.vue`'s column handles use, kept here rather than factored out: this is the
// only other resizable edge in the app, and the two call sites differ enough (this one persists
// through `viewState` directly, that one round-trips through a prop/emit pair) that a shared
// helper would mostly be parameter-passing.
// ---------------------------------------------------------------------------------------
const MIN_DETAIL_WIDTH = 240;
const MAX_DETAIL_WIDTH = 640;

function setDetailWidth(next: number): void {
  detailWidth.value = Math.max(MIN_DETAIL_WIDTH, Math.min(MAX_DETAIL_WIDTH, Math.round(next)));
}

function startDetailResize(event: MouseEvent): void {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = detailWidth.value;
  const onMove = (moveEvent: MouseEvent): void => {
    // Dragging the left edge left (negative movementX) widens a right-docked pane.
    setDetailWidth(startWidth - (moveEvent.clientX - startX));
  };
  const onUp = (): void => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

const DETAIL_HANDLE_KEY_STEP = 16;

function handleDetailHandleKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    setDetailWidth(detailWidth.value + DETAIL_HANDLE_KEY_STEP);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    setDetailWidth(detailWidth.value - DETAIL_HANDLE_KEY_STEP);
  }
}

const detailWidthPx = computed(() => `${detailWidth.value}px`);

// `exactOptionalPropertyTypes` (tsconfig.base.json) treats an explicit `undefined` differently
// from an omitted prop — `CommitGrid.vue`'s `initialScrollRow?: number` wants the latter on a
// first-ever mount (nothing persisted to restore), so this only spreads the prop in once
// `bootstrap()` has actually set one, rather than always binding a possibly-`undefined` value.
const initialScrollRowProp = computed(() =>
  initialScrollRow.value === undefined ? {} : { initialScrollRow: initialScrollRow.value },
);

const hasSelection = computed(() => selection.row.value >= 0);

onMounted(() => {
  document.addEventListener("keydown", onDocumentKeydown);
  document.addEventListener("pointerdown", onDocumentPointerDown);
  if (rootEl.value) {
    breakpoint.value = breakpointFor(rootEl.value.clientWidth);
    breakpointObserver = new ResizeObserver(scheduleBreakpointUpdate);
    breakpointObserver.observe(rootEl.value);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onDocumentKeydown);
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  breakpointObserver?.disconnect();
  if (breakpointRaf !== 0) cancelAnimationFrame(breakpointRaf);
  graphView.dispose();
  refsState.dispose();
  opsState.dispose();
  repoState.value?.dispose();
  settingsState.value?.dispose();
  bridge.dispose();
});
</script>

<template>
  <div ref="rootEl" class="kv-app" :data-connection-state="connectionState">
    <!-- Unconditional, present from first paint regardless of which of the four content states
         below is showing (or whether bootstrap() has resolved a repoState at all yet) — the old
         live-data strip carried this testid unconditionally too (inside its own always-rendered
         toolbar), and it is a genuine e2e wait/assert target across all three hosts' specs, not
         merely cosmetic duplicate of the root's own data-connection-state attribute above. -->
    <span class="kv-visually-hidden" data-testid="connection-state">{{ connectionState }}</span>
    <!-- W14's one polite live region (see the `liveAnnouncement` watch above) — unconditional and
         present from first paint, same as connection-state above, since Load-more/Refresh can
         both complete while this file's own v-if chain is on any branch that renders the toolbar. -->
    <div
      class="kv-visually-hidden"
      role="status"
      aria-live="polite"
      data-testid="live-announcements"
    >
      {{ liveAnnouncement }}
    </div>
    <template v-if="repoState">
      <GitBlockedPanel v-if="repoState.git.value.kind !== 'ok'" :status="repoState.git.value" />

      <NoRepositoryPanel
        v-else-if="!repoState.activeRepo.value"
        :repo-state="repoState"
        @repo-opened="handleRepoOpened"
      />

      <template v-else-if="repoState.activeRepo.value.head.kind === 'unborn'">
        <AppToolbar
          ref="toolbarRef"
          :graph-view="graphView"
          :repo-state="repoState"
          :refs-state="refsState"
          :ops-state="opsState"
          :actions="actions"
          @repo-opened="handleRepoOpened"
        />
        <EmptyRepositoryPanel :branch-name="repoState.activeRepo.value.head.name" />
      </template>

      <template v-else>
        <AppToolbar
          ref="toolbarRef"
          :graph-view="graphView"
          :repo-state="repoState"
          :refs-state="refsState"
          :ops-state="opsState"
          :actions="actions"
          @repo-opened="handleRepoOpened"
        />
        <ConflictBanner
          :ops="opsState"
          :resolve-conflict-enabled="actions?.capabilities.resolveConflict ?? false"
          :resolve-conflict="resolveConflictInEditor"
        />
        <main class="kv-body">
          <section class="kv-graph-region" data-testid="graph-region" aria-label="Commit graph">
            <CommitGrid
              ref="commitGridRef"
              :graph-view="graphView"
              :selection="selection"
              :column-widths="columnWidths"
              :date-format="dateFormat"
              :clipboard-enabled="actions?.capabilities.clipboard ?? false"
              v-bind="initialScrollRowProp"
              @update:column-widths="columnWidths = $event"
              @update:date-format="dateFormat = $event"
              @scroll="scrollRow = $event"
              @toggle-detail="toggleDetail"
              @close-detail="closeDetail"
              @refresh="triggerRefresh"
              @copy-sha="handleCopySha"
              @context-menu="handleGridContextMenu"
            />
            <LoadMoreButton :graph-view="graphView" :page-size="pageSize" />
            <span class="kv-visually-hidden" data-testid="chunk-source">{{
              graphView.lastChunkSource.value ?? ""
            }}</span>
          </section>

          <aside
            v-if="detailOpen && breakpoint !== 'overlay'"
            class="kv-detail-region"
            data-testid="detail-region"
            aria-label="Commit detail"
          >
            <div
              v-if="breakpoint === 'wide'"
              class="kv-detail-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize detail pane"
              :aria-valuenow="detailWidth"
              :aria-valuemin="MIN_DETAIL_WIDTH"
              :aria-valuemax="MAX_DETAIL_WIDTH"
              :aria-valuetext="`${detailWidth} pixels`"
              tabindex="0"
              @mousedown="startDetailResize"
              @keydown="handleDetailHandleKeydown"
            ></div>
            <p v-if="!hasSelection" class="kv-detail-empty">Select a commit to see its details.</p>
            <DetailPane
              v-else-if="actions"
              :detail-state="detailState"
              :store="graphView.store"
              :actions="actions"
              @select-parent-commit="selectCommitFromDetail"
            />
          </aside>
        </main>

        <div
          v-if="detailOpen && breakpoint === 'overlay'"
          class="kv-detail-drawer"
          :class="{ 'kv-detail-drawer--diff': detailState.mode.value === 'diff' }"
        >
          <aside class="kv-detail-region" data-testid="detail-region" aria-label="Commit detail">
            <p v-if="!hasSelection" class="kv-detail-empty">Select a commit to see its details.</p>
            <DetailPane
              v-else-if="actions"
              :detail-state="detailState"
              :store="graphView.store"
              :actions="actions"
              @select-parent-commit="selectCommitFromDetail"
            />
          </aside>
        </div>

        <RowContextMenu
          v-if="contextMenuState"
          :sections="commitMenuSections"
          :x="contextMenuState.x"
          :y="contextMenuState.y"
          label="Commit actions"
          @select="onCommitMenuSelect"
          @close="contextMenuState = undefined"
        />
        <BranchDialog
          :open="branchDialogState.open"
          :start-point="branchDialogState.startPoint"
          :ops="opsState"
          @close="branchDialogState = { open: false, startPoint: '' }"
        />
        <TagDialog
          :open="tagDialogState.open"
          :target="tagDialogState.target"
          :existing-tags="refsState.tags.value"
          :ops="opsState"
          @close="tagDialogState = { open: false, target: '' }"
        />
        <CheckoutDialog :ops="opsState" />
        <RevertDialog :ops="opsState" />
      </template>
    </template>
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

.kv-body {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.kv-graph-region {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background-color: var(--kv-panel-bg);
}

.kv-graph-region .kv-commit-grid {
  flex: 1;
  min-height: 0;
}

.kv-detail-region {
  position: relative;
  width: v-bind(detailWidthPx);
  flex-shrink: 0;
  border-left: 1px solid var(--kv-panel-border);
  background-color: var(--kv-panel-bg);
  overflow: auto;
}

.kv-detail-resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 5px;
  margin-left: -2px;
  cursor: col-resize;
  z-index: 2;
  background: transparent;
}

.kv-detail-resize-handle:hover,
.kv-detail-resize-handle:focus-visible {
  background-color: var(--kv-focus-border);
  outline: none;
}

.kv-detail-empty {
  margin: 0;
  padding: var(--kv-space-4);
  color: var(--kv-description-fg);
}

/* §6.3's <600px band: an overlay drawer over the graph rather than a docked pane. */
.kv-detail-drawer {
  position: absolute;
  inset: 0;
  display: flex;
  justify-content: flex-end;
  background-color: var(--kv-overlay-bg);
  z-index: 20;
}

.kv-detail-drawer .kv-detail-region {
  width: min(320px, 90vw);
  box-shadow: -2px 0 8px var(--kv-widget-shadow);
}

/* W9's breakpoint table: at the overlay breakpoint the diff is a *full*-width overlay over the
 * graph, wider than the tree/meta drawer beside it — the docked/overlay difference stays "a
 * class on the wrapper, not a second copy of the subtree" (W11's own words) by widening this one
 * rule rather than `DetailPane.vue` (or anything inside it) needing to know the breakpoint at
 * all. */
.kv-detail-drawer--diff .kv-detail-region {
  width: 100vw;
}
</style>
