import { describe, expect, test } from "bun:test";
import {
  deleteRemoteBranchArgs,
  forcePushLeaseArgs,
  forcePushPlainArgs,
  parseRefUpdates,
  pushArgs,
} from "./push.ts";

describe("pushArgs", () => {
  test("plain push: explicit refspec, no --set-upstream, never --force", () => {
    expect(pushArgs({ remote: "origin", branch: "main", setUpstream: false })).toEqual([
      "push",
      "--progress",
      "origin",
      "main:main",
    ]);
  });

  test("--set-upstream only when the caller asked for it", () => {
    expect(pushArgs({ remote: "origin", branch: "feature", setUpstream: true })).toEqual([
      "push",
      "--progress",
      "--set-upstream",
      "origin",
      "feature:feature",
    ]);
  });

  test("never contains --force in any form", () => {
    const args = pushArgs({ remote: "origin", branch: "main", setUpstream: true });
    expect(args.some((a) => a.includes("force"))).toBe(false);
  });
});

describe("forcePushLeaseArgs", () => {
  test("bare --force-with-lease --force-if-includes — D48, never an explicit sha", () => {
    expect(forcePushLeaseArgs({ remote: "origin", branch: "main" })).toEqual([
      "push",
      "--progress",
      "--force-with-lease",
      "--force-if-includes",
      "origin",
      "main:main",
    ]);
  });

  test("never an explicit ref:sha form on --force-with-lease", () => {
    const args = forcePushLeaseArgs({ remote: "origin", branch: "main" });
    expect(args.find((a) => a.startsWith("--force-with-lease="))).toBeUndefined();
  });
});

describe("forcePushPlainArgs", () => {
  test("plain --force, explicit refspec", () => {
    expect(forcePushPlainArgs({ remote: "origin", branch: "main" })).toEqual([
      "push",
      "--progress",
      "--force",
      "origin",
      "main:main",
    ]);
  });
});

describe("deleteRemoteBranchArgs", () => {
  test("git push <remote> --delete <branch>", () => {
    expect(deleteRemoteBranchArgs({ remote: "origin", branch: "old-feature" })).toEqual([
      "push",
      "origin",
      "--delete",
      "old-feature",
    ]);
  });
});

describe("push.ts re-exports fetch.ts's parseRefUpdates unchanged", () => {
  test("probe 1 row 4: a forced update line", () => {
    const stderr = " + 3a55c77...d462520 main       -> main            (forced update)";
    expect(parseRefUpdates(stderr)).toEqual([
      { ref: "main", from: "3a55c77", to: "d462520", forced: true },
    ]);
  });
});
