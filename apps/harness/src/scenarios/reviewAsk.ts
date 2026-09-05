import type { CommitRecord, DecorationRef } from "@kira-version/core";
import { topology } from "./topology.ts";
import type { Scenario } from "./types.ts";

/**
 * `docs/plans/P7.md` W15: `reason: "none"` reachable — `feature` has no upstream, and no
 * `main`/`master` branch exists at all (`review.resolveBase`'s mock never models `origin/HEAD`,
 * so step 2 falls straight through to `candidates`, which here find nothing), so resolution asks.
 *
 * Also carries the `unrelated` variant in the same repository: `other` shares no history with
 * `feature` at all (two independent roots) — picking it from the header's own base picker as an
 * explicit override reaches `range: {kind: "unrelated"}`, distinct from this scenario's own
 * default `{kind: "ask"}`.
 */
const COMMIT_SPEC = [
  "feat-root",
  "feat1:feat-root",
  "feat2:feat1",
  "other-root",
  "other1:other-root",
];
const commits = topology(COMMIT_SPEC);

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  feat2: [{ kind: "branch", name: "feature", isHead: true }],
  other1: [{ kind: "branch", name: "other", isHead: false }],
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
  if (!commit) throw new Error(`reviewAsk scenario: no commit named '${subject}'`);
  return commit.sha;
}

export const reviewAsk: Scenario = {
  name: "reviewAsk",
  git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
  repoOpen: {
    kind: "ok",
    repo: {
      repoId: "/repos/reviewAsk",
      root: "/repos/reviewAsk",
      gitDir: "/repos/reviewAsk/.git",
      commonDir: "/repos/reviewAsk/.git",
      isBare: false,
      isLinkedWorktree: false,
      head: { kind: "branch", name: "feature" },
    },
  },
  commits: decorated,
  refs: {
    branches: [
      {
        refname: "refs/heads/feature",
        kind: "branch",
        shortName: "feature",
        objectId: shaOf("feat2"),
        peeledObjectId: undefined,
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_007_200,
        isHead: true,
        checkedOutIn: undefined,
        annotation: undefined,
      },
      {
        refname: "refs/heads/other",
        kind: "branch",
        shortName: "other",
        objectId: shaOf("other1"),
        peeledObjectId: undefined,
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_003_600,
        isHead: false,
        checkedOutIn: undefined,
        annotation: undefined,
      },
    ],
    remoteBranches: [],
    tags: [],
  },
};
