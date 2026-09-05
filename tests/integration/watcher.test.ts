import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { locateGit, resolveRepoIdentity } from "../../packages/git/src/discovery.ts";
import { NodeFileWatcher } from "../../packages/git/src/nodeFileWatcher.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { type WatchSignal, watchRepo } from "../../packages/git/src/watcher.ts";
import { baseEnv, linear } from "../fixtures/generateRepo.ts";

const runner = new NodeProcessRunner();

async function resolvedIdentity(dir: string) {
  const gitResolution = await locateGit({ runner });
  if (gitResolution.kind !== "ok") throw new Error("no usable system git found for this test");
  const identityResolution = await resolveRepoIdentity(gitResolution.git, runner, dir);
  if (identityResolution.kind !== "ok") throw new Error("expected a real repository");
  return identityResolution.identity;
}

async function waitForSignal(
  seen: readonly WatchSignal[],
  signal: WatchSignal,
  maxMs = 2000,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!seen.includes(signal) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("watchRepo against a real repository", () => {
  test("git tag produces exactly one refsChanged", async () => {
    const { dir } = linear(1);
    const identity = await resolvedIdentity(dir);
    const fileWatcher = new NodeFileWatcher();
    const repoWatcher = watchRepo(fileWatcher, identity);
    const seen: WatchSignal[] = [];
    repoWatcher.onSignal((signal) => seen.push(signal));
    try {
      execFileSync("git", ["tag", "v1"], { cwd: dir, env: baseEnv(dir) });
      await waitForSignal(seen, "refsChanged");
      await new Promise((resolve) => setTimeout(resolve, 300)); // let any trailing coalescing settle
      expect(seen.filter((signal) => signal === "refsChanged")).toHaveLength(1);
    } finally {
      repoWatcher.dispose();
    }
  }, 10_000);

  test("git branch produces exactly one refsChanged", async () => {
    const { dir } = linear(1);
    const identity = await resolvedIdentity(dir);
    const fileWatcher = new NodeFileWatcher();
    const repoWatcher = watchRepo(fileWatcher, identity);
    const seen: WatchSignal[] = [];
    repoWatcher.onSignal((signal) => seen.push(signal));
    try {
      execFileSync("git", ["branch", "feature"], { cwd: dir, env: baseEnv(dir) });
      await waitForSignal(seen, "refsChanged");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(seen.filter((signal) => signal === "refsChanged")).toHaveLength(1);
    } finally {
      repoWatcher.dispose();
    }
  }, 10_000);

  test("a second update to an already-watched branch ref still produces refsChanged", async () => {
    // Regression guard for P4c W2: on Linux under Node, the recursive `refs/` watch alone can
    // go stale after a ref file's first rename-over and miss the next one — the reason
    // watchRepo() also non-recursively watches refs/heads (etc.) alongside it. This suite runs
    // under Bun, which does not reproduce that staleness (see the manual Node probe recorded
    // in docs/plans/P4c-linux-test-infra.md's Findings), so this test cannot exercise the bug
    // itself — it guards that the fix's extra subscription doesn't regress the ordinary case.
    const { commits, dir } = linear(3);
    execFileSync("git", ["branch", "feature", commits[0] ?? ""], { cwd: dir, env: baseEnv(dir) });
    const identity = await resolvedIdentity(dir);
    const fileWatcher = new NodeFileWatcher();
    const repoWatcher = watchRepo(fileWatcher, identity);
    const seen: WatchSignal[] = [];
    repoWatcher.onSignal((signal) => seen.push(signal));
    try {
      execFileSync("git", ["branch", "-f", "feature", commits[1] ?? ""], {
        cwd: dir,
        env: baseEnv(dir),
      });
      await waitForSignal(seen, "refsChanged");
      expect(seen).toContain("refsChanged");
      seen.length = 0;

      execFileSync("git", ["branch", "-f", "feature", commits[2] ?? ""], {
        cwd: dir,
        env: baseEnv(dir),
      });
      await waitForSignal(seen, "refsChanged");
      expect(seen).toContain("refsChanged");
    } finally {
      repoWatcher.dispose();
    }
  }, 10_000);

  test("a packed-refs rewrite (git pack-refs --all) produces exactly one refsChanged", async () => {
    const { dir } = linear(1);
    execFileSync("git", ["branch", "feature"], { cwd: dir, env: baseEnv(dir) });
    const identity = await resolvedIdentity(dir);
    const fileWatcher = new NodeFileWatcher();
    const repoWatcher = watchRepo(fileWatcher, identity);
    const seen: WatchSignal[] = [];
    repoWatcher.onSignal((signal) => seen.push(signal));
    try {
      execFileSync("git", ["pack-refs", "--all"], { cwd: dir, env: baseEnv(dir) });
      await waitForSignal(seen, "refsChanged");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(seen.filter((signal) => signal === "refsChanged")).toHaveLength(1);
    } finally {
      repoWatcher.dispose();
    }
  }, 10_000);

  test("a REVERT_HEAD write inside a real linked worktree produces refsChanged (D12 regression, P6/W7)", async () => {
    // `git worktree add` gives the new worktree its own gitDir (`<commonDir>/worktrees/<name>`)
    // distinct from the main worktree's commonDir — REVERT_HEAD is written there, not under
    // commonDir, which is exactly the configuration classify()'s old gitDir-only-recognizes-
    // `index` behaviour missed entirely.
    const { dir, commits } = linear(2);
    const linkedDir = join(dir, "..", "linked-for-revert");
    execFileSync("git", ["worktree", "add", linkedDir, "-b", "feature"], {
      cwd: dir,
      env: baseEnv(dir),
    });
    try {
      const identity = await resolvedIdentity(linkedDir);
      expect(identity.isLinkedWorktree).toBe(true);
      expect(identity.gitDir).not.toBe(identity.commonDir);

      const fileWatcher = new NodeFileWatcher();
      const repoWatcher = watchRepo(fileWatcher, identity);
      const seen: WatchSignal[] = [];
      repoWatcher.onSignal((signal) => seen.push(signal));
      let reverting = false;
      try {
        // This container's filesystem-event delivery (see nodeFileWatcher.ts's doc comment on
        // Linux dev-infra quirks — D27 keeps v1 macOS-only) can drop all but one event from a
        // tight burst of writes to the same directory; `git revert --no-commit` writes
        // REVERT_HEAD alongside MERGE_MSG/ORIG_HEAD/index in one such burst. Toggling the
        // revert on and off gives the watch several independent bursts to catch — this doesn't
        // mask a real classify() regression, since no number of retries would ever produce the
        // signal if REVERT_HEAD were still unrecognized under gitDir.
        for (let attempt = 0; attempt < 6 && !seen.includes("refsChanged"); attempt++) {
          if (!reverting) {
            execFileSync("git", ["revert", "--no-commit", commits[1] ?? ""], {
              cwd: linkedDir,
              env: baseEnv(dir),
            });
            reverting = true;
          } else {
            execFileSync("git", ["revert", "--abort"], { cwd: linkedDir, env: baseEnv(dir) });
            reverting = false;
          }
          await waitForSignal(seen, "refsChanged", 500);
        }
        expect(seen).toContain("refsChanged");
      } finally {
        if (reverting) {
          try {
            execFileSync("git", ["revert", "--abort"], { cwd: linkedDir, env: baseEnv(dir) });
          } catch {
            // best-effort cleanup only
          }
        }
        repoWatcher.dispose();
      }
    } finally {
      execFileSync("git", ["-C", dir, "worktree", "remove", "--force", linkedDir]);
    }
  }, 10_000);

  test("git add produces worktreeChanged", async () => {
    const { dir } = linear(1);
    const identity = await resolvedIdentity(dir);
    const fileWatcher = new NodeFileWatcher();
    const repoWatcher = watchRepo(fileWatcher, identity);
    const seen: WatchSignal[] = [];
    repoWatcher.onSignal((signal) => seen.push(signal));
    try {
      writeFileSync(join(dir, "new-file.txt"), "hello");
      execFileSync("git", ["add", "new-file.txt"], { cwd: dir, env: baseEnv(dir) });
      await waitForSignal(seen, "worktreeChanged");
      expect(seen).toContain("worktreeChanged");
    } finally {
      repoWatcher.dispose();
    }
  }, 10_000);
});
