import type { CommitRecord, DecorationRef } from "@kira-version/core";
import { topology } from "./topology.ts";
import type { Scenario } from "./types.ts";

/**
 * `docs/plans/P7.md` W15: `range: {kind: "empty"}` reachable — `feature`'s tip (`feat2`) is
 * already an ancestor of `main`'s tip (`merge1`, the commit that merged it in), so the range
 * `feature` adds over `main` is empty even though `feature` itself was never deleted.
 */
const COMMIT_SPEC = ["main1", "feat1:main1", "feat2:feat1", "merge1:main1,feat2"];
const commits = topology(COMMIT_SPEC);

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  merge1: [{ kind: "branch", name: "main", isHead: true }],
  feat2: [{ kind: "branch", name: "feature", isHead: false }],
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
  if (!commit) throw new Error(`reviewMerged scenario: no commit named '${subject}'`);
  return commit.sha;
}

export const reviewMerged: Scenario = {
  name: "reviewMerged",
  git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
  repoOpen: {
    kind: "ok",
    repo: {
      repoId: "/repos/reviewMerged",
      root: "/repos/reviewMerged",
      gitDir: "/repos/reviewMerged/.git",
      commonDir: "/repos/reviewMerged/.git",
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
        objectId: shaOf("merge1"),
        peeledObjectId: undefined,
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_010_800,
        isHead: true,
        checkedOutIn: undefined,
        annotation: undefined,
      },
      {
        refname: "refs/heads/feature",
        kind: "branch",
        shortName: "feature",
        objectId: shaOf("feat2"),
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
};
