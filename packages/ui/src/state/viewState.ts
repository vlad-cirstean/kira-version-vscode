/**
 * §2.1's reason the panel does not use `retainContextWhenHidden` (P3 W9): a VS Code webview
 * view is destroyed and recreated on every hide/reveal, so anything the UI needs to survive
 * that has to go through `getState`/`setState` (or the platform's equivalent) rather than live
 * JS heap. `PersistedViewState` is that survivor — deliberately small, versioned, and, per
 * §5.4, read back on mount to re-open `graph.stream` against the host's still-cached rows.
 *
 * §5.4's full list lands at P4 W5 (version 2): scroll position and selection survive a re-walk
 * because they are stored by row/sha rather than implied by `loadedRows` alone, and the column
 * layout (widths, date format, detail pane width) survives independently of any one repo.
 *
 * `docs/plans/P5.md` W11 (version 3) adds exactly one field, `fileListMode` — a user preference
 * about *how* files are browsed, the same kind of thing `dateFormat` already is. Deliberately
 * **not** added: the open diff, the selected file, or `parentIndex` — those are facts about one
 * commit at one moment, and restoring a stale one is §6.8's own argument against a remembered
 * comparison base, applied here. `FileListMode` is imported from `state/detail.ts` rather than
 * redefined here — one alias, not two structurally-identical types drifting apart.
 */
import type { FileListMode } from "./detail.ts";

export interface PersistedViewState {
  readonly version: 3;
  readonly repoId: string | null;
  readonly loadedRows: number;
  readonly detailOpen: boolean;
  /** A row index, not a pixel offset: a row survives a re-walk (renumbering aside — App.vue
   *  re-resolves the scroll target the same way it re-resolves selection), a pixel offset does
   *  not. */
  readonly scrollRow: number;
  readonly selectedSha: string | null;
  readonly columnWidths: ColumnWidths;
  readonly dateFormat: DateFormat;
  readonly detailWidth: number;
  readonly fileListMode: FileListMode;
}

export interface ColumnWidths {
  readonly author: number;
  readonly date: number;
  readonly sha: number;
}

export type DateFormat = "relative" | "absolute";

/** W6/W9's own defaults — sized for the columns' typical content (an author name, a relative
 *  date string, a 7-character short sha) at the density §6.1 targets. Exported so every writer
 *  of a fresh `PersistedViewState` (a first-ever mount, a host's dev-seed hook) uses the same
 *  numbers rather than each inventing its own. */
export const DEFAULT_COLUMN_WIDTHS: ColumnWidths = { author: 140, date: 120, sha: 80 };
export const DEFAULT_DETAIL_WIDTH = 380;

export interface ViewStateStore {
  read(): PersistedViewState | null;
  write(state: PersistedViewState): void;
}

function isColumnWidthsShape(value: unknown): value is ColumnWidths {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.author === "number" &&
    typeof record.date === "number" &&
    typeof record.sha === "number"
  );
}

function isPersistedViewStateShape(value: unknown): value is PersistedViewState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 3 &&
    (typeof record.repoId === "string" || record.repoId === null) &&
    typeof record.loadedRows === "number" &&
    typeof record.detailOpen === "boolean" &&
    typeof record.scrollRow === "number" &&
    (typeof record.selectedSha === "string" || record.selectedSha === null) &&
    isColumnWidthsShape(record.columnWidths) &&
    (record.dateFormat === "relative" || record.dateFormat === "absolute") &&
    typeof record.detailWidth === "number" &&
    (record.fileListMode === "tree" || record.fileListMode === "flat")
  );
}

/**
 * Validates a raw value read back from platform storage against `PersistedViewState`'s
 * current shape. **A `version` that is not the current one is discarded whole, never
 * partially applied** — a v1 state (P3's shape, no scroll/selection/column fields) is exactly
 * such a mismatch, and a half-applied older state is a bug that reproduces once per upgrade.
 * Every concrete `ViewStateStore` (VS Code's `getState`, this file's in-memory one) calls this
 * rather than trusting its raw source.
 */
export function parsePersistedViewState(raw: unknown): PersistedViewState | null {
  return isPersistedViewStateShape(raw) ? raw : null;
}

/**
 * The harness's `ViewStateStore` (§3.1 lists the interface here; the harness is one of the two
 * hosts choosing an implementation at mount, alongside VS Code's `getState`/`setState`) — and a
 * convenient fake for `state/` unit tests, since it needs no platform API.
 */
export class InMemoryViewStateStore implements ViewStateStore {
  #raw: unknown = null;

  read(): PersistedViewState | null {
    return parsePersistedViewState(this.#raw);
  }

  write(state: PersistedViewState): void {
    this.#raw = state;
  }

  /** Test-only: injects a raw (possibly invalid or out-of-version) value as if it had come
   *  back from real platform storage, without going through `write`'s always-valid shape. */
  setRaw(raw: unknown): void {
    this.#raw = raw;
  }
}
