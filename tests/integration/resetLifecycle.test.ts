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
import { baseEnv, conflicting } from "../fixtures/generateRepo.ts";

/** `docs/plans/P10.md` W18's reset exit criteria against real git: repository state per mode
 *  (probe 1's own matrix), undo restores — including the mode-matched-replay negative that
 *  motivated the §7.7/§7.12 spec change (probe 5) — and the in-progress guard (probe 3). */

function identityEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv(dir),
    GIT_AUTHOR_NAME: "Kira Fixture",
    GIT_AUTHOR_EMAIL: "fixture@kira-version.test",
    GIT_COMMITTER_NAME: "Kira Fixture",
    GIT_COMMITTER_EMAIL: "fixture@kira-version.test",
  };
}

/** Probe 1's own fixture shape: a target commit (`targetSha`) and a HEAD one commit ahead of it
 *  (`headSha`), with — atop that, uncommitted — a modified tracked file, a staged new file, an
 *  untracked file, and an ignored file. Every reset-mode test below resets from `headSha` back to
 *  `targetSha` against a *fresh* copy of this dirty state, since each mode consumes it
 *  differently. */
function buildResetRepo(): {
  readonly dir: string;
  readonly targetSha: string;
  readonly headSha: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "kira-fixture-reset-lifecycle-"));
  const env = identityEnv(dir);
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });

  git(["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
  git(["add", "-A"]);
  git(["commit", "--quiet", "--no-gpg-sign", "-m", "add gitignore"]);

  writeFileSync(join(dir, "tracked.txt"), "v1\n");
  git(["add", "-A"]);
  git(["commit", "--quiet", "--no-gpg-sign", "-m", "v1"]);
  const targetSha = git(["rev-parse", "HEAD"]).trim();

  writeFileSync(join(dir, "tracked.txt"), "v2\n");
  git(["add", "-A"]);
  git(["commit", "--quiet", "--no-gpg-sign", "-m", "v2 — to be left behind"]);
  const headSha = git(["rev-parse", "HEAD"]).trim();

  // Uncommitted, on top of headSha: probe 1's own four-way dirty tree.
  writeFileSync(join(dir, "tracked.txt"), "dirty change\n"); // unstaged modification
  writeFileSync(join(dir, "new-staged.txt"), "new content\n");
  git(["add", "new-staged.txt"]); // staged NEW file
  writeFileSync(join(dir, "untracked.txt"), "untracked content\n"); // untracked
  writeFileSync(join(dir, "ignored.txt"), "ignored content\n"); // untracked, but gitignored

  return { dir, targetSha, headSha };
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

describe("Reset leaves the repository exactly as probe 1's matrix says, per mode (P10 W18 exit criterion 1)", () => {
  test("soft: branch pointer only — index and working tree, and everything dirty in them, untouched", async () => {
    const repo = buildResetRepo();
    const { service, repoId } = await openService(repo.dir);
    try {
      const result = await service.runOp(repoId, {
        kind: "reset",
        mode: "soft",
        target: repo.targetSha,
        confirmToken: undefined,
      });
      expect(result.ok).toBe(true);

      const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo.dir,
        env: identityEnv(repo.dir),
        encoding: "utf8",
      }).trim();
      expect(headSha).toBe(repo.targetSha);

      // Nothing on disk moved at all — soft touches only the branch pointer.
      expect(readFileSync(join(repo.dir, "tracked.txt"), "utf8")).toBe("dirty change\n");
      expect(existsSync(join(repo.dir, "new-staged.txt"))).toBe(true);
      expect(existsSync(join(repo.dir, "untracked.txt"))).toBe(true);
      expect(existsSync(join(repo.dir, "ignored.txt"))).toBe(true);
      // The pre-reset staged-new file now shows staged against the new (older) HEAD too — soft
      // never unstages anything.
      const indexStatus = execFileSync("git", ["status", "--porcelain", "new-staged.txt"], {
        cwd: repo.dir,
        encoding: "utf8",
      });
      expect(indexStatus).toMatch(/^A/);
    } finally {
      service.dispose();
    }
  });

  test("mixed: branch pointer and index move; working tree, and everything dirty on disk, untouched", async () => {
    const repo = buildResetRepo();
    const { service, repoId } = await openService(repo.dir);
    try {
      const result = await service.runOp(repoId, {
        kind: "reset",
        mode: "mixed",
        target: repo.targetSha,
        confirmToken: undefined,
      });
      expect(result.ok).toBe(true);

      const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo.dir,
        env: identityEnv(repo.dir),
        encoding: "utf8",
      }).trim();
      expect(headSha).toBe(repo.targetSha);

      // Every file on disk survives exactly as it was — mixed never touches the working tree.
      expect(readFileSync(join(repo.dir, "tracked.txt"), "utf8")).toBe("dirty change\n");
      expect(existsSync(join(repo.dir, "new-staged.txt"))).toBe(true);
      expect(existsSync(join(repo.dir, "untracked.txt"))).toBe(true);
      expect(existsSync(join(repo.dir, "ignored.txt"))).toBe(true);
      // The previously-staged new file is unstaged now (mixed resets the index to the new HEAD).
      const indexStatus = execFileSync("git", ["status", "--porcelain", "new-staged.txt"], {
        cwd: repo.dir,
        encoding: "utf8",
      });
      expect(indexStatus).toMatch(/^\?\?/);
    } finally {
      service.dispose();
    }
  });

  test("hard: branch pointer, index, AND working tree move — destroying the dirty tracked changes and the staged new file, but never the untracked/ignored ones", async () => {
    const repo = buildResetRepo();
    const { service, repoId } = await openService(repo.dir);
    try {
      const result = await service.runOp(repoId, {
        kind: "reset",
        mode: "hard",
        target: repo.targetSha,
        confirmToken: repo.targetSha.slice(0, 7),
      });
      expect(result.ok).toBe(true);

      const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo.dir,
        env: identityEnv(repo.dir),
        encoding: "utf8",
      }).trim();
      expect(headSha).toBe(repo.targetSha);

      // The dirty tracked change is gone — back to the target's own committed content.
      expect(readFileSync(join(repo.dir, "tracked.txt"), "utf8")).toBe("v1\n");
      // The staged NEW file is destroyed too — probe 1's own "looks untracked but isn't" finding.
      expect(existsSync(join(repo.dir, "new-staged.txt"))).toBe(false);
      // Untracked and ignored files are NEVER touched by --hard.
      expect(existsSync(join(repo.dir, "untracked.txt"))).toBe(true);
      expect(existsSync(join(repo.dir, "ignored.txt"))).toBe(true);

      // Plain `--porcelain` never lists ignored files at all (git's own default) — `existsSync`
      // above is what actually proves `ignored.txt` survived; this only re-confirms the
      // untracked half and that nothing else is left dirty.
      const status = execFileSync("git", ["status", "--porcelain"], {
        cwd: repo.dir,
        encoding: "utf8",
      });
      expect(status.trim().split("\n")).toEqual(["?? untracked.txt"]);
    } finally {
      service.dispose();
    }
  });

  test("hard requires the typed confirmation when it would destroy something, and refuses without it", async () => {
    const repo = buildResetRepo();
    const { service, repoId } = await openService(repo.dir);
    try {
      const result = await service.runOp(repoId, {
        kind: "reset",
        mode: "hard",
        target: repo.targetSha,
        confirmToken: undefined,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("ConfirmationRequired");

      // Refused BEFORE any write — nothing moved.
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo.dir,
        env: identityEnv(repo.dir),
        encoding: "utf8",
      }).trim();
      expect(headSha).toBe(repo.headSha);
      expect(existsSync(join(repo.dir, "new-staged.txt"))).toBe(true);
    } finally {
      service.dispose();
    }
  });
});

describe("Reset's undo restores per mode's own honesty (P10 W18 exit criterion 2, hard part 1)", () => {
  test("soft: a full round trip — undo restores HEAD, index, and working tree exactly", async () => {
    const repo = buildResetRepo();
    const { service, repoId } = await openService(repo.dir);
    try {
      const before = execFileSync("git", ["status", "--porcelain"], {
        cwd: repo.dir,
        encoding: "utf8",
      });

      const result = await service.runOp(repoId, {
        kind: "reset",
        mode: "soft",
        target: repo.targetSha,
        confirmToken: undefined,
      });
      expect(result.undo).not.toBeNull();
      if (result.undo === null) throw new Error("unreachable");

      const undone = await service.undoRun(repoId, result.undo.id);
      expect(undone.ok).toBe(true);

      const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo.dir,
        env: identityEnv(repo.dir),
        encoding: "utf8",
      }).trim();
      expect(headSha).toBe(repo.headSha);
      const after = execFileSync("git", ["status", "--porcelain"], {
        cwd: repo.dir,
        encoding: "utf8",
      });
      expect(after).toBe(before); // genuinely a full round trip
    } finally {
      service.dispose();
    }
  });

  test("mixed: undoing with the mode-matched replay leaves a clean status — probe 5's own regression", async () => {
    // A clean, dedicated setup: HEAD one commit ahead of target, with something genuinely
    // STAGED (not merely dirty) before the reset — the exact shape probe 5 used to show
    // `reset --soft <prev>` (§7.7's OLD, wrong rule) leaves phantom `D.` staged deletions.
    const dir = mkdtempSync(join(tmpdir(), "kira-fixture-reset-mixed-undo-"));
    const env = identityEnv(dir);
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
    git(["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(dir, "b.txt"), "b\n");
    writeFileSync(join(dir, "c.txt"), "c\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "base"]);
    const targetSha = git(["rev-parse", "HEAD"]).trim();

    writeFileSync(join(dir, "b.txt"), "b2\n");
    writeFileSync(join(dir, "c.txt"), "c2\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "advance b and c"]);
    const headSha = git(["rev-parse", "HEAD"]).trim();

    const { service, repoId } = await openService(dir);
    try {
      const result = await service.runOp(repoId, {
        kind: "reset",
        mode: "mixed",
        target: targetSha,
        confirmToken: undefined,
      });
      expect(result.ok).toBe(true);
      expect(result.undo).not.toBeNull();
      if (result.undo === null) throw new Error("unreachable");

      const undone = await service.undoRun(repoId, result.undo.id);
      expect(undone.ok).toBe(true);

      const headAfter = git(["rev-parse", "HEAD"]).trim();
      expect(headAfter).toBe(headSha);
      const status = git(["status", "--porcelain"]);
      // The mode-matched replay (`reset --mixed <prev>`, not the spec-as-written `--soft`): a
      // clean status, not the `D. b.txt` / `D. c.txt` phantom staged deletions the old rule left.
      expect(status).toBe("");
    } finally {
      service.dispose();
    }
  });

  test("mixed: what was staged before the reset is genuinely gone — undo restores commits, not index staging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kira-fixture-reset-mixed-staging-"));
    const env = identityEnv(dir);
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
    git(["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    writeFileSync(join(dir, "b.txt"), "b1\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "base"]);
    const targetSha = git(["rev-parse", "HEAD"]).trim();

    writeFileSync(join(dir, "a.txt"), "a2\n");
    writeFileSync(join(dir, "b.txt"), "b2\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "advance a and b"]);
    const headSha = git(["rev-parse", "HEAD"]).trim();

    // Real staged AND unstaged changes present before the reset, atop headSha.
    writeFileSync(join(dir, "a.txt"), "a-staged\n");
    git(["add", "a.txt"]); // staged
    writeFileSync(join(dir, "b.txt"), "b-unstaged\n"); // unstaged

    const { service, repoId } = await openService(dir);
    try {
      const result = await service.runOp(repoId, {
        kind: "reset",
        mode: "mixed",
        target: targetSha,
        confirmToken: undefined,
      });
      expect(result.ok).toBe(true);
      if (result.undo === null) throw new Error("unreachable");

      const undone = await service.undoRun(repoId, result.undo.id);
      expect(undone.ok).toBe(true);

      const headAfter = git(["rev-parse", "HEAD"]).trim();
      expect(headAfter).toBe(headSha); // the branch pointer and the commit ARE back

      // Both files are back as UNSTAGED modifications against headSha's own tree — a.txt's
      // pre-reset STAGED state is not restored (probe 5's own honesty: that index state was
      // never written to the object database, so no replay can bring it back).
      // Split on "\n" and drop the trailing empty entry BEFORE sorting, rather than `.trim()`ing
      // the whole string first — porcelain's leading-space unstaged marker sits at the very start
      // of this string, and a whole-string `.trim()` strips exactly that one leading space,
      // making `" M a.txt"` misread as the staged `"M a.txt"` while later lines are unaffected.
      const status = git(["status", "--porcelain"]);
      expect(status.split("\n").filter(Boolean).sort()).toEqual([" M a.txt", " M b.txt"]);
    } finally {
      service.dispose();
    }
  });

  test("hard: undo restores the branch pointer and the commits, never the destroyed uncommitted work", async () => {
    const repo = buildResetRepo();
    const { service, repoId } = await openService(repo.dir);
    try {
      const result = await service.runOp(repoId, {
        kind: "reset",
        mode: "hard",
        target: repo.targetSha,
        confirmToken: repo.targetSha.slice(0, 7),
      });
      expect(result.ok).toBe(true);
      if (result.undo === null) throw new Error("unreachable");

      const undone = await service.undoRun(repoId, result.undo.id);
      expect(undone.ok).toBe(true);

      const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo.dir,
        env: identityEnv(repo.dir),
        encoding: "utf8",
      }).trim();
      expect(headSha).toBe(repo.headSha); // the commit is back
      expect(readFileSync(join(repo.dir, "tracked.txt"), "utf8")).toBe("v2\n"); // headSha's own content
      // What --hard destroyed stays destroyed — §7.12's own honesty, unchanged by this phase.
      expect(existsSync(join(repo.dir, "new-staged.txt"))).toBe(false);
    } finally {
      service.dispose();
    }
  });
});

describe("Reset is guarded during an in-progress operation (P10 W18 exit criterion 3, probe 3)", () => {
  test("reset through runOp is refused with OperationInProgress, and MERGE_HEAD survives — raw git would have deleted it", async () => {
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
      const headSha = execFileSync("git", ["rev-parse", "main"], {
        cwd: repo.dir,
        encoding: "utf8",
      }).trim();
      const result = await service.runOp(repoId, {
        kind: "reset",
        mode: "hard",
        target: headSha,
        confirmToken: undefined,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("OperationInProgress");
      // The would-be-destructive gate never even ran — this is refused up front, host-side.
      expect(existsSync(join(repo.dir, ".git", "MERGE_HEAD"))).toBe(true);
    } finally {
      service.dispose();
    }
  });
});
