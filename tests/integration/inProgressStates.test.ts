import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings } from "../../packages/core/src/index.ts";
import { FakeLogger } from "../../packages/core/src/ports/testFakes.ts";
import { NodeFileWatcher } from "../../packages/git/src/nodeFileWatcher.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { RepoService } from "../../packages/git/src/repoService.ts";
import { baseEnv, conflicting, inProgressRevert } from "../fixtures/generateRepo.ts";

/**
 * `docs/plans/P6.md` W21/W22-V... : "The in-progress reader against each of the five states,
 * produced for real." `ops/conflict.test.ts` already covers `readInProgressStateFiles` against
 * hand-written state-file directories (empty gitDir, a lone `MERGE_HEAD`, a lone `rebase-merge/`,
 * and so on) — real, but not *produced* by the git command that actually creates each state. This
 * file closes that gap: for each of merge/cherryPick/revert/rebase/bisect, a real git command is
 * run to conflict or start it, and `RepoService.statusSummary()` — the same path the UI's
 * `ConflictBanner.vue` reads — is asserted to report the right `InProgressKind`.
 */

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
    settings: defaultSettings(),
    configuredGitCandidates: [],
  });
  const opened = await service.open(dir);
  if (opened.kind !== "ok") throw new Error("unreachable");
  return { service, repoId: opened.repoId };
}

describe("The in-progress reader, produced for real by each of the five real git states (P6 W21)", () => {
  test("merge: a real conflicting `git merge` leaves MERGE_HEAD, read back as kind 'merge'", async () => {
    const repo = conflicting(); // main and branch-theirs both touch conflict.txt
    const env = identityEnv(repo.dir);
    try {
      execFileSync("git", ["merge", "--no-gpg-sign", "branch-theirs"], { cwd: repo.dir, env });
      throw new Error("expected the merge to conflict");
    } catch (error) {
      if (!(error instanceof Error) || !("status" in error)) throw error;
    }

    const { service, repoId } = await openService(repo.dir);
    try {
      const status = await service.statusSummary(repoId);
      expect(status.inProgress?.kind).toBe("merge");
      expect(status.inProgress?.canContinue).toBe(true);
      expect(status.inProgress?.canAbort).toBe(true);
      expect(status.inProgress?.conflictedPaths).toContain("conflict.txt");
    } finally {
      service.dispose();
    }
  });

  test("cherryPick: a real conflicting `git cherry-pick` leaves CHERRY_PICK_HEAD, read back as kind 'cherryPick'", async () => {
    const repo = conflicting();
    const env = identityEnv(repo.dir);
    const theirsSha = repo.refs["branch-theirs"];
    if (!theirsSha) throw new Error("unreachable");
    try {
      execFileSync("git", ["cherry-pick", "--no-gpg-sign", theirsSha], { cwd: repo.dir, env });
      throw new Error("expected the cherry-pick to conflict");
    } catch (error) {
      if (!(error instanceof Error) || !("status" in error)) throw error;
    }

    const { service, repoId } = await openService(repo.dir);
    try {
      const status = await service.statusSummary(repoId);
      expect(status.inProgress?.kind).toBe("cherryPick");
      expect(status.inProgress?.canContinue).toBe(true);
      expect(status.inProgress?.canAbort).toBe(true);
    } finally {
      service.dispose();
    }
  });

  test("revert: a real conflicting `git revert` leaves REVERT_HEAD, read back as kind 'revert'", async () => {
    const repo = inProgressRevert(); // already left mid-revert, for real, by the generator itself
    const { service, repoId } = await openService(repo.dir);
    try {
      const status = await service.statusSummary(repoId);
      expect(status.inProgress?.kind).toBe("revert");
      expect(status.inProgress?.conflictedPaths).toContain(repo.conflictedPath);
    } finally {
      service.dispose();
    }
  });

  test("rebase: a real conflicting `git rebase` leaves rebase state, read back as kind 'rebase' with canContinue false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kira-fixture-rebase-state-"));
    const env = identityEnv(dir);
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });

    git(["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(dir, "file.txt"), "line0\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "commit0"]);

    writeFileSync(join(dir, "file.txt"), "line1 by main\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "commit1 on main"]);

    git(["switch", "--quiet", "-c", "feature", "HEAD~1"]);
    writeFileSync(join(dir, "file.txt"), "line1 by feature\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "commit1 on feature"]);

    try {
      execFileSync("git", ["rebase", "main"], { cwd: dir, env });
      throw new Error("expected the rebase to conflict");
    } catch (error) {
      if (!(error instanceof Error) || !("status" in error)) throw error;
    }

    const { service, repoId } = await openService(dir);
    try {
      const status = await service.statusSummary(repoId);
      expect(status.inProgress?.kind).toBe("rebase");
      // §9's own rule: rebase never offers Continue in v1, regardless of unmergedCount.
      expect(status.inProgress?.canContinue).toBe(false);
      expect(status.inProgress?.canAbort).toBe(true);
    } finally {
      service.dispose();
      execFileSync("git", ["rebase", "--abort"], { cwd: dir, env }); // hygiene
    }
  });

  test("bisect: a real `git bisect` session leaves BISECT_LOG, read back as kind 'bisect'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kira-fixture-bisect-state-"));
    const env = identityEnv(dir);
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });

    git(["init", "--quiet", "--initial-branch=main"]);
    const shas: string[] = [];
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(dir, "file.txt"), `line ${i}\n`);
      git(["add", "-A"]);
      git(["commit", "--quiet", "--no-gpg-sign", "-m", `commit ${i}`]);
      shas.push(git(["rev-parse", "HEAD"]).trim());
    }

    git(["bisect", "start"]);
    git(["bisect", "bad", "HEAD"]);
    const first = shas[0];
    if (!first) throw new Error("unreachable");
    git(["bisect", "good", first]);

    const { service, repoId } = await openService(dir);
    try {
      const status = await service.statusSummary(repoId);
      expect(status.inProgress?.kind).toBe("bisect");
      expect(status.inProgress?.canContinue).toBe(false); // §9: report-only
      expect(status.inProgress?.canAbort).toBe(true);
    } finally {
      service.dispose();
      execFileSync("git", ["bisect", "reset"], { cwd: dir, env }); // hygiene
    }
  });
});
