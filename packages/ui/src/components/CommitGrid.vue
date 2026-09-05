<script setup lang="ts">
/**
 * `docs/plans/P4.md` W6: the SlickGrid host. A single `<div ref="host">` and nothing else in the
 * template — every column, row and cell in this panel exists because SlickGrid put it there
 * (§5.3/§5.5), never because a Vue `v-for` iterated the commit set. Everything below the
 * template is `onMounted` construction, `onBeforeUnmount` teardown, and the wires between
 * `GraphViewState`/`SelectionState` (W5) and the grid instance.
 *
 * The grid instance (`grid`) is a plain, `markRaw`'d variable, not a `ref()`: wrapping it in
 * `ref()` would hand Vue's reactivity proxy every DOM node the grid owns, which is the exact
 * mistake §5.3 forbids for the commit store, applied to a grid instead of a store.
 *
 * Selection is *ours*: `SelectionState` (W5), not SlickGrid's own `RowSelectionModel` (which
 * exists for multi-select and cell ranges this app does not want). `getItemMetadata`'s
 * `cssClasses` (`columns.ts`) is what actually paints a selected row; changing selection
 * invalidates exactly the two affected rows (`#watchSelection` below), never the whole grid.
 */
import type { CommitRecord } from "@kira-version/core";
import type { Column, OnRenderedEventArgs } from "slickgrid";
import { SlickGrid } from "slickgrid";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { graphColumnWidth } from "../graph/geometry.ts";
import { createGraphFormatter } from "../graph/graphColumn.ts";
import type { GraphViewState, LayoutRange } from "../state/graphView.ts";
import type { SelectionState } from "../state/selection.ts";
import type { ColumnWidths, DateFormat } from "../state/viewState.ts";
import { rowHeightPx, TokenReader } from "../theme/readTokens.ts";
import { buildColumns, createCommitDataView, DATE_COLUMN_ID } from "./columns.ts";
import { formatAbsoluteDate, formatRelativeDate } from "./dateFormat.ts";
import { composeRowLabel } from "./rowAccessibility.ts";

const props = defineProps<{
  graphView: GraphViewState;
  selection: SelectionState;
  columnWidths: ColumnWidths;
  dateFormat: DateFormat;
  /** A previously persisted scroll target (`viewState.scrollRow`) — applied once, right after
   *  the first paint. Absent on a first-ever mount, where there is nothing to restore. */
  initialScrollRow?: number;
  /** §3.3's feature detection for the sha column's copy button (P5 W10) — `app.init`'s
   *  `capabilities.clipboard`, re-read on every render pass rather than captured once, since it
   *  is not yet known at this component's own first paint (`bootstrap()`'s `await` resolves
   *  after). */
  clipboardEnabled: boolean;
}>();

const emit = defineEmits<{
  (e: "update:columnWidths", widths: ColumnWidths): void;
  (e: "update:dateFormat", format: DateFormat): void;
  /** The top loaded row currently in view — what `viewState.scrollRow` should hold (a row
   *  index, not a pixel offset: it survives a re-walk, a pixel offset does not). */
  (e: "scroll", row: number): void;
  /** A row was clicked twice in a row, or `Enter` was pressed: open the detail pane if it is
   *  closed, close it if it is open. W10/App.vue own the pane's actual open/closed state. */
  (e: "toggleDetail"): void;
  /** `Esc`: close the detail pane unconditionally. */
  (e: "closeDetail"): void;
  /** `F5` or `Ctrl/Cmd+R` while this grid has focus. W10 owns the Refresh action itself. */
  (e: "refresh"): void;
  /** The sha column's copy button was clicked (P5 W10) — `App.vue` owns the actual
   *  `clipboard.write` call and the shared live-region announcement; this component only ever
   *  reports which sha, exactly as it reports scroll/toggle/close rather than acting on them. */
  (e: "copySha", fullSha: string): void;
  /** `docs/plans/P6.md` W14: a right-click, `Shift+F10`, or the Menu key on a row — `App.vue`
   *  owns the actual `RowContextMenu.vue` instance (it is the one place with both `ops` and the
   *  commit store's decorations at hand), so this only ever reports which row and where to open
   *  it, exactly as `copySha` reports which sha rather than copying it itself. */
  (e: "contextMenu", detail: { row: number; x: number; y: number }): void;
}>();

const MIN_COLUMN_WIDTH = 40;
const MAX_COLUMN_WIDTH = 600;
const MIN_MESSAGE_WIDTH = 120;
const HANDLE_KEY_STEP = 8;

const host = ref<HTMLDivElement | null>(null);
let grid: SlickGrid<CommitRecord> | undefined;
const tokenReader = new TokenReader();

const widths = ref<ColumnWidths>({ ...props.columnWidths });
const dateFormatRef = ref<DateFormat>(props.dateFormat);

// Built once per mounted grid (W8): closes over this instance's own LayoutStore/CommitStore
// (props.graphView is assumed stable for the life of one CommitGrid — a repo switch remounts
// this component rather than swapping graphView underneath it) and a rowHeight accessor so a
// `--kv-row-height` change is picked up on the next render without rebuilding this formatter.
const graphFormatter = createGraphFormatter(props.graphView.layout, props.graphView.store, () =>
  rowHeightPx(tokenReader),
);

// Positions of the three drag handles (message|author, author|date, date|sha), recomputed
// whenever the widths behind them change — see `updateHandlePositions`.
const handleLeftAuthor = ref(0);
const handleLeftDate = ref(0);
const handleLeftSha = ref(0);

let unsubscribeLayout: (() => void) | undefined;
let unsubscribeTokens: (() => void) | undefined;
let resizeObserver: ResizeObserver | undefined;
let resizeRaf = 0;
let scrollRaf = 0;
let previousSelectedRow = -1;

// W14: the row a click or a keyboard move just selected, so the accessibility pass below can
// move real DOM focus onto it the moment it next renders (`selection scrolls it into view first,
// focuses second` — the plan's own words). Never set for a selection that changes for a reason
// other than this component's own click/keyboard handling (e.g. App.vue re-resolving a selection
// by sha after a refresh) — those must not steal focus from wherever the user actually is.
let pendingFocusRow: number | null = null;

// W14: the row index that currently, genuinely holds real DOM focus, independent of
// `pendingFocusRow` above. A row's DOM node is destroyed and recreated by *any*
// `invalidateRows`/`render()` call that touches it, not only the selection-driven one
// `moveSelection`/`handleClick` trigger — `handleChunkLayout` (graph layout streaming in from
// the layout worker, W5) does the same for whatever range it touches, entirely independently and
// asynchronously of any selection change. When a `hugeRepo`-sized scenario's layout worker is
// still delivering chunks well after the grid is already interactable, one of those chunks can
// touch the very row the user just tabbed onto or selected — recreating its DOM node moments
// after `applyAccessibility` already focused it once, which the browser resolves by silently
// reverting focus to `<body>` (an element *removal*, not a user-driven `Tab`; a genuine, observed
// race, not a hypothetical one). `pendingFocusRow` alone only re-focuses a row on the *one*
// render immediately following a selection change, so it cannot catch this: by the time the
// second, unrelated render arrives, it has already been consumed. `focusedRowIndex` instead
// tracks "the row the user is actually on" persistently, refreshed by every genuine `focusin`
// (`handleFocusIn` below) and cleared only when focus genuinely lands somewhere that is not a
// row — never by the implicit, targetless bounce to `<body>` a DOM removal causes, which fires no
// `focusin` at all. `applyAccessibility` re-focuses this row on *every* render that recreates it,
// for as long as it remains the one the user is on, closing the race `pendingFocusRow` alone
// leaves open.
//
// P5 W10 adds a second real tab stop inside the row's own subtree, its `kv-cell-sha` button, and
// `focusedShaButton` remembers which of the row's two focusable elements the user was actually
// on. Restoring unconditionally to the row div (as this used to) fought the user the moment they
// tabbed onto that button on a `hugeRepo`-sized scenario: the layout worker's still-arriving
// chunks recreate row DOM nodes well after the initial mount regardless of what currently holds
// focus, and always recovering to the row rather than the button they had actually reached
// turned every such background render into an involuntary step backwards — directly observed as
// `Tab` from the button never making forward progress, since the very next render bounced focus
// back to the row before the browser had advanced it anywhere.
let focusedRowIndex: number | null = null;
let focusedShaButton = false;

function handleFocusIn(event: FocusEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const rowAttr = target.closest(".slick-row")?.getAttribute("data-row");
  focusedRowIndex = rowAttr != null ? Number(rowAttr) : null;
  focusedShaButton = target.classList.contains("kv-cell-sha");
}

function computeMessageWidth(hostWidth: number, laneCount: number): number {
  const fixed =
    graphColumnWidth(laneCount) + widths.value.author + widths.value.date + widths.value.sha;
  return Math.max(MIN_MESSAGE_WIDTH, hostWidth - fixed);
}

function currentColumns(): Column<CommitRecord>[] {
  const hostWidth = host.value?.clientWidth ?? 0;
  const laneCount = props.graphView.laneCount.value;
  return buildColumns(
    { ...widths.value, laneCount, messageWidth: computeMessageWidth(hostWidth, laneCount) },
    { dateFormat: () => dateFormatRef.value, now: () => Date.now() },
    graphFormatter,
    { enabled: () => props.clipboardEnabled, onCopy: (fullSha) => emit("copySha", fullSha) },
  );
}

function updateHandlePositions(): void {
  const hostWidth = host.value?.clientWidth ?? 0;
  const laneCount = props.graphView.laneCount.value;
  handleLeftAuthor.value = graphColumnWidth(laneCount) + computeMessageWidth(hostWidth, laneCount);
  handleLeftDate.value = handleLeftAuthor.value + widths.value.author;
  handleLeftSha.value = handleLeftDate.value + widths.value.date;
}

function rebuildColumns(): void {
  grid?.setColumns(currentColumns());
  updateHandlePositions();
}

function setColumnWidth(column: keyof ColumnWidths, next: number): void {
  const clamped = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(next)));
  if (widths.value[column] === clamped) return;
  widths.value = { ...widths.value, [column]: clamped };
  rebuildColumns();
  emit("update:columnWidths", widths.value);
}

function startDrag(column: keyof ColumnWidths, event: MouseEvent): void {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = widths.value[column];
  const onMove = (moveEvent: MouseEvent): void => {
    setColumnWidth(column, startWidth + (moveEvent.clientX - startX));
  };
  const onUp = (): void => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function handleHandleKeydown(column: keyof ColumnWidths, event: KeyboardEvent): void {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    setColumnWidth(column, widths.value[column] - HANDLE_KEY_STEP);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    setColumnWidth(column, widths.value[column] + HANDLE_KEY_STEP);
  }
}

function toggleDateFormat(): void {
  dateFormatRef.value = dateFormatRef.value === "relative" ? "absolute" : "relative";
  rebuildColumns();
  grid?.invalidateAllRows();
  grid?.render();
  emit("update:dateFormat", dateFormatRef.value);
}

/** §6.4: "onClick selects the row (and a second click on the selected row toggles the detail
 *  pane closed)". Clicking the date cell specifically also toggles its relative/absolute format
 *  (§6.2) — the two behaviours compose, since a date-cell click is still a row click. */
function handleClick(row: number, cell: number): void {
  const dateColumnIndex =
    grid?.getColumns().findIndex((column) => column.id === DATE_COLUMN_ID) ?? -1;
  if (cell === dateColumnIndex) toggleDateFormat();

  const wasSelected = props.selection.row.value === row;
  props.selection.select(row);
  pendingFocusRow = row;
  if (wasSelected) emit("toggleDetail");
}

/** §6.4: "right-click selects the row [first]", then (P6 W14) opens `RowContextMenu.vue` at the
 *  click point — the browser's own native menu is suppressed now that there is a real one to
 *  show instead of P4's "nothing else". */
function handleContextMenu(event: MouseEvent): void {
  event.preventDefault();
  const cell = grid?.getCellFromEvent(event);
  if (!cell) return;
  props.selection.select(cell.row);
  emit("contextMenu", { row: cell.row, x: event.clientX, y: event.clientY });
}

/** `Shift+F10`/the Menu key (§6.6): opens the same menu `handleContextMenu` does, anchored to
 *  the selected row's own bounding rect rather than a click point that does not exist for a
 *  keyboard invocation. */
function openMenuFromKeyboard(row: number): void {
  if (!grid) return;
  const container = grid.getContainerNode();
  const rowNode = container.querySelector<HTMLElement>(`.slick-row[data-row="${row}"]`);
  const rect = rowNode?.getBoundingClientRect();
  emit("contextMenu", { row, x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
}

function pageSize(): number {
  if (!grid) return 1;
  const { top, bottom } = grid.getViewport();
  return Math.max(1, bottom - top);
}

function moveSelection(row: number): void {
  const loaded = props.graphView.loadedRows.value;
  const clamped = Math.max(0, Math.min(row, loaded - 1));
  if (clamped < 0) return;
  props.selection.select(clamped);
  pendingFocusRow = clamped;
  grid?.scrollRowIntoView(clamped);
}

/**
 * §6.6's own keyboard model. Wired through `grid.onKeyDown` (not a plain `host` DOM listener —
 * see `onMounted`'s subscription for why): SlickGrid's own `handleKeyDown`, bound to its internal
 * focus sink *and* to the canvas every row lives in (so it also runs when a row itself — W14's own
 * roving-`tabindex` target — holds real DOM focus, not only the sink), intercepts `PageUp`/
 * `PageDown` unconditionally — `handled = true` regardless of `enableCellNavigation`
 * (`slick.grid.js`'s own `e.which === keyCode.PAGE_DOWN ? (this.navigatePageDown(), handled = !0)
 * : ...`) — and calls `stopPropagation()`, so those two keys never reach a listener on `host` at
 * all; `enableCellNavigation: false` spares every *other* key SlickGrid's own switch would
 * otherwise claim, `Tab`/`Shift+Tab` included (`navigateNext`/`navigatePrev` both bottom out in
 * `navigate()`'s own `!this._options.enableCellNavigation` guard, an unconditional `false`).
 *
 * Returns whether this function actually acted on the key — `onMounted`'s subscription calls
 * `event.stopImmediatePropagation()` only when it did (see that call site's own comment for why
 * this matters for `Tab` specifically: this function's caller is exactly where SlickGrid decides
 * whether to `preventDefault()` a keydown, so claiming a key we did nothing with would silently
 * block the browser's own default behaviour for it — `Tab` leaving the grid, most of all).
 */
function handleKeyDown(event: KeyboardEvent): boolean {
  const loaded = props.graphView.loadedRows.value;
  const current = props.selection.row.value;
  switch (event.key) {
    case "ArrowUp":
      if (loaded === 0) return false;
      event.preventDefault();
      moveSelection(current < 0 ? 0 : current - 1);
      return true;
    case "ArrowDown":
      if (loaded === 0) return false;
      event.preventDefault();
      moveSelection(current < 0 ? 0 : current + 1);
      return true;
    case "Home":
      if (loaded === 0) return false;
      event.preventDefault();
      moveSelection(0);
      return true;
    case "End":
      if (loaded === 0) return false;
      event.preventDefault();
      moveSelection(loaded - 1);
      return true;
    case "PageUp":
      if (loaded === 0) return false;
      event.preventDefault();
      moveSelection((current < 0 ? 0 : current) - pageSize());
      return true;
    case "PageDown":
      if (loaded === 0) return false;
      event.preventDefault();
      moveSelection((current < 0 ? 0 : current) + pageSize());
      return true;
    case "Enter":
      event.preventDefault();
      emit("toggleDetail");
      return true;
    case "Escape":
      event.preventDefault();
      emit("closeDetail");
      return true;
    case "F5":
      event.preventDefault();
      emit("refresh");
      return true;
    case "r":
    case "R":
      if (!event.ctrlKey && !event.metaKey) return false;
      event.preventDefault();
      emit("refresh");
      return true;
    case "F10":
      if (!event.shiftKey || current < 0) return false;
      event.preventDefault();
      openMenuFromKeyboard(current);
      return true;
    case "ContextMenu":
      if (current < 0) return false;
      event.preventDefault();
      openMenuFromKeyboard(current);
      return true;
    default:
      return false;
  }
}

// W15: `kira:layout-complete` fires exactly once, the first time a `LayoutChunk` is applied and
// re-rendered — see App.vue's own doc comment on why it moved here rather than firing at mount.
let layoutCompleteMarked = false;

/** The row range that just gained lane layout (`GraphViewState.onChunkLayout`, W5) — rebuild the
 *  column set in case `laneCount` grew (the graph column's width formula depends on it), then
 *  invalidate exactly the rows that changed rather than the whole grid. */
function handleChunkLayout(range: LayoutRange): void {
  if (!grid) return;
  rebuildColumns();
  const rows: number[] = [];
  for (let row = range.from; row < range.to; row++) rows.push(row);
  grid.invalidateRows(rows);
  grid.render();
  if (!layoutCompleteMarked) {
    layoutCompleteMarked = true;
    performance.mark("kira:layout-complete");
    performance.measure("kira:layout-complete", undefined, "kira:layout-complete");
  }
}

function scheduleResize(): void {
  if (resizeRaf !== 0) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    grid?.resizeCanvas();
    rebuildColumns();
  });
}

/**
 * `docs/plans/P4.md` W14, "the whole of the above is one function called from
 * `onRendered({startRow, endRow})`, applied to the rows in that range": counts, selection,
 * roving focus and each row's composed accessible name, all from state this component already
 * holds. Cheap by construction — it only ever touches rows SlickGrid just built (a handful of
 * `setAttribute` calls per row, the same order as the row's own construction), never the whole
 * loaded history.
 *
 * `container`/rendered-row lookups go through `grid.getContainerNode()` rather than `host.value`
 * directly — they are the same element (SlickGrid's own `_container`, the constructor's first
 * argument), but reading it back off the grid instance keeps this function honest about only ever
 * touching DOM the library itself owns and rendered, not assuming anything about this component's
 * own template.
 */
function applyAccessibility(range: { startRow: number; endRow: number }): void {
  if (!grid) return;
  const container = grid.getContainerNode();
  const totalRows = props.graphView.loadedRows.value;
  const columns = grid.getColumns();
  container.setAttribute("aria-rowcount", String(totalRows));
  container.setAttribute("aria-colcount", String(columns.length));

  const selectedRow = props.selection.row.value;
  // No row selected yet (a fresh mount with nothing persisted): row 0, if it exists, is the one
  // tab stop into the grid — the ARIA grid pattern's own answer to "what receives focus before
  // anything has been chosen" (a plain `Tab` must land somewhere real, never nothing at all, once
  // `_focusSink`/`_focusSink2` below are taken out of the tab order).
  const tabbableRow = selectedRow >= 0 ? selectedRow : 0;

  const from = Math.max(0, range.startRow);
  const to = Math.min(range.endRow, totalRows - 1);
  for (let row = from; row <= to; row++) {
    const rowNode = container.querySelector<HTMLElement>(`.slick-row[data-row="${row}"]`);
    if (!rowNode) continue;

    rowNode.setAttribute("aria-rowindex", String(row + 1));
    const isSelected = row === selectedRow;
    rowNode.setAttribute("aria-selected", isSelected ? "true" : "false");
    rowNode.tabIndex = row === tabbableRow ? 0 : -1;
    // P5 W10's sha column button is a real, natively-focusable `<button>` (enabling it is the
    // whole point — a `disabled` one, per its own doc comment, is never a tab stop at all). Left
    // alone, that turns virtualized `Tab` navigation into a keyboard trap no bound on `Tab`
    // presses escapes: reaching an off-screen button scrolls it into view, which SlickGrid
    // answers by virtualizing in yet more rows below, so a scenario with thousands of loaded
    // commits never runs out of *new* buttons to reach before the grid's own last DOM sibling.
    // The fix mirrors the row's own roving tabindex directly above: only the one row that is
    // itself tabbable ever exposes its sha button to `Tab`; every other row's copy button is
    // still there, still clickable by mouse, just not a stop `Tab` alone will find — reaching it
    // needs arrow-key selection first, exactly as reaching that row's own detail does.
    const shaButton = rowNode.querySelector<HTMLButtonElement>(".kv-cell-sha");
    if (shaButton) shaButton.tabIndex = row === tabbableRow ? 0 : -1;

    const commit = props.graphView.store.commitAt(row);
    const dateText =
      dateFormatRef.value === "absolute"
        ? formatAbsoluteDate(commit.author.timestamp)
        : formatRelativeDate(commit.author.timestamp, Date.now());
    rowNode.setAttribute("aria-label", composeRowLabel(commit, dateText));

    const cells = rowNode.querySelectorAll<HTMLElement>(".slick-cell");
    for (const [index, cellNode] of cells.entries()) {
      cellNode.setAttribute("aria-colindex", String(index + 1));
    }
    // The graph column carries no information the row's own aria-label does not (§7.9) — lane
    // colour is decorative, and HEAD/stash/branch-vs-tag are all named in the label already.
    rowNode.querySelector(".kv-cell-graph")?.setAttribute("aria-hidden", "true");

    // Either this row was just explicitly selected (`pendingFocusRow` — always the row div itself,
    // matching "selection scrolls it into view first, focuses second") or it is the row the user
    // was already on (`focusedRowIndex`) and this render just recreated its DOM node out from
    // under it — both cases need a *new* node focused; `focusedRowIndex`'s own doc comment above
    // explains why a one-shot `pendingFocusRow` check alone is not enough, and why the recovery
    // case restores the sha button specifically when that, not the row div, is what the user was
    // last known to be on.
    //
    // `{ preventScroll: true }` is load-bearing, not a micro-optimisation: a freshly re-appended
    // row is added at the *end* of its DOM sibling list (its own doc comment on `handleClick`'s
    // sibling, `pendingFocusRow`, plus `commitList.spec.ts`'s own `rowByIndex` doc comment — "DOM
    // order no longer matches row order") and only *visually* placed back at the right spot via
    // its `transform: translateY(...)` inline style. A bare `.focus()` triggers the browser's own
    // implicit scroll-into-view, which was directly observed (via a `Node.prototype.removeChild`
    // trace) to use the row's untransformed *layout* position rather than its transformed visual
    // one — scrolling the real viewport to wherever the row landed in raw DOM order, not where it
    // is drawn. That scroll fires SlickGrid's own `handleScroll`, which runs its usual
    // `cleanupRows()` pass against the *new* (wrong) scroll position and evicts the very row this
    // function just focused — a real, reproduced keyboard-trap-adjacent bug on `hugeRepo`-sized
    // scenarios, where the eviction lands on no later `onRendered` pass to recover it, leaving
    // focus stranded on `<body>`. This grid already scrolls the target row into view correctly
    // itself (`moveSelection`'s own `grid.scrollRowIntoView` call, run *before* this ever fires) —
    // the browser's own heuristic has nothing left to usefully do here, only harm to avoid.
    const wasPendingFocus = pendingFocusRow === row;
    if (wasPendingFocus) pendingFocusRow = null;
    if (wasPendingFocus) {
      rowNode.focus({ preventScroll: true });
    } else if (row === focusedRowIndex) {
      const target = focusedShaButton ? (shaButton ?? rowNode) : rowNode;
      target.focus({ preventScroll: true });
    }
  }
}

onMounted(() => {
  if (!host.value) return;
  tokenReader.watch();

  const dataView = createCommitDataView({
    store: props.graphView.store,
    loadedRows: () => props.graphView.loadedRows.value,
    isSelected: (row) => props.selection.row.value === row,
  });

  const instance = new SlickGrid<CommitRecord>(host.value, dataView, currentColumns(), {
    rowHeight: rowHeightPx(tokenReader), // §6.1 — never a literal in this file
    enableCellNavigation: false, // §6.6 navigates rows, not cells (see handleKeyDown's doc comment)
    enableColumnReorder: false, // §6.2: resizable, not reorderable — no SortableJS in the loop
    enableHtmlRendering: false, // formatters return elements; no innerHTML, nothing to sanitize
    showColumnHeader: false, // §6.1 — the workbench list this mirrors has no header row
    enableTextSelectionOnCells: true, // subjects/authors/shas are meant to be selectable text
    explicitInitialization: false, // the constructor rendering immediately is what we want here
    minRowBuffer: 3, // render-ahead buffer above/below the viewport, not the whole history
    rowTopOffsetRenderType: "transform", // matches how --kv-row-height drives row positioning
  });
  grid = instance;

  // W14/V2: SlickGrid's own internal structural elements — `_focusSink`/`_focusSink2` (two
  // invisible divs it binds its own keyboard handling to) and, less obviously, six `.slick-pane`,
  // four `.slick-viewport` and four `.grid-canvas` wrapper divs it always constructs regardless of
  // this grid's single-pane, unfrozen configuration — are *all* created with a literal
  // `tabindex="0"` (confirmed against the compiled source, not assumed from the `.d.ts`, which
  // types `_focusSink`/`_focusSink2` `protected` despite them being genuine public JS fields at
  // runtime). Most of those fourteen sit at 0×0 (no frozen columns/rows means their right/bottom
  // counterparts render empty) and a real browser already skips a zero-area stop, but
  // `.slick-pane-top-left`/`.slick-viewport-top-left` are not zero-sized — they are exactly as
  // large as the grid itself and sit in the DOM before any row, so without this sweep `Tab` lands
  // on one of *them*, never on a row. The row-level roving `tabindex` `applyAccessibility`
  // maintains below is the real tab stop this grid wants; this sweep is only the precondition —
  // none of these fourteen may still carry a `tabindex="0"` once it runs. Done once, right after
  // construction and before any row has been given a `tabindex` of its own, so it can safely
  // target every remaining `[tabindex="0"]` under the container without also catching a row.
  // Removing an element from the tab order does not stop a script-invoked `.focus()` from still
  // reaching it (`tabIndex` only governs `Tab`-key reachability) — moot here regardless, since
  // this grid no longer calls `grid.focus()` anywhere (`handleClick`/`moveSelection`'s own
  // `pendingFocusRow` focuses a row directly instead). Removing the `tabindex` attribute outright
  // (rather than setting the `.tabIndex` IDL property to `-1`, which leaves a literal
  // `tabindex="-1"` in the DOM) matters for more than tidiness: axe's `aria-required-children`
  // check for `role="grid"` containers treats *any* child bearing an explicit `tabindex` attribute
  // — any value — as a non-transparent element that must itself be a valid grid child, which these
  // plain structural wrapper divs are not. Removing the attribute keeps them transparent for that
  // computation.
  for (const el of instance.getContainerNode().querySelectorAll<HTMLElement>('[tabindex="0"]')) {
    el.removeAttribute("tabindex");
  }

  instance.onRendered.subscribe((_event, args: OnRenderedEventArgs) => applyAccessibility(args));
  // The constructor above already performed the grid's first render (`explicitInitialization:
  // false`) before this subscription existed to hear about it — `onRendered` is a plain
  // publish/subscribe event, not a replayed one, so that first pass gets the accessibility
  // attributes applied here explicitly rather than by waiting for whatever render happens next.
  const initialRange = instance.getRenderedRange();
  applyAccessibility({ startRow: initialRange.top, endRow: initialRange.bottom });

  instance.onClick.subscribe((_event, args) => handleClick(args.row, args.cell));
  instance.onScroll.subscribe(() => {
    if (scrollRaf !== 0) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (grid) emit("scroll", grid.getViewport().top);
    });
  });
  // `stopImmediatePropagation()` only for a key `handleKeyDown` actually claimed — see that
  // function's own doc comment. Claiming *every* key unconditionally (this project's own earlier
  // approach, before W14) was safe for every key our own switch names, but not for `Tab`:
  // SlickGrid's `handleKeyDown` calls `e.preventDefault()` whenever `handled` ends up `true` by
  // the time it finishes, regardless of *which* code path set it there, so an unconditional
  // `stopImmediatePropagation()` here silently blocked the browser's own `Tab`-key focus
  // navigation the moment a row (rather than the inert `_focusSink`) could hold real DOM focus —
  // exactly the "no keyboard trap" failure W14's own keyboard-only pass exists to catch.
  instance.onKeyDown.subscribe((event) => {
    const handled = handleKeyDown(event.getNativeEvent<KeyboardEvent>());
    if (handled) event.stopImmediatePropagation();
  });

  host.value.addEventListener("contextmenu", handleContextMenu);
  // `document`, not `host.value`: `focusedRowIndex`'s own doc comment above needs to know when
  // focus lands anywhere that is *not* a row, including this grid's own resize handles (siblings
  // of `host`, not descendants — a plain SVG/DOM-tree ancestor listener would miss those) and
  // every other focusable element in the panel (the toolbar, the detail pane).
  document.addEventListener("focusin", handleFocusIn);

  resizeObserver = new ResizeObserver(scheduleResize);
  resizeObserver.observe(host.value);

  unsubscribeLayout = props.graphView.onChunkLayout(handleChunkLayout);

  unsubscribeTokens = tokenReader.onChange(() => {
    if (!grid) return;
    grid.setOptions({ rowHeight: rowHeightPx(tokenReader) });
    grid.invalidateAllRows();
    grid.render();
  });

  updateHandlePositions();
  if (props.initialScrollRow !== undefined) instance.scrollRowIntoView(props.initialScrollRow);
  previousSelectedRow = props.selection.row.value;
});

// `GraphViewState`'s data changes are driven entirely through `onChunkLayout` (registered in
// `onMounted` above) rather than a `watch()` on its scalars — one obvious path for "new rows
// landed" instead of two that could race. `SelectionState.row` is watched here because it can
// change from *outside* this component too (`selectBySha` re-resolving a selection after a
// refresh's re-walk, W11), not only from `handleClick`/keyboard nav, so it needs its own
// always-on two-row invalidation rather than being folded into those call sites.
watch(
  () => props.selection.row.value,
  (row) => {
    if (!grid) return;
    const rows = [previousSelectedRow, row].filter((value) => value >= 0);
    if (rows.length > 0) grid.invalidateRows(rows);
    grid.render();
    previousSelectedRow = row;
  },
);
watch(
  () => props.graphView.loadedRows.value,
  () => {
    grid?.updateRowCount();
    grid?.render();
  },
);
watch(
  () => props.graphView.generation.value,
  () => {
    grid?.invalidateAllRows();
    grid?.updateRowCount();
    grid?.render();
  },
);
// Unlike `columnWidths`/`dateFormat` above (captured once — this component is the only writer
// of either), `clipboardEnabled` genuinely changes *after* this component's own first paint:
// `App.vue`'s `bootstrap()` only learns the real capability once `bridge.init()`'s `await`
// resolves, well after this grid has already built its first set of columns with the button
// disabled. Rebuilding on the flip is what turns that into a live enable rather than one stuck
// showing "not available" for the rest of the session.
watch(
  () => props.clipboardEnabled,
  () => {
    rebuildColumns();
    grid?.invalidateAllRows();
    grid?.render();
  },
);

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  if (resizeRaf !== 0) cancelAnimationFrame(resizeRaf);
  if (scrollRaf !== 0) cancelAnimationFrame(scrollRaf);
  unsubscribeLayout?.();
  unsubscribeTokens?.();
  tokenReader.dispose();
  host.value?.removeEventListener("contextmenu", handleContextMenu);
  document.removeEventListener("focusin", handleFocusIn);
  grid?.destroy();
  grid = undefined;
});

/** `App.vue` (W11) calls this once a refresh's re-walk re-resolves a previously selected sha
 *  back to a (possibly different) row — `initialScrollRow` only ever applies once, at mount
 *  (see its own doc comment above), so a refresh that happens later needs an imperative path
 *  back to the same underlying `scrollRowIntoView` call. */
function scrollToRow(row: number): void {
  grid?.scrollRowIntoView(row);
}

defineExpose({ scrollToRow });
</script>

<template>
  <div class="kv-commit-grid" data-testid="commit-grid">
    <!-- SlickGrid's own `init()` (`Utils.emptyElement(this._container)`) wipes out whatever was
         inside its container the moment it constructs — including these resize handles, if they
         were this element's own children. `host` is SlickGrid's *exclusive* DOM: the handles are
         its siblings, absolutely positioned over it via `.kv-commit-grid`'s own `position:
         relative` above, not descendants a `new SlickGrid(host.value, ...)` call would delete. -->
    <div ref="host" class="kv-grid-host"></div>
    <div
      class="kv-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize author column"
      :aria-valuenow="widths.author"
      :aria-valuemin="MIN_COLUMN_WIDTH"
      :aria-valuemax="MAX_COLUMN_WIDTH"
      :aria-valuetext="`${widths.author} pixels`"
      tabindex="0"
      :style="{ left: `${handleLeftAuthor}px` }"
      @mousedown="startDrag('author', $event)"
      @keydown="handleHandleKeydown('author', $event)"
    ></div>
    <div
      class="kv-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize date column"
      :aria-valuenow="widths.date"
      :aria-valuemin="MIN_COLUMN_WIDTH"
      :aria-valuemax="MAX_COLUMN_WIDTH"
      :aria-valuetext="`${widths.date} pixels`"
      tabindex="0"
      :style="{ left: `${handleLeftDate}px` }"
      @mousedown="startDrag('date', $event)"
      @keydown="handleHandleKeydown('date', $event)"
    ></div>
    <div
      class="kv-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sha column"
      :aria-valuenow="widths.sha"
      :aria-valuemin="MIN_COLUMN_WIDTH"
      :aria-valuemax="MAX_COLUMN_WIDTH"
      :aria-valuetext="`${widths.sha} pixels`"
      tabindex="0"
      :style="{ left: `${handleLeftSha}px` }"
      @mousedown="startDrag('sha', $event)"
      @keydown="handleHandleKeydown('sha', $event)"
    ></div>
  </div>
</template>

<style>
/*
 * The ~80 structural lines SlickGrid needs (§6.1): the library's own stylesheets are not
 * imported (they carry Bootstrap/Salesforce/Material palettes), so viewport, row and cell
 * positioning live here, mapped only to the --kv-* token layer. This file is the only place in
 * the repository where a .slick-* selector appears (W6's own "Done when").
 */
.kv-commit-grid {
  position: relative;
  height: 100%;
  width: 100%;
  /* §6.3's own "Done when": a panel dragged to zero height is a real thing a user can do, and a
     grid asked to lay out a zero-height viewport is where a division-by-viewport-height bug
     would live. One row's worth of floor keeps that arithmetic away from zero. */
  min-height: var(--kv-row-height);
  overflow: hidden;
  font-family: var(--kv-font-family);
  font-size: var(--kv-font-size);
  color: var(--kv-row-fg);
}

/* SlickGrid's own container, sized to fill `.kv-commit-grid` exactly — see the template's own
   comment on why this cannot be `.kv-commit-grid` itself. */
.kv-grid-host {
  height: 100%;
  width: 100%;
}

/* SlickGrid's own dynamic stylesheet (`createCssRules`, `applyColumnWidths`) only ever writes
   `height`/`left`/`right` onto these elements — never `position`. Its own upstream CSS (not
   imported here, see this block's own opening comment) is what makes those declarations do
   anything at all: a `left` on a statically-positioned cell is a no-op, and a `transform:
   translateY()` on a statically-positioned row stacks *on top of* normal document flow instead
   of replacing it, doubling every row's effective offset. These four rules are that minimum,
   copied from `slick.grid.css`'s own `.slick-pane`/`.slick-viewport`/`.grid-canvas`/`.slick-row`/
   `.slick-cell` selectors (upstream also gates the row rule on `.ui-widget-content`, the class
   SlickGrid always adds to every row alongside `.slick-row`, so it's included here rather than
   widening the selector to something upstream doesn't actually rely on). */
.kv-commit-grid .slick-pane {
  position: absolute;
  outline: 0;
  overflow: hidden;
  width: 100%;
}

.kv-commit-grid .slick-viewport,
.kv-commit-grid .grid-canvas {
  position: relative;
  outline: 0;
  background-color: var(--kv-panel-bg);
}

.kv-commit-grid .slick-viewport {
  width: 100%;
}

.kv-commit-grid .slick-row.ui-widget-content {
  position: absolute;
  border: 0;
  width: 100%;
  background-color: transparent;
}

.kv-commit-grid .slick-row:hover {
  background-color: var(--kv-row-hover-bg);
}

.kv-commit-grid .slick-row.kv-row-selected {
  background-color: var(--kv-row-selected-bg);
  color: var(--kv-row-selected-fg);
}

/* `.kv-cell-sha`'s own rule below sets an explicit `color`, which wins over the inherited one
   above regardless of selection — without this override a selected row's sha button keeps its
   normal, unselected text colour against the row's now-blue background, an axe-flagged contrast
   failure in `vscode-light` (P5 W10; `a11y.spec.ts`'s own "known false positive" allowance a few
   lines up covers the message/author cells this same selection recolour affects, but a real
   contrast regression on a *third* cell is not that same false positive and must not be masked
   the same way — fixing the colour is the right answer here, not widening that filter). */
.kv-commit-grid .slick-row.kv-row-selected .kv-cell-sha {
  color: var(--kv-row-selected-fg);
}

/* Same class of bug, a fourth cell: a border-only ref badge (tag/remote/stash/overflow — every
   `refBadges.ts` kind except `.kv-badge-local`, which already fills its own background and so
   never depends on the row's) carries its own decoration colour as both `color` and
   `border-color`, tuned against the row's *un*selected background. A selected row with, say, a
   green `v1.0.0` tag badge fails contrast for real (P5 W14's own axe scan on the commit-detail
   pane's populated state, the first scan to select a row carrying this particular badge kind) —
   caught the same way `.kv-cell-sha` above already was, fixed the same way: the row's own
   selected-foreground, already verified high-contrast against `--kv-row-selected-bg`, for both
   properties so the badge's outline stays visible too. */
.kv-commit-grid .slick-row.kv-row-selected .kv-badge-remote,
.kv-commit-grid .slick-row.kv-row-selected .kv-badge-tag,
.kv-commit-grid .slick-row.kv-row-selected .kv-badge-stash,
.kv-commit-grid .slick-row.kv-row-selected .kv-badge-overflow {
  color: var(--kv-row-selected-fg);
  border-color: var(--kv-row-selected-fg);
}

/* W14's roving tabindex focuses a real row node (not a hidden sink) — it needs a visible
   indicator of its own, the same token every other focusable edge in this grid already uses. */
.kv-commit-grid .slick-row:focus-visible {
  outline: 1px solid var(--kv-focus-border);
  outline-offset: -1px;
}

.kv-commit-grid .slick-row.kv-row-head {
  font-weight: 600;
}

/* The stash tip (refs/stash — W7's DecorationRef "stash" kind): italic subject text is the row-
   level cue; the badge itself (dashed square, codicon-archive) is refBadges.ts's job, rendered
   inline in the message cell, not here. */
.kv-commit-grid .slick-row.kv-row-stash .kv-message-subject {
  font-style: italic;
}

.kv-commit-grid .slick-cell {
  position: absolute;
  border: none;
  padding: 0 var(--kv-space-2);
  display: flex;
  align-items: center;
  overflow: hidden;
}

/* The graph cell alone needs overflow: visible — W8's row overdraw (0.5px past the row's own
   band, so two rows' vertical runs meet without a hairline seam at a fractional DPR) draws
   slightly outside its own cell bounds by design. */
.kv-commit-grid .kv-cell-graph {
  padding: 0;
  overflow: visible;
}

.kv-graph-cell {
  width: 100%;
  height: 100%;
  display: block;
  overflow: visible;
}

.kv-graph-svg {
  display: block;
  overflow: visible;
}

.kv-cell-message {
  display: flex;
  align-items: center;
  gap: var(--kv-space-2);
  min-width: 0;
  overflow: hidden;
}

.kv-message-subject {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kv-cell-author {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* refBadges.ts's inline badge strip (P4 W7, §6.2): a row with no decorations never gets this
   wrapper at all (buildRefBadges returns null), so this only ever costs layout on rows that
   have something to show. flex-shrink: 0 keeps badges from squeezing to nothing before the
   subject's own ellipsis kicks in. */
.kv-ref-badges {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.kv-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 5px;
  height: 16px;
  line-height: 16px;
  font-size: 10px;
  white-space: nowrap;
  border: 1px solid transparent;
}

.kv-badge-pill {
  border-radius: 9px;
}

.kv-badge-square {
  border-radius: 3px;
}

.kv-badge-dashed {
  border-style: dashed;
}

.kv-badge-icon {
  font-size: 11px;
}

/* §6.2's "badge text truncates at ~190px, full name in title" — the icon stays fixed size, only
   the text label clips. */
.kv-badge-label {
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* §7's "no colour-only meaning" — every distinct token below pairs with a distinct shape/glyph
   already chosen in refBadges.ts's badgeSpecFor, this file only supplies the colour. */
.kv-badge-local {
  background-color: var(--kv-badge-local-bg);
  border-color: var(--kv-badge-local-bg);
  color: var(--kv-badge-fg);
}

.kv-badge-remote {
  color: var(--kv-badge-remote-fg);
  border-color: var(--kv-badge-remote-fg);
}

.kv-badge-tag {
  color: var(--kv-badge-tag-fg);
  border-color: var(--kv-badge-tag-fg);
}

.kv-badge-stash {
  color: var(--kv-badge-stash-fg);
  border-color: var(--kv-badge-stash-border);
}

.kv-badge-overflow {
  color: var(--kv-row-fg);
  border-color: var(--kv-panel-border);
}

.kv-badge-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background-color: var(--kv-focus-border);
}

.kv-cell-date {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
}

.kv-cell-sha {
  font-family: var(--kv-mono-font-family);
  font-size: var(--kv-mono-font-size);
  background: transparent;
  border: none;
  padding: 0;
  color: var(--kv-row-fg);
  opacity: 0.75;
  cursor: not-allowed;
}

.kv-cell-sha:not(:disabled) {
  cursor: pointer;
  opacity: 1;
}

.kv-cell-sha:not(:disabled):hover {
  text-decoration: underline;
}

/* §6.1's own resize handles (showColumnHeader: false costs SlickGrid's built-in header resize
   handles, which live in the header this grid doesn't render) — 5px wide, absolutely positioned
   over the grid, spanning its full height. */
.kv-resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 5px;
  margin-left: -2px;
  cursor: col-resize;
  z-index: 2;
  background: transparent;
}

.kv-resize-handle:hover,
.kv-resize-handle:focus-visible {
  background-color: var(--kv-focus-border);
  outline: none;
}
</style>
