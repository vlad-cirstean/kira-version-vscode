import { describe, expect, test } from "bun:test";
import {
  InMemoryViewStateStore,
  parsePersistedViewState,
  type PersistedViewState,
} from "../../../packages/ui/src/state/viewState.ts";

/**
 * P4 W5's own "Done when" (a v1 state is discarded and a v2 one round-trips), P5 W11's own "a v2
 * persisted state is discarded cleanly and a v3 one round-trips", and P11 W7's own "a v3
 * persisted state is discarded cleanly and a v4 one round-trips". `parsePersistedViewState`
 * discards whole, never partially — this exercises that directly and through the harness's
 * `ViewStateStore`, since every concrete store defers to it.
 */

function fullState(overrides: Partial<PersistedViewState> = {}): PersistedViewState {
  return {
    version: 4,
    repoId: "r1",
    loadedRows: 42,
    detailOpen: true,
    scrollRow: 17,
    selectedSha: "abc123",
    columnWidths: { author: 150, date: 130, sha: 90 },
    dateFormat: "absolute",
    detailWidth: 420,
    fileListMode: "tree",
    searchCaseSensitive: false,
    searchWholeWord: false,
    searchRegex: false,
    searchScope: "both",
    ...overrides,
  };
}

describe("parsePersistedViewState", () => {
  test("accepts a well-formed version-4 state and round-trips every field", () => {
    const state = fullState();
    expect(parsePersistedViewState(state)).toEqual(state);
  });

  test("accepts null repoId and selectedSha", () => {
    const state = fullState({ repoId: null, selectedSha: null });
    expect(parsePersistedViewState(state)).toEqual(state);
  });

  test("accepts either dateFormat value", () => {
    expect(parsePersistedViewState(fullState({ dateFormat: "relative" }))?.dateFormat).toBe(
      "relative",
    );
    expect(parsePersistedViewState(fullState({ dateFormat: "absolute" }))?.dateFormat).toBe(
      "absolute",
    );
  });

  test("accepts either fileListMode value", () => {
    expect(parsePersistedViewState(fullState({ fileListMode: "tree" }))?.fileListMode).toBe("tree");
    expect(parsePersistedViewState(fullState({ fileListMode: "flat" }))?.fileListMode).toBe("flat");
  });

  test("accepts every searchScope value", () => {
    expect(parsePersistedViewState(fullState({ searchScope: "commits" }))?.searchScope).toBe(
      "commits",
    );
    expect(parsePersistedViewState(fullState({ searchScope: "refs" }))?.searchScope).toBe("refs");
    expect(parsePersistedViewState(fullState({ searchScope: "both" }))?.searchScope).toBe("both");
  });

  test("accepts every combination of the three boolean search toggles", () => {
    const state = fullState({
      searchCaseSensitive: true,
      searchWholeWord: true,
      searchRegex: true,
    });
    expect(parsePersistedViewState(state)).toEqual(state);
  });

  test("discards a v1 (P3-shaped) state whole, never partially", () => {
    const v1 = { version: 1, repoId: "r1", loadedRows: 42, detailOpen: true };
    expect(parsePersistedViewState(v1)).toBeNull();
  });

  test("discards a v2 (P4-shaped, no fileListMode) state whole, never partially", () => {
    const { fileListMode: _fileListMode, ...v2Shaped } = fullState();
    const v2 = { ...v2Shaped, version: 2 };
    expect(parsePersistedViewState(v2)).toBeNull();
  });

  test("discards a v3 (P5-shaped, no search fields) state whole, never partially", () => {
    const {
      searchCaseSensitive: _searchCaseSensitive,
      searchWholeWord: _searchWholeWord,
      searchRegex: _searchRegex,
      searchScope: _searchScope,
      ...v3Shaped
    } = fullState();
    const v3 = { ...v3Shaped, version: 3 };
    expect(parsePersistedViewState(v3)).toBeNull();
  });

  test("discards a future version whole, not partially", () => {
    const state = { ...fullState(), version: 5 };
    expect(parsePersistedViewState(state)).toBeNull();
  });

  test("discards non-object and null raw values", () => {
    expect(parsePersistedViewState(null)).toBeNull();
    expect(parsePersistedViewState(undefined)).toBeNull();
    expect(parsePersistedViewState("v4")).toBeNull();
    expect(parsePersistedViewState(42)).toBeNull();
  });

  test("discards a shape missing a top-level required field", () => {
    const { detailWidth: _detailWidth, ...withoutDetailWidth } = fullState();
    expect(parsePersistedViewState(withoutDetailWidth)).toBeNull();
  });

  test("discards a shape missing fileListMode", () => {
    const { fileListMode: _fileListMode, ...withoutFileListMode } = fullState();
    expect(parsePersistedViewState(withoutFileListMode)).toBeNull();
  });

  test("discards a shape missing a search field", () => {
    const { searchRegex: _searchRegex, ...withoutSearchRegex } = fullState();
    expect(parsePersistedViewState(withoutSearchRegex)).toBeNull();
  });

  test("discards a shape with a malformed columnWidths", () => {
    expect(
      parsePersistedViewState({ ...fullState(), columnWidths: { author: 150, date: 130 } }),
    ).toBeNull();
    expect(parsePersistedViewState({ ...fullState(), columnWidths: null })).toBeNull();
  });

  test("discards an invalid dateFormat value", () => {
    expect(parsePersistedViewState({ ...fullState(), dateFormat: "iso" })).toBeNull();
  });

  test("discards an invalid fileListMode value", () => {
    expect(parsePersistedViewState({ ...fullState(), fileListMode: "list" })).toBeNull();
  });

  test("discards an invalid searchScope value", () => {
    expect(parsePersistedViewState({ ...fullState(), searchScope: "everywhere" })).toBeNull();
  });
});

describe("InMemoryViewStateStore", () => {
  test("read() returns null before any write", () => {
    const store = new InMemoryViewStateStore();
    expect(store.read()).toBeNull();
  });

  test("round-trips a state written through write()", () => {
    const store = new InMemoryViewStateStore();
    const state = fullState({ loadedRows: 7, detailOpen: false });
    store.write(state);
    expect(store.read()).toEqual(state);
  });

  test("discards a v1-shaped state injected via setRaw", () => {
    const store = new InMemoryViewStateStore();
    store.setRaw({ version: 1, repoId: "r1", loadedRows: 7, detailOpen: false });
    expect(store.read()).toBeNull();
  });

  test("discards a v3-shaped (no search fields) state injected via setRaw", () => {
    const store = new InMemoryViewStateStore();
    const {
      searchCaseSensitive: _searchCaseSensitive,
      searchWholeWord: _searchWholeWord,
      searchRegex: _searchRegex,
      searchScope: _searchScope,
      ...v3Shaped
    } = fullState();
    store.setRaw({ ...v3Shaped, version: 3 });
    expect(store.read()).toBeNull();
  });
});
