import { describe, expect, test } from "bun:test";
import type { InProgressOperation, ResetMode } from "../model/operation.ts";
import { classifyReset } from "./reset.ts";

function base(overrides: Partial<Parameters<typeof classifyReset>[0]> = {}) {
  return {
    target: "abc1234",
    targetSubject: "some commit",
    mode: "mixed" as ResetMode,
    currentHead: "def5678",
    branch: "main",
    leaving: 0,
    gaining: 0,
    leavingCommits: [] as readonly { readonly sha: string; readonly subject: string }[],
    leavingTruncated: false,
    dirty: { staged: [], unstaged: [], untracked: [] },
    stagedNew: [] as readonly string[],
    inProgress: null,
    targetResolves: true,
    ...overrides,
  };
}

describe("classifyReset — destroys, probe 1's matrix", () => {
  test("soft never destroys, regardless of how dirty the tree is", () => {
    const result = classifyReset(
      base({
        mode: "soft",
        dirty: { staged: ["a.txt"], unstaged: ["b.txt"], untracked: ["c.txt"] },
        stagedNew: ["d.txt"],
      }),
    );
    expect(result.destroys).toEqual([]);
    expect(result.requiresTypedConfirmation).toBe(false);
    expect(result.routes).toEqual([]);
    expect(result.verdict).toBe("clean");
  });

  test("mixed never destroys either — the difference lands as unstaged changes, not loss", () => {
    const result = classifyReset(
      base({
        mode: "mixed",
        dirty: { staged: ["a.txt"], unstaged: ["b.txt"], untracked: ["c.txt"] },
        stagedNew: ["d.txt"],
      }),
    );
    expect(result.destroys).toEqual([]);
    expect(result.verdict).toBe("clean");
  });

  test("hard destroys staged and unstaged tracked changes", () => {
    const result = classifyReset(
      base({
        mode: "hard",
        dirty: { staged: ["a.txt"], unstaged: ["b.txt"], untracked: [] },
      }),
    );
    expect([...result.destroys].sort()).toEqual(["a.txt", "b.txt"]);
    expect(result.requiresTypedConfirmation).toBe(true);
    expect(result.routes).toEqual(["stashFirst"]);
    expect(result.verdict).toBe("destructive");
  });

  test("hard destroys a staged NEW file too — probe 1's own 'looks untracked but isn't' case", () => {
    const result = classifyReset(
      base({
        mode: "hard",
        dirty: { staged: [], unstaged: [], untracked: [] },
        stagedNew: ["new.txt"],
      }),
    );
    expect(result.destroys).toEqual(["new.txt"]);
    expect(result.requiresTypedConfirmation).toBe(true);
  });

  test("hard leaves untracked and ignored files alone — they never enter `destroys`", () => {
    const result = classifyReset(
      base({
        mode: "hard",
        dirty: { staged: [], unstaged: [], untracked: ["scratch.txt", "build/out.js"] },
      }),
    );
    expect(result.destroys).toEqual([]);
    expect(result.requiresTypedConfirmation).toBe(false);
    expect(result.routes).toEqual([]);
    expect(result.verdict).toBe("clean"); // nothing at risk ⇒ not "destructive"
  });

  test("hard with nothing at all to destroy has no typed-confirmation route, per hard part 2", () => {
    const result = classifyReset(base({ mode: "hard" }));
    expect(result.destroys).toEqual([]);
    expect(result.requiresTypedConfirmation).toBe(false);
  });

  test("hard de-duplicates a path that is both staged and (somehow) also staged-new", () => {
    const result = classifyReset(
      base({
        mode: "hard",
        dirty: { staged: ["a.txt"], unstaged: [], untracked: [] },
        stagedNew: ["a.txt"],
      }),
    );
    expect(result.destroys).toEqual(["a.txt"]);
  });
});

describe("classifyReset — leaving/gaining, probe 4", () => {
  test("leaving === 0 ⇒ the commit list is forced empty even if the caller passed one", () => {
    const result = classifyReset(
      base({ leaving: 0, leavingCommits: [{ sha: "x", subject: "should not appear" }] }),
    );
    expect(result.leavingCommits).toEqual([]);
    expect(result.leavingTruncated).toBe(false);
  });

  test("leaving > 0 passes the commit list and truncation flag through", () => {
    const result = classifyReset(
      base({
        leaving: 2,
        leavingCommits: [
          { sha: "c1", subject: "one" },
          { sha: "c2", subject: "two" },
        ],
        leavingTruncated: true,
      }),
    );
    expect(result.leavingCommits).toHaveLength(2);
    expect(result.leavingTruncated).toBe(true);
  });

  test("a diverged target: both leaving and gaining are non-zero, and neither is silently dropped", () => {
    const result = classifyReset(base({ leaving: 2, gaining: 2 }));
    expect(result.leaving).toBe(2);
    expect(result.gaining).toBe(2);
  });
});

describe("classifyReset — blockers, probe 3", () => {
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

  test("an in-progress operation blocks, even against an otherwise clean soft reset", () => {
    const result = classifyReset(base({ mode: "soft", inProgress }));
    expect(result.blockers).toEqual(["inProgressOperation"]);
    expect(result.verdict).toBe("blocked");
  });

  test("a target that does not resolve blocks", () => {
    const result = classifyReset(base({ targetResolves: false }));
    expect(result.blockers).toEqual(["unknownTarget"]);
    expect(result.verdict).toBe("blocked");
  });

  test("blocker order: inProgressOperation before unknownTarget", () => {
    const result = classifyReset(base({ inProgress, targetResolves: false }));
    expect(result.blockers).toEqual(["inProgressOperation", "unknownTarget"]);
  });

  test("blocked takes precedence over destructive", () => {
    const result = classifyReset(
      base({
        mode: "hard",
        dirty: { staged: ["a.txt"], unstaged: [], untracked: [] },
        inProgress,
      }),
    );
    expect(result.verdict).toBe("blocked");
    expect(result.destroys).toEqual(["a.txt"]); // still computed — the dialog needs it either way
  });
});

describe("classifyReset — detached HEAD, hard part 8", () => {
  test("branch: null carries through untouched — the caller's own signal for 'HEAD only'", () => {
    const result = classifyReset(base({ branch: null }));
    expect(result.branch).toBeNull();
  });
});
