import { describe, expect, test } from "bun:test";
import type {
  CommitFields,
  ProcessRunner,
  SearchQuery,
  SpawnedProcess,
  SpawnRequest,
} from "../../packages/core/src/index.ts";
import {
  CommitStore,
  compileQuery,
  defaultSettings,
  matchCommitFields,
} from "../../packages/core/src/index.ts";
import { FakeLogger } from "../../packages/core/src/ports/testFakes.ts";
import { locateGit } from "../../packages/git/src/discovery.ts";
import { openGitDriver } from "../../packages/git/src/driver.ts";
import { GitCancelled } from "../../packages/git/src/errors.ts";
import { NodeFileWatcher } from "../../packages/git/src/nodeFileWatcher.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { logScanArgs, parseScanRecord } from "../../packages/git/src/parse/log.ts";
import type { GraphChunkPayload } from "../../packages/git/src/repoService.ts";
import { RepoService } from "../../packages/git/src/repoService.ts";
import { noopCatFileSession } from "../../packages/git/src/testFakes.ts";
import { searchable } from "../fixtures/generateRepo.ts";

/**
 * `docs/plans/P11.md` W17 — the 7 integration assertions over `RepoService.searchCommits`, the
 * one method every other W17 unit test (W16) cannot reach: real streamed git output, real
 * process lifecycles, and `refs()`'s tags-only NUL framing feeding the same matcher.
 *
 * `searchable(N)` (W15) is built once for the whole file — its own on-disk cache keyed by `(N,
 * opts)` makes every call after the first a plain `existsSync` check, so sharing it here costs
 * nothing extra beyond the first build. `N = 2000`: large enough that assertion 4's "abort a
 * still-streaming process" window is comfortably wide (a few hundred KB of stdout, not a burst
 * that lands in one read()), small enough that `git fast-import` builds it in well under a
 * second.
 *
 * One fixture limitation this file works around rather than papering over: `buildSearchableStream`
 * sets a commit's committer identity equal to its author identity (`tests/fixtures/
 * generateRepo.ts`), so `authorName` can never be isolated from `committerName` — nor
 * `authorEmail` from `committerEmail` — within a single commit here. Every "author-only" probe
 * below therefore expects `fields` to contain both name (or both email) fields, never one alone;
 * `matcher.test.ts` (W16, row 10) is what proves the two fields really are independent in
 * `matchCommitFields` itself, with fixture commits built by hand for exactly that purpose.
 */

const N = 2000;
const repo = searchable(N);

function countWhere(limit: number, predicate: (i: number) => boolean): number {
  let count = 0;
  for (let i = 0; i < limit; i++) {
    if (predicate(i)) count++;
  }
  return count;
}

function query(partial: Partial<Omit<SearchQuery, "scope">>): Omit<SearchQuery, "scope"> {
  return {
    text: "",
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    ...partial,
  };
}

async function openSearchService(runner: ProcessRunner): Promise<RepoService> {
  return RepoService.create({
    runner,
    fileWatcher: new NodeFileWatcher(),
    logger: new FakeLogger(),
    settings: () => ({ ...defaultSettings(), "kiraVersion.graph.pageSize": N + 100 }),
    configuredGitCandidates: [],
  });
}

async function openRepo(service: RepoService): Promise<{ readonly repoId: string }> {
  const opened = await service.open(repo.dir);
  if (opened.kind !== "ok") throw new Error(`expected an ok open, got ${opened.kind}`);
  return { repoId: opened.repoId };
}

async function streamAll(service: RepoService, repoId: string): Promise<GraphChunkPayload[]> {
  const chunks: GraphChunkPayload[] = [];
  await service.streamGraph(repoId, {
    onChunk: async (chunk) => {
      chunks.push(chunk);
    },
  });
  return chunks;
}

function shasFromChunks(chunks: readonly GraphChunkPayload[]): string[] {
  const store = new CommitStore();
  for (const chunk of chunks) store.appendPacked(chunk.commits);
  const shas: string[] = [];
  for (let row = 0; row < store.rowCount; row++) shas.push(store.shaAt(row));
  return shas;
}

async function waitFor(predicate: () => boolean, maxMs = 5000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
}

/** Records every spawned `git log` process's own `SpawnedProcess` handle — assertion 4 reads
 *  each one's `exit` promise afterwards to prove a superseded scan's process actually terminates
 *  rather than leaking as an orphan. */
class TrackingRunner implements ProcessRunner {
  readonly logProcesses: SpawnedProcess[] = [];
  readonly #inner = new NodeProcessRunner();

  spawn(executable: string, request: SpawnRequest): SpawnedProcess {
    const proc = this.#inner.spawn(executable, request);
    if (request.argv.includes("log")) this.logProcesses.push(proc);
    return proc;
  }
}

/** A from-scratch scan over the same repo, through a driver instance `RepoService` never sees —
 *  `parseScanRecord`/`matchCommitFields` are each already unit-tested in isolation (W16); this
 *  exercises the real thing only to prove `searchCommits`'s own counting/capping wiring is
 *  correct, independent of the method under test. */
async function independentSearchTotal(
  dir: string,
  queryPartial: Omit<SearchQuery, "scope">,
): Promise<{ readonly total: number; readonly shas: string[] }> {
  const compiled = compileQuery({ ...queryPartial, scope: "commits" });
  if (compiled.kind !== "ok") throw new Error(`expected an ok query, got ${compiled.kind}`);
  const runner = new NodeProcessRunner();
  const resolution = await locateGit({ runner });
  if (resolution.kind !== "ok") throw new Error("no usable system git found for this test");
  const driver = openGitDriver(resolution.git, runner, dir, noopCatFileSession());
  try {
    const read = driver.read(logScanArgs({ kind: "scope", scope: "all" }));
    let total = 0;
    const shas: string[] = [];
    for await (const record of read.records(0x00)) {
      if (record.length === 0) continue;
      const parsed = parseScanRecord(record);
      const fields: CommitFields = {
        sha: parsed.sha,
        subject: parsed.subject,
        body: parsed.body,
        authorName: parsed.author.name,
        authorEmail: parsed.author.email,
        committerName: parsed.committer.name,
        committerEmail: parsed.committer.email,
      };
      if (matchCommitFields(fields, compiled).length === 0) continue;
      total++;
      shas.push(parsed.sha);
    }
    await read.done;
    return { total, shas };
  } finally {
    driver.dispose();
  }
}

describe("RepoService.searchCommits — six-field OR (assertion 1) and body-only hits (assertion 2)", () => {
  test("'sprocket' surfaces a pure subject-only hit set and a disjoint pure author-only hit set", async () => {
    // Verified by construction (SEARCHABLE_AUTHORS/SEARCHABLE_SUBJECTS' i%5/i%10 rotation,
    // tests/fixtures/generateRepo.ts): subject index 5 ("Refactor the sprocket allocator") is
    // authored only by author index 0 (Alice Widgeon — i%10===5 implies i%5===0), never by
    // author index 1 (Bob Sprocket), and Bob Sprocket's own subjects (i%5===1, i%10 cycling 1/6)
    // never land on index 5. The two sets below are therefore genuinely disjoint by construction,
    // not merely observed to be so.
    const service = await openSearchService(new NodeProcessRunner());
    try {
      const { repoId } = await openRepo(service);
      const result = await service.searchCommits(repoId, query({ text: "sprocket" }), N);
      if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);

      const subjectOnly = result.hits.filter(
        (h) => h.fields.length === 1 && h.fields[0] === "subject",
      );
      const authorOnly = result.hits.filter(
        (h) =>
          h.fields.length === 2 &&
          h.fields.includes("authorName") &&
          h.fields.includes("committerName"),
      );
      expect(subjectOnly).toHaveLength(countWhere(N, (i) => i % 10 === 5));
      expect(authorOnly).toHaveLength(countWhere(N, (i) => i % 5 === 1));
      expect(result.hits).toHaveLength(subjectOnly.length + authorOnly.length);
      expect(result.total).toBe(result.hits.length);
      expect(result.truncated).toBe(false);
      expect(result.complete).toBe(true);

      for (const hit of subjectOnly) expect(hit.subject).toBe("Refactor the sprocket allocator");
      for (const hit of authorOnly) expect(hit.authorName).toBe("Bob Sprocket");
    } finally {
      service.dispose();
    }
  });

  test("an author-name term hits both authorName and committerName together — the fixture's own author===committer coupling", async () => {
    const service = await openSearchService(new NodeProcessRunner());
    try {
      const { repoId } = await openRepo(service);
      const result = await service.searchCommits(repoId, query({ text: "widgeon" }), N);
      if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);

      expect(result.hits).toHaveLength(countWhere(N, (i) => i % 5 === 0));
      for (const hit of result.hits) {
        expect(hit.fields).toEqual(["authorName", "committerName"]);
        expect(hit.authorName).toBe("Alice Widgeon");
      }
    } finally {
      service.dispose();
    }
  });

  test("an author-email term hits both authorEmail and committerEmail together", async () => {
    const service = await openSearchService(new NodeProcessRunner());
    try {
      const { repoId } = await openRepo(service);
      const result = await service.searchCommits(repoId, query({ text: "carol@" }), N);
      if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);

      expect(result.hits).toHaveLength(countWhere(N, (i) => i % 5 === 2));
      for (const hit of result.hits) {
        expect(hit.fields).toEqual(["authorEmail", "committerEmail"]);
        expect(hit.authorName).toBe("Carol Ratchet");
      }
    } finally {
      service.dispose();
    }
  });

  test("a sha-prefix term hits exactly the one commit, labelled 'sha' alone", async () => {
    const service = await openSearchService(new NodeProcessRunner());
    try {
      const { repoId } = await openRepo(service);
      const mainSha = repo.refs.main;
      if (mainSha === undefined) throw new Error("searchable(N) fixture: no 'main' ref");
      const prefix = mainSha.slice(0, 8);
      const result = await service.searchCommits(repoId, query({ text: prefix }), N);
      if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);

      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.fields).toEqual(["sha"]);
      expect(result.hits[0]?.sha).toBe(mainSha);
    } finally {
      service.dispose();
    }
  });

  test("a body-only term (hard part 1) hits only commits streamed from git, labelled 'body' alone", async () => {
    const service = await openSearchService(new NodeProcessRunner());
    try {
      const { repoId } = await openRepo(service);
      const result = await service.searchCommits(repoId, query({ text: "gizmocratic" }), N);
      if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);

      expect(result.hits).toHaveLength(countWhere(N, (i) => i % 7 === 3));
      expect(result.hits.length).toBeGreaterThan(0);
      for (const hit of result.hits) expect(hit.fields).toEqual(["body"]);
    } finally {
      service.dispose();
    }
  });
});

describe("RepoService.searchCommits — prefix/ordering property (assertion 3)", () => {
  test("a query matching every commit returns hits in exactly the loaded-page order", async () => {
    const service = await openSearchService(new NodeProcessRunner());
    try {
      const { repoId } = await openRepo(service);
      const loadedOrder = shasFromChunks(await streamAll(service, repoId));
      expect(loadedOrder).toHaveLength(N);

      const result = await service.searchCommits(
        repoId,
        query({ text: ".", regex: true }),
        N + 100,
      );
      if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);

      expect(result.total).toBe(N);
      expect(result.truncated).toBe(false);
      expect(result.hits.map((h) => h.sha)).toEqual(loadedOrder);
    } finally {
      service.dispose();
    }
  });
});

describe("RepoService.searchCommits — supersede kills the process, no orphan survives (assertion 4)", () => {
  test("a second scan on the same repo aborts the first's still-running git log process", async () => {
    const runner = new TrackingRunner();
    const service = await openSearchService(runner);
    try {
      const { repoId } = await openRepo(service);
      const first = service.searchCommits(repoId, query({ text: "widget" }), N);
      await waitFor(() => runner.logProcesses.length >= 1);
      const second = service.searchCommits(repoId, query({ text: "sprocket" }), N);

      await expect(first).rejects.toBeInstanceOf(GitCancelled);
      const secondResult = await second;
      expect(secondResult.kind).toBe("ok");

      expect(runner.logProcesses).toHaveLength(2);
      const exits = await Promise.race([
        Promise.all(runner.logProcesses.map((proc) => proc.exit)),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("a superseded git log process never exited — orphan")),
            4000,
          );
        }),
      ]);
      // Killed via the abort signal (SIGTERM, `nodeProcessRunner.ts`'s own `kill()`) or ran to a
      // natural close before the abort reached it — either way, a real exit. A genuine orphan
      // would make the `Promise.race` above time out instead of ever reaching this line.
      for (const exit of exits) {
        expect(exit.code !== null || exit.signal !== null).toBe(true);
      }
    } finally {
      service.dispose();
    }
  });
});

describe("RepoService.searchCommits — an invalid pattern is data, not a thrown error (assertion 5)", () => {
  test("an unbalanced regex returns {kind: 'invalidPattern'} and spawns nothing", async () => {
    const runner = new CountingRunner();
    const service = await openSearchService(runner);
    try {
      const { repoId } = await openRepo(service);
      const spawnCountBeforeSearch = runner.totalSpawnCount;

      const result = await service.searchCommits(repoId, query({ text: "foo(", regex: true }), N);
      expect(result.kind).toBe("invalidPattern");
      if (result.kind === "invalidPattern") {
        expect(result.message.length).toBeGreaterThan(0);
        expect(result.message).not.toContain("Invalid regular expression");
      }
      // compileQuery fails before searchCommits ever reaches session.driver.read — no git log
      // spawn, on top of whatever open() itself already spawned to resolve identity/refs.
      expect(runner.totalSpawnCount).toBe(spawnCountBeforeSearch);
    } finally {
      service.dispose();
    }
  });
});

describe("RepoService.searchCommits — exactness of total (assertion 6)", () => {
  test("total matches an independently computed scan, both untruncated and truncated", async () => {
    const service = await openSearchService(new NodeProcessRunner());
    try {
      const { repoId } = await openRepo(service);
      // "widget" (case-insensitive, default): matches 4 of the 10 rotating subjects ("Fix the
      // widget cache", "Add WIDGETS support", "Ship the sub-widget driver", "Prewidgetize the
      // pipeline") — enough real matches to make both the untruncated and truncated cases below
      // non-trivial.
      const independent = await independentSearchTotal(repo.dir, query({ text: "widget" }));
      expect(independent.total).toBeGreaterThan(0);

      const untruncated = await service.searchCommits(repoId, query({ text: "widget" }), N + 100);
      if (untruncated.kind !== "ok") throw new Error(`expected ok, got ${untruncated.kind}`);
      expect(untruncated.total).toBe(independent.total);
      expect(untruncated.truncated).toBe(false);
      expect(untruncated.hits.map((h) => h.sha)).toEqual(independent.shas);

      const smallLimit = 3;
      const truncated = await service.searchCommits(repoId, query({ text: "widget" }), smallLimit);
      if (truncated.kind !== "ok") throw new Error(`expected ok, got ${truncated.kind}`);
      expect(truncated.total).toBe(independent.total);
      expect(truncated.truncated).toBe(true);
      expect(truncated.hits).toHaveLength(smallLimit);
      expect(truncated.hits.map((h) => h.sha)).toEqual(independent.shas.slice(0, smallLimit));
    } finally {
      service.dispose();
    }
  });
});

describe("RepoService.refs — tags-only NUL framing regression guard (assertion 7)", () => {
  test("an annotated tag's multi-line body survives intact; branches/remoteBranches are unaffected", async () => {
    const service = await openSearchService(new NodeProcessRunner());
    try {
      const { repoId } = await openRepo(service);
      const refs = await service.refs(repoId);

      const v1 = refs.tags.find((t) => t.shortName === "v1.0.0");
      expect(v1).toBeDefined();
      expect(v1?.annotation?.subject).toBe("Version 1.0.0");
      // .toContain, not a full-string match: robust to the exact trailing-newline trim
      // `parseRefRecord`/`for-each-ref` apply, which is not this test's concern.
      expect(v1?.annotation?.body).toContain("First stable widget release");
      expect(v1?.annotation?.body).toContain("sprocket allocator");
      expect(v1?.annotation?.body).toContain("ratchet dependency bump");

      const preview = refs.tags.find((t) => t.shortName === "release-preview");
      expect(preview).toBeDefined();
      expect(preview?.annotation).toBeUndefined(); // lightweight tag — no annotation at all

      expect(refs.branches.some((b) => b.shortName === "main")).toBe(true);
      expect(refs.branches.some((b) => b.shortName === "release")).toBe(true);
    } finally {
      service.dispose();
    }
  });
});
