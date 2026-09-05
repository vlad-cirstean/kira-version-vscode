import type { CommitRecord, DecorationRef } from "@kira-version/core";
import type { RefRow } from "@kira-version/ipc";
import { topology } from "./topology.ts";
import type { Scenario } from "./types.ts";

/**
 * `docs/plans/P6.md` W18: a mid-rebase repo, in a detached HEAD (mirroring how a real rebase
 * actually runs) with no conflicts outstanding — deliberately different from `conflicted.ts`'s
 * merge so `ConflictBanner.vue` demonstrates `InProgressOperation.canContinue`'s one hard rule
 * (the type's own doc comment): "false for rebase (§9) and bisect" REGARDLESS of
 * `unmergedCount`. Only `Abort` is ever offered here — there is no `--continue` for v1 to wire
 * up, by design, not because this fixture forgot to resolve something.
 */
const COMMIT_SPEC = ["root", "main:root", "side-a:main", "side-b:side-a"];
const commits = topology(COMMIT_SPEC);

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  main: [{ kind: "branch", name: "main", isHead: false }],
  "side-b": [{ kind: "branch", name: "side", isHead: false }],
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
  if (!commit) throw new Error(`rebasing scenario: no commit named '${subject}'`);
  return commit.sha;
}

function branchRow(name: string, objectSubject: string): RefRow {
  return {
    refname: `refs/heads/${name}`,
    kind: "branch",
    shortName: name,
    objectId: shaOf(objectSubject),
    peeledObjectId: undefined,
    upstream: undefined,
    track: undefined,
    committerDate: 1_700_003_600,
    isHead: false,
    checkedOutIn: undefined,
    annotation: undefined,
  };
}

export const rebasing: Scenario = {
  name: "rebasing",
  git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
  repoOpen: {
    kind: "ok",
    repo: {
      repoId: "/repos/rebasing",
      root: "/repos/rebasing",
      gitDir: "/repos/rebasing/.git",
      commonDir: "/repos/rebasing/.git",
      isBare: false,
      // A rebase runs with HEAD detached at the commit being replayed — real, not a stand-in
      // for anything: `git rebase` always leaves HEAD this way mid-sequence.
      isLinkedWorktree: false,
      head: { kind: "detached", sha: shaOf("side-b") },
    },
  },
  commits: decorated,
  refs: {
    branches: [branchRow("main", "main"), branchRow("side", "side-b")],
    remoteBranches: [],
    tags: [],
  },
  status: {
    upstream: undefined,
    counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0 },
    isClean: true,
    dirtyPaths: [],
    dirtyTruncated: false,
    inProgress: {
      kind: "rebase",
      otherSha: shaOf("main"),
      headName: "refs/heads/side",
      conflictedPaths: [],
      canContinue: false,
      canAbort: true,
      isSequence: true,
      unmergedCount: 0,
    },
  },
};
