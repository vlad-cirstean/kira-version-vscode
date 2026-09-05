import { describe, expect, test } from "bun:test";
import {
  branchConfigRegexpArgs,
  branchCreateAndSwitchArgs,
  branchCreateArgs,
  branchDeleteArgs,
  branchRenameArgs,
  branchRevParseArgs,
} from "./branch.ts";

describe("branchCreateArgs", () => {
  test("plain create, no tracking", () => {
    expect(branchCreateArgs("feature", "main")).toEqual(["branch", "feature", "main"]);
  });

  test("with an explicit tracking upstream: -t <upstream> appended", () => {
    expect(branchCreateArgs("feature", "main", { track: "origin/feature" })).toEqual([
      "branch",
      "feature",
      "main",
      "-t",
      "origin/feature",
    ]);
  });
});

describe("branchCreateAndSwitchArgs", () => {
  test("git switch -c <name> <start>", () => {
    expect(branchCreateAndSwitchArgs("feature", "main")).toEqual([
      "switch",
      "-c",
      "feature",
      "main",
    ]);
  });
});

describe("branchDeleteArgs", () => {
  test("default: -d (refuses an unmerged branch)", () => {
    expect(branchDeleteArgs("feature")).toEqual(["branch", "-d", "feature"]);
  });

  test("force: -D", () => {
    expect(branchDeleteArgs("feature", { force: true })).toEqual(["branch", "-D", "feature"]);
  });
});

describe("branchRenameArgs", () => {
  test("git branch -m <from> <to>", () => {
    expect(branchRenameArgs("old", "new")).toEqual(["branch", "-m", "old", "new"]);
  });
});

describe("undo-capture reads", () => {
  test("branchRevParseArgs: rev-parse --verify refs/heads/<name>", () => {
    expect(branchRevParseArgs("feature")).toEqual([
      "rev-parse",
      "--verify",
      "refs/heads/feature",
    ]);
  });

  test("branchConfigRegexpArgs: config --get-regexp ^branch\\.<name>\\.", () => {
    expect(branchConfigRegexpArgs("feature")).toEqual([
      "config",
      "--get-regexp",
      "^branch\\.feature\\.",
    ]);
  });
});
