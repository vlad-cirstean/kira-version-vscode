/**
 * §5.1.1's paused long-lived `git log` process — the phase-defining item of P2.
 *
 * "a single long-lived `git log` process per repo that we read `pageSize` records from and
 * then **pause** (stop reading; the OS pipe buffer applies backpressure and git blocks),
 * resuming on Load more. The second form avoids re-walking and is what P2 implements, with
 * `--skip` as the fallback if a repo's process was reclaimed."
 *
 * Spawned like `catFile.ts`, not through `driver.read()`: a paused session is, by design, held
 * open for the life of the panel, and `driver.read()` acquires one of the bounded read pool's
 * slots (default 4) for as long as a read is outstanding — a permanently-paused session would
 * hold a quarter of the repository's read concurrency hostage. A long-lived, one-per-repo
 * process is categorically not the burst of reads that pool exists to throttle, which is
 * exactly why `catFile.ts` sits outside it too. `errors.ts`'s `classifyGitError` still
 * classifies a failed walk, so it produces the same typed error as any other read.
 */
import type { CommitRecord, ProcessRunner, SpawnedProcess } from "@kira-version/core";
import { RecordSplitter } from "@kira-version/core";
import type { ResolvedGit } from "./discovery.ts";
import type { Disposable } from "./driver.ts";
import { buildGitArgv, buildGitEnv } from "./driver.ts";
import { classifyGitError, GitCancelled } from "./errors.ts";
import {
  logSessionArgs,
  logSessionSkipArgs,
  parseLogRecord,
  revSetArgs,
  type WalkSpec,
} from "./parse/log.ts";
import { parseRefRecord, REFS_RECORD_DELIMITER, refsArgs } from "./parse/refs.ts";

export interface LogSessionOptions {
  /** `docs/plans/P7.md` W3: what this session walks — the graph panel's rev-set `scope`
   *  (unchanged) or Branch review's `<base>..<branch>` range. */
  readonly walk: WalkSpec;
  /** `kiraVersion.graph.pageSize` (§5.1.1); P3's settings schema feeds it. */
  readonly pageSize?: number;
  /** Kills the paused process after this long idle; the next page falls back to `--skip`. */
  readonly idleReclaimMs?: number;
  /** P7 W3: `resolveReviewBase` (W4) has already run `rev-list --count <base>..<branch>` to
   *  decide `ready`/`empty` before this session is even opened — passing that count here primes
   *  `remaining()`'s cache so a ranged session never runs the same count twice for the same
   *  range. Ignored (the session runs its own count) when omitted, which every scoped session
   *  does. */
  readonly precomputedTotal?: number;
}

export type PageOutcome =
  | { readonly kind: "page"; readonly appended: number; readonly exhausted: boolean }
  | { readonly kind: "stale"; readonly reason: "refsChanged" };

export interface ReadPageOptions {
  readonly signal?: AbortSignal;
}

export interface LogSession extends Disposable {
  readonly loadedCount: number;
  readonly exhausted: boolean;
  /** `docs/plans/P11.md` W8: the exact `WalkSpec` this session opened with — `searchCommits`'s
   *  tail scan reads it rather than reconstructing one from settings, so the scan always walks
   *  the SAME rev set the panel's own paging does (judgment call 3), which is what makes probe
   *  11's ordering-identity property hold between a loaded page and a scan's own sequence. */
  readonly walk: WalkSpec;
  readPage(sink: (record: CommitRecord) => void, opts?: ReadPageOptions): Promise<PageOutcome>;
  remaining(): Promise<number>;
  dispose(): void;
}

const DEFAULT_PAGE_SIZE = 5000;

async function collectBytes(bytes: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of bytes) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** A snapshot of every ref's object id, cheap enough to take on every session (re)start and
 *  before every `--skip` restart — the mechanism that stops a spliced page (§5.1.1's own
 *  correctness hazard) from being served silently after refs moved underneath a reclaimed
 *  session. */
async function captureRefSnapshot(
  git: ResolvedGit,
  runner: ProcessRunner,
  repoRoot: string,
): Promise<ReadonlyMap<string, string>> {
  const proc = runner.spawn(git.path, {
    argv: buildGitArgv(refsArgs(), true),
    cwd: repoRoot,
    env: buildGitEnv(),
  });
  const bytes = await collectBytes(proc.stdout);
  const exit = await proc.exit;
  const stderr = await proc.stderr;
  if (exit.code !== 0) {
    throw classifyGitError(refsArgs(), exit.code, new TextDecoder().decode(stderr));
  }
  const splitter = new RecordSplitter({ delimiter: REFS_RECORD_DELIMITER });
  const snapshot = new Map<string, string>();
  for (const record of splitter.push(bytes)) {
    if (record.length === 0) continue;
    const ref = parseRefRecord(record);
    snapshot.set(ref.refname, ref.objectId);
  }
  const tail = splitter.finish();
  if (tail && tail.length > 0) {
    const ref = parseRefRecord(tail);
    snapshot.set(ref.refname, ref.objectId);
  }
  return snapshot;
}

/** `docs/plans/P7.md` W3: the narrowed staleness guard for a *range* walk. Only two refs can
 *  possibly move the answer to `<base>..<branch>` — `base` and `branch` themselves — so this
 *  snapshots exactly those two object ids via `rev-parse` rather than every ref in the
 *  repository. A tag created in another window, or any ref outside this pair, must never
 *  invalidate a review session it cannot possibly affect. Keyed by the ref expression itself
 *  (not a refname), which is all `snapshotsEqual` needs. */
async function captureRangeEndpointSnapshot(
  git: ResolvedGit,
  runner: ProcessRunner,
  repoRoot: string,
  base: string,
  branch: string,
): Promise<ReadonlyMap<string, string>> {
  const argv = ["rev-parse", base, branch];
  const proc = runner.spawn(git.path, {
    argv: buildGitArgv(argv, true),
    cwd: repoRoot,
    env: buildGitEnv(),
  });
  const bytes = await collectBytes(proc.stdout);
  const exit = await proc.exit;
  if (exit.code !== 0) {
    const stderr = await proc.stderr;
    throw classifyGitError(argv, exit.code, new TextDecoder().decode(stderr));
  }
  const lines = new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter((line) => line.length > 0);
  const snapshot = new Map<string, string>();
  snapshot.set(base, lines[0] ?? "");
  snapshot.set(branch, lines[1] ?? "");
  return snapshot;
}

/** Dispatches to the full snapshot for a scoped walk or the two-endpoint snapshot for a range —
 *  the one place `LogSessionImpl` asks "have this walk's own refs moved?" */
async function captureWalkSnapshot(
  git: ResolvedGit,
  runner: ProcessRunner,
  repoRoot: string,
  walk: WalkSpec,
): Promise<ReadonlyMap<string, string>> {
  return walk.kind === "range"
    ? captureRangeEndpointSnapshot(git, runner, repoRoot, walk.base, walk.branch)
    : captureRefSnapshot(git, runner, repoRoot);
}

function snapshotsEqual(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [refname, objectId] of a) {
    if (b.get(refname) !== objectId) return false;
  }
  return true;
}

class LogSessionImpl implements LogSession {
  readonly #git: ResolvedGit;
  readonly #runner: ProcessRunner;
  readonly #repoRoot: string;
  readonly #walk: WalkSpec;
  readonly #pageSize: number;
  readonly #idleReclaimMs: number | undefined;

  #loadedCount = 0;
  #exhausted = false;
  #disposed = false;
  #startRefSnapshot: ReadonlyMap<string, string> | undefined;

  #proc: SpawnedProcess | undefined;
  #iterator: AsyncIterator<Uint8Array> | undefined;
  #splitter = new RecordSplitter();
  /** Records a chunk's `splitter.push()` already parsed but the page boundary didn't have
   *  room to consume — carried to the next `readPage()` call rather than dropped. */
  #pendingRecords: Uint8Array[] = [];
  #idleTimer: ReturnType<typeof setTimeout> | undefined;

  #remainingCache: { readonly total: number } | undefined;

  constructor(git: ResolvedGit, runner: ProcessRunner, repoRoot: string, opts: LogSessionOptions) {
    this.#git = git;
    this.#runner = runner;
    this.#repoRoot = repoRoot;
    this.#walk = opts.walk;
    this.#pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    this.#idleReclaimMs = opts.idleReclaimMs;
    if (opts.precomputedTotal !== undefined) {
      this.#remainingCache = { total: opts.precomputedTotal };
    }
  }

  get loadedCount(): number {
    return this.#loadedCount;
  }

  get exhausted(): boolean {
    return this.#exhausted;
  }

  get walk(): WalkSpec {
    return this.#walk;
  }

  async readPage(
    sink: (record: CommitRecord) => void,
    opts: ReadPageOptions = {},
  ): Promise<PageOutcome> {
    if (this.#disposed) throw new Error("logSession: readPage() called after dispose()");
    this.#clearIdleTimer();
    if (this.#exhausted) return { kind: "page", appended: 0, exhausted: true };

    if (!this.#startRefSnapshot) {
      this.#startRefSnapshot = await captureWalkSnapshot(
        this.#git,
        this.#runner,
        this.#repoRoot,
        this.#walk,
      );
    }

    if (!this.#proc) {
      if (this.#loadedCount > 0) {
        // A fresh spawn resuming a previously paused-then-reclaimed session: refs must not
        // have moved, or `--skip`'s offset would silently point at the wrong record.
        const current = await captureWalkSnapshot(
          this.#git,
          this.#runner,
          this.#repoRoot,
          this.#walk,
        );
        if (!snapshotsEqual(current, this.#startRefSnapshot)) {
          return { kind: "stale", reason: "refsChanged" };
        }
        this.#spawn(logSessionSkipArgs(this.#walk, this.#loadedCount));
      } else {
        this.#spawn(logSessionArgs(this.#walk));
      }
    }

    const proc = this.#proc;
    if (!proc) throw new Error("unreachable: #spawn always sets #proc");
    const iterator = this.#iterator;
    if (!iterator) throw new Error("unreachable: #spawn always sets #iterator");

    let appended = 0;

    // Drain any records a *previous* page's chunk already parsed but didn't have room for —
    // `RecordSplitter.push()` returns every complete record in the chunk handed to it, and
    // does not re-offer ones a caller declines to consume; stopping mid-array without queuing
    // the rest would silently drop them, never to be seen again once the underlying bytes are
    // gone. See this phase's Findings for how this was actually caught.
    while (this.#pendingRecords.length > 0 && appended < this.#pageSize) {
      const record = this.#pendingRecords.shift();
      if (record === undefined) break;
      if (record.length === 0) continue;
      sink(parseLogRecord(record));
      appended++;
      this.#loadedCount++;
    }
    if (appended >= this.#pageSize) {
      this.#armIdleTimer();
      return { kind: "page", appended, exhausted: false };
    }

    for (;;) {
      if (opts.signal?.aborted) {
        proc.kill();
        this.#proc = undefined;
        this.#iterator = undefined;
        throw new GitCancelled(["log", "(session)"]);
      }
      const { value, done } = await iterator.next();
      if (done) {
        const exhaustedCleanly = await this.#handleExit(proc);
        this.#proc = undefined;
        this.#iterator = undefined;
        return { kind: "page", appended, exhausted: exhaustedCleanly };
      }
      this.#pendingRecords.push(...this.#splitter.push(value));
      while (this.#pendingRecords.length > 0 && appended < this.#pageSize) {
        const record = this.#pendingRecords.shift();
        if (record === undefined) break;
        if (record.length === 0) continue; // the trailing empty record after the last NUL
        sink(parseLogRecord(record));
        appended++;
        this.#loadedCount++;
      }
      if (appended >= this.#pageSize) {
        this.#armIdleTimer();
        return { kind: "page", appended, exhausted: false };
      }
    }
  }

  async remaining(): Promise<number> {
    // "run once per refresh" (§5.1.1): cached until the session is invalidated by a fresh
    // `remaining()` caller choosing to bypass the cache — P3's refresh action owns that; this
    // session itself never expires the cache on a timer.
    if (!this.#remainingCache) {
      const total = await this.#countTotal();
      this.#remainingCache = { total };
    }
    return Math.max(0, this.#remainingCache.total - this.#loadedCount);
  }

  async #countTotal(): Promise<number> {
    const argv =
      this.#walk.kind === "range"
        ? ["rev-list", "--count", `${this.#walk.base}..${this.#walk.branch}`]
        : [
            "rev-list",
            "--count",
            ...(this.#walk.scope === "all"
              ? revSetArgs("all", this.#walk.stashShas, this.#walk.includeStash ?? true)
              : ["HEAD"]),
          ];
    const proc = this.#runner.spawn(this.#git.path, {
      argv: buildGitArgv(argv, true),
      cwd: this.#repoRoot,
      env: buildGitEnv(),
    });
    const bytes = await collectBytes(proc.stdout);
    const exit = await proc.exit;
    if (exit.code !== 0) {
      const stderr = await proc.stderr;
      throw classifyGitError(argv, exit.code, new TextDecoder().decode(stderr));
    }
    return Number(new TextDecoder().decode(bytes).trim());
  }

  #spawn(argv: readonly string[]): void {
    const proc = this.#runner.spawn(this.#git.path, {
      argv: buildGitArgv(argv, true),
      cwd: this.#repoRoot,
      env: buildGitEnv(),
    });
    this.#proc = proc;
    this.#splitter = new RecordSplitter();
    this.#pendingRecords = [];
    this.#iterator = proc.stdout[Symbol.asyncIterator]();
  }

  /** `done` alone does not distinguish a clean exit (the walk is genuinely exhausted) from the
   *  process having been killed or crashed (not exhausted — the next `readPage` restarts via
   *  `--skip`). Exit code is the discriminator. */
  async #handleExit(proc: SpawnedProcess): Promise<boolean> {
    let exit: Awaited<typeof proc.exit>;
    try {
      exit = await proc.exit;
    } catch {
      return false;
    }
    if (exit.code === 0) {
      this.#exhausted = true;
      return true;
    }
    return false;
  }

  #armIdleTimer(): void {
    if (this.#idleReclaimMs === undefined || !this.#proc) return;
    const proc = this.#proc;
    this.#idleTimer = setTimeout(() => {
      if (this.#proc === proc) {
        proc.kill();
        this.#proc = undefined;
        this.#iterator = undefined;
      }
    }, this.#idleReclaimMs);
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearIdleTimer();
    this.#proc?.kill();
    this.#proc = undefined;
    this.#iterator = undefined;
  }
}

export function openLogSession(
  git: ResolvedGit,
  runner: ProcessRunner,
  repoRoot: string,
  opts: LogSessionOptions,
): LogSession {
  return new LogSessionImpl(git, runner, repoRoot, opts);
}
