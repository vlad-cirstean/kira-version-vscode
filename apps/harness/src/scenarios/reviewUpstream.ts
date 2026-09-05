import type { CommitRecord, DecorationRef } from "@kira-version/core";
import { add, del, hunk } from "./diffFixtures.ts";
import { diffKey } from "./diffKey.ts";
import { topology } from "./topology.ts";
import type { Scenario } from "./types.ts";

/**
 * `docs/plans/P7.md` W15: `reason: "upstream"` reachable — `feature`'s own upstream names
 * `origin/develop`, a *different* branch from `feature` itself, so §6.8 step 1 picks it over
 * `main` (present here specifically to prove step 1 wins over step 2's default-branch fallback,
 * not merely that no default exists).
 */
const COMMIT_SPEC = ["main1", "develop1:main1", "feat1:develop1", "feat2:feat1"];
const commits = topology(COMMIT_SPEC);

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  main1: [{ kind: "branch", name: "main", isHead: false }],
  develop1: [{ kind: "remoteBranch", name: "origin/develop" }],
  feat2: [{ kind: "branch", name: "feature", isHead: true }],
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
  if (!commit) throw new Error(`reviewUpstream scenario: no commit named '${subject}'`);
  return commit.sha;
}

const mainSha = shaOf("main1");
const developSha = shaOf("develop1");
const featureSha = shaOf("feat2");

export const reviewUpstream: Scenario = {
  name: "reviewUpstream",
  git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
  repoOpen: {
    kind: "ok",
    repo: {
      repoId: "/repos/reviewUpstream",
      root: "/repos/reviewUpstream",
      gitDir: "/repos/reviewUpstream/.git",
      commonDir: "/repos/reviewUpstream/.git",
      isBare: false,
      isLinkedWorktree: false,
      head: { kind: "branch", name: "feature" },
    },
  },
  commits: decorated,
  refs: {
    branches: [
      {
        refname: "refs/heads/main",
        kind: "branch",
        shortName: "main",
        objectId: mainSha,
        peeledObjectId: undefined,
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_000_000,
        isHead: false,
        checkedOutIn: undefined,
        annotation: undefined,
      },
      {
        refname: "refs/heads/feature",
        kind: "branch",
        shortName: "feature",
        objectId: featureSha,
        peeledObjectId: undefined,
        upstream: "origin/develop",
        track: { ahead: 2, behind: 0 },
        committerDate: 1_700_010_800,
        isHead: true,
        checkedOutIn: undefined,
        annotation: undefined,
      },
    ],
    remoteBranches: [
      {
        refname: "refs/remotes/origin/develop",
        kind: "remoteBranch",
        shortName: "origin/develop",
        objectId: developSha,
        peeledObjectId: undefined,
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_003_600,
        isHead: false,
        checkedOutIn: undefined,
        annotation: undefined,
      },
    ],
    tags: [],
  },
  details: {
    [shaOf("feat1")]: [
      {
        body: "",
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
    ],
    [shaOf("feat2")]: [
      {
        body: "",
        trailers: [],
        signature: { status: "N", signer: "" },
        files: [
          {
            kind: "modified",
            path: "feat2.ts",
            originalPath: undefined,
            similarity: undefined,
            additions: 1,
            deletions: 1,
            isBinary: false,
          },
        ],
      },
    ],
  },
  diffs: {
    [diffKey(shaOf("feat1"), "feat1.ts")]: {
      kind: "text",
      hunks: [hunk(1, 1, 1, 1, [del("old feat1", 1), add("new feat1", 1)])],
    },
    [diffKey(shaOf("feat2"), "feat2.ts")]: {
      kind: "text",
      hunks: [hunk(1, 1, 1, 1, [del("old feat2", 1), add("new feat2", 1)])],
    },
  },
  status: {
    upstream: { name: "origin/develop", ahead: 2, behind: 0 },
    counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0 },
    isClean: true,
    dirtyPaths: [],
    dirtyTruncated: false,
    inProgress: null,
  },
};
