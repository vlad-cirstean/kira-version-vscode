import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CommitRecord,
  ProcessRunner,
  SpawnedProcess,
  SpawnRequest,
} from "../../packages/core/src/index.ts";
import { CommitStore, defaultSettings } from "../../packages/core/src/index.ts";
import { FakeLogger } from "../../packages/core/src/ports/testFakes.ts";
import { locateGit, resolveRepoIdentity } from "../../packages/git/src/discovery.ts";
import { GitCancelled } from "../../packages/git/src/errors.ts";
import { openLogSession } from "../../packages/git/src/logSession.ts";
import { NodeFileWatcher } from "../../packages/git/src/nodeFileWatcher.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import type { GraphChunkPayload } from "../../packages/git/src/repoService.ts";
import { RepoService } from "../../packages/git/src/repoService.ts";
import {
  baseEnv,
  branchy,
  conflicting,
  linear,
  withRemote,
  withStash,
} from "../fixtures/generateRepo.ts";

/**
 * W7's own coverage of its "Done when" criteria (open/stream/loadMore/close; a resumed stream
 * spawns nothing; eviction then reveal spawns exactly one; a refsChanged marks stale and the
 * next stream restarts at row 0; a cancelled stream kills nothing a subsequent stream needs).
 * W16 adds the fuller spawn-counting suite the plan promised for this file: open/stream/
 * loadMore/close over `branchy`/`withStash` (not just `linear`), and a row-for-row comparison
 * between a store built from streamed chunks and one built directly from `logSession`.
 */

class CountingRunner implements ProcessRunner {
  readonly calls: Array<{ readonly executable: string; readonly argv: readonly string[] }> = [];
  readonly #inner = new NodeProcessRunner();

  spawn(executable: string, request: SpawnRequest): SpawnedProcess {
    this.calls.push({ executable, argv: request.argv });
    return this.#inner.spawn(executable, request);
  }

  get totalSpawnCount(): number {
    return this.calls.length;
  }

  get logSpawnCount(): number {
    return this.calls.filter((call) => call.argv.includes("log")).length;
  }
}

/**
 * Wraps a real `ProcessRunner` so the first `git log` process' entire stdout is collected and
 * then re-delivered to the reader as two artificial chunks, aborting `controller` between them
 * — deterministic regardless of how the OS actually chunks the pipe (which a real repo's output
 * arriving in a single `read()` would otherwise make this test's "abort strictly mid-page, with
 * some but not all rows already sunk" scenario flaky or untestable). `controller.abort()` runs
 * *before* the first chunk is yielded, so `readPage`'s own abort check (at the top of its loop,
 * before it asks for the next chunk) sees it in time to stop after that one chunk's rows are
 * sunk — not before them, and not after a second chunk sneaks in too.
 */
class MidPageAbortRunner implements ProcessRunner {
  readonly #inner: ProcessRunner;
  readonly #controller: AbortController;
  #armed = true;

  constructor(inner: ProcessRunner, controller: AbortController) {
    this.#inner = inner;
    this.#controller = controller;
  }

  spawn(executable: string, request: SpawnRequest): SpawnedProcess {
    const proc = this.#inner.spawn(executable, request);
    if (!this.#armed || !request.argv.includes("log")) return proc;
    this.#armed = false;
    const controller = this.#controller;

    async function* rechunk(): AsyncGenerator<Uint8Array> {
      const parts: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of proc.stdout) {
        parts.push(chunk);
        total += chunk.length;
      }
      const all = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        all.set(part, offset);
        offset += part.length;
      }
      const mid = Math.max(1, Math.floor(all.length / 2));
      controller.abort();
      yield all.subarray(0, mid);
      yield all.subarray(mid);
    }

    // Not `{ ...proc, stdout: rechunk() }`: `write`/`kill` are prototype methods on the real
    // implementation, so a spread would silently drop them (spread copies only own enumerable
    // properties). Delegating explicitly keeps every other behaviour (kill's grace timer,
    // stderr collection) exactly as the real process provides it.
    return {
      stdout: rechunk(),
      stderr: proc.stderr,
      exit: proc.exit,
      write: (chunk) => proc.write(chunk),
      kill: (signal) => proc.kill(signal),
    };
  }
}

/** Records every argv this session's driver spawns, in order — real git underneath (delegates to
 *  `NodeProcessRunner`), used by the W8 "capture-before-write" ordering test below: a fake driver
 *  would only prove the executor calls the right *methods* in order, not that the read actually
 *  resolves before the write mutates the ref it reads — this proves the real thing. */
class ArgvRecordingRunner implements ProcessRunner {
  readonly argvs: string[][] = [];
  readonly #inner = new NodeProcessRunner();

  spawn(executable: string, request: SpawnRequest): SpawnedProcess {
    this.argvs.push([...request.argv]);
    return this.#inner.spawn(executable, request);
  }
}

function settingsWithPageSize(pageSize: number) {
  return { ...defaultSettings(), "kiraVersion.graph.pageSize": pageSize };
}

async function streamAll(
  service: RepoService,
  repoId: string,
  resumeThroughRow?: number,
  signal?: AbortSignal,
): Promise<GraphChunkPayload[]> {
  const chunks: GraphChunkPayload[] = [];
  await service.streamGraph(repoId, {
    ...(resumeThroughRow !== undefined ? { resumeThroughRow } : {}),
    onChunk: async (chunk) => {
      chunks.push(chunk);
    },
    ...(signal !== undefined ? { signal } : {}),
  });
  return chunks;
}

function totalRows(chunks: readonly GraphChunkPayload[]): number {
  return chunks.reduce((sum, chunk) => sum + (chunk.to - chunk.from), 0);
}

async function waitFor(predicate: () => boolean, maxMs = 5000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The exact rev-set `logSessionArgs("all")` walks (`parse/log.ts`'s `revSetArgs`) — `--all
 *  --glob=refs/stash`, so a stash entry counts here too. Used instead of a hand-derived number
 *  so these tests assert against what git itself considers reachable, not against this file's
 *  own arithmetic. */
function revListAllCount(dir: string): number {
  const out = execFileSync("git", ["rev-list", "--count", "--all", "--glob=refs/stash"], {
    cwd: dir,
    env: baseEnv(dir),
    encoding: "utf8",
  });
  return Number(out.trim());
}

describe("RepoService", () => {
  test("open, stream, loadMore and close over a generated repo", async () => {
    const repo = linear(10);
    const runner = new CountingRunner();
    const service = await RepoService.create({
      runner,
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(3),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      expect(opened.kind).toBe("ok");
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      const first = await streamAll(service, repoId);
      expect(totalRows(first)).toBe(3);
      expect(first.every((chunk) => chunk.source === "git")).toBe(true);
      expect(service.status(repoId)).toEqual({ loaded: 3, remaining: 7, exhausted: false });

      await service.loadMore(repoId, 3);
      expect(service.status(repoId)).toEqual({ loaded: 10, remaining: 0, exhausted: true });

      const second = await streamAll(service, repoId, 3);
      expect(second.every((chunk) => chunk.source === "cache")).toBe(true);
      expect(totalRows(second)).toBe(7);

      service.close(repoId);
      expect(() => service.status(repoId)).toThrow();
    } finally {
      service.dispose();
    }
  });

  test("open() on a non-repository path reports notARepository", async () => {
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(3),
      configuredGitCandidates: [],
    });
    try {
      const notARepo = mkdtempSync(join(tmpdir(), "kira-not-a-repo-"));
      const outcome = await service.open(notARepo);
      expect(outcome.kind).toBe("notARepository");
    } finally {
      service.dispose();
    }
  });

  test("re-opening an already-open root returns the same repoId without duplicating state", async () => {
    const repo = linear(2);
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const first = await service.open(repo.dir);
      const second = await service.open(repo.dir);
      if (first.kind !== "ok" || second.kind !== "ok") throw new Error("unreachable");
      expect(second.repoId).toBe(first.repoId);

      const chunks = await streamAll(service, first.repoId);
      expect(totalRows(chunks)).toBe(2); // exactly one session's worth of rows, not two
    } finally {
      service.dispose();
    }
  });

  test("a resumed streamGraph on the same repo spawns no git process", async () => {
    const repo = linear(6);
    const runner = new CountingRunner();
    const service = await RepoService.create({
      runner,
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");

      await streamAll(service, opened.repoId);
      const spawnsAfterFirstStream = runner.totalSpawnCount;

      const resumed = await streamAll(service, opened.repoId, service.status(opened.repoId).loaded);
      expect(runner.totalSpawnCount).toBe(spawnsAfterFirstStream);
      expect(resumed.every((chunk) => chunk.source === "cache")).toBe(true);
    } finally {
      service.dispose();
    }
  });

  test("eviction then a reveal spawns exactly one git log process", async () => {
    const repo = linear(6);
    const runner = new CountingRunner();
    const service = await RepoService.create(
      {
        runner,
        fileWatcher: new NodeFileWatcher(),
        logger: new FakeLogger(),
        settings: settingsWithPageSize(10),
        configuredGitCandidates: [],
      },
      { evictMs: 20 },
    );
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");

      await streamAll(service, opened.repoId);
      expect(runner.logSpawnCount).toBe(1);

      service.setUiVisible(false);
      await new Promise((resolve) => setTimeout(resolve, 200)); // let the eviction timer fire
      expect(service.status(opened.repoId).loaded).toBe(0); // evicted: store dropped

      service.setUiVisible(true);
      const afterReveal = await streamAll(service, opened.repoId);
      expect(runner.logSpawnCount).toBe(2);
      expect(totalRows(afterReveal)).toBe(6);
    } finally {
      service.dispose();
    }
  }, 10_000);

  test("a refsChanged during a session emits once and the next stream restarts at row 0", async () => {
    const repo = linear(4);
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      await streamAll(service, opened.repoId);
      expect(service.status(opened.repoId).loaded).toBe(4);

      const seen: Array<{ repoId: string; kind: string }> = [];
      service.onChanged((e) => seen.push(e));

      execFileSync("git", ["tag", "v1"], { cwd: repo.dir, env: baseEnv(repo.dir) });
      await waitFor(() => seen.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 300)); // let any trailing coalescing settle
      expect(seen.filter((e) => e.kind === "refsChanged")).toHaveLength(1);

      // The caller's `resumeThroughRow` reflects the pre-reset row count; the service must not
      // trust it once the repo is known stale.
      const restarted = await streamAll(
        service,
        opened.repoId,
        service.status(opened.repoId).loaded,
      );
      expect(restarted[0]?.from).toBe(0);
      expect(restarted.every((chunk) => chunk.source === "git")).toBe(true);
      expect(totalRows(restarted)).toBe(4);
    } finally {
      service.dispose();
    }
  }, 10_000);

  test("a cancelled stream kills nothing a subsequent stream needs", async () => {
    const repo = linear(9);
    const runner = new CountingRunner();
    const service = await RepoService.create({
      runner,
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(4),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");

      const controller = new AbortController();
      let chunkCount = 0;
      await service.streamGraph(opened.repoId, {
        onChunk: async () => {
          chunkCount++;
          controller.abort();
        },
        signal: controller.signal,
      });
      expect(chunkCount).toBe(1);
      expect(service.status(opened.repoId).loaded).toBe(4); // the page already read stays cached

      // The paused `git log` process behind the LogSession must still be alive: a subsequent,
      // uncancelled read continues it rather than respawning.
      await service.loadMore(opened.repoId, 2);
      expect(service.status(opened.repoId)).toEqual({ loaded: 9, remaining: 0, exhausted: true });
      expect(runner.logSpawnCount).toBe(1);
    } finally {
      service.dispose();
    }
  });

  test("open, stream, loadMore and close over a branchy repo", async () => {
    const repo = branchy({ mainCommits: 4, featureCommits: 3, mergeBack: true });
    const total = revListAllCount(repo.dir);
    const runner = new CountingRunner();
    const service = await RepoService.create({
      runner,
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(3),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      expect(opened.kind).toBe("ok");
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      const first = await streamAll(service, repoId);
      expect(totalRows(first)).toBe(3);
      expect(first.every((chunk) => chunk.source === "git")).toBe(true);

      // More pages than strictly needed: the last full page a repo's row count divides evenly
      // into does not by itself reveal exhaustion (§5.1.1 — that needs one more read that comes
      // back empty), and `loadMore`'s own loop already stops early once `exhausted` flips.
      await service.loadMore(repoId, total);
      expect(service.status(repoId)).toEqual({ loaded: total, remaining: 0, exhausted: true });

      const second = await streamAll(service, repoId, 3);
      expect(second.every((chunk) => chunk.source === "cache")).toBe(true);
      expect(totalRows(second)).toBe(total - 3);

      service.close(repoId);
      expect(() => service.status(repoId)).toThrow();
    } finally {
      service.dispose();
    }
  });

  test("open, stream, loadMore and close over a withStash repo", async () => {
    const repo = withStash({ includeUntracked: true });
    // `revSetArgs("all")` globs `refs/stash` too (parse/log.ts), so the stash's own WIP commit
    // (and its extra parents, for the -u variant) are reachable rows here, not just the one real
    // commit `repo.commits` records.
    const total = revListAllCount(repo.dir);
    const runner = new CountingRunner();
    const service = await RepoService.create({
      runner,
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      expect(opened.kind).toBe("ok");
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      const first = await streamAll(service, repoId);
      expect(totalRows(first)).toBe(total);
      expect(service.status(repoId)).toEqual({ loaded: total, remaining: 0, exhausted: true });

      await service.loadMore(repoId, 1); // a no-op past exhaustion, must not spawn or throw
      expect(service.status(repoId)).toEqual({ loaded: total, remaining: 0, exhausted: true });

      service.close(repoId);
      expect(() => service.status(repoId)).toThrow();
    } finally {
      service.dispose();
    }
  });

  test("the store built from streamed chunks matches one built directly from logSession, row for row", async () => {
    const repo = branchy({ mainCommits: 5, featureCommits: 4, mergeBack: true });
    const runner = new NodeProcessRunner();
    const service = await RepoService.create({
      runner,
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(3),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      const chunks = await streamAll(service, repoId); // one page from git (pageSize 3)
      const firstCount = totalRows(chunks);
      // More pages than strictly needed — `loadMore`'s own loop stops early once exhausted.
      await service.loadMore(repoId, revListAllCount(repo.dir));
      // Every row loaded since the first stream, replayed from the store's cache — the first
      // stream already emitted rows [0, firstCount) as "git" chunks, so this resumes from there.
      const rest = await streamAll(service, repoId, firstCount);
      const allChunks = [...chunks, ...rest];

      const streamedStore = new CommitStore();
      for (const chunk of allChunks) streamedStore.appendPacked(chunk.commits);

      const gitResolution = await locateGit({ runner });
      if (gitResolution.kind !== "ok") throw new Error("no usable system git found for this test");
      const identityResolution = await resolveRepoIdentity(gitResolution.git, runner, repo.dir);
      if (identityResolution.kind !== "ok") throw new Error("expected a real repository");

      const session = openLogSession(gitResolution.git, runner, identityResolution.identity.root, {
        scope: "all",
      });
      const records: CommitRecord[] = [];
      try {
        for (;;) {
          const outcome = await session.readPage((record) => records.push(record));
          if (outcome.kind === "stale")
            throw new Error("unreachable: nothing else touches this repo");
          if (outcome.exhausted) break;
        }
      } finally {
        session.dispose();
      }
      const directStore = new CommitStore();
      directStore.appendPage(records);

      expect(streamedStore.rowCount).toBe(directStore.rowCount);
      expect(streamedStore.rowCount).toBe(revListAllCount(repo.dir));
      for (let row = 0; row < directStore.rowCount; row++) {
        expect(streamedStore.commitAt(row)).toEqual(directStore.commitAt(row));
      }
    } finally {
      service.dispose();
    }
  });

  // W2's regression suite: `dictionaryMarks` replacing a single `dictionaryCursor`, cancellable
  // `loadMore`, and `refresh()`.

  test("a resumeThroughRow:0 stream always replays correctly into a brand-new CommitStore, even well after the session has streamed and cached far more", async () => {
    const repo = linear(12);
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(3),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      // A replay taken right after the very first page lands, while the session's dictionary
      // state is still small.
      await streamAll(service, repoId);
      const earlyReplayChunks = await streamAll(service, repoId, 0);
      const earlyStore = new CommitStore();
      for (const chunk of earlyReplayChunks) earlyStore.appendPacked(chunk.commits);

      // Load everything and drain a full cache replay too, advancing the session's internal
      // dictionary state far past where it was for the replay above.
      await service.loadMore(repoId, 10);
      await streamAll(service, repoId, service.status(repoId).loaded);
      expect(service.status(repoId)).toEqual({ loaded: 12, remaining: 0, exhausted: true });

      // A second, independent resumeThroughRow:0 replay taken well after the above — it must
      // still be self-consistent from a fresh dictionary base of 0, not whatever the session's
      // marks have advanced to internally in the meantime (the bug a single running
      // `dictionaryCursor` had: it would hand a `from: 0` chunk the *current*, far-advanced
      // cursor as its dictionary base instead of 0).
      const lateReplayChunks = await streamAll(service, repoId, 0);
      const lateStore = new CommitStore();
      for (const chunk of lateReplayChunks) lateStore.appendPacked(chunk.commits);

      expect(earlyStore.rowCount).toBe(3);
      expect(lateStore.rowCount).toBe(12);
      for (let row = 0; row < earlyStore.rowCount; row++) {
        expect(lateStore.commitAt(row)).toEqual(earlyStore.commitAt(row));
      }
    } finally {
      service.dispose();
    }
  });

  test("resuming at a real chunk boundary appends onto a store holding exactly those rows", async () => {
    const repo = linear(8);
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(3),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      const first = await streamAll(service, repoId); // rows [0, 3) — a recorded mark at 3
      expect(totalRows(first)).toBe(3);
      const store = new CommitStore();
      for (const chunk of first) store.appendPacked(chunk.commits);
      expect(store.rowCount).toBe(3);

      await service.loadMore(repoId, 10); // load the rest into the session's own cache

      // Resume exactly at the boundary the first stream's chunks left the store at.
      const second = await streamAll(service, repoId, 3);
      expect(second[0]?.from).toBe(3);
      for (const chunk of second) store.appendPacked(chunk.commits);
      expect(store.rowCount).toBe(8);

      // Cross-check against a store built from a full resumeThroughRow:0 replay.
      const full = await streamAll(service, repoId, 0);
      const fullStore = new CommitStore();
      for (const chunk of full) fullStore.appendPacked(chunk.commits);
      for (let row = 0; row < store.rowCount; row++) {
        expect(store.commitAt(row)).toEqual(fullStore.commitAt(row));
      }
    } finally {
      service.dispose();
    }
  });

  test("resuming at a row with no recorded mark replays from row 0 instead of guessing", async () => {
    const repo = linear(5);
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10), // bigger than the repo: the whole fixture arrives as
      // a single chunk, so only rows {0, 5} ever get a dictionary mark — row 1 has none.
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      const first = await streamAll(service, repoId);
      expect(first).toHaveLength(1);
      expect(totalRows(first)).toBe(5);

      const resumed = await streamAll(service, repoId, 1); // row 1 has no mark
      expect(resumed[0]?.from).toBe(0); // falls back to a full replay from 0, not a guess
      expect(totalRows(resumed)).toBe(5);
    } finally {
      service.dispose();
    }
  });

  test("refresh() forces the next stream to re-walk from row 0 and spawns exactly one new git log process", async () => {
    const repo = linear(6);
    const runner = new CountingRunner();
    const service = await RepoService.create({
      runner,
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      await streamAll(service, repoId);
      expect(runner.logSpawnCount).toBe(1);
      expect(service.status(repoId)).toEqual({ loaded: 6, remaining: 0, exhausted: true });

      expect(service.refresh("no-such-repo")).toBe(false);
      expect(service.refresh(repoId)).toBe(true);

      const restarted = await streamAll(service, repoId, service.status(repoId).loaded);
      expect(runner.logSpawnCount).toBe(2);
      expect(restarted[0]?.from).toBe(0);
      expect(restarted.every((chunk) => chunk.source === "git")).toBe(true);
      expect(totalRows(restarted)).toBe(6);
      expect(service.status(repoId)).toEqual({ loaded: 6, remaining: 0, exhausted: true });
    } finally {
      service.dispose();
    }
  });

  test("a loadMore aborted mid-page leaves the session usable, with the already-sunk rows readable", async () => {
    const repo = linear(20);
    const total = revListAllCount(repo.dir);
    const controller = new AbortController();
    const runner = new MidPageAbortRunner(new NodeProcessRunner(), controller);
    const service = await RepoService.create({
      runner,
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      // The whole walk is one page, so the abort lands squarely inside a single readPage()
      // call rather than at a page boundary.
      settings: settingsWithPageSize(total),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      await expect(service.loadMore(repoId, 1, controller.signal)).rejects.toBeInstanceOf(
        GitCancelled,
      );

      const partial = service.status(repoId).loaded;
      expect(partial).toBeGreaterThan(0);
      expect(partial).toBeLessThan(total);

      // The session is still usable: an uncancelled loadMore resumes via `--skip` from the
      // partial page rather than needing anything reset, and reaches full exhaustion.
      await service.loadMore(repoId, 5);
      expect(service.status(repoId)).toEqual({ loaded: total, remaining: 0, exhausted: true });
    } finally {
      service.dispose();
    }
  }, 10_000);
});

// ---------------------------------------------------------------------------------------
// P5 W3: detail, fileDiff, blob, worktreeDiff, pathExistsInCheckout — against real repositories.
// `linear(n)`'s commits each fully replace file.txt's one line ("line 0\n" -> "line 1\n" -> …),
// which is a genuine +1/-1 modification, not a whole-file add: exactly what exercises the P1
// rename/numstat fix's sibling case (an ordinary one-line edit) end to end through this layer.
// packages/git/src/repoService.test.ts covers the two LRU caches themselves directly; W16 adds
// the full "Go to file" four-case matrix and drift re-map progression once rpcHandlers exists.
// ---------------------------------------------------------------------------------------

describe("RepoService — commit detail (P5 W3)", () => {
  test("detail() returns metadata, body, files and parentIndex, and is cached until refsChanged", async () => {
    const repo = linear(3);
    const runner = new CountingRunner();
    const service = await RepoService.create({
      runner,
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;
      const sha0 = repo.commits[0];
      const sha1 = repo.commits[1];
      if (!sha0 || !sha1) throw new Error("unreachable");

      const detail = await service.detail(repoId, sha1);
      expect(detail.sha).toBe(sha1);
      expect(detail.parentIndex).toBe(0);
      expect(detail.parents).toEqual([sha0]);
      expect(detail.subject).toBe("commit 1");
      expect(detail.files).toEqual([
        {
          kind: "modified",
          path: "file.txt",
          originalPath: undefined,
          similarity: undefined,
          additions: 1,
          deletions: 1,
          isBinary: false,
        },
      ]);

      const spawnsAfterFirst = runner.totalSpawnCount;
      const second = await service.detail(repoId, sha1);
      expect(second).toEqual(detail);
      expect(runner.totalSpawnCount).toBe(spawnsAfterFirst); // served from the cache, no new spawn

      const seen: Array<{ repoId: string; kind: string }> = [];
      service.onChanged((e) => seen.push(e));
      execFileSync("git", ["tag", "v1"], { cwd: repo.dir, env: baseEnv(repo.dir) });
      await waitFor(() => seen.some((e) => e.kind === "refsChanged"));

      const third = await service.detail(repoId, sha1);
      expect(third).toEqual(detail); // same content
      expect(runner.totalSpawnCount).toBeGreaterThan(spawnsAfterFirst); // but re-fetched, not cached
    } finally {
      service.dispose();
    }
  }, 10_000);

  test("detail() on a root commit reports an empty parents array and parentIndex 0", async () => {
    const repo = linear(1);
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const sha0 = repo.commits[0];
      if (!sha0) throw new Error("unreachable");

      const detail = await service.detail(opened.repoId, sha0);
      expect(detail.parents).toEqual([]);
      expect(detail.parentIndex).toBe(0);
      expect(detail.files).toEqual([
        {
          kind: "added",
          path: "file.txt",
          originalPath: undefined,
          similarity: undefined,
          additions: 1,
          deletions: 0,
          isBinary: false,
        },
      ]);
    } finally {
      service.dispose();
    }
  });

  test("a cancelled detail() request kills its processes; a subsequent one still succeeds", async () => {
    const repo = linear(2);
    const runner = new CountingRunner();
    const service = await RepoService.create({
      runner,
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const sha1 = repo.commits[1];
      if (!sha1) throw new Error("unreachable");

      const controller = new AbortController();
      controller.abort();
      await expect(
        service.detail(opened.repoId, sha1, 0, controller.signal),
      ).rejects.toBeInstanceOf(GitCancelled);

      // The superseded request must not have poisoned the cache or left anything unusable.
      const detail = await service.detail(opened.repoId, sha1);
      expect(detail.sha).toBe(sha1);
    } finally {
      service.dispose();
    }
  });
});

describe("RepoService — per-file diff (P5 W3)", () => {
  test("fileDiff() returns the text hunks for an ordinary modification, and is cached", async () => {
    const repo = linear(3);
    const runner = new CountingRunner();
    const service = await RepoService.create({
      runner,
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;
      const sha1 = repo.commits[1];
      if (!sha1) throw new Error("unreachable");

      const diff = await service.fileDiff(repoId, sha1, "file.txt", undefined);
      expect(diff.sha).toBe(sha1);
      expect(diff.parentIndex).toBe(0);
      expect(diff.baseSha).toBe(repo.commits[0] ?? null);
      expect(diff.change.path).toBe("file.txt");
      expect(diff.change.kind).toBe("modified");
      expect(diff.body.kind).toBe("text");
      if (diff.body.kind !== "text") throw new Error("unreachable");
      expect(diff.body.hunks).toHaveLength(1);
      expect(diff.body.hunks[0]?.lines.map((l) => [l.kind, l.text])).toEqual([
        ["del", "line 0"],
        ["add", "line 1"],
      ]);

      const spawnsAfterFirst = runner.totalSpawnCount;
      const cached = await service.fileDiff(repoId, sha1, "file.txt", undefined);
      expect(cached).toEqual(diff);
      expect(runner.totalSpawnCount).toBe(spawnsAfterFirst); // served from the diff cache
    } finally {
      service.dispose();
    }
  });

  test("fileDiff() on a root commit reports baseSha null and an added file", async () => {
    const repo = linear(1);
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const sha0 = repo.commits[0];
      if (!sha0) throw new Error("unreachable");

      const diff = await service.fileDiff(opened.repoId, sha0, "file.txt", undefined);
      expect(diff.baseSha).toBeNull();
      expect(diff.change.kind).toBe("added");
      expect(diff.body.kind).toBe("text");
    } finally {
      service.dispose();
    }
  });

  test("fileDiff() rejects a path that is not one of the commit's changed files", async () => {
    const repo = linear(2);
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const sha1 = repo.commits[1];
      if (!sha1) throw new Error("unreachable");

      await expect(
        service.fileDiff(opened.repoId, sha1, "nonexistent.txt", undefined),
      ).rejects.toThrow();
    } finally {
      service.dispose();
    }
  });

  test("the diff cache evicts the least-recently-used entry once the byte cap is exceeded", async () => {
    const repo = linear(6);
    const runner = new CountingRunner();
    // Small enough that at most a couple of these tiny one-line patches fit at once.
    const service = await RepoService.create(
      {
        runner,
        fileWatcher: new NodeFileWatcher(),
        logger: new FakeLogger(),
        settings: settingsWithPageSize(10),
        configuredGitCandidates: [],
      },
      { diffCacheMaxBytes: 1 },
    );
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;
      const sha1 = repo.commits[1];
      const sha2 = repo.commits[2];
      if (!sha1 || !sha2) throw new Error("unreachable");

      await service.fileDiff(repoId, sha1, "file.txt", undefined);
      const spawnsAfterFirst = runner.totalSpawnCount;
      await service.fileDiff(repoId, sha2, "file.txt", undefined); // evicts sha1's entry
      const spawnsAfterSecond = runner.totalSpawnCount;
      expect(spawnsAfterSecond).toBeGreaterThan(spawnsAfterFirst);

      await service.fileDiff(repoId, sha1, "file.txt", undefined); // must re-spawn, not hit
      expect(runner.totalSpawnCount).toBeGreaterThan(spawnsAfterSecond);
    } finally {
      service.dispose();
    }
  });
});

describe("RepoService — blob() (P5 W3)", () => {
  test("found: decodes a text blob's content", async () => {
    const repo = linear(2);
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const sha1 = repo.commits[1];
      if (!sha1) throw new Error("unreachable");

      const result = await service.blob(opened.repoId, sha1, "file.txt");
      expect(result).toEqual({ kind: "found", content: "line 1\n" });
    } finally {
      service.dispose();
    }
  });

  test("missing: a path that does not exist at that revision", async () => {
    const repo = linear(1);
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const sha0 = repo.commits[0];
      if (!sha0) throw new Error("unreachable");

      const result = await service.blob(opened.repoId, sha0, "nonexistent.txt");
      expect(result).toEqual({ kind: "missing" });
    } finally {
      service.dispose();
    }
  });

  test("binary: a NUL byte in the first 8 KB is reported as binary, not decoded", async () => {
    const repo = linear(1);
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");

      writeFileSync(join(repo.dir, "image.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
      execFileSync("git", ["add", "image.bin"], { cwd: repo.dir, env: baseEnv(repo.dir) });
      execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "-m", "add a binary file"], {
        cwd: repo.dir,
        env: {
          ...baseEnv(repo.dir),
          GIT_AUTHOR_NAME: "Kira Fixture",
          GIT_AUTHOR_EMAIL: "fixture@kira-version.test",
          GIT_AUTHOR_DATE: "1700100000 +0000",
          GIT_COMMITTER_NAME: "Kira Fixture",
          GIT_COMMITTER_EMAIL: "fixture@kira-version.test",
          GIT_COMMITTER_DATE: "1700100000 +0000",
        },
      });
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo.dir,
        env: baseEnv(repo.dir),
        encoding: "utf8",
      }).trim();

      const result = await service.blob(opened.repoId, headSha, "image.bin");
      expect(result).toEqual({ kind: "binary" });
    } finally {
      service.dispose();
    }
  });
});

describe("RepoService — worktreeDiff() and pathExistsInCheckout() (P5 W3)", () => {
  test("worktreeDiff(): null for a file identical to <rev>, hunks once it drifts on disk", async () => {
    const repo = linear(2);
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const sha1 = repo.commits[1];
      if (!sha1) throw new Error("unreachable");

      const unchanged = await service.worktreeDiff(opened.repoId, sha1, "file.txt");
      expect(unchanged).toBeNull();

      writeFileSync(join(opened.identity.root, "file.txt"), "line 1\nline 1.5\n");
      const hunks = await service.worktreeDiff(opened.repoId, sha1, "file.txt");
      expect(hunks).not.toBeNull();
      expect(hunks?.flatMap((h) => h.lines.map((l) => l.text))).toContain("line 1.5");
    } finally {
      service.dispose();
    }
  });

  test("worktreeDiff(): null for an untracked file, even though it exists on disk", async () => {
    const repo = linear(1);
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const sha0 = repo.commits[0];
      if (!sha0) throw new Error("unreachable");

      writeFileSync(join(opened.identity.root, "untracked.txt"), "hello\n");
      expect(service.pathExistsInCheckout(opened.repoId, "untracked.txt")).toBe(true);

      const result = await service.worktreeDiff(opened.repoId, sha0, "untracked.txt");
      expect(result).toBeNull();
    } finally {
      service.dispose();
    }
  });

  test("pathExistsInCheckout(): true for a real file, false for a missing one, false for path traversal", async () => {
    const repo = linear(1);
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      expect(service.pathExistsInCheckout(repoId, "file.txt")).toBe(true);
      expect(service.pathExistsInCheckout(repoId, "nonexistent.txt")).toBe(false);
      expect(service.pathExistsInCheckout(repoId, "../../etc/passwd")).toBe(false);
      expect(service.pathExistsInCheckout(repoId, "/etc/passwd")).toBe(false);
    } finally {
      service.dispose();
    }
  });
});

/**
 * P6/W8's own coverage, against real repositories and real git: `refs()`'s cache and its
 * invalidation, `statusSummary()`'s fold and its display cap, both pre-flights' orchestration
 * (including the two hard cases — a bare remote-tracking target and a linked-worktree conflict),
 * the executor's ordering/failure/undo behaviour, and the undo slot round trip.
 */
describe("RepoService — refs() (P6 W8)", () => {
  test("branches/remoteBranches/tags and head from a real repo; cache drops on the next write", async () => {
    const repo = branchy();
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      const first = await service.refs(repoId);
      expect(first.branches.map((b) => b.shortName).sort()).toEqual(["feature/a", "main"]);
      expect(first.head).toEqual({ kind: "branch", name: "main" });
      expect(first.branches.find((b) => b.shortName === "topic")).toBeUndefined();

      // Same object back on a second call with no write in between — the cache, not a re-fetch.
      const cached = await service.refs(repoId);
      expect(cached).toBe(first);

      const created = await service.runOp(repoId, {
        kind: "branchCreate",
        name: "topic",
        startPoint: "main",
        checkout: false,
        track: undefined,
      });
      expect(created.ok).toBe(true);

      const second = await service.refs(repoId);
      expect(second).not.toBe(first);
      expect(second.branches.some((b) => b.shortName === "topic")).toBe(true);
    } finally {
      service.dispose();
    }
  });
});

describe("RepoService — statusSummary() (P6 W8)", () => {
  test("a clean repo reports isClean with zero counts and no dirty paths", async () => {
    const repo = linear(1);
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const summary = await service.statusSummary(opened.repoId);
      expect(summary.isClean).toBe(true);
      expect(summary.dirtyPaths).toEqual([]);
      expect(summary.dirtyTruncated).toBe(false);
      expect(summary.counts).toEqual({ staged: 0, unstaged: 0, untracked: 0, unmerged: 0 });
      expect(summary.head).toEqual({ kind: "branch", name: "main" });
    } finally {
      service.dispose();
    }
  });

  test("a dirty tracked file is counted and named", async () => {
    const repo = linear(1);
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      writeFileSync(join(opened.identity.root, "file.txt"), "changed\n");
      const summary = await service.statusSummary(opened.repoId);
      expect(summary.isClean).toBe(false);
      expect(summary.counts.unstaged).toBe(1);
      expect(summary.dirtyPaths).toEqual(["file.txt"]);
    } finally {
      service.dispose();
    }
  });

  test("dirtyPaths truncates at 200 for display while counts report the true total", async () => {
    const repo = linear(1);
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const total = 250;
      for (let i = 0; i < total; i++) {
        writeFileSync(
          join(opened.identity.root, `untracked-${String(i).padStart(4, "0")}.txt`),
          "x\n",
        );
      }
      const summary = await service.statusSummary(opened.repoId);
      expect(summary.dirtyPaths.length).toBe(200);
      expect(summary.dirtyTruncated).toBe(true);
      expect(summary.counts.untracked).toBe(total); // the verdict-relevant count is never capped
    } finally {
      service.dispose();
    }
  });
});

describe("RepoService — preflightCheckout() (P6 W8)", () => {
  test("a plain switch on a clean tree is verdict clean with no blockers", async () => {
    const repo = branchy();
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const preflight = await service.preflightCheckout(opened.repoId, "feature/a", "switch");
      expect(preflight.verdict).toBe("clean");
      expect(preflight.blockers).toEqual([]);
      expect(preflight.detaches).toBe(false);
      expect(preflight.target).toEqual({ kind: "branch", name: "feature/a" });
    } finally {
      service.dispose();
    }
  });

  test("a dirty tracked file the target would rewrite blocks with blockedByTracked", async () => {
    const repo = conflicting(); // main and branch-theirs both touch conflict.txt
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      writeFileSync(join(opened.identity.root, "conflict.txt"), "dirty local edit\n");
      const preflight = await service.preflightCheckout(opened.repoId, "branch-theirs", "switch");
      expect(preflight.verdict).toBe("blocked");
      expect(preflight.blockers).toEqual([{ kind: "blockedByTracked", paths: ["conflict.txt"] }]);
      expect(preflight.routes).toEqual(["discard"]);
    } finally {
      service.dispose();
    }
  });

  test("detach mode on a tag always detaches, regardless of the requested mode", async () => {
    const repo = branchy();
    execFileSync("git", ["tag", "v1.0.0", "main"], { cwd: repo.dir, env: baseEnv(repo.dir) });
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const preflight = await service.preflightCheckout(opened.repoId, "v1.0.0", "switch");
      expect(preflight.detaches).toBe(true);
      expect(preflight.target.kind).toBe("tag");
    } finally {
      service.dispose();
    }
  });

  test("a bare remote-tracking target (no local counterpart) offers createsTracking in switch mode, and plain detach in detach mode", async () => {
    const repo = withRemote();
    // Push a branch to the remote, then remove the local copy but keep the fetched remote-tracking ref —
    // the exact DWIM case probe P7 describes (a `origin/topic` with no local `topic`).
    const env = baseEnv(repo.dir);
    execFileSync("git", ["branch", "topic", "main"], { cwd: repo.dir, env });
    execFileSync("git", ["push", "--quiet", "origin", "topic"], { cwd: repo.dir, env });
    execFileSync("git", ["branch", "-D", "topic"], { cwd: repo.dir, env });
    execFileSync("git", ["fetch", "--quiet", "origin"], { cwd: repo.dir, env });

    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      const switchPreflight = await service.preflightCheckout(repoId, "origin/topic", "switch");
      expect(switchPreflight.target).toEqual({ kind: "remoteBranch", name: "origin/topic" });
      expect(switchPreflight.detaches).toBe(false);
      expect(switchPreflight.createsTracking).toEqual({
        branch: "topic",
        upstream: "origin/topic",
      });

      const detachPreflight = await service.preflightCheckout(repoId, "origin/topic", "detach");
      expect(detachPreflight.detaches).toBe(true);
      expect(detachPreflight.createsTracking).toBeUndefined();
    } finally {
      service.dispose();
    }
  });

  test("a target checked out in another linked worktree reports worktreeConflict, not for this session's own checkout", async () => {
    const repo = branchy();
    const env = baseEnv(repo.dir);
    const worktreeDir = mkdtempSync(join(tmpdir(), "kira-worktree-"));
    execFileSync("git", ["worktree", "add", "--quiet", worktreeDir, "feature/a"], {
      cwd: repo.dir,
      env,
    });

    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      // feature/a is checked out ELSEWHERE (the linked worktree) — blocked.
      const otherBranch = await service.preflightCheckout(repoId, "feature/a", "switch");
      expect(otherBranch.blockers.some((b) => b.kind === "worktreeConflict")).toBe(true);

      // main is checked out in THIS session's own worktree — never reported as a conflict
      // against itself (D12's own-worktree subtraction).
      const ownBranch = await service.preflightCheckout(repoId, "main", "switch");
      expect(ownBranch.blockers.some((b) => b.kind === "worktreeConflict")).toBe(false);
    } finally {
      service.dispose();
    }
  });
});

describe("RepoService — preflightRevert() (P6 W8)", () => {
  test("reverting a plain (non-merge) commit needs no mainline and predicts clean", async () => {
    const repo = branchy({ mergeBack: false });
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const lastMainCommit = repo.commits[repo.commits.length - 1];
      if (!lastMainCommit) throw new Error("unreachable");

      const preflight = await service.preflightRevert(opened.repoId, [lastMainCommit]);
      expect(preflight.mainlineRequired).toEqual([]);
      expect(preflight.verdict).toBe("clean");
      expect(preflight.prediction.kind).toBe("clean");
      expect(preflight.predictedFor).toBe(lastMainCommit);
    } finally {
      service.dispose();
    }
  });

  test("reverting a merge commit with no mainline chosen blocks on mainlineRequired, with real parent data", async () => {
    const repo = branchy({ mergeBack: true });
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const mergeSha = repo.refs.main;
      if (!mergeSha) throw new Error("unreachable");

      const preflight = await service.preflightRevert(opened.repoId, [mergeSha]);
      expect(preflight.blockers).toContain("mainlineRequired");
      expect(preflight.verdict).toBe("blocked");
      expect(preflight.mainlineRequired).toHaveLength(1);
      expect(preflight.mainlineRequired[0]?.sha).toBe(mergeSha);
      expect(preflight.mainlineRequired[0]?.parents.length).toBe(2); // branchy's merge has 2 parents
      expect(preflight.prediction.kind).toBe("unknown"); // no mainline yet ⇒ nothing to predict

      // Once a mainline is supplied, prediction proceeds and the blocker clears.
      const withMainline = await service.preflightRevert(opened.repoId, [mergeSha], 1);
      expect(withMainline.blockers).not.toContain("mainlineRequired");
      expect(
        withMainline.prediction.kind === "clean" || withMainline.prediction.kind === "conflicts",
      ).toBe(true);
    } finally {
      service.dispose();
    }
  });

  test("a dirty worktree blocks a revert regardless of the prediction", async () => {
    const repo = branchy({ mergeBack: false });
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      writeFileSync(join(opened.identity.root, "main.txt"), "dirty\n");
      const lastCommit = repo.commits[repo.commits.length - 1];
      if (!lastCommit) throw new Error("unreachable");

      const preflight = await service.preflightRevert(opened.repoId, [lastCommit]);
      expect(preflight.blockers).toContain("dirtyWorktree");
      expect(preflight.verdict).toBe("blocked");
    } finally {
      service.dispose();
    }
  });
});

describe("RepoService — runOp() executor (P6 W8)", () => {
  test("branchCreate then branchDelete: undo captures the tip and config, and restores it exactly", async () => {
    const repo = branchy();
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;
      const featureSha = repo.refs["feature/a"];

      const del = await service.runOp(repoId, {
        kind: "branchDelete",
        name: "feature/a",
        force: true,
      });
      expect(del.ok).toBe(true);
      expect(del.undo).not.toBeNull();
      expect(del.undo?.recoverySha).toBe(featureSha);
      expect(del.undo?.label).toBe("Deleted branch feature/a");

      const refsAfterDelete = await service.refs(repoId);
      expect(refsAfterDelete.branches.some((b) => b.shortName === "feature/a")).toBe(false);

      const undoId = del.undo?.id;
      if (undoId === undefined) throw new Error("unreachable");
      const undone = await service.undoRun(repoId, undoId);
      expect(undone.ok).toBe(true);
      expect(undone.undo).toBeNull(); // undo.run's own OpResult never carries a new slot

      const refsAfterUndo = await service.refs(repoId);
      const restored = refsAfterUndo.branches.find((b) => b.shortName === "feature/a");
      expect(restored?.objectId).toBe(featureSha);
    } finally {
      service.dispose();
    }
  });

  test("branchDelete undo restores upstream tracking config, not just the ref (P6 W22 exit criteria)", async () => {
    const repo = branchy();
    const env = baseEnv(repo.dir);
    // Arbitrary tracking config directly on the branch-to-be-deleted — undo's capture reads
    // back whatever `branch.<name>.*` keys exist via `--get-regexp`, so this exercises the same
    // path a real `--track`'d branch would, without needing a real remote wired up.
    execFileSync("git", ["config", "branch.feature/a.remote", "origin"], {
      cwd: repo.dir,
      env,
    });
    execFileSync("git", ["config", "branch.feature/a.merge", "refs/heads/main"], {
      cwd: repo.dir,
      env,
    });

    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      const del = await service.runOp(repoId, {
        kind: "branchDelete",
        name: "feature/a",
        force: true,
      });
      expect(del.ok).toBe(true);

      // Deleting the branch also deletes its config in real git — confirms the "before" state
      // this test is actually exercising, not just asserting the replay blindly.
      let configSurvivedDelete = true;
      try {
        execFileSync("git", ["config", "--get", "branch.feature/a.remote"], {
          cwd: repo.dir,
          env,
          encoding: "utf8",
        });
      } catch {
        configSurvivedDelete = false;
      }
      expect(configSurvivedDelete).toBe(false);

      const undoId = del.undo?.id;
      if (undoId === undefined) throw new Error("unreachable");
      const undone = await service.undoRun(repoId, undoId);
      expect(undone.ok).toBe(true);

      const remote = execFileSync("git", ["config", "--get", "branch.feature/a.remote"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
      }).trim();
      const merge = execFileSync("git", ["config", "--get", "branch.feature/a.merge"], {
        cwd: repo.dir,
        env,
        encoding: "utf8",
      }).trim();
      expect(remote).toBe("origin");
      expect(merge).toBe("refs/heads/main");
    } finally {
      service.dispose();
    }
  });

  test("tagDelete undo round-trips an annotated tag back to the same object", async () => {
    const repo = branchy();
    const env = {
      ...baseEnv(repo.dir),
      GIT_AUTHOR_NAME: "Kira Fixture",
      GIT_AUTHOR_EMAIL: "fixture@kira-version.test",
      GIT_COMMITTER_NAME: "Kira Fixture",
      GIT_COMMITTER_EMAIL: "fixture@kira-version.test",
    };
    execFileSync("git", ["tag", "-a", "v1.0.0", "-m", "release", "main"], { cwd: repo.dir, env });
    // The tag OBJECT's own sha (`rev-parse`), not the commit it peels to (`rev-list`) — undo's
    // `recoverySha` for an annotated tag is `RefRecord.objectId`, which is the tag object itself
    // (its own doc comment: "P6's undo depends on that staying true").
    const tagSha = execFileSync("git", ["rev-parse", "v1.0.0"], { cwd: repo.dir, env })
      .toString()
      .trim();

    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      const del = await service.runOp(repoId, { kind: "tagDelete", name: "v1.0.0" });
      expect(del.ok).toBe(true);
      expect(del.undo?.recoverySha).toBe(tagSha);

      const afterDelete = await service.refs(repoId);
      expect(afterDelete.tags.some((t) => t.shortName === "v1.0.0")).toBe(false);

      const undoId = del.undo?.id;
      if (undoId === undefined) throw new Error("unreachable");
      const undone = await service.undoRun(repoId, undoId);
      expect(undone.ok).toBe(true);

      const afterUndo = await service.refs(repoId);
      const restored = afterUndo.tags.find((t) => t.shortName === "v1.0.0");
      expect(restored).toBeDefined();
      expect(restored?.objectType).toBe("tag"); // annotated, not downgraded to lightweight
    } finally {
      service.dispose();
    }
  });

  test("a non-undoable op (tagCreate) clears a previously-set undo slot", async () => {
    const repo = branchy();
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      const del = await service.runOp(repoId, {
        kind: "branchDelete",
        name: "feature/a",
        force: true,
      });
      expect(del.undo).not.toBeNull();
      expect(service.undoPeek(repoId)).not.toBeNull();

      const create = await service.runOp(repoId, {
        kind: "tagCreate",
        name: "v2.0.0",
        target: "main",
        message: undefined,
        force: false,
      });
      expect(create.ok).toBe(true);
      expect(create.undo).toBeNull();
      expect(service.undoPeek(repoId)).toBeNull(); // the slot the branchDelete set is now gone
    } finally {
      service.dispose();
    }
  });

  test("a failing write still returns a populated head and inProgress", async () => {
    const repo = branchy();
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      const result = await service.runOp(repoId, {
        kind: "branchDelete",
        name: "does-not-exist",
        force: true,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("NotFound");
      expect(result.head).toEqual({ kind: "branch", name: "main" });
      expect(result.inProgress).toBeNull();
      expect(result.undo).toBeNull();
    } finally {
      service.dispose();
    }
  });

  test("opContinue/opAbort report an earlyError when nothing is in progress, without spawning a write", async () => {
    const repo = branchy();
    const runner = new CountingRunner();
    const service = await RepoService.create({
      runner,
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      const before = runner.totalSpawnCount;
      const result = await service.runOp(repoId, { kind: "opContinue" });
      expect(result.ok).toBe(false);
      expect(result.error?.message).toMatch(/no operation is currently in progress/i);
      // Only reads (status, in-progress state files) ran — never a write for a nonexistent op.
      expect(
        runner.calls
          .slice(before)
          .every((c) => !c.argv.includes("rebase") && !c.argv.includes("merge")),
      ).toBe(true);
    } finally {
      service.dispose();
    }
  });

  test("a conflicting revert fails with Conflict and its own OpResult already reports the in-progress revert", async () => {
    const repo = conflicting();
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;
      const theirsSha = repo.refs["branch-theirs"];
      if (!theirsSha) throw new Error("unreachable");

      // On main: reverting branch-theirs's own commit re-applies main's conflicting change
      // backwards against a tree that already diverged — guaranteed to conflict.
      const result = await service.runOp(repoId, {
        kind: "revert",
        shas: [theirsSha],
        mainline: undefined,
        noCommit: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("Conflict");
      expect(result.inProgress?.kind).toBe("revert");

      // Clean up so the fixture's tmp dir doesn't linger mid-revert (hygiene, not an assertion).
      await service.runOp(repoId, { kind: "opAbort" });
    } finally {
      service.dispose();
    }
  });

  test("capture-before-write: branchDelete's undo reads run before the delete itself", async () => {
    const repo = branchy();
    const runner = new ArgvRecordingRunner();
    const service = await RepoService.create({
      runner,
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      const before = runner.argvs.length;
      const result = await service.runOp(repoId, {
        kind: "branchDelete",
        name: "feature/a",
        force: true,
      });
      expect(result.ok).toBe(true);

      const relevant = runner.argvs.slice(before);
      const revParseIndex = relevant.findIndex(
        (argv) => argv.includes("rev-parse") && argv.includes("refs/heads/feature/a"),
      );
      const deleteIndex = relevant.findIndex(
        (argv) => argv.includes("branch") && argv.includes("-D") && argv.includes("feature/a"),
      );
      expect(revParseIndex).toBeGreaterThanOrEqual(0);
      expect(deleteIndex).toBeGreaterThan(revParseIndex); // capture happened strictly first
    } finally {
      service.dispose();
    }
  });
});

describe("RepoService — undo slot (P6 W8)", () => {
  test("undoRun() with a stale/unknown id reports NotFound without replaying anything", async () => {
    const repo = branchy();
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      const result = await service.undoRun(repoId, "not-a-real-id");
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("NotFound");
    } finally {
      service.dispose();
    }
  });

  test("undoPeek() never mutates the slot: peeking twice, then running, still succeeds once", async () => {
    const repo = branchy();
    const service = await RepoService.create({
      runner: new NodeProcessRunner(),
      fileWatcher: new NodeFileWatcher(),
      logger: new FakeLogger(),
      settings: settingsWithPageSize(10),
      configuredGitCandidates: [],
    });
    try {
      const opened = await service.open(repo.dir);
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened;

      const del = await service.runOp(repoId, {
        kind: "branchDelete",
        name: "feature/a",
        force: true,
      });
      const id = del.undo?.id;
      if (id === undefined) throw new Error("unreachable");

      expect(service.undoPeek(repoId)?.id).toBe(id);
      expect(service.undoPeek(repoId)?.id).toBe(id); // still there — peek does not take it

      const first = await service.undoRun(repoId, id);
      expect(first.ok).toBe(true);
      expect(service.undoPeek(repoId)).toBeNull(); // taken

      const second = await service.undoRun(repoId, id);
      expect(second.ok).toBe(false); // cannot be replayed twice
      expect(second.error?.kind).toBe("NotFound");
    } finally {
      service.dispose();
    }
  });
});
