import { describe, expect, test } from "bun:test";
import type { LoadedScanResult } from "../../../packages/core/src/search/matcher.ts";
import { buildCommitHits, type SearchRunResult } from "../../../packages/ui/src/state/search.ts";

/**
 * `docs/plans/P11.md` W20 — direct, pure-function coverage of `buildCommitHits`'s "hard part 5"
 * merge, added after E2E testing (`search.spec.ts`'s tail-only-body-hit case) surfaced a real bug
 * with zero prior test coverage at any tier: a tail hit whose row was already paged into the
 * store, but which the *loaded* scan itself never flagged as a hit (a body-only match — the
 * client-side scan never reads `body`, hard part 1), was counted as an "overlap" and silently
 * subtracted out of `matchCount.n` entirely, even though it still produced a real `CommitHit`
 * entry. The fix: overlap means "this row was already in `loaded.hits`", not "this row happens to
 * be loaded" — `buildCommitHits`'s own doc comment now says so directly.
 */

const SHA_0 = "a".repeat(40);
const SHA_1 = "b".repeat(40);
const SHA_2 = "c".repeat(40);
const SHA_UNLOADED = "d".repeat(40);

const ROW_SHAS = [SHA_0, SHA_1, SHA_2] as const;
const ROW_SUBJECTS = ["row 0", "row 1", "row 2"] as const;

function rowOfSha(sha: string): number {
  return ROW_SHAS.indexOf(sha as (typeof ROW_SHAS)[number]);
}

function shaAt(row: number): string {
  const sha = ROW_SHAS[row];
  if (sha === undefined) throw new Error(`no fixture row ${row}`);
  return sha;
}

function subjectAt(row: number): string {
  const subject = ROW_SUBJECTS[row];
  if (subject === undefined) throw new Error(`no fixture row ${row}`);
  return subject;
}

function authorAt(_row: number): { name: string; email: string; timestamp: number } {
  return { name: "Kira Fixture", email: "fixture@kira-version.test", timestamp: 1_700_000_000 };
}

function loaded(hits: LoadedScanResult["hits"]): LoadedScanResult {
  return { hits, total: hits.length, truncated: false, complete: true, scannedRows: 3 };
}

function tail(
  hits: readonly { sha: string; subject: string; fields: readonly ("subject" | "body")[] }[],
): SearchRunResult {
  return {
    kind: "ok",
    hits: hits.map((h) => ({
      sha: h.sha,
      subject: h.subject,
      authorName: "Kira Fixture",
      authorEmail: "fixture@kira-version.test",
      authorTime: 1_700_000_000,
      fields: h.fields,
    })),
    total: hits.length,
    truncated: false,
    scanned: 3,
    complete: true,
  };
}

function merge(
  loadedResult: LoadedScanResult | undefined,
  tailResult: SearchRunResult | undefined,
) {
  return buildCommitHits(rowOfSha, shaAt, subjectAt, authorAt, loadedResult, tailResult);
}

describe("buildCommitHits", () => {
  test("a body-only tail hit on an already-loaded row is not an overlap: it counts and appears once", () => {
    // Row 0 was never a loaded-scan hit (the client-side scan doesn't read body) but is already
    // paged into the store — exactly the search scenario's own "tail commit only body match".
    const { hits, overlapCount } = merge(
      loaded([]),
      tail([{ sha: SHA_0, subject: "row 0", fields: ["body"] }]),
    );
    expect(overlapCount).toBe(0);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ row: 0, sha: SHA_0, fields: ["body"] });
  });

  test("a genuine duplicate — the same row already a loaded hit — is folded, not listed twice, and counted as one overlap", () => {
    const { hits, overlapCount } = merge(
      loaded([{ row: 1, fields: ["subject"] }]),
      tail([{ sha: SHA_1, subject: "row 1", fields: ["body"] }]),
    );
    expect(overlapCount).toBe(1);
    expect(hits).toHaveLength(1);
    const [only] = hits;
    if (only === undefined) throw new Error("expected exactly one hit");
    // Both halves' fields are present on the one folded entry.
    expect([...only.fields].sort()).toEqual(["body", "subject"]);
  });

  test("a tail hit whose sha is not loaded at all becomes a tail-only entry with row -1", () => {
    const { hits, overlapCount } = merge(
      undefined,
      tail([{ sha: SHA_UNLOADED, subject: "not yet loaded", fields: ["subject"] }]),
    );
    expect(overlapCount).toBe(0);
    expect(hits).toEqual([
      expect.objectContaining({ row: -1, sha: SHA_UNLOADED, subject: "not yet loaded" }),
    ]);
  });

  test("loaded hits sort ascending by row and precede every tail-only entry", () => {
    const { hits } = merge(
      loaded([
        { row: 2, fields: ["subject"] },
        { row: 0, fields: ["subject"] },
      ]),
      tail([{ sha: SHA_UNLOADED, subject: "tail only", fields: ["subject"] }]),
    );
    expect(hits.map((h) => h.row)).toEqual([0, 2, -1]);
  });

  test("matchCount's own arithmetic is exact in the body-only case once overlapCount is right", () => {
    // Mirrors `SearchState.matchCount`'s formula directly: n = loadedLen + tailTotal - overlap.
    const loadedResult = loaded([]);
    const tailResult = tail([{ sha: SHA_0, subject: "row 0", fields: ["body"] }]);
    const { overlapCount } = merge(loadedResult, tailResult);
    const n =
      loadedResult.hits.length + (tailResult.kind === "ok" ? tailResult.total : 0) - overlapCount;
    expect(n).toBe(1);
  });

  test("no loaded and no tail result yields nothing, not a crash", () => {
    const { hits, overlapCount } = merge(undefined, undefined);
    expect(hits).toEqual([]);
    expect(overlapCount).toBe(0);
  });
});
