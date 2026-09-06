import { describe, expect, test } from "bun:test";
import type { DecorationRef } from "../../../packages/core/src/model/commit.ts";
import { badgeSpecFor, planBadges } from "../../../packages/ui/src/components/refBadges.ts";

describe("badgeSpecFor", () => {
  test("a local branch is a pill, local-branch token, its own name, no dot", () => {
    const spec = badgeSpecFor({ kind: "branch", name: "main", isHead: false });
    expect(spec).toEqual({
      shape: "pill",
      icon: "codicon-git-branch",
      colorClass: "kv-badge-local",
      text: "main",
      isCurrentBranch: false,
      dashed: false,
      refKind: "branch",
      refName: "main",
    });
  });

  test("the current local branch (isHead: true) is the same badge plus the dot", () => {
    const spec = badgeSpecFor({ kind: "branch", name: "main", isHead: true });
    expect(spec.isCurrentBranch).toBe(true);
    expect(spec.text).toBe("main");
    expect(spec.colorClass).toBe("kv-badge-local");
  });

  test("a remote branch is a pill on the remote token, distinct from local", () => {
    const spec = badgeSpecFor({ kind: "remoteBranch", name: "origin/main" });
    expect(spec.shape).toBe("pill");
    expect(spec.colorClass).toBe("kv-badge-remote");
    expect(spec.colorClass).not.toBe("kv-badge-local");
    expect(spec.text).toBe("origin/main");
    expect(spec.isCurrentBranch).toBe(false);
    expect(spec.refKind).toBe("remoteBranch");
    expect(spec.refName).toBe("origin/main");
  });

  test("a tag is a square on the tag token — different shape and colour from a branch (§7.9)", () => {
    const spec = badgeSpecFor({ kind: "tag", name: "v1.0.0" });
    expect(spec.shape).toBe("square");
    expect(spec.colorClass).toBe("kv-badge-tag");
    expect(spec.text).toBe("v1.0.0");
  });

  test("a stash is a dashed square on the stash token, labelled 'stash@{N}' (P9 W14: real stack position, not the bare word)", () => {
    const spec = badgeSpecFor({ kind: "stash", index: 0 });
    expect(spec.shape).toBe("square");
    expect(spec.dashed).toBe(true);
    expect(spec.colorClass).toBe("kv-badge-stash");
    expect(spec.text).toBe("stash@{0}");
    expect(spec.isCurrentBranch).toBe(false);
  });

  test("a stash badge names its own index — a deeper stack entry gets its own position, not always 0 (P9 W14)", () => {
    const spec = badgeSpecFor({ kind: "stash", index: 3 });
    expect(spec.text).toBe("stash@{3}");
  });

  test("detached HEAD (no branch alongside it) renders as a local-branch-shaped 'HEAD' badge with the dot", () => {
    const spec = badgeSpecFor({ kind: "head" });
    expect(spec.shape).toBe("pill");
    expect(spec.colorClass).toBe("kv-badge-local");
    expect(spec.text).toBe("HEAD");
    expect(spec.isCurrentBranch).toBe(true);
  });

  test("docs/plans/P7.md W14: only branch/remoteBranch carry refKind/refName — tag/HEAD carry neither", () => {
    expect(badgeSpecFor({ kind: "tag", name: "v1.0.0" }).refKind).toBeUndefined();
    expect(badgeSpecFor({ kind: "tag", name: "v1.0.0" }).refName).toBeUndefined();
    expect(badgeSpecFor({ kind: "head" }).refKind).toBeUndefined();
  });

  test("P9 W14: stash now DOES carry refKind/refName too — CommitGrid's context-menu hit-test needs to tell a stash badge apart from a tag one", () => {
    const spec = badgeSpecFor({ kind: "stash", index: 2 });
    expect(spec.refKind).toBe("stash");
    expect(spec.refName).toBe("stash@{2}");
  });
});

describe("planBadges", () => {
  function refs(...kinds: DecorationRef[]): DecorationRef[] {
    return kinds;
  }

  test("three or fewer decorations all show, no overflow badge", () => {
    const plan = planBadges(
      refs(
        { kind: "branch", name: "main", isHead: true },
        { kind: "tag", name: "v1.0.0" },
        { kind: "stash", index: 0 },
      ),
    );
    expect(plan.visible).toHaveLength(3);
    expect(plan.overflow).toBeNull();
  });

  test("a row with no decorations plans zero visible badges and no overflow", () => {
    const plan = planBadges([]);
    expect(plan.visible).toHaveLength(0);
    expect(plan.overflow).toBeNull();
  });

  test("a row with six decorations renders three plus +3, whose title names all six", () => {
    const decorations = refs(
      { kind: "branch", name: "main", isHead: true },
      { kind: "remoteBranch", name: "origin/main" },
      { kind: "remoteBranch", name: "origin/dev" },
      { kind: "tag", name: "v1.0.0" },
      { kind: "tag", name: "v1.0.1" },
      { kind: "stash", index: 0 },
    );
    const plan = planBadges(decorations);
    expect(plan.visible).toHaveLength(3);
    expect(plan.visible.map((spec) => spec.text)).toEqual(["main", "origin/main", "origin/dev"]);
    expect(plan.overflow).not.toBeNull();
    expect(plan.overflow?.count).toBe(3);
    expect(plan.overflow?.title).toBe("main, origin/main, origin/dev, v1.0.0, v1.0.1, stash@{0}");
  });

  test("exactly four decorations still collapses the fourth into +1", () => {
    const plan = planBadges(
      refs(
        { kind: "branch", name: "a", isHead: false },
        { kind: "branch", name: "b", isHead: false },
        { kind: "branch", name: "c", isHead: false },
        { kind: "branch", name: "d", isHead: false },
      ),
    );
    expect(plan.visible).toHaveLength(3);
    expect(plan.overflow).toEqual({ count: 1, title: "a, b, c, d" });
  });
});
