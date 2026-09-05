import type { CommitRecord, DecorationRef } from "@kira-version/core";
import type { RefRow } from "@kira-version/ipc";
import { topology } from "./topology.ts";
import type { Scenario } from "./types.ts";

/**
 * `docs/plans/P6.md` W18: §7.5's fifth checkout blocker — a branch already checked out in
 * another worktree (D12). `mockBridge.ts`'s `defaultCheckoutPreflight` reads a `RefRow`'s own
 * `checkedOutIn` (see that function's own doc comment), so this scenario needs no explicit
 * `preflight.checkout` fixture at all: setting `checkedOutIn` on the ref itself is enough for
 * the default classifier to produce the `worktreeConflict` blocker, exactly as
 * `packages/git/src/repoService.ts` would from a real `%(worktreepath)` field.
 */
const COMMIT_SPEC = ["root", "main:root", "linked:root"];
const commits = topology(COMMIT_SPEC);

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  main: [{ kind: "branch", name: "main", isHead: true }],
  linked: [{ kind: "branch", name: "linked-work", isHead: false }],
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
  if (!commit) throw new Error(`worktrees scenario: no commit named '${subject}'`);
  return commit.sha;
}

export const worktrees: Scenario = {
  name: "worktrees",
  git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
  repoOpen: {
    kind: "ok",
    repo: {
      repoId: "/repos/worktrees",
      root: "/repos/worktrees",
      gitDir: "/repos/worktrees/.git",
      commonDir: "/repos/worktrees/.git",
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
        objectId: shaOf("main"),
        peeledObjectId: undefined,
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_003_600,
        isHead: true,
        checkedOutIn: undefined,
        annotation: undefined,
      },
      {
        refname: "refs/heads/linked-work",
        kind: "branch",
        shortName: "linked-work",
        objectId: shaOf("linked"),
        peeledObjectId: undefined,
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_003_600,
        isHead: false,
        // D12: this session's own toplevel is `/repos/worktrees`, so a non-`undefined` path
        // here means "checked out somewhere else" — the one field a real
        // `%(worktreepath)` minus this repo's own toplevel would also produce.
        checkedOutIn: "/repos/worktrees-linked",
        annotation: undefined,
      } satisfies RefRow,
    ],
    remoteBranches: [],
    tags: [],
  },
  status: {
    upstream: undefined,
    counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0 },
    isClean: true,
    dirtyPaths: [],
    dirtyTruncated: false,
    inProgress: null,
  },
};
