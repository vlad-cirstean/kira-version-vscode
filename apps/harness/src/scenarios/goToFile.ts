import type { CommitRecord, DecorationRef } from "@kira-version/core";
import { ctx, del, hunk } from "./diffFixtures.ts";
import { diffKey } from "./diffKey.ts";
import { topology } from "./topology.ts";
import type { CommitDetailFixture, Scenario } from "./types.ts";

/**
 * P5 W12/W13's "Go to file" scenario: one commit touching six files, `checkoutPaths` and
 * `worktreeDrift` between them producing every `GoToFileOutcome` D14a distinguishes, collapsed to
 * the plan's own "four-case matrix" (`docs/plans/P5.md`'s W10/W13):
 *
 * - `live-with-drift.ts` — present in the checkout. Its commit-level diff opens with a single
 *   content row whose "new"-side line is **50** (`mapDiffLineToRevision(hunks, row, "new")`), so
 *   clicking that one row and pressing "Go to file" sends exactly `line: 50` — the number this
 *   file's own `worktreeDrift` entry (a 5-line net insertion ending at line 20) is built to shift.
 *   `mapLineAcrossDiff`'s closed form then answers `55`, so the re-mapped and historical numbers
 *   are provably different — a regression that drops the drift re-map step fails rather than
 *   passing quietly.
 * - `live-no-drift.ts` — present in the checkout, single content row at line **1**, no drift
 *   entry: pins the case where the two numbers agree (no re-map at all).
 * - `deleted-since.ts`, `renamed-since.ts`, `not-ancestor.ts` — three different real-world
 *   stories (deleted from the checkout, renamed away, from a commit that is not an ancestor of
 *   the checkout) that all reach the same one implementation: none is in `checkoutPaths`, all
 *   three have a fixtured blob at `tipSha`, so all three answer `virtualBlob` — one matrix row,
 *   exercised through all three fixtures.
 * - `missing-blob.ts` — the fourth row, `unavailable`. Modelled as a **deleted** file so its
 *   click path resolves `rev` to the root commit's own sha, not `tipSha` (D14a's `side = "old"`
 *   branch for a deleted change): `commit.fileDiff(tipSha, ...)` is fixtured (so the tree/diff
 *   still opens and "Go to file" is reachable through the same UI flow as every other case), but
 *   `diffs[diffKey(root.sha, ...)]` — what `blobExistsAtRev` actually checks for this rev —
 *   deliberately has no entry, so the blob does not resolve and the outcome is
 *   `unavailable`/`notInRevision`.
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
// `topology()`'s newest-first order puts "tip" at index 0, "root" at index 1 — see this file's
// own `COMMIT_SPEC`.
const tip = decorated[0];
const root = decorated[1];
if (!tip || !root) throw new Error("goToFile scenario: topology() produced fewer than 2 commits");
const tipSha = tip.sha;

function fileChange(
  path: string,
  overrides: Partial<CommitDetailFixture["files"][number]> = {},
): CommitDetailFixture["files"][number] {
  return {
    kind: "modified",
    path,
    originalPath: undefined,
    similarity: undefined,
    additions: 1,
    deletions: 1,
    isBinary: false,
    ...overrides,
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

const FILES: CommitDetailFixture["files"] = PATHS.map((path) =>
  path === "missing-blob.ts"
    ? fileChange(path, { kind: "deleted", additions: 0, deletions: 3 })
    : fileChange(path),
);

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
        files: FILES,
      },
    ],
  },
  diffs: {
    // The two "live" files: one content row each, at new-side lines 50 and 1 respectively — see
    // this file's own top doc comment for why those exact numbers matter.
    [diffKey(tipSha, "live-with-drift.ts")]: {
      kind: "text",
      hunks: [hunk(50, 1, 50, 1, [ctx("line fifty", 50, 50)])],
    },
    [diffKey(tipSha, "live-no-drift.ts")]: {
      kind: "text",
      hunks: [hunk(1, 1, 1, 1, [ctx("line one", 1, 1)])],
    },
    // Blob content is otherwise never rendered here (no real editor behind the harness) — an
    // empty one-line hunk is enough to make `blobExistsAtRev` answer `true` for the three
    // virtual-blob paths, per this file's own doc comment on why that check is independent of
    // `details`.
    [diffKey(tipSha, "deleted-since.ts")]: { kind: "text", hunks: [hunk(1, 1, 1, 1, [])] },
    [diffKey(tipSha, "renamed-since.ts")]: { kind: "text", hunks: [hunk(1, 1, 1, 1, [])] },
    [diffKey(tipSha, "not-ancestor.ts")]: { kind: "text", hunks: [hunk(1, 1, 1, 1, [])] },
    // `missing-blob.ts` opens fine at `tipSha` (needed so its diff/"Go to file" button is
    // reachable at all) — a plain deletion diff, three removed lines.
    [diffKey(tipSha, "missing-blob.ts")]: {
      kind: "text",
      hunks: [hunk(1, 3, 0, 0, [del("gone", 1), del("gone too", 2), del("// eof", 3)])],
    },
    // Deliberately no `diffKey(root.sha, "missing-blob.ts")` entry — its rev for "Go to file" (a
    // deleted file's `side: "old"` branch) is the root commit's own sha, not `tipSha`, and that
    // lookup is what must miss for `unavailable`/`notInRevision` to fire.
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
