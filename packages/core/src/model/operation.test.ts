import { describe, expect, test } from "bun:test";
import {
  canRunOp,
  classifyInProgress,
  describeInProgress,
  type InProgressOperation,
  type InProgressStateFiles,
} from "./operation.ts";

function stateFiles(partial: Partial<InProgressStateFiles>): InProgressStateFiles {
  return {
    mergeHead: undefined,
    cherryPickHead: undefined,
    revertHead: undefined,
    bisectLog: false,
    rebaseMergeDir: false,
    rebaseApplyDir: false,
    rebaseHeadName: undefined,
    rebaseOnto: undefined,
    sequencerDir: false,
    ...partial,
  };
}

describe("classifyInProgress — precedence table (§7.11)", () => {
  test("no state files, no unmerged paths ⇒ null (nothing in progress)", () => {
    expect(classifyInProgress({ stateFiles: stateFiles({}), unmergedPaths: [] })).toBeNull();
  });

  test("rebase-merge dir present ⇒ rebase, cannot continue, can abort", () => {
    const op = classifyInProgress({
      stateFiles: stateFiles({
        rebaseMergeDir: true,
        rebaseHeadName: "refs/heads/side",
        rebaseOnto: "deadbeef",
      }),
      unmergedPaths: ["a.txt"],
    });
    expect(op).toEqual({
      kind: "rebase",
      otherSha: "deadbeef",
      headName: "refs/heads/side",
      conflictedPaths: ["a.txt"],
      canContinue: false,
      canAbort: true,
      isSequence: false,
      unmergedCount: 1,
    });
  });

  test("rebase-apply dir present ⇒ rebase (am-based rebase)", () => {
    const op = classifyInProgress({
      stateFiles: stateFiles({ rebaseApplyDir: true }),
      unmergedPaths: [],
    });
    expect(op?.kind).toBe("rebase");
    expect(op?.canContinue).toBe(false);
  });

  test("MERGE_HEAD present ⇒ merge, can continue and abort", () => {
    const op = classifyInProgress({
      stateFiles: stateFiles({ mergeHead: "cafebabe" }),
      unmergedPaths: ["b.txt"],
    });
    expect(op).toEqual({
      kind: "merge",
      otherSha: "cafebabe",
      headName: undefined,
      conflictedPaths: ["b.txt"],
      canContinue: true,
      canAbort: true,
      isSequence: false,
      unmergedCount: 1,
    });
  });

  test("CHERRY_PICK_HEAD present ⇒ cherryPick", () => {
    const op = classifyInProgress({
      stateFiles: stateFiles({ cherryPickHead: "c0ffee" }),
      unmergedPaths: [],
    });
    expect(op).toEqual({
      kind: "cherryPick",
      otherSha: "c0ffee",
      headName: undefined,
      conflictedPaths: [],
      canContinue: true,
      canAbort: true,
      isSequence: false,
      unmergedCount: 0,
    });
  });

  test("REVERT_HEAD present ⇒ revert", () => {
    const op = classifyInProgress({
      stateFiles: stateFiles({ revertHead: "f00dcafe" }),
      unmergedPaths: [],
    });
    expect(op).toEqual({
      kind: "revert",
      otherSha: "f00dcafe",
      headName: undefined,
      conflictedPaths: [],
      canContinue: true,
      canAbort: true,
      isSequence: false,
      unmergedCount: 0,
    });
  });

  test("BISECT_LOG present ⇒ bisect, cannot continue, can abort", () => {
    const op = classifyInProgress({
      stateFiles: stateFiles({ bisectLog: true }),
      unmergedPaths: [],
    });
    expect(op).toEqual({
      kind: "bisect",
      otherSha: undefined,
      headName: undefined,
      conflictedPaths: [],
      canContinue: false,
      canAbort: true,
      isSequence: false,
      unmergedCount: 0,
    });
  });

  test("unmerged paths with none of the six state files ⇒ unmergedOnly, cannot continue or abort", () => {
    const op = classifyInProgress({
      stateFiles: stateFiles({}),
      unmergedPaths: ["c.txt", "d.txt"],
    });
    expect(op).toEqual({
      kind: "unmergedOnly",
      otherSha: undefined,
      headName: undefined,
      conflictedPaths: ["c.txt", "d.txt"],
      canContinue: false,
      canAbort: false,
      isSequence: false,
      unmergedCount: 2,
    });
  });

  test("shadowing: rebase state files present alongside cherry-pick-shaped sequencer state ⇒ still rebase", () => {
    // A rebase --onto stopped on a conflict leaves rebase-merge/ present; if the sequencer dir
    // and even a stray CHERRY_PICK_HEAD-like signal were also present, rebase must still win —
    // it is checked first in the precedence table, unconditionally.
    const op = classifyInProgress({
      stateFiles: stateFiles({
        rebaseMergeDir: true,
        rebaseHeadName: "refs/heads/topic",
        rebaseOnto: "abc123",
        sequencerDir: true,
        cherryPickHead: "shouldnotwin",
      }),
      unmergedPaths: [],
    });
    expect(op?.kind).toBe("rebase");
    expect(op?.isSequence).toBe(true);
  });

  test("shadowing: merge/cherryPick/revert all present at once ⇒ merge wins (table order)", () => {
    const op = classifyInProgress({
      stateFiles: stateFiles({
        mergeHead: "merge-sha",
        cherryPickHead: "cherry-sha",
        revertHead: "revert-sha",
      }),
      unmergedPaths: [],
    });
    expect(op?.kind).toBe("merge");
  });

  test("fallthrough: unmergedOnly only applies when none of the five state-file kinds matched", () => {
    // Bare unmerged paths with a bisect log present must classify as bisect, not unmergedOnly —
    // bisect is checked before the fallback.
    const op = classifyInProgress({
      stateFiles: stateFiles({ bisectLog: true }),
      unmergedPaths: ["e.txt"],
    });
    expect(op?.kind).toBe("bisect");
    expect(op?.unmergedCount).toBe(1);
  });
});

describe("canRunOp — the gate (§7.11)", () => {
  test("nothing in progress: every op kind is allowed", () => {
    expect(canRunOp(null, "checkout")).toBe(true);
    expect(canRunOp(null, "revert")).toBe(true);
    expect(canRunOp(null, "branchCreate")).toBe(true);
    expect(canRunOp(null, "tagDelete")).toBe(true);
  });

  const inProgress: InProgressOperation = {
    kind: "merge",
    otherSha: "sha",
    headName: undefined,
    conflictedPaths: ["a"],
    canContinue: true,
    canAbort: true,
    isSequence: false,
    unmergedCount: 1,
  };

  test("in progress: checkout is gated", () => {
    expect(canRunOp(inProgress, "checkout")).toBe(false);
  });

  test("in progress: revert is gated", () => {
    expect(canRunOp(inProgress, "revert")).toBe(false);
  });

  test("in progress: branch/tag creation and deletion are NOT gated (git allows them)", () => {
    expect(canRunOp(inProgress, "branchCreate")).toBe(true);
    expect(canRunOp(inProgress, "branchDelete")).toBe(true);
    expect(canRunOp(inProgress, "branchRename")).toBe(true);
    expect(canRunOp(inProgress, "tagCreate")).toBe(true);
    expect(canRunOp(inProgress, "tagDelete")).toBe(true);
    expect(canRunOp(inProgress, "tagPush")).toBe(true);
    expect(canRunOp(inProgress, "tagDeleteRemote")).toBe(true);
  });

  test("in progress: opContinue/opAbort are not gated", () => {
    expect(canRunOp(inProgress, "opContinue")).toBe(true);
    expect(canRunOp(inProgress, "opAbort")).toBe(true);
  });
});

describe("describeInProgress", () => {
  function op(partial: Partial<InProgressOperation> & Pick<InProgressOperation, "kind">): InProgressOperation {
    return {
      otherSha: undefined,
      headName: undefined,
      conflictedPaths: [],
      canContinue: false,
      canAbort: true,
      isSequence: false,
      unmergedCount: 0,
      ...partial,
    };
  }

  test("merge: label plus truncated sha", () => {
    expect(describeInProgress(op({ kind: "merge", otherSha: "0123456789abcdef" }))).toBe(
      "Merging `0123456`",
    );
  });

  test("cherryPick: label plus truncated sha", () => {
    expect(describeInProgress(op({ kind: "cherryPick", otherSha: "fedcba9876543210" }))).toBe(
      "Cherry-picking `fedcba9`",
    );
  });

  test("revert: label plus truncated sha", () => {
    expect(describeInProgress(op({ kind: "revert", otherSha: "aaaaaaaaaaaa" }))).toBe(
      "Reverting `aaaaaaa`",
    );
  });

  test("bisect: label, no sha to show", () => {
    expect(describeInProgress(op({ kind: "bisect" }))).toBe("Bisecting");
  });

  test("rebase: strips the refs/heads/ prefix from headName", () => {
    expect(
      describeInProgress(op({ kind: "rebase", headName: "refs/heads/feature", otherSha: "sha" })),
    ).toBe("Rebasing feature");
  });

  test("rebase: falls back to bare 'Rebasing' when headName is undefined", () => {
    expect(describeInProgress(op({ kind: "rebase", headName: undefined }))).toBe("Rebasing");
  });

  test("unmergedOnly: fixed sentence, ignores any otherSha", () => {
    expect(describeInProgress(op({ kind: "unmergedOnly" }))).toBe("Unresolved conflict");
  });

  test("a kind with no otherSha omits the trailing sha entirely (no dangling backticks)", () => {
    expect(describeInProgress(op({ kind: "merge", otherSha: undefined }))).toBe("Merging");
  });
});
