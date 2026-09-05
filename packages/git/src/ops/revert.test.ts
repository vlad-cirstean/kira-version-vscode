import { describe, expect, test } from "bun:test";
import { revertArgs } from "./revert.ts";

describe("revertArgs", () => {
  test("a single, non-merge revert: --no-edit, no -m, no --no-commit", () => {
    expect(revertArgs(["abc1234"])).toEqual(["revert", "--no-edit", "abc1234"]);
  });

  test("a merge revert: -m <mainline> inserted before the shas", () => {
    expect(revertArgs(["abc1234"], { mainline: 1 })).toEqual([
      "revert",
      "--no-edit",
      "-m",
      "1",
      "abc1234",
    ]);
  });

  test("--no-commit, offered when the prediction shows conflicts", () => {
    expect(revertArgs(["abc1234"], { noCommit: true })).toEqual([
      "revert",
      "--no-edit",
      "--no-commit",
      "abc1234",
    ]);
  });

  test("mainline and --no-commit together", () => {
    expect(revertArgs(["abc1234"], { mainline: 2, noCommit: true })).toEqual([
      "revert",
      "--no-edit",
      "-m",
      "2",
      "--no-commit",
      "abc1234",
    ]);
  });

  test("a multi-sha revert: one invocation, all shas trailing (§7.10's all-or-nothing)", () => {
    expect(revertArgs(["abc1234", "def5678", "ghi9012"])).toEqual([
      "revert",
      "--no-edit",
      "abc1234",
      "def5678",
      "ghi9012",
    ]);
  });
});
