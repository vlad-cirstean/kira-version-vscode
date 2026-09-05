import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings } from "../../packages/core/src/index.ts";
import { FakeLogger } from "../../packages/core/src/ports/testFakes.ts";
import { NodeFileWatcher } from "../../packages/git/src/nodeFileWatcher.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { RepoService } from "../../packages/git/src/repoService.ts";
import { baseEnv } from "../fixtures/generateRepo.ts";

/**
 * `docs/plans/P6.md` W22's V1: "the pre-flight agreement holds on every fixture, not just the
 * probe's hand-built one. Particularly: a submodule path, a symlink, and a path with a space,
 * each in D and in T." A symlink and a space-containing path agree with the plain-file cases
 * (both are just strings to `status --porcelain=v2 -z` / `diff --name-only -z`) — asserted below
 * to lock that in.
 *
 * The submodule case does **not** agree, and that disagreement is real, not hypothetical: a
 * submodule whose locally-checked-out commit differs from HEAD's recorded pointer is reported
 * dirty by `status --porcelain`, and the same path appears in `T` whenever the target commit
 * also moves the submodule's pointer — so the classifier (a pure path-set intersection, same as
 * every other path) predicts `blockedByTracked`. But `git switch` never touches a submodule's own
 * checkout by default (that needs a separate `git submodule update`); it only rewrites the
 * *outer* repo's recorded gitlink, so the real checkout always succeeds, leaving the submodule
 * exactly where the user had it. The disagreement is safe (over-blocking, never a silent data
 * loss) but real: any repo whose submodule has drifted from HEAD's pin will show a false
 * "blocked" checkout badge for any target that also moves that pointer. Recorded here as a known
 * limitation of the file-path-only classifier, not fixed — P6 does not otherwise special-case
 * submodules anywhere in its scope, and the failure mode is conservative rather than unsafe.
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

function buildSymlinkAndSpaceRepo(): { readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "kira-fixture-special-paths-"));
  const env = identityEnv(dir);
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });

  git(["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(join(dir, "target.txt"), "link target v1\n");
  writeFileSync(join(dir, "my file.txt"), "space path v1\n");
  symlinkSync("target.txt", join(dir, "link.txt"));
  git(["add", "-A"]);
  git(["commit", "--quiet", "--no-gpg-sign", "-m", "base"]);

  git(["switch", "--quiet", "-c", "target"]);
  writeFileSync(join(dir, "target.txt"), "link target v2\n");
  writeFileSync(join(dir, "my file.txt"), "space path v2\n");
  execFileSync("rm", [join(dir, "link.txt")]);
  symlinkSync("does-not-exist.txt", join(dir, "link.txt"));
  git(["add", "-A"]);
  git(["commit", "--quiet", "--no-gpg-sign", "-m", "target changes: symlink + space-path"]);
  git(["switch", "--quiet", "main"]);

  return { dir };
}

describe("Pre-flight agreement on special path shapes (P6 W22 V1)", () => {
  test("a dirty symlink inside T: blockedByTracked, and the real switch agrees", async () => {
    const repo = buildSymlinkAndSpaceRepo();
    execFileSync("rm", [join(repo.dir, "link.txt")]);
    symlinkSync("some-other-local-target.txt", join(repo.dir, "link.txt"));

    const { service, repoId } = await openService(repo.dir);
    try {
      const preflight = await service.preflightCheckout(repoId, "target", "switch");
      expect(preflight.verdict).toBe("blocked");
      expect(preflight.blockers).toEqual([{ kind: "blockedByTracked", paths: ["link.txt"] }]);

      const result = await service.runOp(repoId, {
        kind: "checkout",
        target: "target",
        mode: "switch",
        discardLocalChanges: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("DirtyWorktree");
    } finally {
      service.dispose();
    }
  });

  test("a dirty path containing a space, inside T: blockedByTracked, and the real switch agrees", async () => {
    const repo = buildSymlinkAndSpaceRepo();
    writeFileSync(join(repo.dir, "my file.txt"), "local edit with a space in the path\n");

    const { service, repoId } = await openService(repo.dir);
    try {
      const preflight = await service.preflightCheckout(repoId, "target", "switch");
      expect(preflight.verdict).toBe("blocked");
      expect(preflight.blockers).toEqual([{ kind: "blockedByTracked", paths: ["my file.txt"] }]);

      const result = await service.runOp(repoId, {
        kind: "checkout",
        target: "target",
        mode: "switch",
        discardLocalChanges: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("DirtyWorktree");
    } finally {
      service.dispose();
    }
  });

  test("a submodule whose local checkout has drifted, inside T: preflight over-blocks; the real switch still succeeds (known, safe disagreement)", async () => {
    const subDir = mkdtempSync(join(tmpdir(), "kira-fixture-special-paths-sub-"));
    const subEnv = identityEnv(subDir);
    const subGit = (args: string[]) =>
      execFileSync("git", args, { cwd: subDir, env: subEnv, encoding: "utf8" });
    subGit(["init", "--quiet", "--initial-branch=main"]);
    const subShas: string[] = [];
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(subDir, "f.txt"), `sub v${i}\n`);
      subGit(["add", "-A"]);
      subGit(["commit", "--quiet", "--no-gpg-sign", "-m", `sub v${i}`]);
      subShas.push(subGit(["rev-parse", "HEAD"]).trim());
    }
    const [subV0, subV1, subV2] = subShas as [string, string, string];
    subGit(["switch", "--quiet", "main"]);

    const dir = mkdtempSync(join(tmpdir(), "kira-fixture-special-paths-outer-"));
    const env = identityEnv(dir);
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });

    git(["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(dir, "keep.txt"), "keep\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "base"]);
    git(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", subDir, "sub"]);
    git(["-C", "sub", "checkout", "--quiet", subV0]); // main pins v0
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "add submodule at v0"]);

    git(["switch", "--quiet", "-c", "target"]);
    git(["-C", "sub", "checkout", "--quiet", subV1]); // target pins v1
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "bump submodule to v1"]);
    git(["switch", "--quiet", "main"]);
    git(["submodule", "update", "--quiet"]);

    // Genuinely dirty: the submodule's local checkout (v2) differs from BOTH main's pin (v0)
    // and target's pin (v1) — not a lucky content match.
    git(["-C", "sub", "checkout", "--quiet", subV2]);

    const { service, repoId } = await openService(dir);
    try {
      const preflight = await service.preflightCheckout(repoId, "target", "switch");
      expect(preflight.verdict).toBe("blocked");
      expect(preflight.blockers).toEqual([{ kind: "blockedByTracked", paths: ["sub"] }]);

      const result = await service.runOp(repoId, {
        kind: "checkout",
        target: "target",
        mode: "switch",
        discardLocalChanges: false,
      });
      // The disagreement: git's own `switch` does not refuse this — it never touches the
      // submodule's own checkout, only the outer repo's recorded gitlink.
      expect(result.ok).toBe(true);
      expect(result.head).toEqual({ kind: "branch", name: "target" });

      const subHeadAfter = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: join(dir, "sub"),
        env,
        encoding: "utf8",
      }).trim();
      // The submodule itself is left exactly as the user had it — not rewritten to target's v1.
      expect(subHeadAfter).toBe(subV2);
    } finally {
      service.dispose();
    }
  });
});
