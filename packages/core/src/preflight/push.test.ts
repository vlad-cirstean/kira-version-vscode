import { describe, expect, test } from "bun:test";
import { classifyPush } from "./push.ts";

const DEFAULT_PROTECTED = ["main", "master", "release/*"];

describe("classifyPush", () => {
  test("clean fast-forward push on an unprotected branch", () => {
    const p = classifyPush({
      branch: "feature/x",
      upstream: "origin/feature/x",
      ahead: 2,
      behind: 0,
      remoteTip: "abc123",
      protectedBranches: DEFAULT_PROTECTED,
    });
    expect(p).toEqual({
      upstream: "origin/feature/x",
      wouldSetUpstream: false,
      ahead: 2,
      behind: 0,
      remoteTip: "abc123",
      protectedBy: null,
      fastForward: true,
    });
  });

  test("no upstream: wouldSetUpstream is true and remoteTip is null", () => {
    const p = classifyPush({
      branch: "feature/new",
      upstream: null,
      ahead: 1,
      behind: 0,
      remoteTip: null,
      protectedBranches: DEFAULT_PROTECTED,
    });
    expect(p.wouldSetUpstream).toBe(true);
    expect(p.remoteTip).toBeNull();
  });

  test("behind > 0 is not a fast-forward from our side", () => {
    const p = classifyPush({
      branch: "feature/x",
      upstream: "origin/feature/x",
      ahead: 1,
      behind: 1,
      remoteTip: "def456",
      protectedBranches: DEFAULT_PROTECTED,
    });
    expect(p.fastForward).toBe(false);
  });

  test("protected branch (exact match) surfaces the matched pattern", () => {
    const p = classifyPush({
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      remoteTip: "sha1",
      protectedBranches: DEFAULT_PROTECTED,
    });
    expect(p.protectedBy).toBe("main");
  });

  test("protected branch (glob match) surfaces the matched pattern, not the branch name", () => {
    const p = classifyPush({
      branch: "release/2.0",
      upstream: "origin/release/2.0",
      ahead: 1,
      behind: 0,
      remoteTip: "sha1",
      protectedBranches: DEFAULT_PROTECTED,
    });
    expect(p.protectedBy).toBe("release/*");
  });

  test("unprotected branch: protectedBy is null, never a bare boolean", () => {
    const p = classifyPush({
      branch: "feature/anything",
      upstream: "origin/feature/anything",
      ahead: 1,
      behind: 0,
      remoteTip: "sha1",
      protectedBranches: DEFAULT_PROTECTED,
    });
    expect(p.protectedBy).toBeNull();
  });

  test("empty protected-branches list never matches", () => {
    const p = classifyPush({
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      remoteTip: "sha1",
      protectedBranches: [],
    });
    expect(p.protectedBy).toBeNull();
  });
});
