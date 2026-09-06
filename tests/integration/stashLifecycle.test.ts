import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSettings } from "../../packages/core/src/index.ts";
import { FakeLogger } from "../../packages/core/src/ports/testFakes.ts";
import { locateGit } from "../../packages/git/src/discovery.ts";
import { openGitDriver } from "../../packages/git/src/driver.ts";
import { NodeFileWatcher } from "../../packages/git/src/nodeFileWatcher.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { predictMerge } from "../../packages/git/src/queries.ts";
import { RepoService } from "../../packages/git/src/repoService.ts";
import { noopCatFileSession } from "../../packages/git/src/testFakes.ts";
import { withStashes } from "../fixtures/generateRepo.ts";

/**
 * `docs/plans/P9.md` W18 — exit criterion 1, against real repos. Each test names the plan's own
 * numbered scenario in its title so a failure here maps straight back to the plan's own words.
 */

const runner = new NodeProcessRunner();
const noopCatFile = noopCatFileSession();

async function driverFor(repoRoot: string) {
  const resolution = await locateGit({ runner });
  if (resolution.kind !== "ok") throw new Error("no usable system git found for this test");
  return openGitDriver(resolution.git, runner, repoRoot, noopCatFile);
}

async function openService(dir: string) {
  const service = await RepoService.create({
    runner: new NodeProcessRunner(),
    fileWatcher: new NodeFileWatcher(),
    logger: new FakeLogger(),
    settings: () => defaultSettings(),
    configuredGitCandidates: [],
  });
  const opened = await service.open(dir);
  if (opened.kind !== "ok") throw new Error("unreachable");
  return { service, repoId: opened.repoId };
}

describe("W18 scenario 1 — clean prediction, clean pop", () => {
  test("predicts clean; the real pop succeeds, no unmerged paths, the stash is gone", async () => {
    const repo = withStashes({ count: 1 });
    const { service, repoId } = await openService(repo.dir);
    try {
      const { entries } = await service.stashList(repoId);
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      if (!entry) throw new Error("unreachable");

      const preflight = await service.preflightStashPop(repoId, entry.sha, entry.index);
      expect(preflight.prediction.kind).toBe("clean");
      expect(preflight.blockers).toEqual([]);
      expect(preflight.verdict).toBe("clean");

      const result = await service.runOp(repoId, {
        kind: "stashPop",
        sha: entry.sha,
        index: entry.index,
        restoreIndex: false,
      });
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.inProgress).toBeNull(); // no unmerged paths left behind

      const after = await service.stashList(repoId);
      expect(after.entries).toEqual([]); // stash gone
    } finally {
      service.dispose();
    }
  });
});

describe("W18 scenario 2 — conflict prediction, conflicting pop", () => {
  test("predicts conflicts with a path list; the real pop leaves that exact conflict, stash kept", async () => {
    const repo = withStashes({ count: 0, conflicting: true });
    const { service, repoId } = await openService(repo.dir);
    try {
      const { entries } = await service.stashList(repoId);
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      if (!entry) throw new Error("unreachable");

      const preflight = await service.preflightStashPop(repoId, entry.sha, entry.index);
      expect(preflight.prediction.kind).toBe("conflicts");
      expect(preflight.prediction.kind === "conflicts" && preflight.prediction.paths).toEqual([
        "a.txt",
      ]);
      expect(preflight.verdict).toBe("willConflict");

      const result = await service.runOp(repoId, {
        kind: "stashPop",
        sha: entry.sha,
        index: entry.index,
        restoreIndex: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("StashConflict");
      expect(result.inProgress?.kind).toBe("unmergedOnly");
      // §7.6's explicit requirement: the conflicted paths the read-back reports equal the
      // predicted ones exactly.
      expect(
        result.inProgress?.kind === "unmergedOnly" && result.inProgress.conflictedPaths,
      ).toEqual(["a.txt"]);

      // §7.6's explicit requirement: the stash is still in the list.
      const after = await service.stashList(repoId);
      expect(after.entries).toHaveLength(1);
      expect(after.entries[0]?.sha).toBe(entry.sha);
    } finally {
      service.dispose();
    }
  });
});

describe("W18 scenario 3 — --merge-base is load-bearing (probe 2 regression)", () => {
  test("mergeTreeArgs without mergeBase reports clean; the pre-flight's own call — and the real pop — agree it conflicts", async () => {
    const repo = withStashes({ count: 0, conflicting: true });
    const { service, repoId } = await openService(repo.dir);
    try {
      const { entries } = await service.stashList(repoId);
      const entry = entries[0];
      if (!entry) throw new Error("unreachable");

      const driver = await driverFor(repo.dir);
      const withoutMergeBase = await predictMerge(driver, "HEAD", entry.sha);
      expect(withoutMergeBase.kind).toBe("clean"); // the false clean this probe exists to catch

      const preflight = await service.preflightStashPop(repoId, entry.sha, entry.index);
      expect(preflight.prediction.kind).toBe("conflicts"); // the pre-flight's own call disagrees

      const result = await service.runOp(repoId, {
        kind: "stashPop",
        sha: entry.sha,
        index: entry.index,
        restoreIndex: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("StashConflict"); // the executed pop matches the pre-flight
    } finally {
      service.dispose();
    }
  });
});

describe("W18 scenario 4 — untracked collision, partial application", () => {
  test("the pre-flight blocks; forcing it anyway applies the tracked half and keeps the stash (probe 3)", async () => {
    const repo = withStashes({ count: 0, includeUntracked: true });
    const { service, repoId } = await openService(repo.dir);
    try {
      const { entries } = await service.stashList(repoId);
      const entry = entries[0];
      if (!entry) throw new Error("unreachable");

      const preflight = await service.preflightStashPop(repoId, entry.sha, entry.index);
      expect(preflight.verdict).toBe("blocked");
      const untrackedBlocker = preflight.blockers.find((b) => b.kind === "untrackedCollision");
      expect(untrackedBlocker?.kind === "untrackedCollision" && untrackedBlocker.paths).toEqual([
        "new.txt",
      ]);

      // Force it anyway — the op layer never refuses on a `blocked` verdict; it is the UI's own
      // dialog that would normally ask first.
      const result = await service.runOp(repoId, {
        kind: "stashPop",
        sha: entry.sha,
        index: entry.index,
        restoreIndex: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("StashUntrackedCollision");

      // Non-atomic: the tracked half landed, the stash is still kept.
      const after = await service.stashList(repoId);
      expect(after.entries).toHaveLength(1);
      const status = await service.statusSummary(repoId);
      expect(status.isClean).toBe(false);
    } finally {
      service.dispose();
    }
  });
});

describe("W18 scenario 5 — local changes would be overwritten, atomic", () => {
  test("the pre-flight blocks; forcing it anyway applies nothing", async () => {
    const repo = withStashes({ count: 1 });
    const { service, repoId } = await openService(repo.dir);
    try {
      const { entries } = await service.stashList(repoId);
      const entry = entries[0];
      if (!entry) throw new Error("unreachable");

      // Dirty the same path the stash itself changes, differently — probe 4's shape.
      writeFileSync(join(repo.dir, "base.txt"), "a conflicting worktree edit, not committed\n");

      const preflight = await service.preflightStashPop(repoId, entry.sha, entry.index);
      expect(preflight.verdict).toBe("blocked");
      const localBlocker = preflight.blockers.find(
        (b) => b.kind === "localChangesWouldBeOverwritten",
      );
      expect(localBlocker?.kind === "localChangesWouldBeOverwritten" && localBlocker.paths).toEqual(
        ["base.txt"],
      );

      const beforeContent = readFileSync(join(repo.dir, "base.txt"), "utf8");

      const result = await service.runOp(repoId, {
        kind: "stashPop",
        sha: entry.sha,
        index: entry.index,
        restoreIndex: false,
      });
      expect(result.ok).toBe(false); // atomic — git refuses before touching anything

      const afterContent = readFileSync(join(repo.dir, "base.txt"), "utf8");
      expect(afterContent).toBe(beforeContent); // nothing applied
      const after = await service.stashList(repoId);
      expect(after.entries).toHaveLength(1); // stash untouched
    } finally {
      service.dispose();
    }
  });
});

describe("W18 scenario 6 — stash branch, clean and blocked (probe 11's non-atomicity)", () => {
  test("clean: the branch is created and the stash is dropped", async () => {
    const repo = withStashes({ count: 1 });
    const { service, repoId } = await openService(repo.dir);
    try {
      const { entries } = await service.stashList(repoId);
      const entry = entries[0];
      if (!entry) throw new Error("unreachable");

      const preflight = await service.preflightStashBranch(repoId, entry.sha, "from-stash");
      expect(preflight.verdict).toBe("clean");

      const result = await service.runOp(repoId, {
        kind: "stashBranch",
        branch: "from-stash",
        sha: entry.sha,
        index: entry.index,
      });
      expect(result.ok).toBe(true);

      const after = await service.stashList(repoId);
      expect(after.entries).toEqual([]); // dropped as part of `stash branch`
    } finally {
      service.dispose();
    }
  });

  test("probe 11's own transcript: predicted clean, yet the real apply half still fails non-atomically", async () => {
    // Faithful to probe 11: HEAD === the stash's own base (nothing committed since it was
    // pushed), so `classifyCheckout`'s rewritten-paths diff is EMPTY and `classifyStashBranch`
    // predicts "clean" — the checkout half genuinely has nothing to block on. The worktree is
    // then dirtied on the SAME path the stash itself changes, which the checkout half never
    // looks at (only HEAD-vs-target is compared, never the stash's own diff — `preflightStashBranch`'s
    // own doc comment calls this "clean by construction", a known, deliberate imprecision). Real
    // git still runs `checkout -b` (succeeds — a true no-op switch) then the implied apply
    // (fails — the dirty file collides with the stash's own change), so the branch is created,
    // HEAD moves to it, and the stash survives untouched: probe 11's exact non-atomicity, not
    // predicted by the pre-flight and pinned here so it is never predicted by accident either.
    const repo = withStashes({ count: 1 });
    const { service, repoId } = await openService(repo.dir);
    try {
      const { entries } = await service.stashList(repoId);
      const entry = entries[0];
      if (!entry) throw new Error("unreachable");

      writeFileSync(join(repo.dir, "base.txt"), "a conflicting worktree edit, not committed\n");

      const preflight = await service.preflightStashBranch(repoId, entry.sha, "from-stash-blocked");
      expect(preflight.verdict).toBe("clean"); // the documented gap: not predicted

      const result = await service.runOp(repoId, {
        kind: "stashBranch",
        branch: "from-stash-blocked",
        sha: entry.sha,
        index: entry.index,
      });
      expect(result.ok).toBe(false); // the apply half failed

      const headBranch = readFileSync(join(repo.dir, ".git", "HEAD"), "utf8").trim();
      expect(headBranch).toBe("ref: refs/heads/from-stash-blocked"); // HEAD moved anyway

      const after = await service.stashList(repoId);
      expect(after.entries).toHaveLength(1); // the stash survived — no rollback (OQ6)
    } finally {
      service.dispose();
    }
  });
});
