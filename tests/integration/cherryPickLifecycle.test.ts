import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings } from "../../packages/core/src/index.ts";
import { FakeLogger } from "../../packages/core/src/ports/testFakes.ts";
import { NodeFileWatcher } from "../../packages/git/src/nodeFileWatcher.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { RepoService } from "../../packages/git/src/repoService.ts";
import { baseEnv, conflicting, withEmptyPickCandidate } from "../fixtures/generateRepo.ts";

/** `docs/plans/P10.md` W18's cherry-pick exit criteria against real git: D64's argv arrangement
 *  proven forwards (the deferred W17 item — a probe-2-shaped scenario where the natural,
 *  unpinned `merge-base(HEAD, sha)` would predict clean but the real pick conflicts), the
 *  `--keep` undo's own honest refusal (probe 9) rather than destroying work it never touched,
 *  the in-progress guard (probe 3), and the conflict path end to end (probe 7) — abort, resolve
 *  and continue, and skip an empty pick. */

function identityEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv(dir),
    GIT_AUTHOR_NAME: "Kira Fixture",
    GIT_AUTHOR_EMAIL: "fixture@kira-version.test",
    GIT_COMMITTER_NAME: "Kira Fixture",
    GIT_COMMITTER_EMAIL: "fixture@kira-version.test",
  };
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

describe("Cherry-pick's prediction is pinned to sha^mainline, not git's own merge-base (P10 W18, deferred W17 regression, D64/probe 2)", () => {
  test("a pick that reads clean against the natural merge-base actually conflicts — pinning the base is what catches it", async () => {
    // F (fork): line1 = "orig". T1 (topic, not picked): line1 -> "topic-orig". T2 (the commit to
    // pick): line1 back to "orig" (T2's own diff vs its parent T1 touches line1 NOT AT ALL) plus
    // an unrelated line2 change so T2 is a real commit. main (HEAD): line1 -> "main-change".
    //
    // Naturally-computed merge-base(HEAD, T2) is F (line1="orig"): diffing F -> T2 on line1 shows
    // NO change at all (T2 undid T1's edit), so a predictor using that base would read T2's
    // arrival as a no-op on line1 and call the whole pick clean. `sha^mainline` (T1, line1=
    // "topic-orig") is T2's own actual parent: diffing T1 -> T2 DOES touch line1, and merging
    // that against HEAD's own "main-change" on the same line is a genuine conflict — exactly what
    // `git cherry-pick T2` itself produces. This is cherry-pick's own mirror of the revert-side
    // probe 2 regression D64's doc comment on `#predictCherryPick` names.
    const dir = mkdtempSync(join(tmpdir(), "kira-fixture-pick-argv-"));
    const env = identityEnv(dir);
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
    git(["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(dir, "file.txt"), "orig\nline2\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "fork"]);

    git(["checkout", "--quiet", "-b", "topic"]);
    writeFileSync(join(dir, "file.txt"), "topic-orig\nline2\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "topic: temporary line1 edit"]);

    writeFileSync(join(dir, "file.txt"), "orig\nline2-topic\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "topic: undo line1, touch line2"]);
    const pickSha = git(["rev-parse", "HEAD"]).trim();

    git(["checkout", "--quiet", "main"]);
    writeFileSync(join(dir, "file.txt"), "main-change\nline2\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "main: conflicting line1 edit"]);

    // Sanity: the naturally-computed merge-base really is the fork, and diffing from it to the
    // pick candidate really is silent on line1 — the exact trap a wrong arrangement would fall
    // into.
    const naturalBase = git(["merge-base", "main", pickSha]).trim();
    const forkSha = git(["rev-parse", "main~1"]).trim();
    expect(naturalBase).toBe(forkSha);
    const diffFromNaturalBase = git(["diff", naturalBase, pickSha, "--", "file.txt"]);
    expect(diffFromNaturalBase).not.toMatch(/-orig|-topic-orig/); // line1 unchanged across that diff

    const { service, repoId } = await openService(dir);
    try {
      const preflight = await service.preflightCherryPick(repoId, pickSha);
      expect(preflight.prediction.kind).toBe("conflicts");

      const result = await service.runOp(repoId, {
        kind: "cherryPick",
        sha: pickSha,
        mainline: undefined,
        noCommit: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("Conflict");
      expect(result.inProgress?.kind).toBe("cherryPick");
      expect(result.inProgress?.conflictedPaths).toContain("file.txt");

      await service.runOp(repoId, { kind: "opAbort" });
    } finally {
      service.dispose();
    }
  });
});

describe("Cherry-pick's undo is --keep, and refuses rather than destroying work it never touched (P10 W18 exit criterion 2, probe 9, D66)", () => {
  test("editing the picked file again after the pick makes --keep refuse; the commit stays and the edit survives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kira-fixture-pick-keep-"));
    const env = identityEnv(dir);
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
    git(["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(dir, "shared.txt"), "root\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "base"]);

    git(["checkout", "--quiet", "-b", "feature"]);
    writeFileSync(join(dir, "shared.txt"), "feature change\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "feature change"]);
    const pickSha = git(["rev-parse", "HEAD"]).trim();
    git(["checkout", "--quiet", "main"]);

    const { service, repoId } = await openService(dir);
    try {
      const result = await service.runOp(repoId, {
        kind: "cherryPick",
        sha: pickSha,
        mainline: undefined,
        noCommit: false,
      });
      expect(result.ok).toBe(true);
      if (result.undo === null) throw new Error("unreachable");

      const headAfterPick = git(["rev-parse", "HEAD"]).trim();

      // Real, uncommitted work landing on exactly the file the pick touched — the shape `--keep`
      // exists to protect (probe 9: it refuses rather than silently discarding this).
      writeFileSync(join(dir, "shared.txt"), "feature change\nmore edits, uncommitted\n");

      const undone = await service.undoRun(repoId, result.undo.id);
      expect(undone.ok).toBe(false);

      // The commit is NOT rolled back — a refused reset never even partially applies.
      const headAfterUndo = git(["rev-parse", "HEAD"]).trim();
      expect(headAfterUndo).toBe(headAfterPick);
      // Nor is the uncommitted edit destroyed.
      expect(readFileSync(join(dir, "shared.txt"), "utf8")).toBe(
        "feature change\nmore edits, uncommitted\n",
      );
    } finally {
      service.dispose();
    }
  });
});

describe("Cherry-pick is guarded during an in-progress operation (P10 W18 exit criterion 3, probe 3)", () => {
  test("cherry-pick through runOp is refused with OperationInProgress, and MERGE_HEAD survives", async () => {
    const repo = conflicting(); // main and branch-theirs both touch conflict.txt
    const env = identityEnv(repo.dir);
    try {
      execFileSync("git", ["merge", "--no-gpg-sign", "branch-theirs"], { cwd: repo.dir, env });
      throw new Error("expected the merge to conflict");
    } catch (error) {
      if (!(error instanceof Error) || !("status" in error)) throw error;
    }
    expect(existsSync(join(repo.dir, ".git", "MERGE_HEAD"))).toBe(true);

    const { service, repoId } = await openService(repo.dir);
    try {
      const branchTheirsSha = execFileSync("git", ["rev-parse", "branch-theirs"], {
        cwd: repo.dir,
        encoding: "utf8",
      }).trim();
      const result = await service.runOp(repoId, {
        kind: "cherryPick",
        sha: branchTheirsSha,
        mainline: undefined,
        noCommit: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("OperationInProgress");
      expect(existsSync(join(repo.dir, ".git", "MERGE_HEAD"))).toBe(true);
    } finally {
      service.dispose();
    }
  });
});

describe("Cherry-pick's conflict path, end to end (P10 W18 exit criterion 4, probe 7)", () => {
  function buildConflictingPickRepo(): { readonly dir: string; readonly pickSha: string } {
    const dir = mkdtempSync(join(tmpdir(), "kira-fixture-pick-conflict-"));
    const env = identityEnv(dir);
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
    git(["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(dir, "file.txt"), "base\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "root"]);

    git(["checkout", "--quiet", "-b", "feature"]);
    writeFileSync(join(dir, "file.txt"), "feature change\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "feature change"]);
    const pickSha = git(["rev-parse", "HEAD"]).trim();
    git(["checkout", "--quiet", "main"]);

    writeFileSync(join(dir, "file.txt"), "main change\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "main change"]);

    return { dir, pickSha };
  }

  test("a conflicting pick: predicted conflicts, and the real pick leaves CHERRY_PICK_HEAD with the predicted paths unmerged", async () => {
    const repo = buildConflictingPickRepo();
    const { service, repoId } = await openService(repo.dir);
    try {
      const preflight = await service.preflightCherryPick(repoId, repo.pickSha);
      expect(preflight.prediction.kind).toBe("conflicts");
      if (preflight.prediction.kind !== "conflicts") throw new Error("unreachable");
      expect(preflight.prediction.paths).toContain("file.txt");

      const result = await service.runOp(repoId, {
        kind: "cherryPick",
        sha: repo.pickSha,
        mainline: undefined,
        noCommit: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("Conflict");
      expect(result.inProgress?.kind).toBe("cherryPick");
      expect(result.inProgress?.canContinue).toBe(true);
      expect(result.inProgress?.canAbort).toBe(true);
      expect(result.inProgress?.canSkip).toBe(true);
      expect(result.inProgress?.conflictedPaths).toEqual(
        preflight.prediction.kind === "conflicts" ? preflight.prediction.paths : [],
      );

      await service.runOp(repoId, { kind: "opAbort" });
    } finally {
      service.dispose();
    }
  });

  test("opAbort restores the pre-pick state exactly", async () => {
    const repo = buildConflictingPickRepo();
    const env = identityEnv(repo.dir);
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo.dir,
      env,
      encoding: "utf8",
    }).trim();

    const { service, repoId } = await openService(repo.dir);
    try {
      const started = await service.runOp(repoId, {
        kind: "cherryPick",
        sha: repo.pickSha,
        mainline: undefined,
        noCommit: false,
      });
      expect(started.ok).toBe(false);
      expect(started.inProgress?.kind).toBe("cherryPick");

      const aborted = await service.runOp(repoId, { kind: "opAbort" });
      expect(aborted.ok).toBe(true);
      expect(aborted.inProgress).toBeNull();

      const headAfter = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
      }).trim();
      expect(headAfter).toBe(headBefore);
      expect(readFileSync(join(repo.dir, "file.txt"), "utf8")).toBe("main change\n");

      const status = await service.statusSummary(repoId);
      expect(status.isClean).toBe(true);
      expect(status.inProgress).toBeNull();
    } finally {
      service.dispose();
    }
  });

  test("resolving by hand, then Continue: a new commit lands, the banner is gone", async () => {
    const repo = buildConflictingPickRepo();
    const env = identityEnv(repo.dir);

    const { service, repoId } = await openService(repo.dir);
    try {
      const started = await service.runOp(repoId, {
        kind: "cherryPick",
        sha: repo.pickSha,
        mainline: undefined,
        noCommit: false,
      });
      expect(started.ok).toBe(false);
      expect(started.inProgress?.conflictedPaths).toContain("file.txt");

      writeFileSync(join(repo.dir, "file.txt"), "resolved by hand\n");
      execFileSync("git", ["add", "file.txt"], { cwd: repo.dir, env });

      const headBeforeContinue = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
      }).trim();

      const continued = await service.runOp(repoId, { kind: "opContinue" });
      expect(continued.ok).toBe(true);
      expect(continued.inProgress).toBeNull();

      const headAfterContinue = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
      }).trim();
      expect(headAfterContinue).not.toBe(headBeforeContinue);

      const status = await service.statusSummary(repoId);
      expect(status.inProgress).toBeNull();
      expect(status.isClean).toBe(true);
    } finally {
      service.dispose();
    }
  });

  test("an empty pick (probe 6): EmptyCherryPick with a working Skip, from withEmptyPickCandidate", async () => {
    const repo = withEmptyPickCandidate();
    const topicSha = repo.refs.topic;
    if (topicSha === undefined) throw new Error("unreachable");

    const { service, repoId } = await openService(repo.dir);
    try {
      const result = await service.runOp(repoId, {
        kind: "cherryPick",
        sha: topicSha,
        mainline: undefined,
        noCommit: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("EmptyCherryPick");
      expect(result.inProgress?.kind).toBe("cherryPick");
      expect(result.inProgress?.canSkip).toBe(true);
      expect(result.inProgress?.unmergedCount).toBe(0);

      const skipped = await service.runOp(repoId, { kind: "opSkip" });
      expect(skipped.ok).toBe(true);
      expect(skipped.inProgress).toBeNull();

      const status = await service.statusSummary(repoId);
      expect(status.isClean).toBe(true);
      expect(status.inProgress).toBeNull();
    } finally {
      service.dispose();
    }
  });
});
