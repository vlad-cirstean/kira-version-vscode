import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilitiesCache, capabilitiesForVersion } from "./capabilities.ts";
import type { GitVersion } from "./discovery.ts";
import { type CatFileSession, openGitDriver } from "./driver.ts";
import { FakeProcessRunner, fakeResolvedGit, flushUntil, noopCatFileSession } from "./testFakes.ts";

function version(major: number, minor: number, patch = 0): GitVersion {
  return { major, minor, patch, raw: `${major}.${minor}.${patch}` };
}

describe("capabilitiesForVersion", () => {
  test("everything is true at the 2.38 floor (all three capability floors are <= 2.38)", () => {
    expect(capabilitiesForVersion(version(2, 38, 0))).toEqual({
      mergeTreeWriteTree: true,
      commitGraph: true,
      sparseCheckout: true,
    });
  });

  test("a version between the sparseCheckout and mergeTreeWriteTree floors", () => {
    expect(capabilitiesForVersion(version(2, 30, 0))).toEqual({
      mergeTreeWriteTree: false,
      commitGraph: true,
      sparseCheckout: true,
    });
  });

  test("a version below every floor", () => {
    expect(capabilitiesForVersion(version(2, 20, 0))).toEqual({
      mergeTreeWriteTree: false,
      commitGraph: false,
      sparseCheckout: false,
    });
  });

  test("a version well above the floor", () => {
    expect(capabilitiesForVersion(version(3, 0, 0))).toEqual({
      mergeTreeWriteTree: true,
      commitGraph: true,
      sparseCheckout: true,
    });
  });
});

describe("CapabilitiesCache — per-binary", () => {
  test("computes once per (path, version) — same key returns the same object", () => {
    const cache = new CapabilitiesCache();
    const first = cache.binaryCapabilities("/usr/bin/git", version(2, 45, 0));
    const second = cache.binaryCapabilities("/usr/bin/git", version(2, 45, 0));
    expect(second).toBe(first); // reference equality: proof it was memoized, not recomputed
  });

  test("a different binary path or version is a different cache entry", () => {
    const cache = new CapabilitiesCache();
    const a = cache.binaryCapabilities("/usr/bin/git", version(2, 45, 0));
    const b = cache.binaryCapabilities("/opt/homebrew/bin/git", version(2, 45, 0));
    const c = cache.binaryCapabilities("/usr/bin/git", version(2, 30, 0));
    expect(b).not.toBe(a);
    expect(c).not.toBe(a);
  });
});

const noopCatFile: CatFileSession = noopCatFileSession();

describe("CapabilitiesCache — per-repo", () => {
  test("computes repo capabilities once per generation (one spawn, not two)", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile);
    const cache = new CapabilitiesCache();
    const identity = {
      root: "/repo",
      gitDir: "/repo/.git",
      commonDir: "/repo/.git",
      isBare: false,
      isLinkedWorktree: false,
      head: { kind: "branch" as const, name: "main" },
    };

    const firstCall = cache.repoCapabilities(driver, identity);
    await flushUntil(() => runner.processes.length >= 1);
    runner.processes[0]?.emitStdout(new TextEncoder().encode("false\n"));
    runner.processes[0]?.finish(0);
    const first = await firstCall;

    // Second call, same generation: must not spawn again.
    const second = await cache.repoCapabilities(driver, identity);
    expect(runner.processes).toHaveLength(1);
    expect(second).toBe(first);
    expect(first.isSparseCheckout).toBe(false);
  });

  test("a write bumping generation invalidates the per-repo cache", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile);
    const cache = new CapabilitiesCache();
    const identity = {
      root: "/repo",
      gitDir: "/repo/.git",
      commonDir: "/repo/.git",
      isBare: false,
      isLinkedWorktree: false,
      head: { kind: "branch" as const, name: "main" },
    };

    const firstCall = cache.repoCapabilities(driver, identity);
    await flushUntil(() => runner.processes.length >= 1);
    runner.processes[0]?.emitStdout(new TextEncoder().encode("false\n"));
    runner.processes[0]?.finish(0);
    await firstCall;
    expect(driver.generation).toBe(0);

    // A completed write bumps generation — a fresh capability read is now expected.
    const writePromise = driver.write(["tag", "v1"]);
    await flushUntil(() => runner.processes.length >= 2);
    runner.processes[1]?.finish(0);
    await writePromise;
    expect(driver.generation).toBe(1);

    const secondCall = cache.repoCapabilities(driver, identity);
    await flushUntil(() => runner.processes.length >= 3);
    runner.processes[2]?.emitStdout(new TextEncoder().encode("true\n"));
    runner.processes[2]?.finish(0);
    const second = await secondCall;
    expect(runner.processes).toHaveLength(3);
    expect(second.isSparseCheckout).toBe(true);
  });

  test("reads sparse-checkout state via driver.read(), not driver.write()", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile);
    const cache = new CapabilitiesCache();
    const identity = {
      root: "/repo",
      gitDir: "/repo/.git",
      commonDir: "/repo/.git",
      isBare: false,
      isLinkedWorktree: false,
      head: { kind: "branch" as const, name: "main" },
    };

    const call = cache.repoCapabilities(driver, identity);
    await flushUntil(() => runner.processes.length >= 1);
    runner.processes[0]?.emitStdout(new TextEncoder().encode("false\n"));
    runner.processes[0]?.finish(0);
    await call;

    const argv = runner.calls[0]?.request.argv ?? [];
    // Reads get --no-optional-locks (driver.ts, W7); writes never do — this is how the test
    // proves the config lookup went through read(), without needing to spy on the driver.
    expect(argv).toContain("--no-optional-locks");
    expect(argv).toContain("core.sparseCheckout");
  });
});

describe("commit-graph presence (via a real temp directory)", () => {
  test("absent when neither the single file nor the chain file exists", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile);
    const cache = new CapabilitiesCache();
    const commonDir = mkdtempSync(join(tmpdir(), "kira-commongraph-"));
    const identity = {
      root: commonDir,
      gitDir: commonDir,
      commonDir,
      isBare: false,
      isLinkedWorktree: false,
      head: { kind: "branch" as const, name: "main" },
    };

    const call = cache.repoCapabilities(driver, identity);
    await flushUntil(() => runner.processes.length >= 1);
    runner.processes[0]?.emitStdout(new TextEncoder().encode("false\n"));
    runner.processes[0]?.finish(0);
    const result = await call;
    expect(result.hasCommitGraph).toBe(false);
  });

  test("present when objects/info/commit-graph exists", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile);
    const cache = new CapabilitiesCache();
    const commonDir = mkdtempSync(join(tmpdir(), "kira-commongraph-"));
    mkdirSync(join(commonDir, "objects", "info"), { recursive: true });
    writeFileSync(join(commonDir, "objects", "info", "commit-graph"), "");
    const identity = {
      root: commonDir,
      gitDir: commonDir,
      commonDir,
      isBare: false,
      isLinkedWorktree: false,
      head: { kind: "branch" as const, name: "main" },
    };

    const call = cache.repoCapabilities(driver, identity);
    await flushUntil(() => runner.processes.length >= 1);
    runner.processes[0]?.emitStdout(new TextEncoder().encode("false\n"));
    runner.processes[0]?.finish(0);
    const result = await call;
    expect(result.hasCommitGraph).toBe(true);
  });

  test("present when only the split chain file exists", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile);
    const cache = new CapabilitiesCache();
    const commonDir = mkdtempSync(join(tmpdir(), "kira-commongraph-"));
    mkdirSync(join(commonDir, "objects", "info", "commit-graphs"), { recursive: true });
    writeFileSync(join(commonDir, "objects", "info", "commit-graphs", "commit-graph-chain"), "");
    const identity = {
      root: commonDir,
      gitDir: commonDir,
      commonDir,
      isBare: false,
      isLinkedWorktree: false,
      head: { kind: "branch" as const, name: "main" },
    };

    const call = cache.repoCapabilities(driver, identity);
    await flushUntil(() => runner.processes.length >= 1);
    runner.processes[0]?.emitStdout(new TextEncoder().encode("false\n"));
    runner.processes[0]?.finish(0);
    const result = await call;
    expect(result.hasCommitGraph).toBe(true);
  });

  test("a linked worktree reads commit-graph presence from the common dir, not its own git dir", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile);
    const cache = new CapabilitiesCache();
    const commonDir = mkdtempSync(join(tmpdir(), "kira-commongraph-common-"));
    const worktreeGitDir = mkdtempSync(join(tmpdir(), "kira-commongraph-wt-"));
    mkdirSync(join(commonDir, "objects", "info"), { recursive: true });
    writeFileSync(join(commonDir, "objects", "info", "commit-graph"), "");
    const identity = {
      root: "/worktree",
      gitDir: worktreeGitDir, // deliberately has no commit-graph of its own
      commonDir,
      isBare: false,
      isLinkedWorktree: true,
      head: { kind: "branch" as const, name: "wt" },
    };

    const call = cache.repoCapabilities(driver, identity);
    await flushUntil(() => runner.processes.length >= 1);
    runner.processes[0]?.emitStdout(new TextEncoder().encode("false\n"));
    runner.processes[0]?.finish(0);
    const result = await call;
    expect(result.hasCommitGraph).toBe(true);
    expect(result.isLinkedWorktree).toBe(true);
  });
});
