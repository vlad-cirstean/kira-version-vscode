import { describe, expect, test } from "bun:test";
import { fetchArgs, parseRefUpdates } from "./fetch.ts";

describe("fetchArgs", () => {
  test("bare fetch: --progress and the remote only", () => {
    expect(fetchArgs({ remote: "origin", prune: false, pruneTags: false })).toEqual([
      "fetch",
      "--progress",
      "origin",
    ]);
  });

  test("--prune on, --prune-tags off (the UI defaults, D49/OQ2)", () => {
    expect(fetchArgs({ remote: "origin", prune: true, pruneTags: false })).toEqual([
      "fetch",
      "--progress",
      "--prune",
      "origin",
    ]);
  });

  test("both flags explicit when the caller asks for both", () => {
    expect(fetchArgs({ remote: "origin", prune: true, pruneTags: true })).toEqual([
      "fetch",
      "--progress",
      "--prune",
      "--prune-tags",
      "origin",
    ]);
  });

  test("--all replaces the remote name entirely", () => {
    expect(fetchArgs({ remote: "--all", prune: false, pruneTags: false })).toEqual([
      "fetch",
      "--progress",
      "--all",
    ]);
  });
});

describe("parseRefUpdates", () => {
  test("probe 6: a plain fast-forward fetch update", () => {
    const stderr = ["From /path/to/rem", "   d876420..b5c3142  main       -> origin/main"].join(
      "\n",
    );
    expect(parseRefUpdates(stderr)).toEqual([
      { ref: "origin/main", from: "d876420", to: "b5c3142", forced: false },
    ]);
  });

  test("probe 1 row 4: a forced update via triple-dot + leading '+' flag", () => {
    const stderr = [
      "To /tmp/errprobe-remote.git",
      " + 3a55c77...d462520 main       -> main            (forced update)",
    ].join("\n");
    expect(parseRefUpdates(stderr)).toEqual([
      { ref: "main", from: "3a55c77", to: "d462520", forced: true },
    ]);
  });

  test("forced is also true from a bare triple-dot even without a '+' flag character", () => {
    const stderr = "   3a55c77...d462520  main       -> main";
    expect(parseRefUpdates(stderr)).toEqual([
      { ref: "main", from: "3a55c77", to: "d462520", forced: true },
    ]);
  });

  test("a new branch: no sha in the text, from/to both null, forced false", () => {
    const stderr = " * [new branch]      feature    -> origin/feature";
    expect(parseRefUpdates(stderr)).toEqual([
      { ref: "origin/feature", from: null, to: null, forced: false },
    ]);
  });

  test("a new tag", () => {
    const stderr = " * [new tag]         v1.0       -> v1.0";
    expect(parseRefUpdates(stderr)).toEqual([{ ref: "v1.0", from: null, to: null, forced: false }]);
  });

  test("a deleted ref (--prune)", () => {
    const stderr = " - [deleted]         (none)     -> origin/old-branch";
    expect(parseRefUpdates(stderr)).toEqual([
      { ref: "origin/old-branch", from: null, to: null, forced: false },
    ]);
  });

  test("multiple ref lines in one block, in order", () => {
    const stderr = [
      "From /path/to/rem",
      "   d876420..b5c3142  main       -> origin/main",
      " * [new branch]      feature    -> origin/feature",
    ].join("\n");
    expect(parseRefUpdates(stderr)).toEqual([
      { ref: "origin/main", from: "d876420", to: "b5c3142", forced: false },
      { ref: "origin/feature", from: null, to: null, forced: false },
    ]);
  });

  test("progress lines and the 'From'/'To' header are not ref-update lines — ignored", () => {
    const stderr = [
      "remote: Enumerating objects: 91, done.",
      "remote: Counting objects:  31% (29/91)",
      "Receiving objects: 100% (89/89), 3.42 MiB | 12.10 MiB/s, done.",
      "From /path/to/rem",
      "   d876420..b5c3142  main       -> origin/main",
    ].join("\n");
    expect(parseRefUpdates(stderr)).toEqual([
      { ref: "origin/main", from: "d876420", to: "b5c3142", forced: false },
    ]);
  });

  test("an empty stderr (a small local-transport fetch that moved nothing) yields no updates", () => {
    expect(parseRefUpdates("")).toEqual([]);
  });

  test("a failed fetch's stderr (no successful ref line at all) yields no updates", () => {
    const stderr = "fatal: Could not read from remote repository.\n";
    expect(parseRefUpdates(stderr)).toEqual([]);
  });
});
