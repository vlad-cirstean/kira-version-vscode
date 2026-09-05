import { describe, expect, test } from "bun:test";
import type { RefRow } from "../../../packages/ipc/src/index.ts";
import {
  buildRefListSections,
  capSection,
  filterRefs,
  formatTrack,
  localNameForRemoteBranch,
  naturalCompare,
  remoteCheckoutLabel,
  remoteCheckoutTarget,
  sortTags,
} from "../../../packages/ui/src/components/refListModel.ts";

function row(overrides: Partial<RefRow> = {}): RefRow {
  return {
    refname: "refs/heads/main",
    kind: "branch",
    shortName: "main",
    objectId: "a".repeat(40),
    peeledObjectId: undefined,
    upstream: undefined,
    track: undefined,
    committerDate: 0,
    isHead: false,
    checkedOutIn: undefined,
    annotation: undefined,
    ...overrides,
  };
}

describe("naturalCompare", () => {
  test("v10 sorts after v9, not before it", () => {
    expect(naturalCompare("v9", "v10")).toBeLessThan(0);
    expect(naturalCompare("v10", "v9")).toBeGreaterThan(0);
  });

  test("v10.1 sorts after v10 (the shorter, shared-prefix name comes first)", () => {
    expect(naturalCompare("v10", "v10.1")).toBeLessThan(0);
  });

  test("equal names compare equal", () => {
    expect(naturalCompare("v1.2.0", "v1.2.0")).toBe(0);
  });

  test("falls back to locale comparison for non-numeric runs", () => {
    expect(naturalCompare("alpha", "beta")).toBeLessThan(0);
  });
});

describe("filterRefs", () => {
  test("case-insensitive substring over shortName", () => {
    const rows = [row({ shortName: "Feature/Login" }), row({ shortName: "main" })];
    expect(filterRefs(rows, "login").map((r) => r.shortName)).toEqual(["Feature/Login"]);
  });

  test("blank filter matches everything", () => {
    const rows = [row({ shortName: "a" }), row({ shortName: "b" })];
    expect(filterRefs(rows, "  ")).toHaveLength(2);
  });
});

describe("capSection", () => {
  test("no cap applied under the limit", () => {
    const rows = [row(), row()];
    expect(capSection(rows, 5)).toEqual({ visible: rows, hiddenCount: 0 });
  });

  test("caps and reports the hidden count", () => {
    const rows = [row({ shortName: "a" }), row({ shortName: "b" }), row({ shortName: "c" })];
    const capped = capSection(rows, 2);
    expect(capped.visible).toHaveLength(2);
    expect(capped.hiddenCount).toBe(1);
  });
});

describe("buildRefListSections", () => {
  test("filters, sorts (name for branches, version-aware for tags) and caps all three sections", () => {
    const sections = buildRefListSections(
      {
        branches: [row({ shortName: "zeta" }), row({ shortName: "alpha" })],
        remoteBranches: [],
        tags: [row({ kind: "tag", shortName: "v10" }), row({ kind: "tag", shortName: "v9" })],
      },
      "",
    );
    expect(sections.branches.visible.map((r) => r.shortName)).toEqual(["alpha", "zeta"]);
    expect(sections.tags.visible.map((r) => r.shortName)).toEqual(["v9", "v10"]);
  });
});

describe("sortTags", () => {
  test("v9, v10, v10.1 sort in version order", () => {
    const rows = [
      row({ kind: "tag", shortName: "v10.1" }),
      row({ kind: "tag", shortName: "v9" }),
      row({ kind: "tag", shortName: "v10" }),
    ];
    expect(sortTags(rows).map((r) => r.shortName)).toEqual(["v9", "v10", "v10.1"]);
  });
});

describe("formatTrack", () => {
  test("no upstream at all: nothing to show", () => {
    expect(formatTrack(undefined)).toBeUndefined();
  });

  test("gone: the upstream branch was deleted", () => {
    expect(formatTrack("gone")).toBe("gone");
  });

  test("up to date: nothing to show even though there is an upstream", () => {
    expect(formatTrack({ ahead: 0, behind: 0 })).toBeUndefined();
  });

  test("ahead only, behind only, and both", () => {
    expect(formatTrack({ ahead: 2, behind: 0 })).toBe("↑2");
    expect(formatTrack({ ahead: 0, behind: 3 })).toBe("↓3");
    expect(formatTrack({ ahead: 2, behind: 3 })).toBe("↑2 ↓3");
  });
});

describe("localNameForRemoteBranch", () => {
  test("strips the leading remote segment only", () => {
    expect(localNameForRemoteBranch("origin/feature/login")).toBe("feature/login");
  });

  test("no slash: returns the name unchanged", () => {
    expect(localNameForRemoteBranch("main")).toBe("main");
  });
});

describe("remoteCheckoutLabel", () => {
  test("an existing local branch of the same name: switch, never silently create", () => {
    const remote = row({ kind: "remoteBranch", shortName: "origin/feature" });
    const branches = [row({ shortName: "feature" })];
    expect(remoteCheckoutLabel(remote, branches)).toBe("Switch to feature");
  });

  test("no local branch of that name: names the tracking branch it will create", () => {
    const remote = row({ kind: "remoteBranch", shortName: "origin/feature" });
    expect(remoteCheckoutLabel(remote, [])).toBe("Create local branch tracking origin/feature");
  });
});

describe("remoteCheckoutTarget", () => {
  test("an existing local branch: the target IS the local branch, not the remote ref", () => {
    const remote = row({ kind: "remoteBranch", shortName: "origin/feature" });
    const branches = [row({ shortName: "feature" })];
    expect(remoteCheckoutTarget(remote, branches)).toBe("feature");
  });

  test("no local branch: the target is the remote ref itself, so the server creates tracking", () => {
    const remote = row({ kind: "remoteBranch", shortName: "origin/feature" });
    expect(remoteCheckoutTarget(remote, [])).toBe("origin/feature");
  });
});
