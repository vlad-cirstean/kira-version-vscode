import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessRunner, SpawnedProcess, SpawnRequest } from "../../packages/core/src/index.ts";
import { CommitStore, defaultSettings } from "../../packages/core/src/index.ts";
import { FakeLogger } from "../../packages/core/src/ports/testFakes.ts";
import { NodeFileWatcher } from "../../packages/git/src/nodeFileWatcher.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import type { GraphChunkPayload } from "../../packages/git/src/repoService.ts";
import { RepoService } from "../../packages/git/src/repoService.ts";
import { baseEnv, branchy, linear, withRemote } from "../fixtures/generateRepo.ts";

/**
 * `docs/plans/P7.md` W19 — the dedicated integration tier for Branch review's base-resolution and
 * range-walk machinery, against real repositories `generateRepo.ts` builds (not the in-memory
 * `resolveBase` fixtures `packages/core/src/model/review.test.ts` already covers, and not a
 * second copy of everything `repoService.test.ts`'s own "P7 W4" describe blocks already pin).
 *
 * Three things already have thorough real-git coverage elsewhere, and are deliberately NOT
 * re-litigated here beyond a short cross-reference:
 *  - the ranged `LogSession`'s own paging/`remaining()`/`--skip`/staleness mechanics (including
 *    V3, a force-push mid-pause) — `tests/integration/logSession.test.ts`'s own
 *    "range walk (P7 W3)" describe block;
 *  - the D38 isolation claim at full length (a graph walk's `store`/`dictionaryMarks`/
 *    `logSession` untouched by a review walk's entire open/stream/loadMore/end lifecycle on the
 *    same `repoId`) — `repoService.test.ts`'s own "D38 — a review walk never touches the panel's
 *    own graph walk state" test. This file adds its own, smaller instance of the same claim
 *    (below) so the guarantee still has a named home in *this* file, per this plan section's own
 *    text, without repeating that test's full four-step body;
 *  - `resolveReviewBase`'s "override"/self-base-empty/orphan-unrelated/no-candidates-ask paths —
 *    `repoService.test.ts`'s own "RepoService — resolveReviewBase()" describe block.
 *
 * What is new here: every resolution rule §6.8 names, exercised one at a time against a real
 * `for-each-ref` snapshot and real `symbolic-ref`/`merge-base` spawns (rather than the in-memory
 * `ResolveBaseInput` `review.test.ts` hand-builds); the git-log agreement check against a
 * topology with a merge commit inside the range; a *genuinely* fully-merged branch (not the
 * branch-is-its-own-base degenerate case); and V6's other half — a base that plainly does not
 * exist throws rather than reporting `unrelated`.
 */

function settingsWithCandidates(candidates: readonly string[]) {
  return { ...defaultSettings(), "kiraVersion.review.baseCandidates": candidates };
}

async function openService(dir: string, settings = defaultSettings(), runner?: ProcessRunner) {
  const service = await RepoService.create({
    runner: runner ?? new NodeProcessRunner(),
    fileWatcher: new NodeFileWatcher(),
    logger: new FakeLogger(),
    settings,
    configuredGitCandidates: [],
  });
  const opened = await service.open(dir);
  if (opened.kind !== "ok") throw new Error("unreachable: repo failed to open");
  return { service, repoId: opened.repoId };
}

/** `repoService.test.ts`'s own spawn-counting convention (P7 W16), duplicated rather than
 *  imported — that file's `CountingRunner` is not exported, and this one only needs to name
 *  processes by their first argv token (V8 counts `symbolic-ref`/`merge-base`/`rev-list`/`log`
 *  spawns, not argv detail `logSpawnCount`'s narrower filter already covers elsewhere). */
class CountingRunner implements ProcessRunner {
  readonly calls: string[][] = [];
  readonly #inner = new NodeProcessRunner();

  spawn(executable: string, request: SpawnRequest): SpawnedProcess {
    this.calls.push([...request.argv]);
    return this.#inner.spawn(executable, request);
  }

  /** `buildGitArgv` (driver.ts) prefixes every call with `-c` config overrides and `--no-pager`/
   *  `--no-optional-locks`, so the subcommand is never argv[0] — `.includes` rather than an index
   *  check, matched against the exact token so `"log"` never also matches `"--topo-order"`. */
  countOf(subcommand: string): number {
    return this.calls.filter((argv) => argv.includes(subcommand)).length;
  }

  reset(): void {
    this.calls.length = 0;
  }
}

function commitEnv(dir: string) {
  return {
    ...baseEnv(dir),
    GIT_AUTHOR_NAME: "Kira Fixture",
    GIT_AUTHOR_EMAIL: "fixture@kira-version.test",
    GIT_COMMITTER_NAME: "Kira Fixture",
    GIT_COMMITTER_EMAIL: "fixture@kira-version.test",
  };
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, env: baseEnv(dir) }).toString("utf8");
}

function gitCommit(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, env: commitEnv(dir) }).toString("utf8");
}

async function streamRange(
  service: RepoService,
  repoId: string,
  range: { base: string; branch: string },
): Promise<GraphChunkPayload[]> {
  const chunks: GraphChunkPayload[] = [];
  await service.streamGraph(repoId, {
    range,
    onChunk: async (chunk) => {
      chunks.push(chunk);
    },
  });
  return chunks;
}

describe("resolveReviewBase — every §6.8 resolution rule, against a real repo (P7 W19)", () => {
  test("a branch tracking origin/<same-name> falls through rule 1 to defaultBranch", async () => {
    const repo = withRemote();
    // `main` clones tracking `origin/main` by default — same bare name as itself, so rule 1
    // must reject it and fall through to rule 2 (origin/HEAD, which the clone also set up).
    const { service, repoId } = await openService(repo.dir);
    try {
      const resolution = await service.resolveReviewBase(repoId, "main");
      expect(resolution.reason).toBe("defaultBranch");
      expect(resolution.base).toBe("origin/main");
    } finally {
      service.dispose();
    }
  });

  test("a branch tracking origin/develop (a differently-named remote branch) is honoured by rule 1", async () => {
    const repo = withRemote();
    gitCommit(repo.dir, ["checkout", "--quiet", "-b", "develop"]);
    writeFileSync(join(repo.dir, "develop.txt"), "develop\n");
    git(repo.dir, ["add", "develop.txt"]);
    gitCommit(repo.dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "develop commit"]);
    git(repo.dir, ["push", "--quiet", "origin", "develop"]);
    git(repo.dir, ["fetch", "--quiet", "origin"]); // guarantee origin/develop exists as a local ref
    gitCommit(repo.dir, ["checkout", "--quiet", "-b", "topic", "main"]);
    git(repo.dir, ["branch", "--set-upstream-to=origin/develop", "topic"]);

    const { service, repoId } = await openService(repo.dir);
    try {
      const resolution = await service.resolveReviewBase(repoId, "topic");
      expect(resolution.reason).toBe("upstream");
      expect(resolution.base).toBe("origin/develop");
    } finally {
      service.dispose();
    }
  });

  test("a 'gone' upstream (pruned after the fact) falls through exactly like an absent one (V6)", async () => {
    const repo = withRemote();
    gitCommit(repo.dir, ["checkout", "--quiet", "-b", "develop"]);
    writeFileSync(join(repo.dir, "develop.txt"), "develop\n");
    git(repo.dir, ["add", "develop.txt"]);
    gitCommit(repo.dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "develop commit"]);
    git(repo.dir, ["push", "--quiet", "origin", "develop"]);
    git(repo.dir, ["fetch", "--quiet", "origin"]);
    gitCommit(repo.dir, ["checkout", "--quiet", "-b", "topic", "main"]);
    git(repo.dir, ["branch", "--set-upstream-to=origin/develop", "topic"]);
    // Delete `develop` on the remote, then prune: `topic`'s own `branch.topic.merge`/`.remote`
    // config (what `%(upstream)` reads) survives this untouched — only the remote-tracking ref
    // itself disappears, the exact real-git shape of `git branch -vv`'s own "[origin/develop:
    // gone]" — confirmed by asserting `%(upstream:track)` below before trusting the resolution.
    git(repo.dir, ["push", "--quiet", "origin", "--delete", "develop"]);
    git(repo.dir, ["fetch", "--quiet", "--prune", "origin"]);
    const track = git(repo.dir, [
      "for-each-ref",
      "--format=%(upstream:track)",
      "refs/heads/topic",
    ]).trim();
    expect(track).toBe("[gone]");

    const { service, repoId } = await openService(
      repo.dir,
      settingsWithCandidates(["main", "master"]),
    );
    try {
      const resolution = await service.resolveReviewBase(repoId, "topic");
      expect(resolution.reason).toBe("defaultBranch");
      expect(resolution.base).toBe("origin/main");
    } finally {
      service.dispose();
    }
  });

  test("a branch tracking a LOCAL branch (not a remote) is honoured by rule 1", async () => {
    const repo = branchy({ mergeBack: false });
    gitCommit(repo.dir, ["checkout", "--quiet", "-b", "topic", "main"]);
    git(repo.dir, ["branch", "--set-upstream-to=main", "topic"]);

    const { service, repoId } = await openService(repo.dir);
    try {
      const resolution = await service.resolveReviewBase(repoId, "topic");
      expect(resolution.reason).toBe("upstream");
      expect(resolution.base).toBe("main");
    } finally {
      service.dispose();
    }
  });

  test("origin/HEAD set: rule 2 picks it over the main/master candidate list", async () => {
    const repo = withRemote();
    // Both "main" and "master" exist locally, but origin/HEAD (set by the clone, to "main") must
    // win over the candidate list per §6.8's own step 2 ordering (originHead before candidates).
    gitCommit(repo.dir, ["branch", "master", "main"]);
    gitCommit(repo.dir, ["checkout", "--quiet", "-b", "topic", "main"]);

    const { service, repoId } = await openService(
      repo.dir,
      settingsWithCandidates(["main", "master"]),
    );
    try {
      const resolution = await service.resolveReviewBase(repoId, "topic");
      expect(resolution.reason).toBe("defaultBranch");
      expect(resolution.base).toBe("origin/main");
    } finally {
      service.dispose();
    }
  });

  test("origin/HEAD unset: rule 2 falls back to the first existing candidate ('main')", async () => {
    const repo = withRemote();
    git(repo.dir, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    gitCommit(repo.dir, ["checkout", "--quiet", "-b", "topic", "main"]);

    const { service, repoId } = await openService(
      repo.dir,
      settingsWithCandidates(["main", "master"]),
    );
    try {
      const resolution = await service.resolveReviewBase(repoId, "topic");
      expect(resolution.reason).toBe("defaultBranch");
      expect(resolution.base).toBe("main");
    } finally {
      service.dispose();
    }
  });

  test("origin/HEAD dangling (target since pruned): falls through the same as unset (V1)", async () => {
    const repo = withRemote();
    // `git symbolic-ref --short refs/remotes/origin/HEAD` does not verify its target exists — it
    // still prints "origin/main" even after `refs/remotes/origin/main` itself is gone (confirmed
    // empirically), so `detectDefaultBranch` (packages/git/src/queries.ts) returns a real string
    // here, not `undefined`. It is `resolveBase` (core) that must then notice "origin/main" names
    // nothing in the ref snapshot and fall through to the candidate list on its own — this is the
    // "successful-but-nonexistent answer" that function's own doc comment calls out as not
    // `detectDefaultBranch`'s problem to catch.
    git(repo.dir, ["update-ref", "-d", "refs/remotes/origin/main"]);
    gitCommit(repo.dir, ["checkout", "--quiet", "-b", "topic", "main"]);

    const { service, repoId } = await openService(
      repo.dir,
      settingsWithCandidates(["main", "master"]),
    );
    try {
      const resolution = await service.resolveReviewBase(repoId, "topic");
      expect(resolution.reason).toBe("defaultBranch");
      expect(resolution.base).toBe("main");
    } finally {
      service.dispose();
    }
  });

  test("'main' absent, 'master' present: the candidate list's second entry is used", async () => {
    const repo = linear(3);
    git(repo.dir, ["branch", "-m", "main", "master"]); // rename the only branch to "master"
    gitCommit(repo.dir, ["checkout", "--quiet", "-b", "topic", "master"]);
    writeFileSync(join(repo.dir, "topic.txt"), "topic\n");
    git(repo.dir, ["add", "topic.txt"]);
    gitCommit(repo.dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "topic commit"]);

    const { service, repoId } = await openService(
      repo.dir,
      settingsWithCandidates(["main", "master"]),
    );
    try {
      const resolution = await service.resolveReviewBase(repoId, "topic");
      expect(resolution.reason).toBe("defaultBranch");
      expect(resolution.base).toBe("master");
    } finally {
      service.dispose();
    }
  });

  test("neither 'main' nor 'master' present, no upstream, no origin: reports 'none'/'ask'", async () => {
    const repo = linear(3);
    git(repo.dir, ["branch", "-m", "main", "trunk"]);
    gitCommit(repo.dir, ["checkout", "--quiet", "-b", "topic", "trunk"]);
    writeFileSync(join(repo.dir, "topic.txt"), "topic\n");
    git(repo.dir, ["add", "topic.txt"]);
    gitCommit(repo.dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "topic commit"]);

    const { service, repoId } = await openService(
      repo.dir,
      settingsWithCandidates(["main", "master"]),
    );
    try {
      const resolution = await service.resolveReviewBase(repoId, "topic");
      expect(resolution.reason).toBe("none");
      expect(resolution.base).toBeNull();
      expect(resolution.range).toEqual({ kind: "ask" });
    } finally {
      service.dispose();
    }
  });
});

describe("the range walk's rows agree with `git log` itself (P7 W19)", () => {
  test("a range whose history includes a merge commit matches git log --topo-order exactly, in order", async () => {
    const repo = branchy({ mainCommits: 2, featureCommits: 3, mergeBack: false });
    // Merge main into feature/a partway through, so the range base..branch itself contains a
    // merge commit — the case a naive per-parent walk could reorder or double-count.
    gitCommit(repo.dir, ["checkout", "--quiet", "feature/a"]);
    gitCommit(repo.dir, [
      "merge",
      "--no-ff",
      "--no-gpg-sign",
      "-m",
      "merge main into feature/a",
      "main",
    ]);
    writeFileSync(join(repo.dir, "feature-after-merge.txt"), "after merge\n");
    git(repo.dir, ["add", "feature-after-merge.txt"]);
    gitCommit(repo.dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "feature commit after merge"]);

    const expectedShas = git(repo.dir, ["log", "--topo-order", "--format=%H", "main..feature/a"])
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(expectedShas.length).toBeGreaterThan(3); // the merge really is inside the range

    const { service, repoId } = await openService(repo.dir, {
      ...defaultSettings(),
      "kiraVersion.graph.pageSize": 2,
    });
    try {
      const range = { base: "main", branch: "feature/a" };
      // First stream only reads (and emits) the walk's first page; loadMore drives the rest into
      // the walk's own store; a second stream on the same range then replays the now-complete
      // store from row 0 (per `#streamReviewGraph`'s own doc comment) — the only way to observe
      // every row `RepoService`'s public surface offers for a ranged walk.
      await streamRange(service, repoId, range);
      await service.loadMore(repoId, 100, undefined, range);
      const fullChunks = await streamRange(service, repoId, range);

      const store = new CommitStore();
      for (const chunk of fullChunks) store.appendPacked(chunk.commits);
      const shas: string[] = [];
      for (let row = 0; row < store.rowCount; row++) shas.push(store.shaAt(row));
      expect(shas).toEqual(expectedShas);
      expect(service.status(repoId, range)).toEqual({
        loaded: expectedShas.length,
        remaining: 0,
        exhausted: true,
      });
    } finally {
      service.dispose();
    }
  });
});

describe("empty ranges (P7 W19)", () => {
  test("a branch fully merged into its base (via a real merge commit) reports 'empty'", async () => {
    const repo = branchy({ mainCommits: 2, featureCommits: 3, mergeBack: true });
    // branchy({mergeBack: true}) merges feature/a INTO main — main is then ahead of/equal to
    // feature/a's own history, so reviewing feature/a against main has nothing left to show.
    const { service, repoId } = await openService(repo.dir);
    try {
      const resolution = await service.resolveReviewBase(repoId, "feature/a", "main");
      expect(resolution.range).toEqual({ kind: "empty" });
    } finally {
      service.dispose();
    }
  });
});

describe("unrelated histories never open a walk (P7 W19)", () => {
  test("two unrelated root histories report 'unrelated', and status() proves no walk was ever opened", async () => {
    const repo = branchy({ mergeBack: false });
    gitCommit(repo.dir, ["checkout", "--quiet", "--orphan", "orphan-branch"]);
    git(repo.dir, ["rm", "-rf", "--quiet", "."]);
    writeFileSync(join(repo.dir, "orphan.txt"), "orphan\n");
    git(repo.dir, ["add", "orphan.txt"]);
    gitCommit(repo.dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "orphan root"]);
    gitCommit(repo.dir, ["checkout", "--quiet", "main"]);

    const { service, repoId } = await openService(repo.dir);
    try {
      const resolution = await service.resolveReviewBase(repoId, "orphan-branch", "main");
      expect(resolution.range).toEqual({ kind: "unrelated" });

      // No walk was ever created for this range: status() reports the same zeroed shape it would
      // for a range never touched at all, never a partially-initialized one.
      const range = { base: "main", branch: "orphan-branch" };
      expect(service.status(repoId, range)).toEqual({ loaded: 0, remaining: 0, exhausted: false });
    } finally {
      service.dispose();
    }
  });
});

describe("a nonexistent base ref throws rather than reporting 'unrelated' (V6, P7 W19)", () => {
  test("an override base that names no ref at all rejects with a real GitError", async () => {
    const repo = branchy({ mergeBack: false });
    const { service, repoId } = await openService(repo.dir);
    try {
      await expect(
        service.resolveReviewBase(repoId, "feature/a", "totally-bogus-ref-name"),
      ).rejects.toThrow();
    } finally {
      service.dispose();
    }
  });
});

describe("isolation (P7 W19; the full four-step claim lives in repoService.test.ts's own D38 test)", () => {
  test("opening and ending a review walk leaves the panel's own graph status untouched", async () => {
    const repo = branchy({ mainCommits: 4, featureCommits: 3, mergeBack: false });
    const { service, repoId } = await openService(repo.dir, {
      ...defaultSettings(),
      "kiraVersion.graph.pageSize": 2,
    });
    try {
      await service.streamGraph(repoId, { onChunk: async () => {} });
      const graphStatusBefore = service.status(repoId);
      expect(graphStatusBefore.loaded).toBeGreaterThan(0);

      const range = { base: "main", branch: "feature/a" };
      await service.resolveReviewBase(repoId, "feature/a", "main");
      await streamRange(service, repoId, range);
      await service.loadMore(repoId, 10, undefined, range);
      expect(service.status(repoId, range).exhausted).toBe(true);
      service.endReview(repoId);

      expect(service.status(repoId)).toEqual(graphStatusBefore);
    } finally {
      service.dispose();
    }
  });
});

describe("spawn count for one review open (V8, P7 W19)", () => {
  test("resolveReviewBase (defaultBranch path) + the walk's first page: refs cached, one symbolic-ref, merge-base, rev-list --count, and the walk's own two spawns", async () => {
    // The plan's own W21 phrasing bundles "the walk" as one item; empirically it is two spawns —
    // `logSession.ts`'s narrowed staleness guard (`rev-parse <base> <branch>`, W3's own endpoint
    // snapshot) taken before the walk's first `git log` page — so five spawns total is the honest
    // number for one review open on the defaultBranch path, not four. Recorded in Findings.
    const repo = withRemote();
    gitCommit(repo.dir, ["checkout", "--quiet", "-b", "topic", "main"]);
    writeFileSync(join(repo.dir, "topic.txt"), "topic\n");
    git(repo.dir, ["add", "topic.txt"]);
    gitCommit(repo.dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "topic commit"]);

    const runner = new CountingRunner();
    const { service, repoId } = await openService(repo.dir, defaultSettings(), runner);
    try {
      // Warm the refs cache the way a real review-open always finds it already warm (the panel's
      // own `app.init`/`repo.open` populates it first) — excluded from the count below, since V8
      // is asking about the *review*'s own honest cost, not repoding.
      await service.refs(repoId);
      runner.reset();

      const resolution = await service.resolveReviewBase(repoId, "topic");
      expect(resolution.reason).toBe("defaultBranch"); // "topic" has no upstream — the probe
      // falls through, so `detectDefaultBranch` (one `symbolic-ref` spawn) genuinely runs here.
      expect(resolution.base).toBe("origin/main");

      // The resolved base, not the literal setting — `#ensureReviewWalk` keys its
      // `lastReviewResolution` reuse off the exact range object, so the walk must open on
      // `origin/main..topic`, precisely what `resolveReviewBase` itself just computed, or its
      // own `rev-list --count` is wasted and `remaining()` pays for a second one.
      const range = { base: resolution.base as string, branch: "topic" };
      await streamRange(service, repoId, range);

      expect(runner.countOf("for-each-ref")).toBe(0); // refs served from the cache, not respawned
      expect(runner.countOf("symbolic-ref")).toBe(1);
      expect(runner.countOf("merge-base")).toBe(1);
      expect(runner.countOf("rev-list")).toBe(1);
      expect(runner.countOf("rev-parse")).toBe(1); // the walk's own narrowed staleness snapshot
      expect(runner.countOf("log")).toBe(1); // the walk's own first-page spawn
      expect(runner.calls.length).toBe(5);
    } finally {
      service.dispose();
    }
  });

  test("a second resolution for an overridden base adds exactly two spawns (merge-base + rev-list --count)", async () => {
    const repo = withRemote();
    gitCommit(repo.dir, ["checkout", "--quiet", "-b", "develop"]);
    writeFileSync(join(repo.dir, "develop.txt"), "develop\n");
    git(repo.dir, ["add", "develop.txt"]);
    gitCommit(repo.dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "develop commit"]);
    git(repo.dir, ["push", "--quiet", "origin", "develop"]);
    git(repo.dir, ["fetch", "--quiet", "origin"]);
    gitCommit(repo.dir, ["checkout", "--quiet", "-b", "topic", "main"]);
    git(repo.dir, ["branch", "--set-upstream-to=origin/develop", "topic"]);
    writeFileSync(join(repo.dir, "topic.txt"), "topic\n");
    git(repo.dir, ["add", "topic.txt"]);
    gitCommit(repo.dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "topic commit"]);

    const runner = new CountingRunner();
    const { service, repoId } = await openService(repo.dir, defaultSettings(), runner);
    try {
      await service.refs(repoId);
      runner.reset();

      // "topic" tracks "origin/develop" — rule 1's cheap probe (candidates: [], originHead:
      // undefined) already resolves via upstream, so `detectDefaultBranch` never spawns at all,
      // on this call or the next: `#naturalResolution`'s own doc comment ("one spawn, only when
      // rule 1 falls through") means the *override* below repeats the same, now free, probe.
      const first = await service.resolveReviewBase(repoId, "topic");
      expect(first.reason).toBe("upstream");
      expect(runner.countOf("symbolic-ref")).toBe(0);
      expect(runner.calls.length).toBe(2); // merge-base + rev-list --count, nothing else

      runner.reset();
      const overridden = await service.resolveReviewBase(repoId, "topic", "main");
      expect(overridden.reason).toBe("override");
      expect(runner.countOf("symbolic-ref")).toBe(0);
      expect(runner.countOf("for-each-ref")).toBe(0);
      expect(runner.calls.length).toBe(2); // exactly two more: merge-base + rev-list --count
    } finally {
      service.dispose();
    }
  });
});
