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
import { baseEnv } from "../fixtures/generateRepo.ts";

/**
 * `docs/plans/P6.md` W21's own first bullet: "for each of probe P1's six cases: run the
 * classifier, then run the real checkout, and assert they agree." §7.5's own doc comment (this
 * plan, "The hard parts") states the model exactly: `D` = locally modified/staged/untracked
 * paths, `T` = paths the target tree rewrites, and the six cases below are the six distinct
 * `(path in D?, path in T?, content)` combinations that model actually distinguishes — including
 * probe P1/CASE 2c, the one a content-aware predictor would get wrong (git blocks a dirty file
 * even when its content is byte-identical to the target's own version, because the check is a
 * path check with a dirty bit, not a content diff).
 *
 * One shared repo (`buildAgreementRepo`) with a `target` branch that differs from `main` on
 * every path these six cases care about; each test starts from a *fresh* clone of it (not a
 * shared mutable working tree) so one case's dirty/untracked state can never leak into another's
 * — `runOp`'s checkout is a real `git switch`, and a stray leftover file would silently change
 * which case a later test is actually exercising.
 */

interface AgreementRepo {
  readonly dir: string;
}

function buildAgreementRepo(): AgreementRepo {
  const dir = mkdtempSync(join(tmpdir(), "kira-fixture-agreement-"));
  const env = baseEnv(dir);
  const commitEnv = {
    ...env,
    GIT_AUTHOR_NAME: "Kira Fixture",
    GIT_AUTHOR_EMAIL: "fixture@kira-version.test",
    GIT_COMMITTER_NAME: "Kira Fixture",
    GIT_COMMITTER_EMAIL: "fixture@kira-version.test",
  };
  const git = (args: string[], extraEnv: NodeJS.ProcessEnv = commitEnv) =>
    execFileSync("git", args, { cwd: dir, env: extraEnv, encoding: "utf8" });

  git(["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(dir, "tracked-diff.txt"), "main line\n");
  writeFileSync(join(dir, "tracked-carry.txt"), "carry base\n");
  writeFileSync(join(dir, "byte-identical.txt"), "main content\n");
  git(["add", "-A"]);
  git(["commit", "--quiet", "--no-gpg-sign", "-m", "base"]);

  git(["switch", "--quiet", "-c", "target"]);
  writeFileSync(join(dir, "tracked-diff.txt"), "target line\n");
  writeFileSync(join(dir, "byte-identical.txt"), "shared content\n");
  writeFileSync(join(dir, "untracked-target.txt"), "target added this\n");
  writeFileSync(join(dir, "ignored.txt"), "target's tracked copy\n");
  git(["add", "-A"]);
  git(["add", "-f", "ignored.txt"]);
  git(["commit", "--quiet", "--no-gpg-sign", "-m", "target changes"]);
  git(["switch", "--quiet", "main"]);

  return { dir };
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

describe("Pre-flight vs real checkout — agreement on all six of probe P1's cases (P6 W21)", () => {
  test("case 1: nothing dirty at all — verdict clean, real checkout succeeds", async () => {
    const repo = buildAgreementRepo();
    const { service, repoId } = await openService(repo.dir);
    try {
      const preflight = await service.preflightCheckout(repoId, "target", "switch");
      expect(preflight.verdict).toBe("clean");
      expect(preflight.blockers).toEqual([]);

      const result = await service.runOp(repoId, {
        kind: "checkout",
        target: "target",
        mode: "switch",
        discardLocalChanges: false,
      });
      expect(result.ok).toBe(true);
      expect(result.head).toEqual({ kind: "branch", name: "target" });
    } finally {
      service.dispose();
    }
  });

  test("case 2: dirty but outside T (D ∩ T = ∅) — verdict cleanCarry, real checkout carries it", async () => {
    const repo = buildAgreementRepo();
    writeFileSync(join(repo.dir, "tracked-carry.txt"), "carry local edit\n");
    const { service, repoId } = await openService(repo.dir);
    try {
      const preflight = await service.preflightCheckout(repoId, "target", "switch");
      expect(preflight.verdict).toBe("cleanCarry");
      expect(preflight.carried).toEqual(["tracked-carry.txt"]);
      expect(preflight.blockers).toEqual([]);

      const result = await service.runOp(repoId, {
        kind: "checkout",
        target: "target",
        mode: "switch",
        discardLocalChanges: false,
      });
      expect(result.ok).toBe(true);
      const content = execFileSync("cat", [join(repo.dir, "tracked-carry.txt")], {
        encoding: "utf8",
      });
      expect(content).toBe("carry local edit\n"); // the local edit survived the switch
    } finally {
      service.dispose();
    }
  });

  test("case 3: dirty tracked file inside T, content differs — blockedByTracked, real switch refuses too", async () => {
    const repo = buildAgreementRepo();
    writeFileSync(join(repo.dir, "tracked-diff.txt"), "my own local edit\n");
    const { service, repoId } = await openService(repo.dir);
    try {
      const preflight = await service.preflightCheckout(repoId, "target", "switch");
      expect(preflight.verdict).toBe("blocked");
      expect(preflight.blockers).toEqual([
        { kind: "blockedByTracked", paths: ["tracked-diff.txt"] },
      ]);
      expect(preflight.routes).toEqual(["discard"]);

      const result = await service.runOp(repoId, {
        kind: "checkout",
        target: "target",
        mode: "switch",
        discardLocalChanges: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("DirtyWorktree");
      expect(result.head).toEqual({ kind: "branch", name: "main" }); // never moved
    } finally {
      service.dispose();
    }
  });

  test("case 4 (probe P1/2c): dirty tracked file inside T, content BYTE-IDENTICAL to target — still blocked", async () => {
    const repo = buildAgreementRepo();
    // Exactly what `target` itself checks this path out as — the one case a content-aware
    // predictor would wrongly wave through.
    writeFileSync(join(repo.dir, "byte-identical.txt"), "shared content\n");
    const { service, repoId } = await openService(repo.dir);
    try {
      const preflight = await service.preflightCheckout(repoId, "target", "switch");
      expect(preflight.verdict).toBe("blocked");
      expect(preflight.blockers).toEqual([
        { kind: "blockedByTracked", paths: ["byte-identical.txt"] },
      ]);

      const result = await service.runOp(repoId, {
        kind: "checkout",
        target: "target",
        mode: "switch",
        discardLocalChanges: false,
      });
      // Git's own index-based dirty-bit check refuses this exactly as it would any other
      // tracked conflict — content equality buys nothing, which is the whole point of the case.
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("DirtyWorktree");
    } finally {
      service.dispose();
    }
  });

  test("case 5: untracked file inside T — blockedByUntracked, real switch refuses with no discard route", async () => {
    const repo = buildAgreementRepo();
    writeFileSync(join(repo.dir, "untracked-target.txt"), "an unrelated local file\n");
    const { service, repoId } = await openService(repo.dir);
    try {
      const preflight = await service.preflightCheckout(repoId, "target", "switch");
      expect(preflight.verdict).toBe("blocked");
      expect(preflight.blockers).toEqual([
        { kind: "blockedByUntracked", paths: ["untracked-target.txt"] },
      ]);
      expect(preflight.routes).toEqual([]); // no discard route for an untracked block

      const result = await service.runOp(repoId, {
        kind: "checkout",
        target: "target",
        mode: "switch",
        discardLocalChanges: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("UntrackedWouldBeOverwritten");
    } finally {
      service.dispose();
    }
  });

  test("case 6: ignored file inside T — outside D by construction, real checkout overwrites it silently", async () => {
    const repo = buildAgreementRepo();
    writeFileSync(join(repo.dir, "ignored.txt"), "local ignored edit, never added\n");
    const { service, repoId } = await openService(repo.dir);
    try {
      const preflight = await service.preflightCheckout(repoId, "target", "switch");
      // `.gitignore` keeps this path out of `status --porcelain` entirely, so it is never in D —
      // nothing else is dirty in this fixture, so the verdict is a plain "clean", not blocked.
      expect(preflight.verdict).toBe("clean");
      expect(preflight.blockers).toEqual([]);

      const result = await service.runOp(repoId, {
        kind: "checkout",
        target: "target",
        mode: "switch",
        discardLocalChanges: false,
      });
      expect(result.ok).toBe(true);
      const content = execFileSync("cat", [join(repo.dir, "ignored.txt")], { encoding: "utf8" });
      // Git overwrote the ignored file with target's own tracked copy, without a word — probe
      // P5's own behaviour, reproduced rather than diverged from (this plan's "The hard parts").
      expect(content).toBe("target's tracked copy\n");
    } finally {
      service.dispose();
    }
  });
});
