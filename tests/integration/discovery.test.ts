import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — ResolvedGitImpl is deliberately not exported (discovery.ts's header
// comment): the only way to obtain a `ResolvedGit` is `locateGit()`'s "ok" branch, which is
// unreachable for a sub-2.38 git. This import existing at all is the regression this guards
// against — if it ever stops erroring, the type-level floor guarantee has been broken.
import type { ResolvedGitImpl as _NeverExported } from "../../packages/git/src/discovery.ts";
import {
  locateGit,
  MINIMUM_GIT_VERSION,
  resolveRepoIdentity,
} from "../../packages/git/src/discovery.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { makeFakeGit } from "../fixtures/fakeGit.ts";
import { conflicting, linear } from "../fixtures/generateRepo.ts";

type _AssertStillOpaque = _NeverExported;

const runner = new NodeProcessRunner();

describe("locateGit", () => {
  test("resolves a configured candidate at or above the floor", async () => {
    const fakeGit = makeFakeGit({ version: "2.45.1" });
    const resolution = await locateGit({ runner, configuredCandidates: [fakeGit] });
    expect(resolution.kind).toBe("ok");
    if (resolution.kind === "ok") {
      expect(resolution.git.path).toBe(fakeGit);
      expect(resolution.git.version).toEqual(
        expect.objectContaining({ major: 2, minor: 45, patch: 1 }),
      );
    }
  });

  test("a sub-2.38 git produces the tooOld block state, naming detected/required", async () => {
    const fakeGit = makeFakeGit({ version: "2.30.2" });
    const resolution = await locateGit({ runner, configuredCandidates: [fakeGit] });
    expect(resolution.kind).toBe("tooOld");
    if (resolution.kind === "tooOld") {
      expect(resolution.path).toBe(fakeGit);
      expect(resolution.detected).toEqual(
        expect.objectContaining({ major: 2, minor: 30, patch: 2 }),
      );
      expect(resolution.required).toEqual(MINIMUM_GIT_VERSION);
    }
  });

  test("exactly the floor version resolves ok, not tooOld", async () => {
    const fakeGit = makeFakeGit({ version: "2.38.0" });
    const resolution = await locateGit({ runner, configuredCandidates: [fakeGit] });
    expect(resolution.kind).toBe("ok");
  });

  test("a git that exits non-zero on version is unusable", async () => {
    const fakeGit = makeFakeGit({ behaviour: "exitNonZero" });
    const resolution = await locateGit({ runner, configuredCandidates: [fakeGit] });
    expect(resolution.kind).toBe("unusable");
    if (resolution.kind === "unusable") {
      expect(resolution.stderr).toContain("fake git refuses everything");
    }
  });

  test("a git with unparsable version output is unusable", async () => {
    const fakeGit = makeFakeGit({ behaviour: "garbageOutput" });
    const resolution = await locateGit({ runner, configuredCandidates: [fakeGit] });
    expect(resolution.kind).toBe("unusable");
    if (resolution.kind === "unusable") {
      expect(resolution.reason).toContain("could not parse");
    }
  });

  test("a hanging git times out and is reported unusable, not left to hang the caller", async () => {
    const fakeGit = makeFakeGit({ behaviour: "hang" });
    const resolution = await locateGit({ runner, configuredCandidates: [fakeGit], timeoutMs: 200 });
    expect(resolution.kind).toBe("unusable");
    if (resolution.kind === "unusable") {
      expect(resolution.reason).toContain("did not respond within");
    }
  }, 10_000);

  test("an absent git yields notFound naming everything probed", async () => {
    // Clear PATH too — this machine has a real git on it, and the point of this test is
    // exhausting every resolution step, not accidentally finding the container's own git.
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const resolution = await locateGit({
        runner,
        configuredCandidates: ["/no/such/git-binary"],
        platform: "darwin", // so the macOS fallback candidates are also (harmlessly) exhausted
      });
      expect(resolution.kind).toBe("notFound");
      if (resolution.kind === "notFound") {
        expect(resolution.probed).toContain("/no/such/git-binary");
        expect(resolution.probed.length).toBeGreaterThan(1);
      }
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test("falls through to a later candidate when an earlier one is absent", async () => {
    const goodGit = makeFakeGit({ version: "2.40.0" });
    const resolution = await locateGit({
      runner,
      configuredCandidates: ["/no/such/git-binary", goodGit],
    });
    expect(resolution.kind).toBe("ok");
    if (resolution.kind === "ok") expect(resolution.git.path).toBe(goodGit);
  });

  test("an unsupported platform throws only once genuinely reached", async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(
        locateGit({ runner, configuredCandidates: ["/no/such/git-binary"], platform: "win32" }),
      ).rejects.toThrow(/not supported yet/);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test("the Linux fallback list is reachable and resolves, not a throw", async () => {
    // Unlike the darwin fallback case above (whose /usr/bin/git is gated behind
    // `xcode-select -p`, which fails on this container), the Linux fallback list has no gate
    // and this container has a real, working /usr/bin/git — so reaching the Linux fallbacks
    // here resolves "ok" via that binary rather than exhausting into "notFound". That is a
    // stronger proof the branch works than a synthetic notFound would be: it exercises the
    // real candidate end to end. The important assertion is the one that would fail if W1
    // still threw: this call resolves at all (a throw would reject the promise, not return
    // "ok"), and the resolved path is a Linux fallback candidate — proving the fallback list
    // was actually reached, since PATH is cleared so it cannot have been found any other way.
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const resolution = await locateGit({
        runner,
        configuredCandidates: ["/no/such/git-binary"],
        platform: "linux",
      });
      expect(resolution.kind).toBe("ok");
      if (resolution.kind === "ok") {
        expect(resolution.git.path).toBe("/usr/bin/git");
      }
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test("a real system git resolves and meets the floor (this machine's git)", async () => {
    const resolution = await locateGit({ runner });
    expect(resolution.kind).toBe("ok");
  });
});

describe("resolveRepoIdentity", () => {
  async function resolvedRealGit() {
    const resolution = await locateGit({ runner });
    if (resolution.kind !== "ok") throw new Error("no usable system git found for this test");
    return resolution.git;
  }

  test("a normal repo: root, gitDir, commonDir, and a branch HEAD", async () => {
    const git = await resolvedRealGit();
    const { dir } = linear(1);
    const result = await resolveRepoIdentity(git, runner, dir);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.identity.root).toBe(dir);
      expect(result.identity.isBare).toBe(false);
      expect(result.identity.isLinkedWorktree).toBe(false);
      expect(result.identity.head).toEqual({ kind: "branch", name: "main" });
    }
  });

  test("an unborn repo: HEAD is a symbolic branch with no commit yet", async () => {
    const git = await resolvedRealGit();
    const dir = mkdtempSync(join(tmpdir(), "kira-unborn-"));
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: dir });

    const result = await resolveRepoIdentity(git, runner, dir);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.identity.head).toEqual({ kind: "unborn", name: "main" });
    }
  });

  test("a bare repo: root falls back to the git dir (--show-toplevel has no work tree)", async () => {
    const git = await resolvedRealGit();
    const dir = mkdtempSync(join(tmpdir(), "kira-bare-"));
    execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main"], { cwd: dir });

    const result = await resolveRepoIdentity(git, runner, dir);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.identity.isBare).toBe(true);
      expect(result.identity.root).toBe(result.identity.gitDir);
    }
  });

  test("a linked worktree: gitDir !== commonDir (D12's free detection)", async () => {
    const git = await resolvedRealGit();
    const { dir } = linear(1);
    const worktreeDir = mkdtempSync(join(tmpdir(), "kira-worktree-"));
    execFileSync("git", ["worktree", "add", "--quiet", "-b", "wt", worktreeDir], { cwd: dir });

    const result = await resolveRepoIdentity(git, runner, worktreeDir);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.identity.isLinkedWorktree).toBe(true);
      expect(result.identity.gitDir).not.toBe(result.identity.commonDir);
      expect(result.identity.commonDir).toBe(join(dir, ".git"));
    }
  });

  test("a detached HEAD reports the sha, not a branch name", async () => {
    const git = await resolvedRealGit();
    const { commits, dir } = linear(2);
    const target = commits[0];
    if (target === undefined) throw new Error("expected at least one commit");
    execFileSync("git", ["switch", "--quiet", "--detach", target], { cwd: dir });

    const result = await resolveRepoIdentity(git, runner, dir);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.identity.head).toEqual({ kind: "detached", sha: target });
    }
  });

  test("a directory with no repository at all", async () => {
    const git = await resolvedRealGit();
    const dir = mkdtempSync(join(tmpdir(), "kira-not-a-repo-"));

    const result = await resolveRepoIdentity(git, runner, dir);
    expect(result.kind).toBe("notARepository");
  });

  test("an unmerged conflict repo still resolves identity normally", async () => {
    const git = await resolvedRealGit();
    const { dir } = conflicting();
    try {
      execFileSync("git", ["merge", "--no-gpg-sign", "branch-theirs"], { cwd: dir });
    } catch {
      // Expected: the merge conflicts. Identity resolution should still succeed.
    }
    const result = await resolveRepoIdentity(git, runner, dir);
    expect(result.kind).toBe("ok");
  });
});
