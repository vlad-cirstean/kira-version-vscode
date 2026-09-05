import type { CommitRecord, DecorationRef } from "@kira-version/core";
import type { RefRow } from "@kira-version/ipc";
import { topology } from "./topology.ts";
import type { Scenario } from "./types.ts";

/**
 * `docs/plans/P6.md` W18: a repo with both an annotated and a lightweight tag, plus a remote-
 * tracking branch — enough for `TagList.vue`'s two-kind rendering and `rowMenuModel.ts`'s
 * `remoteNamesFrom` (no `remotes.list` endpoint exists, so a tag row's push/delete-on-remote
 * entries derive their remote name from `remoteBranches` alone; see that function's own doc
 * comment) to have something real to derive `"origin"` from.
 */
const COMMIT_SPEC = ["root", "released:root", "main:released"];
const commits = topology(COMMIT_SPEC);

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  main: [{ kind: "branch", name: "main", isHead: true }],
  released: [{ kind: "tag", name: "v1.0.0" }],
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
  if (!commit) throw new Error(`tags scenario: no commit named '${subject}'`);
  return commit.sha;
}

export const tags: Scenario = {
  name: "tags",
  git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
  repoOpen: {
    kind: "ok",
    repo: {
      repoId: "/repos/tags",
      root: "/repos/tags",
      gitDir: "/repos/tags/.git",
      commonDir: "/repos/tags/.git",
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
        upstream: "origin/main",
        track: { ahead: 1, behind: 0 },
        committerDate: 1_700_007_200,
        isHead: true,
        checkedOutIn: undefined,
        annotation: undefined,
      },
    ],
    remoteBranches: [
      {
        refname: "refs/remotes/origin/main",
        kind: "remoteBranch",
        shortName: "origin/main",
        objectId: shaOf("released"),
        peeledObjectId: undefined,
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_003_600,
        isHead: false,
        checkedOutIn: undefined,
        annotation: undefined,
      },
    ],
    tags: [
      {
        refname: "refs/tags/v1.0.0",
        kind: "tag",
        shortName: "v1.0.0",
        // The tag object's own sha (probe P3) — deliberately not `shaOf("released")`, which is
        // the *pointed-at commit*; `peeledObjectId` carries that instead, matching a real
        // annotated tag's two distinct objects.
        objectId: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        peeledObjectId: shaOf("released"),
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_003_600,
        isHead: false,
        checkedOutIn: undefined,
        annotation: {
          tagger: "Kira Fixture <fixture@kira-version.test>",
          date: 1_700_003_600,
          subject: "Release 1.0.0",
        },
      },
      {
        refname: "refs/tags/checkpoint",
        kind: "tag",
        shortName: "checkpoint",
        objectId: shaOf("released"),
        peeledObjectId: undefined,
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_003_600,
        isHead: false,
        checkedOutIn: undefined,
        annotation: undefined,
      },
      // P6 W19's `refs.spec.ts`: a `v9`/`v10` pair — the one case a plain lexicographic sort gets
      // wrong ("v10" before "v9") and `refListModel.ts`'s `naturalCompare` exists to fix (§7.9).
      {
        refname: "refs/tags/v9.0.0",
        kind: "tag",
        shortName: "v9.0.0",
        objectId: shaOf("released"),
        peeledObjectId: undefined,
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_003_600,
        isHead: false,
        checkedOutIn: undefined,
        annotation: undefined,
      },
      {
        refname: "refs/tags/v10.0.0",
        kind: "tag",
        shortName: "v10.0.0",
        objectId: shaOf("released"),
        peeledObjectId: undefined,
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_003_600,
        isHead: false,
        checkedOutIn: undefined,
        annotation: undefined,
      },
    ] satisfies RefRow[],
  },
  status: {
    upstream: { name: "origin/main", ahead: 1, behind: 0 },
    counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0 },
    isClean: true,
    dirtyPaths: [],
    dirtyTruncated: false,
    inProgress: null,
  },
};
