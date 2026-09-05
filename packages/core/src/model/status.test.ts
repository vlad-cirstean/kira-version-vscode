import { describe, expect, test } from "bun:test";
import type { InProgressOperation } from "./operation.ts";
import type { StatusEntry, StatusResult } from "./status.ts";
import { dirtyPathsFrom, summarizeStatus } from "./status.ts";

function result(
  entries: StatusEntry[],
  branch: Partial<StatusResult["branch"]> = {},
): StatusResult {
  return {
    branch: {
      oid: "abc1234abc1234abc1234abc1234abc1234abc1",
      head: { kind: "branch", name: "main" },
      upstream: undefined,
      ahead: undefined,
      behind: undefined,
      ...branch,
    },
    entries,
  };
}

function ordinary(path: string, staged: "M" | "." = "M", unstaged: "M" | "." = "."): StatusEntry {
  return {
    kind: "ordinary",
    staged,
    unstaged,
    submodule: "N...",
    headMode: "100644",
    indexMode: "100644",
    worktreeMode: "100644",
    headObjectId: "0".repeat(40),
    indexObjectId: "0".repeat(40),
    path,
  };
}

function untracked(path: string): StatusEntry {
  return { kind: "untracked", path };
}

function ignored(path: string): StatusEntry {
  return { kind: "ignored", path };
}

function unmerged(path: string): StatusEntry {
  return {
    kind: "unmerged",
    staged: "U",
    unstaged: "U",
    submodule: "N...",
    base: { mode: "100644", objectId: "0".repeat(40) },
    ours: { mode: "100644", objectId: "0".repeat(40) },
    theirs: { mode: "100644", objectId: "0".repeat(40) },
    worktreeMode: "100644",
    path,
  };
}

describe("summarizeStatus", () => {
  test("a clean tree: all counts zero, isClean true, no dirty paths", () => {
    const summary = summarizeStatus(result([]), null);
    expect(summary.counts).toEqual({ staged: 0, unstaged: 0, untracked: 0, unmerged: 0 });
    expect(summary.isClean).toBe(true);
    expect(summary.dirtyPaths).toEqual([]);
    expect(summary.dirtyTruncated).toBe(false);
  });

  test("counts staged and unstaged independently; a path modified in both counts toward both", () => {
    const summary = summarizeStatus(result([ordinary("both.txt", "M", "M")]), null);
    expect(summary.counts.staged).toBe(1);
    expect(summary.counts.unstaged).toBe(1);
    expect(summary.isClean).toBe(false);
    expect(summary.dirtyPaths).toEqual(["both.txt"]);
  });

  test("untracked and unmerged are counted and listed", () => {
    const summary = summarizeStatus(result([untracked("new.txt"), unmerged("conflict.txt")]), null);
    expect(summary.counts).toEqual({ staged: 0, unstaged: 0, untracked: 1, unmerged: 1 });
    expect([...summary.dirtyPaths].sort()).toEqual(["conflict.txt", "new.txt"]);
  });

  test("ignored paths are never counted or listed", () => {
    const summary = summarizeStatus(result([ignored("dist/bundle.js")]), null);
    expect(summary.counts).toEqual({ staged: 0, unstaged: 0, untracked: 0, unmerged: 0 });
    expect(summary.isClean).toBe(true);
    expect(summary.dirtyPaths).toEqual([]);
  });

  test("head: a named branch with a real oid", () => {
    const summary = summarizeStatus(
      result([], { head: { kind: "branch", name: "feature" }, oid: "sha" }),
      null,
    );
    expect(summary.head).toEqual({ kind: "branch", name: "feature" });
  });

  test("head: unborn — a named branch with no oid yet", () => {
    const summary = summarizeStatus(
      result([], { head: { kind: "branch", name: "main" }, oid: undefined }),
      null,
    );
    expect(summary.head).toEqual({ kind: "unborn", name: "main" });
  });

  test("head: detached — oid becomes the sha", () => {
    const summary = summarizeStatus(
      result([], { head: { kind: "detached" }, oid: "deadbeef" }),
      null,
    );
    expect(summary.head).toEqual({ kind: "detached", sha: "deadbeef" });
  });

  test("upstream present: ahead/behind carried through", () => {
    const summary = summarizeStatus(
      result([], { upstream: "origin/main", ahead: 2, behind: 3 }),
      null,
    );
    expect(summary.upstream).toEqual({ name: "origin/main", ahead: 2, behind: 3 });
  });

  test("upstream absent: undefined, not a zeroed object", () => {
    const summary = summarizeStatus(result([]), null);
    expect(summary.upstream).toBeUndefined();
  });

  test("inProgress is threaded through unchanged", () => {
    const op: InProgressOperation = {
      kind: "revert",
      otherSha: "abc1234",
      headName: undefined,
      conflictedPaths: ["a.txt"],
      canContinue: true,
      canAbort: true,
      isSequence: false,
      unmergedCount: 1,
    };
    const summary = summarizeStatus(result([unmerged("a.txt")]), op);
    expect(summary.inProgress).toBe(op);
  });

  test("dirtyTruncated is always false here — capping is the service's job, not this fold's", () => {
    const many = Array.from({ length: 500 }, (_, i) => untracked(`f${i}.txt`));
    const summary = summarizeStatus(result(many), null);
    expect(summary.dirtyPaths).toHaveLength(500);
    expect(summary.dirtyTruncated).toBe(false);
  });
});

describe("dirtyPathsFrom", () => {
  test("ordinary and renamed and unmerged are tracked; untracked is not; ignored is absent", () => {
    const paths = dirtyPathsFrom(
      result([
        ordinary("modified.txt"),
        unmerged("conflict.txt"),
        untracked("new.txt"),
        ignored("dist/x.js"),
      ]),
    );
    expect(paths).toEqual([
      { path: "modified.txt", tracked: true },
      { path: "conflict.txt", tracked: true },
      { path: "new.txt", tracked: false },
    ]);
  });

  test("empty status yields an empty list", () => {
    expect(dirtyPathsFrom(result([]))).toEqual([]);
  });
});
