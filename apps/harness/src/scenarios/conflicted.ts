import type { CommitRecord, DecorationRef } from "@kira-version/core";
import type { RefRow } from "@kira-version/ipc";
import { topology } from "./topology.ts";
import type { Scenario } from "./types.ts";

/**
 * `docs/plans/P6.md` W18: a real mid-merge, mid-conflict repo — replaces the P0 `Proxy` stub.
 * Exists to demonstrate `ConflictBanner.vue` (W16) and the gate `canRunOp` puts on `checkout`/
 * `revert` while `inProgress !== null` (§7.11) — `Continue` starts disabled (two unresolved
 * paths) and re-enables once the mock's `op.run`/`status.get` loop reflects them resolved,
 * which this scenario cannot fake without a real index, so it simply states two conflicted
 * paths and leaves resolving them to whatever a real host would do.
 */
const COMMIT_SPEC = ["root", "main:root", "topic:root"];
const commits = topology(COMMIT_SPEC);

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  main: [{ kind: "branch", name: "main", isHead: true }],
  topic: [{ kind: "branch", name: "topic", isHead: false }],
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
  if (!commit) throw new Error(`conflicted scenario: no commit named '${subject}'`);
  return commit.sha;
}

const CONFLICTED_PATHS = ["src/shared.ts", "docs/notes.md"];

function branchRow(name: string, isHead: boolean): RefRow {
  return {
    refname: `refs/heads/${name}`,
    kind: "branch",
    shortName: name,
    objectId: shaOf(name),
    peeledObjectId: undefined,
    upstream: undefined,
    track: undefined,
    committerDate: 1_700_003_600,
    isHead,
    checkedOutIn: undefined,
    annotation: undefined,
  };
}

export const conflicted: Scenario = {
  name: "conflicted",
  git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
  repoOpen: {
    kind: "ok",
    repo: {
      repoId: "/repos/conflicted",
      root: "/repos/conflicted",
      gitDir: "/repos/conflicted/.git",
      commonDir: "/repos/conflicted/.git",
      isBare: false,
      isLinkedWorktree: false,
      head: { kind: "branch", name: "main" },
    },
  },
  commits: decorated,
  refs: {
    branches: [branchRow("main", true), branchRow("topic", false)],
    remoteBranches: [],
    tags: [],
  },
  status: {
    upstream: undefined,
    counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 2 },
    isClean: false,
    dirtyPaths: CONFLICTED_PATHS,
    dirtyTruncated: false,
    inProgress: {
      kind: "merge",
      otherSha: shaOf("topic"),
      headName: undefined,
      conflictedPaths: CONFLICTED_PATHS,
      canContinue: true,
      canAbort: true,
      isSequence: false,
      unmergedCount: CONFLICTED_PATHS.length,
    },
  },
};
