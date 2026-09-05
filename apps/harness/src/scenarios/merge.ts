import type { CommitRecord, DecorationRef } from "@kira-version/core";
import { add, ctx, del, hunk } from "./diffFixtures.ts";
import { diffKey } from "./diffKey.ts";
import { topology } from "./topology.ts";
import type { CommitDetailFixture, Scenario } from "./types.ts";

/**
 * P5 W12's merge-parent-selector scenario: a three-parent (octopus) merge whose three parents
 * each produce a *different* file list, so switching `parentIndex` visibly changes the tree and
 * cannot be faked by one stable fixture answering every selection the same way.
 */
const COMMIT_SPEC = [
  "root",
  "side-a:root",
  "side-b:root",
  "side-c:root",
  "merge:side-a,side-b,side-c",
];
const commits = topology(COMMIT_SPEC);

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  merge: [{ kind: "branch", name: "main", isHead: true }],
};

function decorate(records: readonly CommitRecord[]): CommitRecord[] {
  return records.map((record) => {
    const decoration = DECORATIONS[record.subject];
    return decoration ? { ...record, decoration } : record;
  });
}

const decorated = decorate(commits);
// `topology()`'s newest-first order puts "merge" at index 0 — see this file's own `COMMIT_SPEC`.
const mergeCommit = decorated[0];
if (!mergeCommit) throw new Error("merge scenario: topology() produced no commits");
const mergeSha = mergeCommit.sha;

// P6 W19's own "predicted conflict" case: `side-a` is an ordinary, single-parent commit —
// `defaultRevertPreflight` would otherwise call it a clean, un-prompted revert, so this scenario
// states an explicit `preflight.revert` fixture for it instead (`revert.spec.ts`'s own doc
// comment on why: no other scenario has a reason to name a revert-conflict fixture by hand).
const sideACommit = decorated.find((c) => c.subject === "side-a");
if (!sideACommit) throw new Error("merge scenario: no commit named 'side-a'");
const sideASha = sideACommit.sha;
const REVERT_CONFLICT_PATHS = ["a-only.ts"];

function detailFixture(body: string, files: CommitDetailFixture["files"]): CommitDetailFixture {
  return { body, trailers: [], signature: { status: "N", signer: "" }, files };
}

export const merge: Scenario = {
  name: "merge",
  git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
  repoOpen: {
    kind: "ok",
    repo: {
      repoId: "/repos/merge",
      root: "/repos/merge",
      gitDir: "/repos/merge/.git",
      commonDir: "/repos/merge/.git",
      isBare: false,
      isLinkedWorktree: false,
      head: { kind: "branch", name: "main" },
    },
  },
  commits: decorated,
  details: {
    [mergeSha]: [
      detailFixture("Octopus merge of side-a, side-b and side-c.", [
        {
          kind: "modified",
          path: "a-only.ts",
          originalPath: undefined,
          similarity: undefined,
          additions: 2,
          deletions: 1,
          isBinary: false,
        },
      ]),
      detailFixture("Octopus merge of side-a, side-b and side-c.", [
        {
          kind: "added",
          path: "b-only.ts",
          originalPath: undefined,
          similarity: undefined,
          additions: 6,
          deletions: 0,
          isBinary: false,
        },
      ]),
      detailFixture("Octopus merge of side-a, side-b and side-c.", [
        {
          kind: "deleted",
          path: "c-only.ts",
          originalPath: undefined,
          similarity: undefined,
          additions: 0,
          deletions: 9,
          isBinary: false,
        },
      ]),
    ],
  },
  diffs: {
    [diffKey(mergeSha, "a-only.ts")]: {
      kind: "text",
      hunks: [hunk(1, 2, 1, 2, [del("old a", 1), add("new a", 1), ctx("tail", 2, 2)])],
    },
    [diffKey(mergeSha, "b-only.ts")]: {
      kind: "text",
      hunks: [hunk(0, 0, 1, 1, [add("new file b", 1)])],
    },
    [diffKey(mergeSha, "c-only.ts")]: {
      kind: "text",
      hunks: [hunk(1, 1, 0, 0, [del("removed c", 1)])],
    },
  },
  preflight: {
    revert: {
      [sideASha]: {
        shas: [sideASha],
        mainlineRequired: [],
        dirtyPaths: [],
        inProgress: null,
        prediction: { kind: "conflicts", paths: REVERT_CONFLICT_PATHS },
        predictedFor: sideASha,
        detachedHead: false,
        verdict: "willConflict",
        blockers: [],
      },
    },
  },
};
