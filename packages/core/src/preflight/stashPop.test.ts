import { describe, expect, test } from "bun:test";
import type { InProgressOperation } from "../model/operation.ts";
import type { StashEntry } from "../model/stash.ts";
import { classifyStashBranch, classifyStashPop } from "./stashPop.ts";
import type { CheckoutPreflight, DirtyPath, MergeOutcomePrediction } from "./types.ts";

const STASH: StashEntry = {
  index: 0,
  sha: "s".repeat(40),
  baseSha: "b".repeat(40),
  indexSha: "i".repeat(40),
  untrackedSha: undefined,
  message: "On main: s",
  branch: "main",
  timestamp: 1_700_000_000,
  fileCount: 1,
  includedUntracked: false,
};

const CLEAN: MergeOutcomePrediction = { kind: "clean" };
const CONFLICTS: MergeOutcomePrediction = { kind: "conflicts", paths: ["a.txt"] };
const UNKNOWN: MergeOutcomePrediction = { kind: "unknown", reason: "merge-tree exited 128" };

function base(overrides: Partial<Parameters<typeof classifyStashPop>[0]> = {}) {
  return {
    stash: STASH,
    targetSha: "t".repeat(40),
    prediction: CLEAN,
    stashPaths: [] as readonly string[],
    stashUntrackedPaths: [] as readonly string[],
    dirty: [] as readonly DirtyPath[],
    existingPaths: [] as readonly string[],
    inProgress: null,
    ...overrides,
  };
}

describe("classifyStashPop", () => {
  test("clean prediction, no blockers ⇒ clean", () => {
    const result = classifyStashPop(base());
    expect(result.verdict).toBe("clean");
    expect(result.blockers).toEqual([]);
    expect(result.prediction).toEqual(CLEAN);
  });

  test("conflicting prediction, no blockers ⇒ willConflict", () => {
    const result = classifyStashPop(base({ prediction: CONFLICTS }));
    expect(result.verdict).toBe("willConflict");
  });

  test("unknown prediction is never clean — willConflict, stating the reason via the prediction itself", () => {
    const result = classifyStashPop(base({ prediction: UNKNOWN }));
    expect(result.verdict).toBe("willConflict");
    expect(result.prediction).toEqual(UNKNOWN);
  });

  test("untrackedCollision alone: an untracked stash path exists in the worktree", () => {
    const result = classifyStashPop(
      base({
        stashUntrackedPaths: ["u.txt", "other.txt"],
        existingPaths: ["u.txt"],
      }),
    );
    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toEqual([{ kind: "untrackedCollision", paths: ["u.txt"] }]);
  });

  test("a stash-untracked path that merely happens to also be `dirty` is still only reachable via existingPaths, not `dirty` membership (probe 3)", () => {
    // Deliberately do NOT populate `dirty` with the untracked path — the classifier must not
    // silently fall back to it; `existingPaths` is the only test that matters here.
    const result = classifyStashPop(
      base({
        stashUntrackedPaths: ["u.txt"],
        existingPaths: [],
        dirty: [{ path: "u.txt", tracked: false }],
      }),
    );
    expect(result.blockers).toEqual([]);
    expect(result.verdict).toBe("clean");
  });

  test("localChangesWouldBeOverwritten alone: a tracked dirty path overlaps the stash's own changed paths", () => {
    const result = classifyStashPop(
      base({
        stashPaths: ["a.txt", "b.txt"],
        dirty: [{ path: "a.txt", tracked: true }],
      }),
    );
    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toEqual([
      { kind: "localChangesWouldBeOverwritten", paths: ["a.txt"] },
    ]);
  });

  test("an untracked dirty path overlapping stashPaths is NOT localChangesWouldBeOverwritten (tracked-only)", () => {
    const result = classifyStashPop(
      base({
        stashPaths: ["a.txt"],
        dirty: [{ path: "a.txt", tracked: false }],
      }),
    );
    expect(result.blockers).toEqual([]);
  });

  test("both blockers together, ordered untrackedCollision before localChangesWouldBeOverwritten", () => {
    const result = classifyStashPop(
      base({
        stashPaths: ["a.txt"],
        stashUntrackedPaths: ["u.txt"],
        existingPaths: ["u.txt"],
        dirty: [{ path: "a.txt", tracked: true }],
      }),
    );
    expect(result.blockers).toEqual([
      { kind: "untrackedCollision", paths: ["u.txt"] },
      { kind: "localChangesWouldBeOverwritten", paths: ["a.txt"] },
    ]);
  });

  test("inProgressOperation is always first, ahead of both stash-pop blockers", () => {
    const inProgress: InProgressOperation = {
      kind: "merge",
      otherSha: "x".repeat(40),
      headName: undefined,
      conflictedPaths: [],
      canContinue: true,
      canAbort: true,
      isSequence: false,
      unmergedCount: 0,
    };
    const result = classifyStashPop(
      base({
        inProgress,
        stashPaths: ["a.txt"],
        dirty: [{ path: "a.txt", tracked: true }],
      }),
    );
    expect(result.blockers[0]).toEqual({ kind: "inProgressOperation", operation: inProgress });
    expect(result.verdict).toBe("blocked");
  });

  test("a blocker present alongside a clean prediction: verdict is blocked, the clean prediction is still reported as-is", () => {
    const result = classifyStashPop(
      base({
        prediction: CLEAN,
        stashPaths: ["a.txt"],
        dirty: [{ path: "a.txt", tracked: true }],
      }),
    );
    expect(result.verdict).toBe("blocked");
    expect(result.prediction).toEqual(CLEAN);
  });

  test("stashSha/stashIndex/targetSha pass through verbatim", () => {
    const result = classifyStashPop(base());
    expect(result.stashSha).toBe(STASH.sha);
    expect(result.stashIndex).toBe(STASH.index);
    expect(result.targetSha).toBe("t".repeat(40));
  });
});

const CLEAN_CHECKOUT: CheckoutPreflight = {
  target: { kind: "branch", name: "topic" },
  detaches: false,
  createsTracking: undefined,
  carried: [],
  blockers: [],
  verdict: "clean",
  routes: [],
};

const BLOCKED_CHECKOUT: CheckoutPreflight = {
  ...CLEAN_CHECKOUT,
  blockers: [{ kind: "blockedByTracked", paths: ["a.txt"] }],
  verdict: "blocked",
};

describe("classifyStashBranch", () => {
  test("valid, non-existing name, clean checkout ⇒ clean", () => {
    const result = classifyStashBranch({
      name: "recovered",
      existingBranchNames: new Set(),
      checkout: CLEAN_CHECKOUT,
    });
    expect(result.verdict).toBe("clean");
    expect(result.name).toEqual({ valid: true, error: undefined, exists: false });
  });

  test("invalid name (reserved '@{' shorthand) ⇒ invalidName, checkout passed through untouched", () => {
    const result = classifyStashBranch({
      name: "bad@{0}",
      existingBranchNames: new Set(),
      checkout: CLEAN_CHECKOUT,
    });
    expect(result.verdict).toBe("invalidName");
    expect(result.name.valid).toBe(false);
    expect(result.checkout).toBe(CLEAN_CHECKOUT);
  });

  test("an already-existing branch name ⇒ invalidName with its own error, distinct from a malformed name", () => {
    const result = classifyStashBranch({
      name: "topic",
      existingBranchNames: new Set(["topic"]),
      checkout: CLEAN_CHECKOUT,
    });
    expect(result.verdict).toBe("invalidName");
    expect(result.name).toEqual({
      valid: true,
      error: "A branch with this name already exists.",
      exists: true,
    });
  });

  test("valid name but the nested checkout preflight is blocked ⇒ blocked, non-atomic on failure per OQ6 (no rollback here — that is ops.ts's job, not the classifier's)", () => {
    const result = classifyStashBranch({
      name: "recovered",
      existingBranchNames: new Set(),
      checkout: BLOCKED_CHECKOUT,
    });
    expect(result.verdict).toBe("blocked");
    expect(result.checkout).toBe(BLOCKED_CHECKOUT);
  });

  test("gets no merge-tree prediction of its own — StashBranchPreflight has no `prediction` field at all (probe 11)", () => {
    const result = classifyStashBranch({
      name: "recovered",
      existingBranchNames: new Set(),
      checkout: CLEAN_CHECKOUT,
    });
    expect("prediction" in result).toBe(false);
  });
});
