import { describe, expect, test } from "bun:test";
import type { InProgressOperation } from "../../../packages/ipc/src/index.ts";
import {
  buildRefMenu,
  buildRowMenu,
  remoteNamesFrom,
} from "../../../packages/ui/src/components/rowMenuModel.ts";

function inProgress(overrides: Partial<InProgressOperation> = {}): InProgressOperation {
  return {
    kind: "merge",
    otherSha: "a".repeat(40),
    headName: undefined,
    conflictedPaths: [],
    canContinue: true,
    canAbort: true,
    isSequence: false,
    unmergedCount: 0,
    ...overrides,
  };
}

function findItem(sections: ReturnType<typeof buildRowMenu>, id: string) {
  for (const section of sections) {
    const item = section.items.find((i) => i.id === id);
    if (item) return item;
  }
  return undefined;
}

describe("buildRowMenu", () => {
  test("a commit with no in-progress op: checkout/create/revert all enabled", () => {
    const sections = buildRowMenu({
      sha: "a".repeat(40),
      decorations: [],
      inProgress: null,
      clipboardEnabled: true,
    });
    expect(findItem(sections, "checkoutDetached")?.disabled).toBe(false);
    expect(findItem(sections, "createBranchHere")?.disabled).toBe(false);
    expect(findItem(sections, "createTagHere")?.disabled).toBe(false);
    expect(findItem(sections, "revertThisCommit")?.disabled).toBe(false);
  });

  test("cherry-pick and reset are absent, not disabled", () => {
    const sections = buildRowMenu({
      sha: "a".repeat(40),
      decorations: [],
      inProgress: null,
      clipboardEnabled: true,
    });
    expect(findItem(sections, "cherryPick")).toBeUndefined();
    expect(findItem(sections, "resetToHere")).toBeUndefined();
  });

  test("copy actions are absent (not disabled) when clipboard is unavailable", () => {
    const sections = buildRowMenu({
      sha: "a".repeat(40),
      decorations: [],
      inProgress: null,
      clipboardEnabled: false,
    });
    expect(findItem(sections, "copySha")).toBeUndefined();
    expect(findItem(sections, "copyMessage")).toBeUndefined();
  });

  test("during an in-progress op: checkout/revert disabled with the banner's own reason, create not gated", () => {
    const sections = buildRowMenu({
      sha: "a".repeat(40),
      decorations: [],
      inProgress: inProgress({ kind: "rebase", headName: "refs/heads/side" }),
      clipboardEnabled: true,
    });
    expect(findItem(sections, "checkoutDetached")).toEqual({
      id: "checkoutDetached",
      label: "Checkout this commit (detached HEAD)",
      disabled: true,
      disabledReason: "Rebasing side",
    });
    expect(findItem(sections, "revertThisCommit")?.disabled).toBe(true);
    expect(findItem(sections, "createBranchHere")?.disabled).toBe(false);
    expect(findItem(sections, "createTagHere")?.disabled).toBe(false);
  });

  test("with a branch/tag decoration present, the menu shape is unaffected (decorations do not add items)", () => {
    const sections = buildRowMenu({
      sha: "a".repeat(40),
      decorations: [{ kind: "branch", name: "main", isHead: true }],
      inProgress: null,
      clipboardEnabled: true,
    });
    expect(sections.flatMap((s) => s.items.map((i) => i.id))).toEqual([
      "checkoutDetached",
      "createBranchHere",
      "createTagHere",
      "revertThisCommit",
      "copySha",
      "copyMessage",
    ]);
  });
});

describe("buildRefMenu", () => {
  test("a branch: checkout/rename/delete, all enabled with nothing in progress", () => {
    const sections = buildRefMenu({
      kind: "branch",
      shortName: "feature",
      isHead: false,
      knownRemotes: [],
      inProgress: null,
    });
    const ids = sections.flatMap((s) => s.items.map((i) => i.id));
    expect(ids).toEqual(["checkoutRef", "renameRef", "deleteRef"]);
    expect(sections[0]?.items.every((i) => !i.disabled)).toBe(true);
  });

  test("the current branch: delete is disabled with its own reason, not the banner's", () => {
    const sections = buildRefMenu({
      kind: "branch",
      shortName: "main",
      isHead: true,
      knownRemotes: [],
      inProgress: null,
    });
    const deleteItem = sections.flatMap((s) => s.items).find((i) => i.id === "deleteRef");
    expect(deleteItem).toEqual({
      id: "deleteRef",
      label: "Delete branch",
      disabled: true,
      disabledReason: "This is the current branch.",
    });
  });

  test("a remote branch: checkout only, no rename/delete", () => {
    const sections = buildRefMenu({
      kind: "remoteBranch",
      shortName: "origin/feature",
      isHead: false,
      knownRemotes: [],
      inProgress: null,
    });
    expect(sections.flatMap((s) => s.items.map((i) => i.id))).toEqual(["checkoutRef"]);
  });

  test("a tag with no known remotes: checkout/delete only", () => {
    const sections = buildRefMenu({
      kind: "tag",
      shortName: "v1.0",
      isHead: false,
      knownRemotes: [],
      inProgress: null,
    });
    expect(sections.flatMap((s) => s.items.map((i) => i.id))).toEqual(["checkoutRef", "deleteRef"]);
  });

  test("a tag known on a remote: gains push/delete-on-remote entries per remote", () => {
    const sections = buildRefMenu({
      kind: "tag",
      shortName: "v1.0",
      isHead: false,
      knownRemotes: ["origin"],
      inProgress: null,
    });
    expect(sections.flatMap((s) => s.items.map((i) => i.id))).toEqual([
      "checkoutRef",
      "deleteRef",
      "pushRef:origin",
      "deleteRemoteRef:origin",
    ]);
  });

  test("during an in-progress op: only checkout is gated (§7.11 scopes the gate to checkout/revert)", () => {
    const sections = buildRefMenu({
      kind: "branch",
      shortName: "feature",
      isHead: false,
      knownRemotes: [],
      inProgress: inProgress({ kind: "merge" }),
    });
    expect(sections.flatMap((s) => s.items).find((i) => i.id === "checkoutRef")?.disabled).toBe(
      true,
    );
    // Delete/rename are not gated op kinds — git allows them mid-merge, so they stay enabled.
    expect(sections.flatMap((s) => s.items).find((i) => i.id === "deleteRef")?.disabled).toBe(
      false,
    );
    expect(sections.flatMap((s) => s.items).find((i) => i.id === "renameRef")?.disabled).toBe(
      false,
    );
  });
});

describe("remoteNamesFrom", () => {
  test("derives distinct remote names from remote-branch short names", () => {
    expect(remoteNamesFrom(["origin/main", "origin/feature", "upstream/main"])).toEqual([
      "origin",
      "upstream",
    ]);
  });

  test("a malformed name with no slash contributes nothing", () => {
    expect(remoteNamesFrom(["nofix"])).toEqual([]);
  });
});
