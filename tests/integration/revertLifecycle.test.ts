import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings } from "../../packages/core/src/index.ts";
import { FakeLogger } from "../../packages/core/src/ports/testFakes.ts";
import { NodeFileWatcher } from "../../packages/git/src/nodeFileWatcher.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { RepoService } from "../../packages/git/src/repoService.ts";
import { baseEnv, branchy } from "../fixtures/generateRepo.ts";

/** `docs/plans/P6.md` W21's revert bullets, against real git: the `--merge-base` prediction
 *  agreeing with the real outcome on both a clean and a conflicting revert (the probe-P2
 *  regression its own doc comment on `mergeTreeArgs` names), `--abort` restoring the pre-revert
 *  state, and `--continue` completing a conflicted revert under `driver.ts`'s own
 *  `GIT_EDITOR=true` with rc=0 and the banner (`statusSummary().inProgress`) gone. */

function identityEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv(dir),
    GIT_AUTHOR_NAME: "Kira Fixture",
    GIT_AUTHOR_EMAIL: "fixture@kira-version.test",
    GIT_COMMITTER_NAME: "Kira Fixture",
    GIT_COMMITTER_EMAIL: "fixture@kira-version.test",
  };
}

/** A base commit, a commit that changes one line (the one every test here reverts), and a
 *  further commit that changes the *same* line again — reverting the middle commit once the
 *  tip has moved the same line is exactly what makes the inverse patch fail to apply cleanly.
 *  Kept local rather than reusing `generateRepo.ts`'s `inProgressRevert()` because these tests
 *  need to call `preflightRevert` *before* anything has actually been reverted, which that
 *  generator (by design) does not leave a seam for. */
function buildRevertRepo(): { readonly dir: string; readonly revertedSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "kira-fixture-revert-lifecycle-"));
  const env = identityEnv(dir);
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });

  git(["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(join(dir, "file.txt"), "base line\n");
  git(["add", "-A"]);
  git(["commit", "--quiet", "--no-gpg-sign", "-m", "base"]);

  writeFileSync(join(dir, "file.txt"), "changed by the commit we will revert\n");
  git(["add", "-A"]);
  git(["commit", "--quiet", "--no-gpg-sign", "-m", "change to revert"]);
  const revertedSha = git(["rev-parse", "HEAD"]).trim();

  writeFileSync(join(dir, "file.txt"), "changed again after that, on top\n");
  git(["add", "-A"]);
  git(["commit", "--quiet", "--no-gpg-sign", "-m", "further change on the same line"]);

  return { dir, revertedSha };
}

async function openService(dir: string) {
  const service = await RepoService.create({
    runner: new NodeProcessRunner(),
    fileWatcher: new NodeFileWatcher(),
    logger: new FakeLogger(),
    settings: defaultSettings(),
    configuredGitCandidates: [],
  });
  const opened = await service.open(dir);
  if (opened.kind !== "ok") throw new Error("unreachable");
  return { service, repoId: opened.repoId };
}

describe("Revert prediction agrees with the real outcome (P6 W21, probe-P2 regression)", () => {
  test("a clean revert: predicted clean, and the real revert commits with no conflict", async () => {
    const repo = branchy({ mergeBack: false });
    const { service, repoId } = await openService(repo.dir);
    try {
      const lastMainCommit = repo.commits[repo.commits.length - 1];
      if (!lastMainCommit) throw new Error("unreachable");

      const preflight = await service.preflightRevert(repoId, [lastMainCommit]);
      expect(preflight.prediction.kind).toBe("clean");
      expect(preflight.verdict).toBe("clean");

      const result = await service.runOp(repoId, {
        kind: "revert",
        shas: [lastMainCommit],
        mainline: undefined,
        noCommit: false,
      });
      expect(result.ok).toBe(true);
      expect(result.inProgress).toBeNull(); // no revert left in progress — it committed cleanly

      const status = await service.statusSummary(repoId);
      expect(status.inProgress).toBeNull();
    } finally {
      service.dispose();
    }
  });

  test("a conflicting revert: predicted conflicts, and the real revert leaves REVERT_HEAD unresolved", async () => {
    const repo = buildRevertRepo();
    const { service, repoId } = await openService(repo.dir);
    try {
      const preflight = await service.preflightRevert(repoId, [repo.revertedSha]);
      expect(preflight.prediction.kind).toBe("conflicts");
      expect(preflight.predictedFor).toBe(repo.revertedSha);

      const result = await service.runOp(repoId, {
        kind: "revert",
        shas: [repo.revertedSha],
        mainline: undefined,
        noCommit: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("Conflict");
      expect(result.inProgress?.kind).toBe("revert");
      expect(result.inProgress?.conflictedPaths).toContain("file.txt");

      // Clean up so the fixture's tmp dir doesn't linger mid-revert.
      await service.runOp(repoId, { kind: "opAbort" });
    } finally {
      service.dispose();
    }
  });
});

describe("opAbort restores the pre-revert state exactly (P6 W21)", () => {
  test("HEAD, the ref and the working tree are all back to how they were before the revert", async () => {
    const repo = buildRevertRepo();
    const env = identityEnv(repo.dir);
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo.dir,
      env,
      encoding: "utf8",
    }).trim();

    const { service, repoId } = await openService(repo.dir);
    try {
      const started = await service.runOp(repoId, {
        kind: "revert",
        shas: [repo.revertedSha],
        mainline: undefined,
        noCommit: false,
      });
      expect(started.ok).toBe(false);
      expect(started.inProgress?.kind).toBe("revert");

      const aborted = await service.runOp(repoId, { kind: "opAbort" });
      expect(aborted.ok).toBe(true);
      expect(aborted.inProgress).toBeNull();

      const headAfter = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
      }).trim();
      expect(headAfter).toBe(headBefore); // never moved

      const content = readFileSync(join(repo.dir, "file.txt"), "utf8");
      expect(content).toBe("changed again after that, on top\n"); // the pre-revert content

      const status = await service.statusSummary(repoId);
      expect(status.isClean).toBe(true);
      expect(status.inProgress).toBeNull();
    } finally {
      service.dispose();
    }
  });
});

describe("opContinue completes a resolved revert under GIT_EDITOR=true (P6 W21)", () => {
  test("resolving the conflict by hand, then Continue: rc=0, a new commit lands, the banner is gone", async () => {
    const repo = buildRevertRepo();
    const env = identityEnv(repo.dir);

    const { service, repoId } = await openService(repo.dir);
    try {
      const started = await service.runOp(repoId, {
        kind: "revert",
        shas: [repo.revertedSha],
        mainline: undefined,
        noCommit: false,
      });
      expect(started.ok).toBe(false);
      expect(started.inProgress?.conflictedPaths).toContain("file.txt");

      // Resolve exactly as a real user's merge editor would: overwrite the conflict-marked
      // file with a resolution, then stage it.
      writeFileSync(join(repo.dir, "file.txt"), "resolved by hand\n");
      execFileSync("git", ["add", "file.txt"], { cwd: repo.dir, env });

      const headBeforeContinue = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
      }).trim();

      const continued = await service.runOp(repoId, { kind: "opContinue" });
      // `driver.ts`'s own `GIT_EDITOR=true` (W6) is what makes this complete non-interactively
      // rather than hang or fail on "Please supply a commit message" — the exact gap this test
      // exists to close.
      expect(continued.ok).toBe(true);
      expect(continued.inProgress).toBeNull(); // banner gone, no manual refresh needed

      const headAfterContinue = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
      }).trim();
      expect(headAfterContinue).not.toBe(headBeforeContinue); // a real commit landed

      const status = await service.statusSummary(repoId);
      expect(status.inProgress).toBeNull();
      expect(status.isClean).toBe(true);
    } finally {
      service.dispose();
    }
  });
});
