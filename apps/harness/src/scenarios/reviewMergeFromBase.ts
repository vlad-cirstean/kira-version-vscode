import type { CommitRecord, DecorationRef } from "@kira-version/core";
import { add, hunk } from "./diffFixtures.ts";
import { diffKey } from "./diffKey.ts";
import { topology } from "./topology.ts";
import type { CommitDetailFixture, Scenario } from "./types.ts";

/**
 * `docs/plans/P7.md` V5's other half: `review.ts`'s own merge (`feat3`) has both parents
 * *inside* the walked range (`side1` is reachable from `feature`, not from `main`), so its
 * parent selector never needs `FileTree.vue`'s subject-less fallback label — every option
 * already has a real subject to show. This scenario is the case that does: `merge1`'s second
 * parent is `main2`, `main`'s own tip — reachable from `main`, so `main..feature` never walks it
 * and the review's own commit store has no row, and therefore no subject, for it. `#kv-parent-
 * select`'s second `<option>` must fall back to `Parent 2 · <short sha>` alone.
 */
const COMMIT_SPEC = ["main1", "main2:main1", "feat1:main1", "merge1:feat1,main2"];
const commits = topology(COMMIT_SPEC);

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  main2: [{ kind: "branch", name: "main", isHead: true }],
  merge1: [{ kind: "branch", name: "feature", isHead: false }],
};

function decorate(records: readonly CommitRecord[]): CommitRecord[] {
  return records.map((record) => {
    const decoration = DECORATIONS[record.subject];
    return decoration ? { ...record, decoration } : record;
  });
}

const decorated = decorate(commits);

function shaOf(subject: string): string {
  const commit = decorated.find((c) => c.subject === subject);
  if (!commit) throw new Error(`reviewMergeFromBase scenario: no commit named '${subject}'`);
  return commit.sha;
}

function simpleDetail(path: string): CommitDetailFixture {
  return {
    body: "",
    trailers: [],
    signature: { status: "N", signer: "" },
    files: [
      {
        kind: "modified",
        path,
        originalPath: undefined,
        similarity: undefined,
        additions: 1,
        deletions: 1,
        isBinary: false,
      },
    ],
  };
}

const mergeSha = shaOf("merge1");

export const reviewMergeFromBase: Scenario = {
  name: "reviewMergeFromBase",
  git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
  repoOpen: {
    kind: "ok",
    repo: {
      repoId: "/repos/reviewMergeFromBase",
      root: "/repos/reviewMergeFromBase",
      gitDir: "/repos/reviewMergeFromBase/.git",
      commonDir: "/repos/reviewMergeFromBase/.git",
      isBare: false,
      isLinkedWorktree: false,
      head: { kind: "branch", name: "main" },
    },
  },
  commits: decorated,
  refs: {
    branches: [
      {
        refname: "refs/heads/main",
        kind: "branch",
        shortName: "main",
        objectId: shaOf("main2"),
        peeledObjectId: undefined,
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_003_600,
        isHead: true,
        checkedOutIn: undefined,
        annotation: undefined,
      },
      {
        refname: "refs/heads/feature",
        kind: "branch",
        shortName: "feature",
        objectId: mergeSha,
        peeledObjectId: undefined,
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_007_200,
        isHead: false,
        checkedOutIn: undefined,
        annotation: undefined,
      },
    ],
    remoteBranches: [],
    tags: [],
  },
  details: {
    [shaOf("feat1")]: [simpleDetail("feat1.ts")],
    // One entry per parent (`parentIndex` 0 = `feat1`, in range; 1 = `main2`, outside it) — same
    // shape `review.ts`'s own `feat3` merge uses, so `FileTree.vue`'s selector has two real files
    // to switch between regardless of which parent's *label* it can name.
    [mergeSha]: [
      {
        body: "Merge main into feature.",
        trailers: [],
        signature: { status: "N", signer: "" },
        files: [
          {
            kind: "modified",
            path: "feat1.ts",
            originalPath: undefined,
            similarity: undefined,
            additions: 1,
            deletions: 1,
            isBinary: false,
          },
        ],
      },
      {
        body: "Merge main into feature.",
        trailers: [],
        signature: { status: "N", signer: "" },
        files: [
          {
            kind: "added",
            path: "frommain.ts",
            originalPath: undefined,
            similarity: undefined,
            additions: 3,
            deletions: 0,
            isBinary: false,
          },
        ],
      },
    ],
  },
  diffs: {
    [diffKey(shaOf("feat1"), "feat1.ts")]: {
      kind: "text",
      hunks: [hunk(1, 1, 1, 1, [add("export const feat1 = 1;", 1)])],
    },
    [diffKey(mergeSha, "feat1.ts")]: {
      kind: "text",
      hunks: [hunk(1, 1, 1, 1, [add("export const feat1 = 2;", 1)])],
    },
    [diffKey(mergeSha, "frommain.ts")]: {
      kind: "text",
      hunks: [hunk(0, 0, 1, 3, [add("export const fromMain = true;", 1)])],
    },
  },
};
