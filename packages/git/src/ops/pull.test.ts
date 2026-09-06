import { describe, expect, test } from "bun:test";
import {
  ffOnlyWouldDiverge,
  mergeArgs,
  mergeFfOnlyArgs,
  parsePullConfig,
  pullConfigArgs,
  rebaseArgs,
} from "./pull.ts";

describe("pullConfigArgs", () => {
  test("one config --null --get-regexp spawn naming all three keys for the given branch", () => {
    expect(pullConfigArgs("main")).toEqual([
      "config",
      "--null",
      "--get-regexp",
      "^(branch\\.main\\.rebase|pull\\.rebase|pull\\.ff)$",
    ]);
  });

  test("regex-metacharacters in the branch name are escaped", () => {
    const args = pullConfigArgs("release/1.0+fix");
    expect(args[3]).toBe("^(branch\\.release/1\\.0\\+fix\\.rebase|pull\\.rebase|pull\\.ff)$");
  });
});

describe("parsePullConfig", () => {
  test("all three keys present with explicit values (real git --null --get-regexp bytes)", () => {
    const stdout = "branch.main.rebase\ntrue\0pull.rebase\nfalse\0pull.ff\nonly\0";
    expect(parsePullConfig(stdout)).toEqual({
      branchRebase: "true",
      pullRebase: "false",
      pullFf: "only",
    });
  });

  test("a valueless boolean entry (no embedded newline) maps to the string 'true'", () => {
    const stdout = "pull.rebase\0";
    expect(parsePullConfig(stdout)).toEqual({ pullRebase: "true" });
  });

  test("a later duplicate entry overwrites an earlier one, matching git's own 'last one wins'", () => {
    const stdout = "pull.rebase\nfalse\0pull.rebase\0";
    expect(parsePullConfig(stdout)).toEqual({ pullRebase: "true" });
  });

  test("no matches at all (nothing configured) yields an all-undefined object", () => {
    expect(parsePullConfig("")).toEqual({});
  });

  test("only branch.<name>.rebase set", () => {
    const stdout = "branch.feature.rebase\ninteractive\0";
    expect(parsePullConfig(stdout)).toEqual({ branchRebase: "interactive" });
  });

  test("an unrelated key sharing the '.rebase' suffix shape but not 'branch.*' is ignored", () => {
    // Defensive: pullConfigArgs's own regex would never surface this, but the parser's own
    // matching should still be exact rather than a loose substring test.
    const stdout = "notbranch.main.rebase\ntrue\0";
    expect(parsePullConfig(stdout)).toEqual({});
  });
});

describe("mergeFfOnlyArgs / mergeArgs / rebaseArgs", () => {
  test("git merge --ff-only <upstream>", () => {
    expect(mergeFfOnlyArgs("origin/main")).toEqual(["merge", "--ff-only", "origin/main"]);
  });

  test("git merge --no-edit <upstream>", () => {
    expect(mergeArgs("origin/main")).toEqual(["merge", "--no-edit", "origin/main"]);
  });

  test("git rebase <upstream>, never --interactive", () => {
    const args = rebaseArgs("origin/main");
    expect(args).toEqual(["rebase", "origin/main"]);
    expect(args.some((a) => a.includes("interactive"))).toBe(false);
  });
});

describe("ffOnlyWouldDiverge", () => {
  test("ahead and behind both > 0: diverged, ff-only would fail", () => {
    expect(ffOnlyWouldDiverge(2, 3)).toBe(true);
  });

  test("behind only: a clean fast-forward, not diverged", () => {
    expect(ffOnlyWouldDiverge(0, 3)).toBe(false);
  });

  test("ahead only: nothing to integrate, not diverged", () => {
    expect(ffOnlyWouldDiverge(2, 0)).toBe(false);
  });

  test("neither ahead nor behind: up to date, not diverged", () => {
    expect(ffOnlyWouldDiverge(0, 0)).toBe(false);
  });
});
