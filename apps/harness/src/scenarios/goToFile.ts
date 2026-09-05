import type { CommitRecord, DecorationRef } from "@kira-version/core";
import { ctx, hunk } from "./diffFixtures.ts";
import { diffKey } from "./diffKey.ts";
import { topology } from "./topology.ts";
import type { CommitDetailFixture, Scenario } from "./types.ts";

/**
 * P5 W12's "Go to file" scenario: one commit touching six files, `checkoutPaths` and
 * `worktreeDrift` between them producing every `GoToFileOutcome` D14a distinguishes —
 * `docs/plans/P5.md`'s own list for this scenario:
 *
 * - `live-with-drift.ts` — present in the checkout, and its `worktreeDrift` entry carries an
 *   insertion **above** the target line, so the re-mapped and historical line numbers are
 *   provably different (a regression that drops the drift re-map step fails rather than passing
 *   quietly).
 * - `live-no-drift.ts` — present in the checkout with no drift entry, pinning the case where the
 *   two numbers agree.
 * - `deleted-since.ts`, `renamed-since.ts`, `not-ancestor.ts` — three different real-world
 *   stories (deleted from the checkout, renamed away, from a commit that is not an ancestor of
 *   the checkout) that all reach the same one implementation: none is in `checkoutPaths`, all
 *   three have a fixtured blob, so all three answer `virtualBlob`.
 * - `missing-blob.ts` — also absent from `checkoutPaths`, but *no* `diffs` entry either, so its
 *   blob does not resolve and the outcome is `unavailable`/`notInRevision`.
 */
const COMMIT_SPEC = ["root", "tip:root"];
const commits = topology(COMMIT_SPEC);

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  tip: [{ kind: "branch", name: "main", isHead: true }],
};

function decorate(records: readonly CommitRecord[]): CommitRecord[] {
  return records.map((record) => {
    const decoration = DECORATIONS[record.subject];
    return decoration ? { ...record, decoration } : record;
  });
}

const decorated = decorate(commits);
// `topology()`'s newest-first order puts "tip" at index 0 — see this file's own `COMMIT_SPEC`.
const tip = decorated[0];
if (!tip) throw new Error("goToFile scenario: topology() produced no commits");
const tipSha = tip.sha;

function fileChange(path: string): CommitDetailFixture["files"][number] {
  return {
    kind: "modified",
    path,
    originalPath: undefined,
    similarity: undefined,
    additions: 1,
    deletions: 1,
    isBinary: false,
  };
}

const PATHS = [
  "live-with-drift.ts",
  "live-no-drift.ts",
  "deleted-since.ts",
  "renamed-since.ts",
  "not-ancestor.ts",
  "missing-blob.ts",
] as const;

export const goToFile: Scenario = {
  name: "goToFile",
  git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
  repoOpen: {
    kind: "ok",
    repo: {
      repoId: "/repos/goToFile",
      root: "/repos/goToFile",
      gitDir: "/repos/goToFile/.git",
      commonDir: "/repos/goToFile/.git",
      isBare: false,
      isLinkedWorktree: false,
      head: { kind: "branch", name: "main" },
    },
  },
  commits: decorated,
  details: {
    [tipSha]: [
      {
        body: "Touches six files exercising every 'Go to file' outcome.",
        trailers: [],
        signature: { status: "N", signer: "" },
        files: PATHS.map(fileChange),
      },
    ],
  },
  // Blob content itself is never rendered here (no real editor behind the harness) — an empty
  // one-line hunk is enough to make `blobExistsAtRev` answer `true` for the three virtual-blob
  // paths, per this file's own doc comment on why that check is independent of `details`.
  diffs: {
    [diffKey(tipSha, "deleted-since.ts")]: { kind: "text", hunks: [hunk(1, 1, 1, 1, [])] },
    [diffKey(tipSha, "renamed-since.ts")]: { kind: "text", hunks: [hunk(1, 1, 1, 1, [])] },
    [diffKey(tipSha, "not-ancestor.ts")]: { kind: "text", hunks: [hunk(1, 1, 1, 1, [])] },
    // `missing-blob.ts` deliberately has no entry — its blob does not resolve at `tipSha`.
  },
  checkoutPaths: ["live-with-drift.ts", "live-no-drift.ts"],
  // A 5-line insertion ending before line 20 shifts anything at or after it by +5 — asserted
  // against `line: 50` (→ 55) by `tests/e2e/harness/commitDetail.spec.ts` (W13). No individual
  // `lines` are needed: `mapLineAcrossDiff`'s exact-row match never fires for a line outside the
  // hunk's own range, so only the start/length fields the closed-form delta reads are exercised.
  worktreeDrift: {
    [diffKey(tipSha, "live-with-drift.ts")]: [hunk(10, 10, 10, 15, [ctx("unchanged", 10, 10)])],
  },
};
