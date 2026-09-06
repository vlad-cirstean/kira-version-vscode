import { describe, expect, test } from "bun:test";
import type { InProgressOperation } from "../model/operation.ts";
import { classifyCherryPick } from "./cherryPick.ts";
import type { RevertParentChoice } from "./types.ts";

function base(overrides: Partial<Parameters<typeof classifyCherryPick>[0]> = {}) {
  return {
    sha: "c1",
    subject: "the change to pick",
    mergeParents: [] as readonly RevertParentChoice[],
    mainline: undefined,
    commitPaths: { touched: ["a.txt"], added: ["n.txt"] },
    dirty: { staged: [], unstaged: [], untracked: [] },
    prediction: { kind: "clean" as const },
    alreadyApplied: false,
    inProgress: null,
    detachedHead: false,
    ...overrides,
  };
}

describe("classifyCherryPick — probe 7's dirty-tree matrix", () => {
  test("A: unrelated unstaged dirt is tolerated — no blocker, clean verdict", () => {
    const result = classifyCherryPick(
      base({ dirty: { staged: [], unstaged: ["b.txt"], untracked: [] } }),
    );
    expect(result.blockers).toEqual([]);
    expect(result.verdict).toBe("clean");
  });

  test("B: ANY staged change blocks, even to a file the pick never touches", () => {
    const result = classifyCherryPick(
      base({ dirty: { staged: ["b.txt"], unstaged: [], untracked: [] } }),
    );
    expect(result.blockers).toEqual([{ kind: "stagedChanges", paths: ["b.txt"] }]);
    expect(result.verdict).toBe("blocked");
  });

  test("C: unstaged dirt on a path the pick touches blocks as localChangesWouldBeOverwritten", () => {
    const result = classifyCherryPick(
      base({ dirty: { staged: [], unstaged: ["a.txt"], untracked: [] } }),
    );
    expect(result.blockers).toEqual([{ kind: "localChangesWouldBeOverwritten", paths: ["a.txt"] }]);
    expect(result.verdict).toBe("blocked");
  });

  test("D: staged dirt on a touched path blocks as stagedChanges, same as B — relation is irrelevant", () => {
    const result = classifyCherryPick(
      base({ dirty: { staged: ["a.txt"], unstaged: [], untracked: [] } }),
    );
    expect(result.blockers).toEqual([{ kind: "stagedChanges", paths: ["a.txt"] }]);
  });

  test("E: an untracked file in the way of one the pick adds blocks as untrackedWouldBeOverwritten", () => {
    const result = classifyCherryPick(
      base({ dirty: { staged: [], unstaged: [], untracked: ["n.txt"] } }),
    );
    expect(result.blockers).toEqual([{ kind: "untrackedWouldBeOverwritten", paths: ["n.txt"] }]);
    expect(result.verdict).toBe("blocked");
  });

  test("an untracked file NOT among the pick's added paths is not a blocker", () => {
    const result = classifyCherryPick(
      base({ dirty: { staged: [], unstaged: [], untracked: ["unrelated.txt"] } }),
    );
    expect(result.blockers).toEqual([]);
  });
});

describe("classifyCherryPick — blocker ordering", () => {
  const inProgress: InProgressOperation = {
    kind: "merge",
    otherSha: "sha",
    headName: undefined,
    conflictedPaths: [],
    canContinue: true,
    canAbort: true,
    isSequence: false,
    unmergedCount: 0,
    canSkip: false,
  };
  const twoParents: readonly RevertParentChoice[] = [
    { parentNumber: 1, sha: "p1", subject: "mainline work" },
    { parentNumber: 2, sha: "p2", subject: "feature work" },
  ];

  test("every possible blocker at once, in the documented order", () => {
    const result = classifyCherryPick(
      base({
        mergeParents: twoParents,
        dirty: { staged: ["s.txt"], unstaged: ["a.txt"], untracked: ["n.txt"] },
        inProgress,
      }),
    );
    expect(result.blockers.map((b) => b.kind)).toEqual([
      "inProgressOperation",
      "mainlineRequired",
      "stagedChanges",
      "untrackedWouldBeOverwritten",
      "localChangesWouldBeOverwritten",
    ]);
  });

  test("an in-progress operation blocks alone, even an otherwise clean pick", () => {
    const result = classifyCherryPick(base({ inProgress }));
    expect(result.blockers).toEqual([{ kind: "inProgressOperation", operation: inProgress }]);
    expect(result.verdict).toBe("blocked");
  });
});

describe("classifyCherryPick — mainline, probe 8", () => {
  const twoParents: readonly RevertParentChoice[] = [
    { parentNumber: 1, sha: "p1", subject: "mainline work" },
    { parentNumber: 2, sha: "p2", subject: "feature work" },
  ];

  test("a merge commit with no mainline chosen ⇒ mainlineRequired names every parent, blocked", () => {
    const result = classifyCherryPick(base({ mergeParents: twoParents }));
    expect(result.mainlineRequired).toEqual(twoParents);
    expect(result.blockers).toEqual([{ kind: "mainlineRequired", parents: twoParents }]);
    expect(result.verdict).toBe("blocked");
  });

  test("a merge commit with mainline already supplied ⇒ mainlineRequired is empty, not blocked on it", () => {
    const result = classifyCherryPick(base({ mergeParents: twoParents, mainline: 1 }));
    expect(result.mainlineRequired).toEqual([]);
    expect(result.blockers).toEqual([]);
  });

  test("a non-merge commit never requires a mainline, regardless of the mainline field", () => {
    const result = classifyCherryPick(base({ mergeParents: [], mainline: undefined }));
    expect(result.mainlineRequired).toEqual([]);
  });
});

describe("classifyCherryPick — alreadyApplied is advisory, never a blocker or verdict change", () => {
  test("alreadyApplied true with everything else clean ⇒ still verdict clean, no blocker", () => {
    const result = classifyCherryPick(base({ alreadyApplied: true }));
    expect(result.verdict).toBe("clean");
    expect(result.blockers).toEqual([]);
    expect(result.alreadyApplied).toBe(true);
  });
});

describe("classifyCherryPick — prediction folds into verdict", () => {
  test("a conflicting prediction ⇒ willConflict, when nothing else blocks", () => {
    const result = classifyCherryPick(
      base({ prediction: { kind: "conflicts", paths: ["a.txt"] } }),
    );
    expect(result.verdict).toBe("willConflict");
  });

  test("an unknown prediction does not by itself block or willConflict", () => {
    const result = classifyCherryPick(
      base({ prediction: { kind: "unknown", reason: "spawn failed" } }),
    );
    expect(result.verdict).toBe("clean");
  });

  test("blocked takes precedence over a conflicting prediction", () => {
    const result = classifyCherryPick(
      base({
        dirty: { staged: ["s.txt"], unstaged: [], untracked: [] },
        prediction: { kind: "conflicts", paths: ["a.txt"] },
      }),
    );
    expect(result.verdict).toBe("blocked");
  });
});

describe("classifyCherryPick — detached HEAD is a note, never a blocker", () => {
  test("detachedHead true with everything else clean ⇒ still verdict clean", () => {
    const result = classifyCherryPick(base({ detachedHead: true }));
    expect(result.verdict).toBe("clean");
    expect(result.blockers).toEqual([]);
    expect(result.detachedHead).toBe(true);
  });
});
