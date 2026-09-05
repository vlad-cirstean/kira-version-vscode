import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeTreeArgs, parseMergeTreeOutput } from "./mergeTree.ts";

const FIXTURES = join(import.meta.dir, "../../../../tests/fixtures/porcelain/mergeTree");

describe("mergeTreeArgs", () => {
  test("with no options: the plain two-revision form (git picks its own merge base)", () => {
    expect(mergeTreeArgs("HEAD", "topic")).toEqual([
      "merge-tree",
      "--write-tree",
      "--messages",
      "--name-only",
      "HEAD",
      "topic",
    ]);
  });

  test("with mergeBase: --merge-base=<sha> is inserted BEFORE the two revisions (§7.10's revert prediction)", () => {
    expect(mergeTreeArgs("HEAD", "c1^1", { mergeBase: "c1" })).toEqual([
      "merge-tree",
      "--write-tree",
      "--messages",
      "--name-only",
      "--merge-base=c1",
      "HEAD",
      "c1^1",
    ]);
  });

  test("mergeBase works for a merge commit's mainline spelling too (<C>^<mainline>)", () => {
    expect(mergeTreeArgs("HEAD", "m1^2", { mergeBase: "m1" })).toEqual([
      "merge-tree",
      "--write-tree",
      "--messages",
      "--name-only",
      "--merge-base=m1",
      "HEAD",
      "m1^2",
    ]);
  });
});

describe("parseMergeTreeOutput", () => {
  test("a clean merge yields the tree id and no conflicted paths", () => {
    const stdout = readFileSync(join(FIXTURES, "clean.bin"), "utf8");
    const result = parseMergeTreeOutput(stdout, 0);
    expect(result.kind).toBe("clean");
    if (result.kind === "clean") {
      expect(result.treeId).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  test("a real conflict (cross-checked against an actual merge, see integration suite) lists the conflicted path", () => {
    const stdout = readFileSync(join(FIXTURES, "conflict.bin"), "utf8");
    const result = parseMergeTreeOutput(stdout, 1);
    expect(result.kind).toBe("conflicts");
    if (result.kind === "conflicts") {
      expect(result.paths).toEqual(["conflict.txt"]);
      expect(result.messages.some((m) => m.includes("CONFLICT"))).toBe(true);
    }
  });

  test("exit codes above 1 are not a clean/conflict result", () => {
    expect(() => parseMergeTreeOutput("abc\n", 2)).toThrow();
  });
});
