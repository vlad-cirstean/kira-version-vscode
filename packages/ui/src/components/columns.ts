/**
 * `docs/plans/P4.md` W6: the SlickGrid column definitions and the `CustomDataView` adapter that
 * is "the whole of §5.5's contract with the library" — three methods, called only for the rows
 * the grid actually renders, each `CommitRecord` materialized and immediately discarded rather
 * than retained (`getItem` is never memoized here; see `createCommitDataView`'s doc comment).
 *
 * The **graph** column's formatter is supplied by the caller (`CommitGrid.vue`, via W8's
 * `graphColumn.ts`'s `createGraphFormatter`) rather than built here: it needs a `LayoutStore` and
 * a `CommitStore` closed over per grid instance, which this module — shared column-definition
 * logic with no state of its own — does not hold. The **message** column (W7) renders the subject
 * plus, when the row has decorations, `refBadges.ts`'s inline badge strip ahead of it.
 *
 * `enableHtmlRendering: false` (set by `CommitGrid.vue`) means every formatter here must return
 * a real `HTMLElement`/`SVGElement`, never a string — enforced by the library, not by discipline,
 * so a commit subject containing `<script>` is text by construction.
 */
import type { CommitRecord, CommitStore, DecorationRef } from "@kira-version/core";
import type { Column, CustomDataView, Formatter, ItemMetadata } from "slickgrid";
import { graphColumnWidth } from "../graph/geometry.ts";
import type { ColumnWidths, DateFormat } from "../state/viewState.ts";
import { formatAbsoluteDate, formatRelativeDate } from "./dateFormat.ts";
import { buildRefBadges } from "./refBadges.ts";

/** Every field a column's `field:` must name is a valid dotted path into `CommitRecord`
 *  (SlickGrid's `Column<T>.field` is typed against `T`'s own leaf paths); formatters here read
 *  `dataContext` directly and ignore `value`, so which leaf each column claims is otherwise
 *  arbitrary — chosen for readability, not because the formatter uses it. */
export const GRAPH_COLUMN_ID = "graph";
export const MESSAGE_COLUMN_ID = "message";
export const AUTHOR_COLUMN_ID = "author";
export const DATE_COLUMN_ID = "date";
export const SHA_COLUMN_ID = "sha";

function isHeadDecoration(ref: DecorationRef): boolean {
  return ref.kind === "head" || (ref.kind === "branch" && ref.isHead);
}

function isStashDecoration(ref: DecorationRef): boolean {
  return ref.kind === "stash";
}

function textCell(text: string, className: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

/** The message cell is a flex row (`CommitGrid.vue`'s `<style>`): `refBadges.ts`'s badge strip
 *  (only when the row has decorations — most rows do not, and get no wrapper at all) followed by
 *  the subject, which alone gets `text-overflow: ellipsis` — a CSS rule on `.kv-message-subject`,
 *  not something this formatter computes. */
const messageFormatter: Formatter<CommitRecord> = (
  _row,
  _cell,
  _value,
  _columnDef,
  dataContext,
) => {
  const cell = document.createElement("span");
  cell.className = "kv-cell-message";

  const badges = buildRefBadges(dataContext.decoration);
  if (badges !== null) cell.appendChild(badges);

  const subject = document.createElement("span");
  subject.className = "kv-message-subject";
  subject.textContent = dataContext.subject;
  cell.appendChild(subject);

  return cell;
};

const authorFormatter: Formatter<CommitRecord> = (_row, _cell, _value, _columnDef, dataContext) =>
  textCell(dataContext.author.name, "kv-cell-author");

/** `ctx.dateFormat`/`ctx.now` are accessors, not values, so a single `Column[]` array built once
 *  keeps rendering the *current* format on every SlickGrid-triggered re-render — `CommitGrid.vue`
 *  toggles the underlying ref and calls `invalidateAllRows()`/`render()`, it never rebuilds the
 *  column definitions just to flip a date format. */
export interface DateFormatterContext {
  readonly dateFormat: () => DateFormat;
  readonly now: () => number;
}

function dateFormatter(ctx: DateFormatterContext): Formatter<CommitRecord> {
  return (_row, _cell, _value, _columnDef, dataContext) => {
    const timestamp = dataContext.author.timestamp;
    const text =
      ctx.dateFormat() === "absolute"
        ? formatAbsoluteDate(timestamp)
        : formatRelativeDate(timestamp, ctx.now());
    return textCell(text, "kv-cell-date");
  };
}

/** P5 W10: lands the copy action P4 shipped `disabled` with a "not available until P5" title.
 *  `enabled()` is re-read on every render pass (mirroring `DateFormatterContext`'s own accessor
 *  pattern) so a capability that is only known once `app.init` resolves — after the grid's first
 *  paint — enables the button on the very next `invalidateAllRows()`/`render()` without a column
 *  rebuild. Disabled rather than absent when the host has no clipboard (§3.3's feature
 *  detection): the button still communicates "this copies the sha", it just cannot act on it —
 *  consistent with `noCapabilities.ts`'s doc comment describing the same button under §6.4. */
export interface ShaCopyContext {
  readonly enabled: () => boolean;
  readonly onCopy: (fullSha: string) => void;
}

function shaFormatter(ctx: ShaCopyContext): Formatter<CommitRecord> {
  return (_row, _cell, _value, _columnDef, dataContext) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "kv-cell-sha";
    // Starts out of the native tab order the instant it exists, never natively-tabbable even for
    // one render frame — `CommitGrid.vue`'s `applyAccessibility` is what promotes exactly the
    // currently-tabbable row's own button back to `0`, mirroring the row's roving tabindex. A
    // button left at its browser default (implicitly focusable, no attribute needed) is reachable
    // by a *native* `Tab` the instant it lands in the DOM, whether or not `applyAccessibility` has
    // gotten to it yet — on a `hugeRepo`-sized scenario, where `Tab`-driven `scrollIntoView`
    // continually reveals fresh rows before that pass catches up, that race turns into every row's
    // still-default button becoming reachable in turn, one Tab press at a time, never actually
    // escaping the grid.
    button.tabIndex = -1;
    const enabled = ctx.enabled();
    button.disabled = !enabled;
    button.title = enabled ? "Copy full SHA" : "Copy SHA — not available in this host";
    const shortSha = dataContext.sha.slice(0, 7);
    button.textContent = shortSha;
    if (enabled) {
      button.addEventListener("click", (event) => {
        // Stops this click from also reaching SlickGrid's own delegated row-click handler
        // (`CommitGrid.vue`'s `handleClick`) — copying a sha is not a row selection.
        event.stopPropagation();
        ctx.onCopy(dataContext.sha);
        button.textContent = "Copied";
        window.setTimeout(() => {
          button.textContent = shortSha;
        }, 1500);
      });
    }
    return button;
  };
}

/** The explicit widths `CommitGrid.vue` computes before building columns: `messageWidth` is
 *  whatever remains of the host's own width once every other column is accounted for, the graph
 *  column's width is `graphColumnWidth(laneCount)`, and `author`/`date`/`sha` come from
 *  `viewState`'s persisted `ColumnWidths` (or `DEFAULT_COLUMN_WIDTHS` on first mount). */
export interface ColumnWidthInputs extends ColumnWidths {
  readonly laneCount: number;
  readonly messageWidth: number;
}

/** Builds the five column definitions in display order. Not user-resizable: `graph` (its width
 *  is derived from `laneCount`, not a user choice — its `graphFormatter` and geometry are W8's
 *  `graphColumn.ts`/`rowSvg.ts`, built once per grid instance and passed in here rather than
 *  built by this stateless module) and `message` (it is "remaining width", recomputed by
 *  `CommitGrid.vue` on every resize rather than dragged). `author`/`date`/`sha` are resizable via
 *  `CommitGrid.vue`'s own drag handles (§6.1: `showColumnHeader: false` costs SlickGrid's built-in
 *  header resize handles, so this repo keeps its own), which write back through
 *  `grid.setColumns(...)` — this function, called again with the new widths, is the single source
 *  of the column model either way. */
export function buildColumns(
  widths: ColumnWidthInputs,
  dateCtx: DateFormatterContext,
  graphFormatter: Formatter<CommitRecord>,
  shaCopyCtx: ShaCopyContext,
): Column<CommitRecord>[] {
  return [
    {
      id: GRAPH_COLUMN_ID,
      field: "sha",
      name: "",
      width: graphColumnWidth(widths.laneCount),
      resizable: false,
      sortable: false,
      focusable: false,
      selectable: false,
      cssClass: "kv-cell-graph",
      formatter: graphFormatter,
    },
    {
      id: MESSAGE_COLUMN_ID,
      field: "subject",
      name: "",
      width: widths.messageWidth,
      resizable: false,
      sortable: false,
      focusable: false,
      selectable: false,
      formatter: messageFormatter,
    },
    {
      id: AUTHOR_COLUMN_ID,
      field: "author.name",
      name: "",
      width: widths.author,
      resizable: false,
      sortable: false,
      focusable: false,
      selectable: false,
      formatter: authorFormatter,
    },
    {
      id: DATE_COLUMN_ID,
      field: "author.timestamp",
      name: "",
      width: widths.date,
      resizable: false,
      sortable: false,
      focusable: false,
      selectable: false,
      formatter: dateFormatter(dateCtx),
    },
    {
      id: SHA_COLUMN_ID,
      field: "sha",
      name: "",
      width: widths.sha,
      resizable: false,
      sortable: false,
      focusable: false,
      selectable: false,
      formatter: shaFormatter(shaCopyCtx),
    },
  ];
}

/** `getItemMetadata`'s `cssClasses`: `selected` from `SelectionState` (not SlickGrid's own
 *  `RowSelectionModel` — see `CommitGrid.vue`'s doc comment), `head`/`stash` from `decorationAt` —
 *  the single source `docs/plans/P4.md` W8 promises ("the single source is `decorationAt`, not a
 *  second heuristic" — in particular, never a guess from the subject line, which an ordinary
 *  commit could coincidentally match). */
export interface RowMetadataContext {
  readonly store: CommitStore;
  readonly isSelected: (row: number) => boolean;
}

export function rowMetadata(ctx: RowMetadataContext, row: number): ItemMetadata | null {
  const classes: string[] = [];
  if (ctx.isSelected(row)) classes.push("kv-row-selected");
  const decoration = ctx.store.decorationAt(row);
  if (decoration.some(isHeadDecoration)) classes.push("kv-row-head");
  if (decoration.some(isStashDecoration)) classes.push("kv-row-stash");
  return classes.length > 0 ? { cssClasses: classes.join(" ") } : null;
}

/**
 * §5.5's whole contract with the library, three methods: `getItem` calls `store.commitAt(row)`
 * fresh on every invocation — no cache, no memoization — because the only way to guarantee "the
 * grid is never handed materialized rows" is for nothing here to *hold* a materialized row for
 * longer than one formatter pass needs it. `getLength`/`isSelected` are accessors rather than
 * captured values so this data view always answers with the store's/selection's *current* state,
 * matching the plan's own sketch (`getLength: () => graphView.loadedRows.value`).
 */
export interface CommitDataViewDeps {
  readonly store: CommitStore;
  readonly loadedRows: () => number;
  readonly isSelected: (row: number) => boolean;
}

export function createCommitDataView(deps: CommitDataViewDeps): CustomDataView<CommitRecord> {
  return {
    getLength: () => deps.loadedRows(),
    getItem: (row: number) => deps.store.commitAt(row),
    getItemMetadata: (row: number) => rowMetadata(deps, row),
  };
}
