import { describe, expect, test } from "bun:test";
import type { CommitRecord } from "../../../packages/core/src/model/commit.ts";
import { searchLoadedCommits } from "../../../packages/core/src/search/matcher.ts";
import type { SearchQuery } from "../../../packages/core/src/search/query.ts";
import { compileQuery } from "../../../packages/core/src/search/query.ts";
import { CommitStore } from "../../../packages/core/src/store/commitStore.ts";

/**
 * `docs/plans/P11.md` W16: `searchLoadedCommits`' own edge cases, beyond the semantics table in
 * `packages/core/src/search/matcher.test.ts` — its odd/even sha-nibble comparison, its time-box
 * early exit (`complete: false`, `scannedRows`), and its `limit`-vs-`total` split. Per
 * AGENTS.md's "unit tests earn their keep for advanced logic": these are the parts of the scan
 * with real bit-twiddling and early-exit control flow, not the plain OR the semantics table
 * already covers.
 */

function query(partial: Partial<SearchQuery>) {
  const compiled = compileQuery({
    text: "",
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    scope: "commits",
    ...partial,
  });
  if (compiled.kind !== "ok") throw new Error(`expected an ok query, got ${compiled.kind}`);
  return compiled;
}

function commit(sha: string, subject: string): CommitRecord {
  return {
    sha,
    parents: [],
    author: { name: "Kira Fixture", email: "fixture@kira-version.test", timestamp: 1_700_000_000 },
    committer: {
      name: "Kira Fixture",
      email: "fixture@kira-version.test",
      timestamp: 1_700_000_000,
    },
    subject,
    decoration: [],
  };
}

function storeOf(shas: readonly string[]): CommitStore {
  const store = new CommitStore();
  shas.forEach((sha, i) => {
    store.append(commit(sha, `commit ${i}`));
  });
  return store;
}

describe("searchLoadedCommits — sha-prefix nibble comparison", () => {
  test("an even-length prefix (whole bytes only) matches exactly the rows that start with it", () => {
    const shas = [
      `218224${"a".repeat(34)}`, // matches
      `218225${"a".repeat(34)}`, // one nibble off in the last compared byte — must not match
      `218${"a".repeat(37)}`, // shorter shared prefix only — must not match
    ];
    const store = storeOf(shas);
    const result = searchLoadedCommits(store, query({ text: "218224" }), {
      limit: 10,
      budgetMs: 1000,
    });
    expect(result.hits.map((h) => h.row)).toEqual([0]);
    expect(result.hits[0]?.fields).toEqual(["sha"]);
  });

  test("an odd-length prefix compares only the trailing half-nibble, not the whole next byte", () => {
    // "2182a" is 2 whole bytes (0x21, 0x82) plus the *high* nibble of a third (0xa_). Two shas
    // whose third byte differs only in its low nibble (0xa0 vs 0xaf) must both match; one whose
    // third byte's high nibble differs (0xb0) must not — proving the comparison really stops at
    // the nibble, rather than silently requiring the next full hex digit to match too.
    const shas = [
      `2182a0${"1".repeat(34)}`, // third byte 0xa0: high nibble a — matches
      `2182af${"1".repeat(34)}`, // third byte 0xaf: high nibble a — matches (low nibble differs)
      `2182b0${"1".repeat(34)}`, // third byte 0xb0: high nibble b — must not match
    ];
    const store = storeOf(shas);
    const result = searchLoadedCommits(store, query({ text: "2182a" }), {
      limit: 10,
      budgetMs: 1000,
    });
    expect(result.hits.map((h) => h.row)).toEqual([0, 1]);
  });
});

describe("searchLoadedCommits — time-box early exit", () => {
  test("a deadline already in the past stops before scanning any row: complete: false, scannedRows: 0", () => {
    const store = storeOf(Array.from({ length: 5 }, (_, i) => `${i}`.repeat(40).slice(0, 40)));
    const result = searchLoadedCommits(store, query({ text: "commit" }), {
      limit: 100,
      budgetMs: -1_000_000, // deadline is already 1000s in the past the instant this call starts
    });
    expect(result.complete).toBe(false);
    expect(result.scannedRows).toBe(0);
    expect(result.hits).toEqual([]);
    expect(result.total).toBe(0);
  });

  test("an ample budget scans every row: complete: true, scannedRows === rowCount", () => {
    const store = storeOf(Array.from({ length: 5 }, (_, i) => `${i}`.repeat(40).slice(0, 40)));
    const result = searchLoadedCommits(store, query({ text: "commit" }), {
      limit: 100,
      budgetMs: 60_000,
    });
    expect(result.complete).toBe(true);
    expect(result.scannedRows).toBe(5);
    expect(result.total).toBe(5);
  });
});

describe("searchLoadedCommits — limit vs. total", () => {
  test("hits are capped at limit; total keeps counting past it, and truncated is set", () => {
    const shas = Array.from({ length: 20 }, (_, i) =>
      `${i.toString(16).padStart(2, "0")}`.repeat(20),
    );
    const store = storeOf(shas);
    const result = searchLoadedCommits(store, query({ text: "commit" }), {
      limit: 5,
      budgetMs: 60_000,
    });
    expect(result.hits).toHaveLength(5);
    expect(result.total).toBe(20);
    expect(result.truncated).toBe(true);
    expect(result.complete).toBe(true); // the time box never fired — every row was still scanned
  });

  test("when every match fits under the limit, truncated is false", () => {
    const store = storeOf(Array.from({ length: 3 }, (_, i) => `${i}`.repeat(40).slice(0, 40)));
    const result = searchLoadedCommits(store, query({ text: "commit" }), {
      limit: 10,
      budgetMs: 60_000,
    });
    expect(result.hits).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(false);
  });
});
