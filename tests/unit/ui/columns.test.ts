import { describe, expect, test } from "bun:test";
import { CommitStore } from "../../../packages/core/src/store/commitStore.ts";
import type { CommitRecord } from "../../../packages/core/src/model/commit.ts";
import { DEFAULT_COLUMN_WIDTHS } from "../../../packages/ui/src/state/viewState.ts";
import { GEOMETRY, graphColumnWidth } from "../../../packages/ui/src/graph/geometry.ts";
import {
  AUTHOR_COLUMN_ID,
  buildColumns,
  createCommitDataView,
  DATE_COLUMN_ID,
  GRAPH_COLUMN_ID,
  MESSAGE_COLUMN_ID,
  rowMetadata,
  SHA_COLUMN_ID,
} from "../../../packages/ui/src/components/columns.ts";
import { topology } from "../../fixtures/topology.ts";

// buildColumns takes the graph formatter as a caller-supplied argument (W8: it is built once per
// grid instance, closed over a LayoutStore/CommitStore this module never sees) — a never-invoked
// stub is all these tests need, since none of them render a cell. Typed off buildColumns's own
// third parameter rather than importing "slickgrid" directly (not resolvable from this
// directory's own module scope — it is packages/ui's dependency, not the tests package's).
const stubGraphFormatter: Parameters<typeof buildColumns>[2] = () => document.createElement("div");

// The sha column's copy button (W10) is exercised directly in shaFormatter's own tests; these
// buildColumns tests only assert column shape/width/resizability, so a never-invoked stub with
// clipboard support "off" is all a caller here needs.
const stubShaCopyCtx: Parameters<typeof buildColumns>[3] = {
  enabled: () => false,
  onCopy: () => {},
};

function record(overrides: Partial<CommitRecord> = {}): CommitRecord {
  return {
    sha: "a".repeat(40),
    parents: [],
    author: { name: "Alice", email: "alice@example.test", timestamp: 1_700_000_000 },
    committer: { name: "Alice", email: "alice@example.test", timestamp: 1_700_000_000 },
    subject: "a commit",
    decoration: [],
    ...overrides,
  };
}

describe("buildColumns", () => {
  const dateCtx = { dateFormat: () => "relative" as const, now: () => Date.now() };

  test("builds the five columns in display order, ids matching the plan's table", () => {
    const columns = buildColumns(
      { ...DEFAULT_COLUMN_WIDTHS, laneCount: 2, messageWidth: 300 },
      dateCtx,
      stubGraphFormatter,
      stubShaCopyCtx,
    );
    expect(columns.map((column) => column.id)).toEqual([
      GRAPH_COLUMN_ID,
      MESSAGE_COLUMN_ID,
      AUTHOR_COLUMN_ID,
      DATE_COLUMN_ID,
      SHA_COLUMN_ID,
    ]);
  });

  test("the graph column's width tracks laneCount through graphColumnWidth, not a literal", () => {
    const columns = buildColumns(
      { ...DEFAULT_COLUMN_WIDTHS, laneCount: 5, messageWidth: 300 },
      dateCtx,
      stubGraphFormatter,
      stubShaCopyCtx,
    );
    const graph = columns.find((column) => column.id === GRAPH_COLUMN_ID);
    expect(graph?.width).toBe(graphColumnWidth(5));
    expect(graph?.width).toBe(GEOMETRY.padLeft + 5 * GEOMETRY.laneWidth + GEOMETRY.gutterPad);
  });

  test("message, author, date and sha take the caller's widths verbatim", () => {
    const columns = buildColumns(
      { author: 111, date: 222, sha: 333, laneCount: 0, messageWidth: 444 },
      dateCtx,
      stubGraphFormatter,
      stubShaCopyCtx,
    );
    const widthOf = (id: string) => columns.find((column) => column.id === id)?.width;
    expect(widthOf(MESSAGE_COLUMN_ID)).toBe(444);
    expect(widthOf(AUTHOR_COLUMN_ID)).toBe(111);
    expect(widthOf(DATE_COLUMN_ID)).toBe(222);
    expect(widthOf(SHA_COLUMN_ID)).toBe(333);
  });

  test("only graph and message are non-resizable; author/date/sha are resized by CommitGrid.vue's own handles, not the library's", () => {
    const columns = buildColumns(
      { ...DEFAULT_COLUMN_WIDTHS, laneCount: 1, messageWidth: 200 },
      dateCtx,
      stubGraphFormatter,
      stubShaCopyCtx,
    );
    for (const column of columns) {
      expect(column.resizable).toBe(false);
    }
  });
});

describe("createCommitDataView", () => {
  function storeWith(records: CommitRecord[]): CommitStore {
    const store = new CommitStore();
    store.appendPage(records);
    return store;
  }

  test("getLength defers to the loadedRows accessor, not the store's own rowCount", () => {
    const store = storeWith(topology(["a", "b:a"]));
    let loaded = 1; // fewer than the store actually holds — e.g. text landed before layout
    const view = createCommitDataView({ store, loadedRows: () => loaded, isSelected: () => false });
    expect(view.getLength()).toBe(1);
    loaded = 2;
    expect(view.getLength()).toBe(2);
  });

  test("getItem materializes a fresh CommitRecord on every call rather than caching one", () => {
    const store = storeWith(topology(["a", "b:a", "c:b"]));
    const view = createCommitDataView({ store, loadedRows: () => 3, isSelected: () => false });
    const first = view.getItem(1);
    const second = view.getItem(1);
    expect(first).toEqual(second);
    expect(first).not.toBe(second); // §5.5: materialized, used, discarded — never retained
  });

  test("getItem(row) matches store.commitAt(row) — the data view adds no transformation of its own", () => {
    const store = storeWith(topology(["a", "b:a", "c:b"]));
    const view = createCommitDataView({ store, loadedRows: () => 3, isSelected: () => false });
    expect(view.getItem(2)).toEqual(store.commitAt(2));
  });

  test("getItemMetadata reflects the isSelected accessor's current answer, not a snapshot", () => {
    const store = storeWith(topology(["a", "b:a"]));
    let selectedRow = -1;
    const view = createCommitDataView({
      store,
      loadedRows: () => 2,
      isSelected: (row) => row === selectedRow,
    });
    expect(view.getItemMetadata(0)).toBeNull();
    selectedRow = 0;
    expect(view.getItemMetadata(0)).toEqual({ cssClasses: "kv-row-selected" });
    expect(view.getItemMetadata(1)).toBeNull();
  });
});

describe("rowMetadata", () => {
  test("a row that is neither selected nor HEAD gets no metadata", () => {
    const store = new CommitStore();
    store.appendPage([record()]);
    const meta = rowMetadata({ store, isSelected: () => false }, 0);
    expect(meta).toBeNull();
  });

  test("HEAD (detached) contributes kv-row-head", () => {
    const store = new CommitStore();
    store.appendPage([record({ decoration: [{ kind: "head" }] })]);
    const meta = rowMetadata({ store, isSelected: () => false }, 0);
    expect(meta?.cssClasses).toBe("kv-row-head");
  });

  test("a branch decoration with isHead: true also contributes kv-row-head; isHead: false does not", () => {
    const store = new CommitStore();
    store.appendPage([
      record({ decoration: [{ kind: "branch", name: "main", isHead: true }] }),
      record({ sha: "b".repeat(40), decoration: [{ kind: "branch", name: "dev", isHead: false }] }),
    ]);
    expect(rowMetadata({ store, isSelected: () => false }, 0)?.cssClasses).toBe("kv-row-head");
    expect(rowMetadata({ store, isSelected: () => false }, 1)).toBeNull();
  });

  test("selected and HEAD combine into one space-separated class list", () => {
    const store = new CommitStore();
    store.appendPage([record({ decoration: [{ kind: "head" }] })]);
    const meta = rowMetadata({ store, isSelected: () => true }, 0);
    expect(meta?.cssClasses).toBe("kv-row-selected kv-row-head");
  });

  test("the refs/stash tip contributes kv-row-stash, keyed off decorationAt alone", () => {
    const store = new CommitStore();
    store.appendPage([record({ decoration: [{ kind: "stash" }] })]);
    const meta = rowMetadata({ store, isSelected: () => false }, 0);
    expect(meta?.cssClasses).toBe("kv-row-stash");
  });

  test("selected and stash combine into one space-separated class list", () => {
    const store = new CommitStore();
    store.appendPage([record({ decoration: [{ kind: "stash" }] })]);
    const meta = rowMetadata({ store, isSelected: () => true }, 0);
    expect(meta?.cssClasses).toBe("kv-row-selected kv-row-stash");
  });
});
