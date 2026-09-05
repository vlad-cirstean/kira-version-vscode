import type { CommitRecord, DecorationRef } from "@kira-version/core";
import { add, ctx, del, hunk } from "./diffFixtures.ts";
import { diffKey } from "./diffKey.ts";
import { topology } from "./topology.ts";
import type { CommitDetailFixture, Scenario } from "./types.ts";

/**
 * `docs/plans/P7.md` W15's happy-path review scenario — `feature` over `main` (`main` is a
 * `kiraVersion.review.baseCandidates` default, so `review.resolveBase` detects it with
 * `reason: "defaultBranch"` with no upstream fixture needed), ten commits in the range, including
 * one two-parent merge (the parent selector), one rename-with-edits, one binary file and one LFS
 * pointer — P5's own file-tree edge cases, exercised inside a review row rather than the panel's
 * detail pane.
 */
const COMMIT_SPEC = [
  "main1",
  "main2:main1",
  "feat1:main2",
  "feat2:feat1",
  "side1:feat1",
  // Two parents: a real merge, enough for `ReviewCommitRow.vue`'s parent selector — this
  // scenario does not need `merge.ts`'s octopus, only that a selector renders at all.
  "feat3:feat2,side1",
  "feat4:feat3",
  "rename1:feat4",
  "binary1:rename1",
  "lfs1:binary1",
  "feat5:lfs1",
  "feat6:feat5",
];
const commits = topology(COMMIT_SPEC);

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  main2: [{ kind: "branch", name: "main", isHead: true }],
  feat6: [{ kind: "branch", name: "feature", isHead: false }],
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
  if (!commit) throw new Error(`review scenario: no commit named '${subject}'`);
  return commit.sha;
}

const mainTipSha = shaOf("main2");
const featureTipSha = shaOf("feat6");
const mergeSha = shaOf("feat3");
const renameSha = shaOf("rename1");
const binarySha = shaOf("binary1");
const lfsSha = shaOf("lfs1");

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

function simpleDiff(path: string) {
  return {
    kind: "text" as const,
    hunks: [hunk(1, 1, 1, 1, [del(`old ${path}`, 1), add(`new ${path}`, 1)])],
  };
}

export const review: Scenario = {
  name: "review",
  git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
  repoOpen: {
    kind: "ok",
    repo: {
      repoId: "/repos/review",
      root: "/repos/review",
      gitDir: "/repos/review/.git",
      commonDir: "/repos/review/.git",
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
        objectId: mainTipSha,
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
        objectId: featureTipSha,
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
    [shaOf("feat2")]: [simpleDetail("feat2.ts")],
    [shaOf("side1")]: [simpleDetail("side1.ts")],
    // The merge (`feat3`): two entries, one per parent (`parentIndex` 0 = `feat2`, 1 = `side1`),
    // each naming a different file — `ReviewCommitRow.vue`'s parent selector has something real
    // to switch between, the same shape `merge.ts` already established for the panel's own
    // detail pane.
    [mergeSha]: [
      {
        body: "Merge side1 into feat2.",
        trailers: [],
        signature: { status: "N", signer: "" },
        files: [
          {
            kind: "modified",
            path: "feat2.ts",
            originalPath: undefined,
            similarity: undefined,
            additions: 2,
            deletions: 1,
            isBinary: false,
          },
        ],
      },
      {
        body: "Merge side1 into feat2.",
        trailers: [],
        signature: { status: "N", signer: "" },
        files: [
          {
            kind: "added",
            path: "side1.ts",
            originalPath: undefined,
            similarity: undefined,
            additions: 6,
            deletions: 0,
            isBinary: false,
          },
        ],
      },
    ],
    [shaOf("feat4")]: [simpleDetail("feat4.ts")],
    [renameSha]: [
      {
        body: "Rename and lightly edit.",
        trailers: [],
        signature: { status: "N", signer: "" },
        files: [
          {
            kind: "renamed",
            path: "src/renamed-new.ts",
            originalPath: "src/renamed-old.ts",
            similarity: 85,
            additions: 3,
            deletions: 1,
            isBinary: false,
          },
        ],
      },
    ],
    [binarySha]: [
      {
        body: "Update the icon.",
        trailers: [],
        signature: { status: "N", signer: "" },
        files: [
          {
            kind: "modified",
            path: "assets/icon.png",
            originalPath: undefined,
            similarity: undefined,
            additions: undefined,
            deletions: undefined,
            isBinary: true,
          },
        ],
      },
    ],
    [lfsSha]: [
      {
        body: "Track a large asset with LFS.",
        trailers: [],
        signature: { status: "N", signer: "" },
        files: [
          {
            kind: "added",
            path: "assets/large-asset.bin",
            originalPath: undefined,
            similarity: undefined,
            additions: 3,
            deletions: 0,
            isBinary: false,
          },
        ],
      },
    ],
    // Two files, not `simpleDetail`'s one — `review.spec.ts`'s (W16) own "arrow keys move between
    // files with the diff following" needs a row with more than one file to move between.
    [shaOf("feat5")]: [
      {
        body: "",
        trailers: [],
        signature: { status: "N", signer: "" },
        files: [
          {
            kind: "modified",
            path: "feat5.ts",
            originalPath: undefined,
            similarity: undefined,
            additions: 1,
            deletions: 1,
            isBinary: false,
          },
          {
            kind: "modified",
            path: "feat5b.ts",
            originalPath: undefined,
            similarity: undefined,
            additions: 1,
            deletions: 1,
            isBinary: false,
          },
        ],
      },
    ],
    [shaOf("feat6")]: [simpleDetail("feat6.ts")],
  },
  diffs: {
    [diffKey(shaOf("feat5"), "feat5b.ts")]: simpleDiff("feat5b.ts"),
    [diffKey(shaOf("feat1"), "feat1.ts")]: simpleDiff("feat1.ts"),
    [diffKey(shaOf("feat2"), "feat2.ts")]: simpleDiff("feat2.ts"),
    [diffKey(shaOf("side1"), "side1.ts")]: simpleDiff("side1.ts"),
    [diffKey(mergeSha, "feat2.ts")]: simpleDiff("feat2.ts"),
    [diffKey(mergeSha, "side1.ts")]: {
      kind: "text",
      hunks: [hunk(0, 0, 1, 1, [add("export const side1 = true;", 1)])],
    },
    [diffKey(shaOf("feat4"), "feat4.ts")]: simpleDiff("feat4.ts"),
    [diffKey(renameSha, "src/renamed-new.ts")]: {
      kind: "text",
      hunks: [
        hunk(1, 2, 1, 3, [
          ctx("export function renamed(): number {", 1, 1),
          del("  return 1;", 2),
          add("  return 2;", 2),
          add("  // renamed", 3),
        ]),
      ],
    },
    [diffKey(binarySha, "assets/icon.png")]: { kind: "binary", oldBytes: 4_096, newBytes: 4_608 },
    [diffKey(lfsSha, "assets/large-asset.bin")]: {
      kind: "lfsPointer",
      oid: "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944e",
      bytes: 52_428_800,
    },
    [diffKey(shaOf("feat5"), "feat5.ts")]: simpleDiff("feat5.ts"),
    [diffKey(shaOf("feat6"), "feat6.ts")]: simpleDiff("feat6.ts"),
  },
};
