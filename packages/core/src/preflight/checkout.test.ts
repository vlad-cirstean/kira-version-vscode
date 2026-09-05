import { describe, expect, test } from "bun:test";
import type { InProgressOperation } from "../model/operation.ts";
import { classifyCheckout } from "./checkout.ts";
import type { DirtyPath } from "./types.ts";

function base(overrides: Partial<Parameters<typeof classifyCheckout>[0]> = {}) {
  return {
    target: { kind: "branch" as const, name: "topic" },
    dirty: [] as readonly DirtyPath[],
    rewritten: [] as readonly string[],
    targetTreePaths: null,
    inProgress: null,
    checkedOutIn: undefined,
    stashAvailable: false,
    ...overrides,
  };
}

const T = ["added-on-topic.txt", "shared.txt"];

describe("classifyCheckout — probe P1's six cases", () => {
  test("case 1: modify untouched.txt (∉ T) ⇒ cleanCarry, edit carried", () => {
    const result = classifyCheckout(
      base({ rewritten: T, dirty: [{ path: "untouched.txt", tracked: true }] }),
    );
    expect(result.verdict).toBe("cleanCarry");
    expect(result.carried).toEqual(["untouched.txt"]);
    expect(result.blockers).toEqual([]);
  });

  test("case 2: modify shared.txt (∈ T, tracked) ⇒ blockedByTracked", () => {
    const result = classifyCheckout(
      base({ rewritten: T, dirty: [{ path: "shared.txt", tracked: true }] }),
    );
    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toEqual([{ kind: "blockedByTracked", paths: ["shared.txt"] }]);
  });

  test("case 2b: a STAGED change to shared.txt classifies identically — staged and unstaged are one set", () => {
    // DirtyPath carries no staged/unstaged distinction by design: status collapses both into one
    // `tracked: true` dirty path, exactly matching git's own behaviour (probe P1/2b).
    const result = classifyCheckout(
      base({ rewritten: T, dirty: [{ path: "shared.txt", tracked: true }] }),
    );
    expect(result.blockers).toEqual([{ kind: "blockedByTracked", paths: ["shared.txt"] }]);
  });

  test("case 2c: byte-identical content is STILL blocked — the classifier has no content field to check", () => {
    // DirtyPath is (path, tracked) only; there is no way for this classifier to special-case
    // identical content even if it wanted to — which is the point (probe P1/2c rules out a
    // content-aware predictor as *wrong*, not merely unimplemented).
    const result = classifyCheckout(
      base({ rewritten: T, dirty: [{ path: "shared.txt", tracked: true }] }),
    );
    expect(result.verdict).toBe("blocked");
  });

  test("case 3: untracked added-on-topic.txt (∈ T, added by target) ⇒ blockedByUntracked", () => {
    const result = classifyCheckout(
      base({ rewritten: T, dirty: [{ path: "added-on-topic.txt", tracked: false }] }),
    );
    expect(result.verdict).toBe("blocked");
    expect(result.blockers).toEqual([
      { kind: "blockedByUntracked", paths: ["added-on-topic.txt"] },
    ]);
  });

  test("case 3b: untracked scratch.txt (∉ T) ⇒ survives, cleanCarry", () => {
    const result = classifyCheckout(
      base({ rewritten: T, dirty: [{ path: "scratch.txt", tracked: false }] }),
    );
    expect(result.verdict).toBe("cleanCarry");
    expect(result.carried).toEqual(["scratch.txt"]);
    expect(result.blockers).toEqual([]);
  });
});

describe("classifyCheckout — clean and disjoint trees", () => {
  test("a fully clean tree ⇒ verdict clean, no carried paths, no blockers", () => {
    const result = classifyCheckout(base({ rewritten: T }));
    expect(result.verdict).toBe("clean");
    expect(result.carried).toEqual([]);
    expect(result.blockers).toEqual([]);
  });

  test("a dirty-but-disjoint tree with both tracked and untracked members ⇒ cleanCarry, both carried", () => {
    const result = classifyCheckout(
      base({
        rewritten: T,
        dirty: [
          { path: "untouched.txt", tracked: true },
          { path: "scratch.txt", tracked: false },
        ],
      }),
    );
    expect(result.verdict).toBe("cleanCarry");
    expect(result.carried).toEqual(["untouched.txt", "scratch.txt"]);
    expect(result.blockers).toEqual([]);
  });

  test("empty T (checkout of the current HEAD) ⇒ every dirty path carries, never blocked", () => {
    const result = classifyCheckout(
      base({
        rewritten: [],
        dirty: [
          { path: "a.txt", tracked: true },
          { path: "b.txt", tracked: false },
        ],
      }),
    );
    expect(result.verdict).toBe("cleanCarry");
    expect(result.blockers).toEqual([]);
    expect(result.carried).toEqual(["a.txt", "b.txt"]);
  });
});

describe("classifyCheckout — both blocker kinds at once", () => {
  test("tracked and untracked both intersect T ⇒ both blockers, untracked first, no discard route", () => {
    const result = classifyCheckout(
      base({
        rewritten: T,
        dirty: [
          { path: "shared.txt", tracked: true },
          { path: "added-on-topic.txt", tracked: false },
        ],
      }),
    );
    expect(result.blockers).toEqual([
      { kind: "blockedByUntracked", paths: ["added-on-topic.txt"] },
      { kind: "blockedByTracked", paths: ["shared.txt"] },
    ]);
    expect(result.routes).toEqual([]);
  });
});

const inProgress: InProgressOperation = {
  kind: "merge",
  otherSha: "abc",
  headName: undefined,
  conflictedPaths: [],
  canContinue: true,
  canAbort: true,
  isSequence: false,
  unmergedCount: 0,
};

describe("classifyCheckout — the three non-path blockers, alone and combined, and blocker ORDER", () => {
  test("inProgressOperation alone", () => {
    const result = classifyCheckout(base({ inProgress }));
    expect(result.blockers).toEqual([{ kind: "inProgressOperation", operation: inProgress }]);
    expect(result.verdict).toBe("blocked");
  });

  test("worktreeConflict alone", () => {
    const result = classifyCheckout(base({ checkedOutIn: "/tmp/other-wt" }));
    expect(result.blockers).toEqual([
      { kind: "worktreeConflict", branch: "topic", worktreePath: "/tmp/other-wt" },
    ]);
  });

  test("inProgressOperation and worktreeConflict together: inProgress first", () => {
    const result = classifyCheckout(base({ inProgress, checkedOutIn: "/tmp/other-wt" }));
    expect(result.blockers).toEqual([
      { kind: "inProgressOperation", operation: inProgress },
      { kind: "worktreeConflict", branch: "topic", worktreePath: "/tmp/other-wt" },
    ]);
  });

  test("all four blockers at once: inProgress, worktreeConflict, blockedByUntracked, blockedByTracked, in that order", () => {
    const result = classifyCheckout(
      base({
        inProgress,
        checkedOutIn: "/tmp/other-wt",
        rewritten: T,
        dirty: [
          { path: "shared.txt", tracked: true },
          { path: "added-on-topic.txt", tracked: false },
        ],
      }),
    );
    expect(result.blockers.map((b) => b.kind)).toEqual([
      "inProgressOperation",
      "worktreeConflict",
      "blockedByUntracked",
      "blockedByTracked",
    ]);
    // An in-progress repository with dirty files must not lead with "commit or stash": the
    // first blocker (the dialog's headline) is inProgressOperation.
    expect(result.blockers[0]?.kind).toBe("inProgressOperation");
  });
});

describe("classifyCheckout — targets", () => {
  test("a sha target always detaches", () => {
    const result = classifyCheckout(base({ target: { kind: "sha", name: "deadbeef" } }));
    expect(result.detaches).toBe(true);
    expect(result.createsTracking).toBeUndefined();
  });

  test("a tag target always detaches (§7.9)", () => {
    const result = classifyCheckout(base({ target: { kind: "tag", name: "v1.0" } }));
    expect(result.detaches).toBe(true);
  });

  test("a branch target does not detach", () => {
    const result = classifyCheckout(base({ target: { kind: "branch", name: "main" } }));
    expect(result.detaches).toBe(false);
    expect(result.createsTracking).toBeUndefined();
  });

  test("a remote-branch target WITH a local counterpart: caller passes kind 'branch', no tracking creation", () => {
    // The decision of whether a local counterpart exists is made by the caller before invoking
    // the classifier (RepoService / ui state) — see checkout.ts's header comment.
    const result = classifyCheckout(base({ target: { kind: "branch", name: "topic" } }));
    expect(result.createsTracking).toBeUndefined();
  });

  test("a remote-branch target WITHOUT a local counterpart: kind 'remoteBranch' ⇒ createsTracking, no silent detach", () => {
    const result = classifyCheckout(
      base({ target: { kind: "remoteBranch", name: "origin/topic" } }),
    );
    expect(result.detaches).toBe(false);
    expect(result.createsTracking).toEqual({ branch: "topic", upstream: "origin/topic" });
  });
});

describe("classifyCheckout — stashAvailable only changes routes", () => {
  test("stashAvailable=false, blockedByTracked alone ⇒ routes = ['discard']", () => {
    const result = classifyCheckout(
      base({ rewritten: T, dirty: [{ path: "shared.txt", tracked: true }], stashAvailable: false }),
    );
    expect(result.routes).toEqual(["discard"]);
  });

  test("stashAvailable=true, blockedByTracked alone ⇒ routes = ['discard', 'stashAndCarry']", () => {
    const result = classifyCheckout(
      base({ rewritten: T, dirty: [{ path: "shared.txt", tracked: true }], stashAvailable: true }),
    );
    expect(result.routes).toEqual(["discard", "stashAndCarry"]);
  });

  test("stashAvailable=true but blockedByUntracked present ⇒ routes still empty (discard cannot help)", () => {
    const result = classifyCheckout(
      base({
        rewritten: T,
        dirty: [{ path: "added-on-topic.txt", tracked: false }],
        stashAvailable: true,
      }),
    );
    expect(result.routes).toEqual([]);
  });

  test("no blockedByTracked ⇒ routes empty regardless of stashAvailable", () => {
    const result = classifyCheckout(base({ stashAvailable: true }));
    expect(result.routes).toEqual([]);
  });
});
