import { describe, expect, test } from "bun:test";
import type { CommitRecord, DecorationRef } from "../../../packages/core/src/model/commit.ts";
import {
  composeRowLabel,
  describeDecoration,
} from "../../../packages/ui/src/components/rowAccessibility.ts";

function commit(overrides: Partial<CommitRecord> = {}): CommitRecord {
  return {
    sha: "abc1234567890",
    parents: [],
    author: { name: "Alice", email: "alice@example.com", timestamp: 0 },
    committer: { name: "Alice", email: "alice@example.com", timestamp: 0 },
    subject: "Fix the thing",
    decoration: [],
    ...overrides,
  };
}

describe("describeDecoration", () => {
  test("a local branch, not the current one", () => {
    expect(describeDecoration({ kind: "branch", name: "main", isHead: false })).toBe("branch main");
  });

  test("a local branch that is also HEAD is called out as the current branch", () => {
    expect(describeDecoration({ kind: "branch", name: "main", isHead: true })).toBe(
      "current branch main",
    );
  });

  test("a remote branch", () => {
    expect(describeDecoration({ kind: "remoteBranch", name: "origin/main" })).toBe(
      "remote branch origin/main",
    );
  });

  test("a tag", () => {
    expect(describeDecoration({ kind: "tag", name: "v1.0.0" })).toBe("tag v1.0.0");
  });

  test("a stash", () => {
    expect(describeDecoration({ kind: "stash", index: 0 })).toBe("stash");
  });

  test("detached HEAD", () => {
    expect(describeDecoration({ kind: "head" })).toBe("HEAD");
  });
});

describe("composeRowLabel", () => {
  test("an ordinary row with no decorations: subject, author, date — nothing else", () => {
    const label = composeRowLabel(commit(), "2h");
    expect(label).toBe("Fix the thing, Alice, 2h");
  });

  test("a decorated row appends every decoration, in order, as one more segment", () => {
    const decoration: DecorationRef[] = [
      { kind: "branch", name: "main", isHead: true },
      { kind: "tag", name: "v1.0.0" },
    ];
    const label = composeRowLabel(commit({ decoration }), "now");
    expect(label).toBe("Fix the thing, Alice, now, current branch main, tag v1.0.0");
  });

  test("the date segment is whatever the caller passed, verbatim — this function has no clock", () => {
    const label = composeRowLabel(commit(), "2024-03-14 09:41");
    expect(label).toContain("2024-03-14 09:41");
  });
});
