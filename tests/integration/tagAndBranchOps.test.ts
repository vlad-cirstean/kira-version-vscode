import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import type { ProcessRunner, SpawnedProcess, SpawnRequest } from "../../packages/core/src/index.ts";
import { defaultSettings } from "../../packages/core/src/index.ts";
import { FakeLogger } from "../../packages/core/src/ports/testFakes.ts";
import { NodeFileWatcher } from "../../packages/git/src/nodeFileWatcher.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { RepoService } from "../../packages/git/src/repoService.ts";
import { baseEnv, branchy, octopus, withRemote, withWorktree } from "../fixtures/generateRepo.ts";

/** `git tag -a` needs a tagger identity, same as a commit — `baseEnv()` alone (pinned config
 *  sources, no real `~/.gitconfig`) leaves nothing for git to fall back to, so every raw
 *  `git tag -a`/`commit` this file spawns directly (outside `RepoService`, which never needs
 *  one for a read) supplies it explicitly. */
function identityEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv(dir),
    GIT_AUTHOR_NAME: "Kira Fixture",
    GIT_AUTHOR_EMAIL: "fixture@kira-version.test",
    GIT_COMMITTER_NAME: "Kira Fixture",
    GIT_COMMITTER_EMAIL: "fixture@kira-version.test",
  };
}

function settingsWithPageSize(pageSize: number) {
  return { ...defaultSettings(), "kiraVersion.graph.pageSize": pageSize };
}

class CountingRunner implements ProcessRunner {
  readonly calls: string[][] = [];
  readonly #inner = new NodeProcessRunner();

  spawn(executable: string, request: SpawnRequest): SpawnedProcess {
    this.calls.push([...request.argv]);
    return this.#inner.spawn(executable, request);
  }
}

async function openService(dir: string, runner: ProcessRunner = new NodeProcessRunner()) {
  const service = await RepoService.create({
    runner,
    fileWatcher: new NodeFileWatcher(),
    logger: new FakeLogger(),
    settings: settingsWithPageSize(10),
    configuredGitCandidates: [],
  });
  const opened = await service.open(dir);
  if (opened.kind !== "ok") throw new Error("unreachable");
  return { service, repoId: opened.repoId };
}

describe("Tag operations against real git (P6 W21)", () => {
  test("V4: -f -a -m on an existing annotated tag preserves objecttype and lands the new message", async () => {
    const repo = branchy();
    const env = identityEnv(repo.dir);
    execFileSync("git", ["tag", "-a", "v1.0.0", "-m", "first message", "main"], {
      cwd: repo.dir,
      env,
    });
    const before = execFileSync("git", ["cat-file", "-t", "v1.0.0"], {
      cwd: repo.dir,
      env,
      encoding: "utf8",
    }).trim();
    expect(before).toBe("tag");

    const { service, repoId } = await openService(repo.dir);
    try {
      const result = await service.runOp(repoId, {
        kind: "tagCreate",
        name: "v1.0.0",
        target: "main",
        message: "second message",
        force: true,
      });
      expect(result.ok).toBe(true);

      const after = execFileSync("git", ["cat-file", "-t", "v1.0.0"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
      }).trim();
      expect(after).toBe("tag"); // never silently downgraded to lightweight

      const message = execFileSync(
        "git",
        ["for-each-ref", "--format=%(contents:subject)", "refs/tags/v1.0.0"],
        { cwd: repo.dir, env, encoding: "utf8" },
      ).trim();
      expect(message).toBe("second message"); // the new message actually landed, not the old one

      const refs = await service.refs(repoId);
      const tag = refs.tags.find((t) => t.shortName === "v1.0.0");
      expect(tag?.annotation?.subject).toBe("second message");
    } finally {
      service.dispose();
    }
  });

  test("push then remote-delete against a local bare remote: the fetch asymmetry §7.9 now states", async () => {
    const repo = withRemote();
    const env = baseEnv(repo.dir);
    execFileSync("git", ["tag", "v1"], { cwd: repo.dir, env }); // lightweight, on local HEAD

    const { service, repoId } = await openService(repo.dir);
    try {
      const pushed = await service.runOp(repoId, {
        kind: "tagPush",
        remote: "origin",
        names: ["v1"],
      });
      expect(pushed.ok).toBe(true);

      // Local delete does NOT touch the remote.
      const deleted = await service.runOp(repoId, { kind: "tagDelete", name: "v1" });
      expect(deleted.ok).toBe(true);
      const refsAfterDelete = await service.refs(repoId);
      expect(refsAfterDelete.tags.some((t) => t.shortName === "v1")).toBe(false);

      // A plain fetch brings it right back — the asymmetry the corrected §7.9 describes.
      execFileSync("git", ["fetch", "--quiet", "origin"], { cwd: repo.dir, env });
      const restored = execFileSync("git", ["tag", "-l", "v1"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
      }).trim();
      expect(restored).toBe("v1");

      // Only an explicit remote delete removes it for good.
      const remoteDeleted = await service.runOp(repoId, {
        kind: "tagDeleteRemote",
        remote: "origin",
        name: "v1",
      });
      expect(remoteDeleted.ok).toBe(true);
      execFileSync("git", ["tag", "-d", "v1"], { cwd: repo.dir, env }); // re-sync local first
      execFileSync("git", ["fetch", "--quiet", "origin"], { cwd: repo.dir, env });
      const goneForGood = execFileSync("git", ["tag", "-l", "v1"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
      }).trim();
      expect(goneForGood).toBe(""); // this time it does not come back
    } finally {
      service.dispose();
    }
  });
});

describe("Branch operations against real git (P6 W21)", () => {
  test("branchDelete on a branch checked out in another linked worktree refuses with WorktreeConflict", async () => {
    const repo = withWorktree();
    const { service, repoId } = await openService(repo.dir);
    try {
      const result = await service.runOp(repoId, {
        kind: "branchDelete",
        name: repo.branchInWorktree,
        force: true,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("WorktreeConflict");
      // Refused, not merely warned — the branch is still there.
      const refs = await service.refs(repoId);
      expect(refs.branches.some((b) => b.shortName === repo.branchInWorktree)).toBe(true);
    } finally {
      service.dispose();
    }
  });
});

describe("driver.write() serializes two rapid ops in submission order (P6 W22 V6)", () => {
  test("branchCreate then branchDelete, fired back-to-back with no await between them, run in order", async () => {
    const repo = branchy();
    const { service, repoId } = await openService(repo.dir);
    try {
      // Neither call is awaited before the next is issued — exactly the "double-click Checkout"
      // shape V6 asks about. If the write queue did not serialize in submission order, the
      // delete could reach git before the create did and fail with "branch not found"; if it
      // ran the delete against a pre-create read of refs, it could report a stale success. Both
      // resolving `ok: true`, in this order, is only possible if `driver.ts`'s FIFO queue ran
      // the create fully to completion (including RepoService's own post-write read-back)
      // before starting the delete.
      const createPromise = service.runOp(repoId, {
        kind: "branchCreate",
        name: "temp-order-test",
        startPoint: "HEAD",
        checkout: false,
        track: undefined,
      });
      const deletePromise = service.runOp(repoId, {
        kind: "branchDelete",
        name: "temp-order-test",
        force: false,
      });

      const [created, deleted] = await Promise.all([createPromise, deletePromise]);
      expect(created.ok).toBe(true);
      expect(deleted.ok).toBe(true); // only possible if the delete saw the branch the create made

      const refs = await service.refs(repoId);
      expect(refs.branches.some((b) => b.shortName === "temp-order-test")).toBe(false);
    } finally {
      service.dispose();
    }
  });
});

describe("refs.list is exactly two spawns, regardless of ref count (P6 W21 — a correctness invariant, not a budget)", () => {
  test("a repo with many more refs still costs the same two spawns as a small one", async () => {
    const small = branchy();
    const big = octopus();
    const bigEnv = baseEnv(big.dir);
    for (let i = 0; i < 30; i++) {
      execFileSync("git", ["branch", `extra-${i}`, "main"], { cwd: big.dir, env: bigEnv });
      execFileSync("git", ["tag", `tag-${i}`, "main"], { cwd: big.dir, env: bigEnv });
    }

    const smallRunner = new CountingRunner();
    const { service: smallService, repoId: smallRepoId } = await openService(
      small.dir,
      smallRunner,
    );
    const bigRunner = new CountingRunner();
    const { service: bigService, repoId: bigRepoId } = await openService(big.dir, bigRunner);
    try {
      const before1 = smallRunner.calls.length;
      await smallService.refs(smallRepoId);
      const smallSpawns = smallRunner.calls.length - before1;

      const before2 = bigRunner.calls.length;
      const bigRefs = await bigService.refs(bigRepoId);
      const bigSpawns = bigRunner.calls.length - before2;

      expect(bigRefs.branches.length).toBeGreaterThan(25); // the fixture really is much bigger
      expect(smallSpawns).toBe(bigSpawns);
      expect(smallSpawns).toBe(2);
    } finally {
      smallService.dispose();
      bigService.dispose();
    }
  });
});
