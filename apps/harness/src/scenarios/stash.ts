import type { CommitRecord, DecorationRef } from "@kira-version/core";
import type { CheckoutPreflight, RefRow } from "@kira-version/ipc";
import { EPOCH_SECONDS, STEP_SECONDS, topology } from "./topology.ts";
import type { Scenario } from "./types.ts";

/**
 * `docs/plans/P9.md` W21: a dirty tracked file to stash from the toolbar, two pre-existing stash
 * entries (`Scenario.stash`, this same phase's own addition to the fixture surface — see that
 * field's own doc comment) so "the list renders three entries" has two real ones to join the one
 * the test itself creates, and a `feature` branch whose checkout is a bare `blockedByTracked`
 * (`dirty.ts`'s own "feature-blocked-tracked" convention: a fixture-only target, its `objectId`
 * reusing `main`'s own tip rather than a second real commit) offering `"stashAndCarry"` alongside
 * `"discard"`, so the blocked-checkout route has somewhere real to land a clean pop.
 */
const COMMIT_SPEC = ["root", "main:root"];
const commits = topology(COMMIT_SPEC);

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  main: [{ kind: "branch", name: "main", isHead: true }],
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
  if (!commit) throw new Error(`stash scenario: no commit named '${subject}'`);
  return commit.sha;
}

function branchRow(name: string, isHead: boolean, objectId = shaOf(name)): RefRow {
  return {
    refname: `refs/heads/${name}`,
    kind: "branch",
    shortName: name,
    objectId,
    peeledObjectId: undefined,
    upstream: undefined,
    track: undefined,
    committerDate: 1_700_003_600,
    isHead,
    checkedOutIn: undefined,
    annotation: undefined,
  };
}

const DIRTY_PATHS = ["src/app.ts"];

const preflightByTarget: Readonly<Record<string, CheckoutPreflight>> = {
  feature: {
    target: { kind: "branch", name: "feature" },
    detaches: false,
    createsTracking: undefined,
    carried: [],
    blockers: [{ kind: "blockedByTracked", paths: DIRTY_PATHS }],
    verdict: "blocked",
    routes: ["discard", "stashAndCarry"],
  },
};

const SEED_STASH: NonNullable<Scenario["stash"]> = [
  {
    entry: {
      index: 0,
      sha: "a".repeat(40),
      baseSha: shaOf("main"),
      baseSubject: "main",
      indexSha: "b".repeat(40),
      untrackedSha: undefined,
      message: "Backend refactor (WIP)",
      branch: "main",
      timestamp: EPOCH_SECONDS + 19 * STEP_SECONDS,
      fileCount: 2,
      includedUntracked: false,
    },
    // Deliberately overlaps `DIRTY_PATHS` (`src/app.ts`) — the mock's `defaultStashPopPreflight`
    // computes `localChangesWouldBeOverwritten` as a real set intersection against
    // `session.status.dirtyPaths`, so popping or applying THIS entry while that file is still
    // dirty is genuinely blocked, not a scenario-only fixture. Gives `stash.spec.ts`/
    // `refsVisual.spec.ts` a real blocked-pop case to drive `StashDialog.vue`'s `popConfirm` mode
    // with, without inventing a `preflight.stashPop` override.
    stashedPaths: ["src/app.ts", "src/backend.ts"],
  },
  {
    entry: {
      index: 1,
      sha: "c".repeat(40),
      baseSha: shaOf("main"),
      baseSubject: "main",
      indexSha: "d".repeat(40),
      untrackedSha: undefined,
      message: "Docs pass",
      branch: "main",
      timestamp: EPOCH_SECONDS + 18 * STEP_SECONDS,
      fileCount: 1,
      includedUntracked: false,
    },
    stashedPaths: ["README.md"],
  },
];

export const stash: Scenario = {
  name: "stash",
  git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
  repoOpen: {
    kind: "ok",
    repo: {
      repoId: "/repos/stash",
      root: "/repos/stash",
      gitDir: "/repos/stash/.git",
      commonDir: "/repos/stash/.git",
      isBare: false,
      isLinkedWorktree: false,
      head: { kind: "branch", name: "main" },
    },
  },
  commits: decorated,
  refs: {
    branches: [branchRow("main", true), branchRow("feature", false, shaOf("main"))],
    remoteBranches: [],
    tags: [],
  },
  status: {
    upstream: undefined,
    counts: { staged: 0, unstaged: 1, untracked: 1, unmerged: 0 },
    isClean: false,
    dirtyPaths: DIRTY_PATHS,
    dirtyTruncated: false,
    inProgress: null,
  },
  preflight: { checkout: preflightByTarget },
  stash: SEED_STASH,
};
