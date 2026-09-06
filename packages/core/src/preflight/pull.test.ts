import { describe, expect, test } from "bun:test";
import { buildPullPreflight, resolvePullStrategy } from "./pull.ts";

describe("resolvePullStrategy", () => {
  test("1. explicit wins over everything", () => {
    expect(
      resolvePullStrategy({
        explicit: "merge",
        settingStrategy: "rebase",
        gitConfig: { branchRebase: "true" },
      }),
    ).toEqual({ strategy: "merge", source: "explicit" });
  });

  test("2. kiraVersion.pull.strategy wins when not auto", () => {
    expect(
      resolvePullStrategy({
        settingStrategy: "rebase",
        gitConfig: { branchRebase: "false" },
      }),
    ).toEqual({ strategy: "rebase", source: "setting" });
  });

  test("3. branch.<name>.rebase wins when setting is auto", () => {
    expect(
      resolvePullStrategy({
        settingStrategy: "auto",
        gitConfig: { branchRebase: "true", pullRebase: "false" },
      }),
    ).toEqual({ strategy: "rebase", source: "branchConfig" });
  });

  test("3b. branch.<name>.rebase=false maps to merge", () => {
    expect(
      resolvePullStrategy({
        settingStrategy: "auto",
        gitConfig: { branchRebase: "false" },
      }),
    ).toEqual({ strategy: "merge", source: "branchConfig" });
  });

  test("3c. branch.<name>.rebase=interactive/merges both map to rebase", () => {
    expect(
      resolvePullStrategy({ settingStrategy: "auto", gitConfig: { branchRebase: "interactive" } }),
    ).toEqual({ strategy: "rebase", source: "branchConfig" });
    expect(
      resolvePullStrategy({ settingStrategy: "auto", gitConfig: { branchRebase: "merges" } }),
    ).toEqual({ strategy: "rebase", source: "branchConfig" });
  });

  test("4. pull.rebase wins when branch.<name>.rebase is unset", () => {
    expect(
      resolvePullStrategy({
        settingStrategy: "auto",
        gitConfig: { pullRebase: "true" },
      }),
    ).toEqual({ strategy: "rebase", source: "pullConfig" });
  });

  test("5. pull.ff=only wins when neither rebase key resolves", () => {
    expect(
      resolvePullStrategy({
        settingStrategy: "auto",
        gitConfig: { pullFf: "only" },
      }),
    ).toEqual({ strategy: "ff-only", source: "pullConfig" });
  });

  test("6. falls back to ff-only/default when nothing resolves", () => {
    expect(resolvePullStrategy({ settingStrategy: "auto", gitConfig: {} })).toEqual({
      strategy: "ff-only",
      source: "default",
    });
  });

  test("an unrecognised rebase value is not a decision — falls through", () => {
    expect(
      resolvePullStrategy({
        settingStrategy: "auto",
        gitConfig: { branchRebase: "garbage", pullRebase: "true" },
      }),
    ).toEqual({ strategy: "rebase", source: "pullConfig" });
  });

  test('pull.ff=true/false (not "only") does not resolve — falls to default', () => {
    expect(
      resolvePullStrategy({ settingStrategy: "auto", gitConfig: { pullFf: "false" } }),
    ).toEqual({ strategy: "ff-only", source: "default" });
  });
});

describe("buildPullPreflight", () => {
  test("clean, ff-only, ahead 0 behind 0: no blockers", () => {
    const p = buildPullPreflight({
      strategy: "ff-only",
      source: "default",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      dirty: false,
    });
    expect(p.blockers).toEqual([]);
  });

  test("dirty + ff-only + behind: ff-only never rewrites history, so no blocker", () => {
    const p = buildPullPreflight({
      strategy: "ff-only",
      source: "default",
      upstream: "origin/main",
      ahead: 0,
      behind: 3,
      dirty: true,
    });
    expect(p.blockers).toEqual([]);
  });

  test("dirty + merge + behind: blocked — a merge would integrate onto a dirty tree", () => {
    const p = buildPullPreflight({
      strategy: "merge",
      source: "setting",
      upstream: "origin/main",
      ahead: 0,
      behind: 3,
      dirty: true,
    });
    expect(p.blockers).toEqual(["dirtyNonFastForward"]);
  });

  test("dirty + rebase + diverged (ahead and behind): blocked", () => {
    const p = buildPullPreflight({
      strategy: "rebase",
      source: "branchConfig",
      upstream: "origin/main",
      ahead: 2,
      behind: 3,
      dirty: true,
    });
    expect(p.blockers).toEqual(["dirtyNonFastForward"]);
  });

  test("dirty + merge but not behind (nothing to integrate): no blocker", () => {
    const p = buildPullPreflight({
      strategy: "merge",
      source: "setting",
      upstream: "origin/main",
      ahead: 2,
      behind: 0,
      dirty: true,
    });
    expect(p.blockers).toEqual([]);
  });

  test("clean + merge + behind: no blocker (dirty is the trigger, not divergence alone)", () => {
    const p = buildPullPreflight({
      strategy: "merge",
      source: "setting",
      upstream: "origin/main",
      ahead: 0,
      behind: 3,
      dirty: false,
    });
    expect(p.blockers).toEqual([]);
  });

  test("routes are empty when there is no blocker (P8's own case, unchanged by P9)", () => {
    const p = buildPullPreflight({
      strategy: "rebase",
      source: "default",
      upstream: null,
      ahead: 0,
      behind: 0,
      dirty: true,
    });
    expect(p.blockers).toEqual([]);
    expect(p.routes).toEqual([]);
  });

  test("P9/W10: routes offers stashAndCarry exactly when dirtyNonFastForward blocks", () => {
    const p = buildPullPreflight({
      strategy: "rebase",
      source: "default",
      upstream: "origin/main",
      ahead: 0,
      behind: 2,
      dirty: true,
    });
    expect(p.blockers).toEqual(["dirtyNonFastForward"]);
    expect(p.routes).toEqual(["stashAndCarry"]);
  });
});
