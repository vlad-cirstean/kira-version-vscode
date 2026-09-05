import { describe, expect, test } from "bun:test";
import type { InProgressOperation } from "../model/operation.ts";
import { classifyRevert } from "./revert.ts";
import type { RevertParentChoice } from "./types.ts";

function base(overrides: Partial<Parameters<typeof classifyRevert>[0]> = {}) {
  return {
    shas: ["c1"],
    mergeParents: new Map<string, readonly RevertParentChoice[]>(),
    mainline: undefined,
    dirtyPaths: [] as readonly string[],
    inProgress: null,
    detachedHead: false,
    prediction: { kind: "clean" as const },
    ...overrides,
  };
}

describe("classifyRevert — non-merge", () => {
  test("a non-merge commit needs no mainline and is clean when the prediction is clean", () => {
    const result = classifyRevert(base());
    expect(result.mainlineRequired).toEqual([]);
    expect(result.verdict).toBe("clean");
    expect(result.blockers).toEqual([]);
    expect(result.predictedFor).toBe("c1");
  });
});

describe("classifyRevert — merges", () => {
  const twoParents: readonly RevertParentChoice[] = [
    { parentNumber: 1, sha: "p1", subject: "mainline work" },
    { parentNumber: 2, sha: "p2", subject: "feature work" },
  ];

  test("a two-parent merge with no mainline chosen ⇒ mainlineRequired names it, blocked", () => {
    const result = classifyRevert(
      base({ shas: ["m1"], mergeParents: new Map([["m1", twoParents]]) }),
    );
    expect(result.mainlineRequired).toEqual([{ sha: "m1", parents: twoParents }]);
    expect(result.blockers).toEqual(["mainlineRequired"]);
    expect(result.verdict).toBe("blocked");
  });

  test("an octopus merge (3+ parents) offers every parent", () => {
    const octopus: readonly RevertParentChoice[] = [
      { parentNumber: 1, sha: "p1", subject: "s1" },
      { parentNumber: 2, sha: "p2", subject: "s2" },
      { parentNumber: 3, sha: "p3", subject: "s3" },
    ];
    const result = classifyRevert(base({ shas: ["m1"], mergeParents: new Map([["m1", octopus]]) }));
    expect(result.mainlineRequired[0]?.parents).toHaveLength(3);
    expect(result.mainlineRequired[0]?.parents).toEqual(octopus);
  });

  test("a merge with mainline ALREADY supplied ⇒ mainlineRequired is empty, not blocked on it", () => {
    const result = classifyRevert(
      base({ shas: ["m1"], mergeParents: new Map([["m1", twoParents]]), mainline: 1 }),
    );
    expect(result.mainlineRequired).toEqual([]);
    expect(result.blockers).not.toContain("mainlineRequired");
    expect(result.verdict).toBe("clean");
  });
});

describe("classifyRevert — the other two blockers", () => {
  test("a dirty tree blocks", () => {
    const result = classifyRevert(base({ dirtyPaths: ["a.txt"] }));
    expect(result.blockers).toEqual(["dirtyWorktree"]);
    expect(result.verdict).toBe("blocked");
  });

  const inProgress: InProgressOperation = {
    kind: "rebase",
    otherSha: "sha",
    headName: "refs/heads/side",
    conflictedPaths: [],
    canContinue: false,
    canAbort: true,
    isSequence: false,
    unmergedCount: 0,
  };

  test("an in-progress operation blocks", () => {
    const result = classifyRevert(base({ inProgress }));
    expect(result.blockers).toEqual(["inProgressOperation"]);
    expect(result.verdict).toBe("blocked");
  });

  test("blocker order: inProgressOperation, mainlineRequired, dirtyWorktree", () => {
    const twoParents: readonly RevertParentChoice[] = [
      { parentNumber: 1, sha: "p1", subject: "s1" },
      { parentNumber: 2, sha: "p2", subject: "s2" },
    ];
    const result = classifyRevert(
      base({
        shas: ["m1"],
        mergeParents: new Map([["m1", twoParents]]),
        dirtyPaths: ["a.txt"],
        inProgress,
      }),
    );
    expect(result.blockers).toEqual(["inProgressOperation", "mainlineRequired", "dirtyWorktree"]);
  });
});

describe("classifyRevert — detached HEAD is a note, never a blocker", () => {
  test("detachedHead true with everything else clean ⇒ still verdict clean", () => {
    const result = classifyRevert(base({ detachedHead: true }));
    expect(result.verdict).toBe("clean");
    expect(result.blockers).toEqual([]);
    expect(result.detachedHead).toBe(true);
  });
});

describe("classifyRevert — prediction folds into verdict", () => {
  test("a conflicting prediction ⇒ willConflict (when nothing else blocks)", () => {
    const result = classifyRevert(base({ prediction: { kind: "conflicts", paths: ["f.txt"] } }));
    expect(result.verdict).toBe("willConflict");
  });

  test("an unknown prediction does not by itself block or willConflict", () => {
    const result = classifyRevert(base({ prediction: { kind: "unknown", reason: "spawn failed" } }));
    expect(result.verdict).toBe("clean");
  });

  test("blocked takes precedence over a conflicting prediction", () => {
    const result = classifyRevert(
      base({ dirtyPaths: ["a.txt"], prediction: { kind: "conflicts", paths: ["f.txt"] } }),
    );
    expect(result.verdict).toBe("blocked");
  });
});

describe("classifyRevert — multi-sha", () => {
  test("predictedFor is always shas[0], even with multiple shas", () => {
    const result = classifyRevert(base({ shas: ["c1", "c2", "c3"] }));
    expect(result.predictedFor).toBe("c1");
    expect(result.shas).toEqual(["c1", "c2", "c3"]);
  });

  test("an empty shas array ⇒ predictedFor is null", () => {
    const result = classifyRevert(base({ shas: [] }));
    expect(result.predictedFor).toBeNull();
  });
});
