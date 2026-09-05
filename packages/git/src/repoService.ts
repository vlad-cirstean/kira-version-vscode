/**
 * §3.2's host-side object — the first thing in this project to compose P1's driver and P2's
 * paged log session into something with a lifetime. One `RepoService` per host process; one
 * `RepoSession` per open repo, holding exactly what §5.4 says the host holds: the `CommitStore`,
 * the `LogSession`, the `RepoWatcher`, the `GitDriver` (which itself owns the `CatFileSession`),
 * a `dictionaryCursor` for W3's delta, and a `staleReason`.
 *
 * `GitStatus`/`RepoOpenOutcome`/`GraphChunkPayload` below are structural copies of what
 * `packages/ipc`'s contract will eventually declare — this package cannot import `@kira-version/ipc`
 * until W8 binds this service to it, per §3.1's dependency rule (`git` may depend on `core` and
 * `ipc`, but nothing here needed `ipc` until now).
 */
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type {
  CommitDetail,
  CommitStore,
  DiffHunk,
  Disposable,
  FileDiff,
  FileDiffBody,
  FileWatcher,
  Logger,
  PackedCommitChunk,
  ProcessRunner,
  RepoIdentity,
  Settings,
} from "@kira-version/core";
import { assertDefined, CommitStore as CommitStoreImpl } from "@kira-version/core";
import { DEFAULT_MAX_BLOB_BYTES, openCatFileSession } from "./catFile.ts";
import type { GitResolution, GitVersion, ResolvedGit } from "./discovery.ts";
import { locateGit, resolveRepoIdentity } from "./discovery.ts";
import type { GitDriver } from "./driver.ts";
import { openGitDriver } from "./driver.ts";
import type { LogSession } from "./logSession.ts";
import { openLogSession } from "./logSession.ts";
import type { ParsedFileDiffBody } from "./parse/diff.ts";
import {
  fileDiffArgs,
  hasDeletedPostImage,
  parseFileDiffBody,
  worktreeDiffArgs,
} from "./parse/diff.ts";
import { commitDetail } from "./queries.ts";
import type { RepoWatcher, WatchSignal } from "./watcher.ts";
import { watchRepo } from "./watcher.ts";

// ---------------------------------------------------------------------------------------
// Local wire-shaped types (see the module doc comment for why these live here, not in ipc).
// ---------------------------------------------------------------------------------------

export type GitStatus =
  | { readonly kind: "ok"; readonly path: string; readonly version: string }
  | { readonly kind: "notFound"; readonly probed: readonly string[] }
  | {
      readonly kind: "tooOld";
      readonly path: string;
      readonly detected: string;
      readonly required: string;
    }
  | { readonly kind: "unusable"; readonly path: string; readonly reason: string };

export type RepoOpenOutcome =
  | { readonly kind: "ok"; readonly repoId: string; readonly identity: RepoIdentity }
  | { readonly kind: "notARepository"; readonly path: string }
  | { readonly kind: "gitUnavailable"; readonly git: GitStatus };

export interface GraphChunkPayload {
  readonly repoId: string;
  readonly seq: number;
  readonly from: number;
  readonly to: number;
  readonly source: "git" | "cache";
  readonly remaining: number;
  readonly exhausted: boolean;
  readonly commits: PackedCommitChunk;
}

/**
 * W3's wire shape for `blob(repoId, rev, path)` — the virtual document source's read (§4.4,
 * D14a). Local, not `core`'s, for the same reason `GraphChunkPayload` above is: no consumer of
 * this exists across the wire until `ipc`'s contract (W4) declares its own structural copy.
 * `binary` is this function's own sniff (a NUL byte in the first 8 KB, git's own heuristic) —
 * `catFile.ts`'s size gate alone cannot tell binary from text, only "too big to read at all".
 */
export type BlobResult =
  | { readonly kind: "found"; readonly content: string }
  | { readonly kind: "missing" }
  | { readonly kind: "binary" }
  | { readonly kind: "tooLarge"; readonly bytes: number; readonly limitBytes: number };

/** git's own binary heuristic (`buffer_is_binary`): a NUL byte anywhere in the first 8 KB. */
const BINARY_SNIFF_WINDOW_BYTES = 8 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: false });

/** §5.5's "diff text LRU (cap by bytes, not entries)" — the single per-repo diff cache below. */
export const DIFF_CACHE_MAX_BYTES = 4 * 1024 * 1024;

/** The detail cache's entry cap (§5.5) — small on purpose: it exists to make re-selecting a
 *  just-viewed commit free, not to hold a whole session's history in memory. */
export const DETAIL_CACHE_MAX_ENTRIES = 64;

/** A single per-file patch over this size is never materialized into hunks — `fileDiff` reports
 *  `tooLarge` instead. Shared with `worktreeDiff`, which declines to re-map (returns `null`)
 *  rather than surface the cap on the wire, since a re-map is a refinement, not a result. */
export const MAX_PATCH_BYTES = 1 * 1024 * 1024;

function looksBinary(content: Uint8Array): boolean {
  const len = Math.min(content.length, BINARY_SNIFF_WINDOW_BYTES);
  for (let i = 0; i < len; i++) {
    if (content[i] === 0x00) return true;
  }
  return false;
}

/** Drains `bytes` to completion — counting every byte read even past `capBytes` so a caller can
 *  report an accurate total — but stops *retaining* chunks once over the cap, so a patch far
 *  larger than the cap never sits fully buffered in memory just to be thrown away. Never
 *  cancels the underlying read: draining it here is simpler and cheaper than teaching every
 *  caller to handle the `GitCancelled` a mid-stream `read.cancel()` would produce instead. */
async function collectWithCap(
  bytes: AsyncIterable<Uint8Array>,
  capBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly total: number; readonly overCap: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overCap = false;
  for await (const chunk of bytes) {
    total += chunk.length;
    if (total > capBytes) {
      overCap = true;
      chunks.length = 0; // over cap: nothing here will be parsed, no reason to keep it buffered
    } else {
      chunks.push(chunk);
    }
  }
  if (overCap) return { bytes: new Uint8Array(0), total, overCap: true };
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes: out, total, overCap: false };
}

/**
 * An LRU cache capped by the total byte size of its values, not by entry count — §5.5's "diff
 * text LRU (cap by bytes, not entries)". `Map`'s own iteration order (insertion order) is what
 * gives this its recency ordering for free: `get` re-inserts its key to move it to the end,
 * and eviction always removes from the front.
 */
export class ByteCappedLru<V> {
  readonly #capBytes: number;
  readonly #entries = new Map<string, { readonly value: V; readonly bytes: number }>();
  #totalBytes = 0;

  constructor(capBytes: number) {
    this.#capBytes = capBytes;
  }

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, bytes: number): void {
    const existing = this.#entries.get(key);
    if (existing) {
      this.#totalBytes -= existing.bytes;
      this.#entries.delete(key);
    }
    this.#entries.set(key, { value, bytes });
    this.#totalBytes += bytes;
    while (this.#totalBytes > this.#capBytes) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.#entries.get(oldestKey);
      this.#entries.delete(oldestKey);
      if (oldest) this.#totalBytes -= oldest.bytes;
    }
  }
}

/** An LRU cache capped by entry count — the detail cache's shape (§5.5). */
export class CountCappedLru<V> {
  readonly #capEntries: number;
  readonly #entries = new Map<string, V>();

  constructor(capEntries: number) {
    this.#capEntries = capEntries;
  }

  get(key: string): V | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.#capEntries) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.#entries.delete(oldestKey);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}

function versionString(version: GitVersion): string {
  return version.raw;
}

function toGitStatus(resolution: GitResolution): GitStatus {
  switch (resolution.kind) {
    case "ok":
      return {
        kind: "ok",
        path: resolution.git.path,
        version: versionString(resolution.git.version),
      };
    case "notFound":
      return { kind: "notFound", probed: resolution.probed };
    case "tooOld":
      return {
        kind: "tooOld",
        path: resolution.path,
        detected: versionString(resolution.detected),
        required: versionString(resolution.required),
      };
    case "unusable":
      return { kind: "unusable", path: resolution.path, reason: resolution.reason };
  }
}

// ---------------------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------------------

export interface RepoServiceDeps {
  readonly runner: ProcessRunner;
  readonly fileWatcher: FileWatcher;
  readonly logger: Logger;
  readonly settings: Settings;
  readonly configuredGitCandidates: readonly string[];
}

/** How many rows one `streamGraph` chunk carries, whether replayed from cache or freshly read
 *  from git — §5.1's "first commits painted" budget, not §5.1.1's page size. Exported so a test
 *  building a small generated repo can assert chunk boundaries without hard-coding 500. */
export const CHUNK_ROWS = 500;

/** §5.4/§5.5: how long a hidden repo's state survives before `setUiVisible(false)` evicts it.
 *  An exported named constant, not a literal in a closure — deliberately not a setting; see this
 *  file's `#evict` for what eviction actually discards. */
export const HIDDEN_EVICT_MS = 5 * 60 * 1000;

interface RepoServiceOptions {
  /** Testability hook for `HIDDEN_EVICT_MS` — the plan's given `RepoServiceDeps` has no other
   *  way to exercise real eviction timing without a 5-minute test. Additive, defaults to the
   *  real constant. */
  readonly evictMs?: number;
  /** Testability hook for `DIFF_CACHE_MAX_BYTES` (W3) — lets a test drive real eviction without
   *  4 MB of fixture data. Additive, defaults to the real constant. */
  readonly diffCacheMaxBytes?: number;
  /** Testability hook for `DETAIL_CACHE_MAX_ENTRIES` (W3) — same reasoning as
   *  `diffCacheMaxBytes` above. Additive, defaults to the real constant. */
  readonly detailCacheMaxEntries?: number;
}

interface RepoSession {
  readonly repoId: string;
  readonly identity: RepoIdentity;
  readonly driver: GitDriver;
  logSession: LogSession;
  readonly store: CommitStore;
  readonly watcher: RepoWatcher;
  /** Boundary row -> interner size after that row (W2). A mark exists for every row a stream
   *  has ever emitted a chunk up to — exactly the set of rows a client's `loadedRows` can equal,
   *  since a client only ever advances by whole chunks — plus `0 -> 0` at session start. Never a
   *  single running cursor: two streams (or one stream resuming after a reconnect) can resume
   *  from different rows, and each row's correct dictionary base is a fixed fact about that row,
   *  not about whichever caller last packed a chunk. */
  dictionaryMarks: Map<number, number>;
  staleReason: "refsChanged" | "refresh" | undefined;
  lastRemaining: number;
  nextSeq: number;
  evictTimer: ReturnType<typeof setTimeout> | undefined;
  readonly subscriptions: Disposable[];
  /** Keyed `<sha>:<parentIndex>` (W3). Dropped whole on `refsChanged` — `decoration` (`%D`) is
   *  a fact about refs, not about the commit, and re-fetching the whole entry is simpler to
   *  reason about than patching one field of it. */
  readonly detailCache: CountCappedLru<CommitDetail>;
  /** Keyed `<baseSha|"root">:<sha>:<path>` (W3). Two tree oids and a path determine a patch
   *  forever, so — unlike `detailCache` — this is *never* invalidated by the watcher; it lives
   *  exactly as long as this `RepoSession` does. */
  readonly diffCache: ByteCappedLru<FileDiffBody>;
}

function initialDictionaryMarks(): Map<number, number> {
  return new Map([[0, 0]]);
}

export class RepoService {
  readonly #deps: RepoServiceDeps;
  readonly #resolution: GitResolution;
  readonly #evictMs: number;
  readonly #diffCacheMaxBytes: number;
  readonly #detailCacheMaxEntries: number;
  readonly #logger: Logger;
  readonly #sessions = new Map<string, RepoSession>();
  readonly #changeListeners = new Set<
    (e: { repoId: string; kind: "refsChanged" | "worktreeChanged" }) => void
  >();

  readonly git: GitStatus;

  private constructor(
    deps: RepoServiceDeps,
    resolution: GitResolution,
    evictMs: number,
    diffCacheMaxBytes: number,
    detailCacheMaxEntries: number,
  ) {
    this.#deps = deps;
    this.#resolution = resolution;
    this.#evictMs = evictMs;
    this.#diffCacheMaxBytes = diffCacheMaxBytes;
    this.#detailCacheMaxEntries = detailCacheMaxEntries;
    this.#logger = deps.logger.child("repoService");
    this.git = toGitStatus(resolution);
  }

  static async create(deps: RepoServiceDeps, opts: RepoServiceOptions = {}): Promise<RepoService> {
    const resolution = await locateGit({
      runner: deps.runner,
      configuredCandidates: deps.configuredGitCandidates,
    });
    return new RepoService(
      deps,
      resolution,
      opts.evictMs ?? HIDDEN_EVICT_MS,
      opts.diffCacheMaxBytes ?? DIFF_CACHE_MAX_BYTES,
      opts.detailCacheMaxEntries ?? DETAIL_CACHE_MAX_ENTRIES,
    );
  }

  #git(): ResolvedGit {
    if (this.#resolution.kind !== "ok") {
      throw new Error("RepoService: git is unavailable — check `.git` before calling this");
    }
    return this.#resolution.git;
  }

  async open(path: string): Promise<RepoOpenOutcome> {
    if (this.#resolution.kind !== "ok") return { kind: "gitUnavailable", git: this.git };

    const resolved = await resolveRepoIdentity(this.#resolution.git, this.#deps.runner, path);
    if (resolved.kind !== "ok") return { kind: "notARepository", path };

    const identity = resolved.identity;
    const repoId = identity.root;
    const existing = this.#sessions.get(repoId);
    if (existing) return { kind: "ok", repoId, identity: existing.identity };

    const session = this.#openSession(identity);
    this.#sessions.set(repoId, session);
    this.#logger.log("debug", "opened repo", { repoId, root: identity.root });
    return { kind: "ok", repoId, identity };
  }

  close(repoId: string): void {
    const session = this.#sessions.get(repoId);
    if (!session) return;
    this.#sessions.delete(repoId);
    this.#clearEvictTimer(session);
    for (const subscription of session.subscriptions) subscription.dispose();
    session.watcher.dispose();
    session.logSession.dispose();
    session.driver.dispose();
  }

  status(repoId: string): { loaded: number; remaining: number; exhausted: boolean } {
    const session = this.#requireSession(repoId);
    return {
      loaded: session.store.rowCount,
      remaining: session.lastRemaining,
      exhausted: session.logSession.exhausted,
    };
  }

  async streamGraph(
    repoId: string,
    opts: {
      resumeThroughRow?: number;
      onChunk: (chunk: GraphChunkPayload) => Promise<void>;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    const session = this.#requireSession(repoId);
    await this.#ensureFresh(session);

    // Clamped, not trusted verbatim: a caller-supplied `resumeThroughRow` from before a stale
    // reset would otherwise point past the (now empty) store. The dictionary base for that row
    // is then resolved from `dictionaryMarks`, not guessed: a row this session never emitted a
    // chunk up to (W2's fix) has no mark, and replays from row 0 with base 0 rather than risking
    // a receiver whose interner does not actually match `dictionaryBase`.
    const requestedRow = Math.min(opts.resumeThroughRow ?? 0, session.store.rowCount);
    const mark = session.dictionaryMarks.get(requestedRow);
    let cursor = mark !== undefined ? requestedRow : 0;
    let dictionaryBase = mark ?? 0;
    const cachedThrough = session.store.rowCount;

    while (cursor < cachedThrough) {
      if (opts.signal?.aborted) return;
      const to = Math.min(cursor + CHUNK_ROWS, cachedThrough);
      dictionaryBase = await this.#emitRange(
        session,
        cursor,
        to,
        dictionaryBase,
        "cache",
        opts.onChunk,
      );
      cursor = to;
    }
    if (opts.signal?.aborted) return;

    // A page is fetched from git here only on the very first stream for this repo — nothing is
    // cached yet at all. Every later page comes from an explicit `loadMore()` (§5.1.1: "the
    // host never loads a page the user did not ask for"), which is also what keeps a resumed
    // stream — a hide/reveal replaying the cache above — spawn-free.
    if (cachedThrough === 0 && !session.logSession.exhausted) {
      await this.#readPageIntoStore(session);
    }

    while (cursor < session.store.rowCount) {
      if (opts.signal?.aborted) return;
      const to = Math.min(cursor + CHUNK_ROWS, session.store.rowCount);
      dictionaryBase = await this.#emitRange(
        session,
        cursor,
        to,
        dictionaryBase,
        "git",
        opts.onChunk,
      );
      cursor = to;
    }
  }

  async loadMore(repoId: string, pages = 1, signal?: AbortSignal): Promise<void> {
    const session = this.#requireSession(repoId);
    await this.#ensureFresh(session);
    for (let i = 0; i < pages && !session.logSession.exhausted; i++) {
      if (signal?.aborted) return;
      await this.#readPageIntoStore(session, signal);
    }
  }

  /** §6.2: forces the next stream to re-walk from scratch, bypassing every cache — distinct
   *  from the automatic invalidation a watcher's `refsChanged` performs, which is incremental.
   *  Idempotent: marking an already-stale session stale again is a no-op past this call, since
   *  the next `streamGraph`/`loadMore` consumes the flag exactly once regardless of which reason
   *  set it. Returns `false` — the honest answer, not a throw — when `repoId` has no open
   *  session. */
  refresh(repoId: string): boolean {
    const session = this.#sessions.get(repoId);
    if (!session) return false;
    session.staleReason = "refresh";
    return true;
  }

  onChanged(
    fn: (e: { repoId: string; kind: "refsChanged" | "worktreeChanged" }) => void,
  ): Disposable {
    this.#changeListeners.add(fn);
    return { dispose: () => this.#changeListeners.delete(fn) };
  }

  setUiVisible(visible: boolean): void {
    for (const session of this.#sessions.values()) {
      if (visible) {
        this.#clearEvictTimer(session);
        session.watcher.resume();
      } else {
        session.watcher.pause();
        this.#armEvictTimer(session);
      }
    }
  }

  dispose(): void {
    for (const repoId of [...this.#sessions.keys()]) this.close(repoId);
  }

  // ---------------------------------------------------------------------------------------
  // P5 W3 — commit detail, a per-file diff, a blob for the virtual document source, the
  // drift re-map's own diff, and the filesystem question D14a needs to choose between them.
  // ---------------------------------------------------------------------------------------

  /** §4.4: metadata + body + signature + the merged file list, for one commit against one of
   *  its parents. Cached (keyed `<sha>:<parentIndex>`, §5.5) — a re-select of a just-viewed
   *  commit, or `fileDiff`'s own lookup of `change`/`baseSha` below, costs nothing. */
  async detail(
    repoId: string,
    sha: string,
    parentIndex = 0,
    signal?: AbortSignal,
  ): Promise<CommitDetail> {
    const session = this.#requireSession(repoId);
    const key = `${sha}:${parentIndex}`;
    const cached = session.detailCache.get(key);
    if (cached) return cached;
    const result = await commitDetail(session.driver, sha, {
      parentIndex,
      ...(signal ? { signal } : {}),
    });
    session.detailCache.set(key, result);
    return result;
  }

  /** §4.4: one file's patch for one commit against one of its parents. `change` (status,
   *  rename arrow, counts) comes from `detail`'s own cached file list — `fileDiff`'s wire params
   *  carry only `path`/`originalPath`/`parentIndex`, not the full `FileChange`, so this always
   *  resolves `detail` first (itself cached, so this is not a second spawn once `detail` has
   *  already been requested for this commit, which is every real call site's order). */
  async fileDiff(
    repoId: string,
    sha: string,
    path: string,
    originalPath: string | undefined,
    parentIndex = 0,
    signal?: AbortSignal,
  ): Promise<FileDiff> {
    const session = this.#requireSession(repoId);
    const detailResult = await this.detail(repoId, sha, parentIndex, signal);
    const change = assertDefined(
      detailResult.files.find((f) => f.path === path),
      `RepoService.fileDiff: ${JSON.stringify(path)} is not one of ${sha}'s changed files (parent ${parentIndex})`,
    );
    const baseSha = detailResult.parents[parentIndex] ?? null;

    const cacheKey = `${baseSha ?? "root"}:${sha}:${path}`;
    const cachedBody = session.diffCache.get(cacheKey);
    if (cachedBody) return { sha, parentIndex, baseSha, change, body: cachedBody };

    const argv = fileDiffArgs(baseSha ?? undefined, sha, path, originalPath);
    const read = session.driver.read(argv, signal ? { signal } : {});
    const { bytes, total, overCap } = await collectWithCap(read.bytes, MAX_PATCH_BYTES);
    await read.done;

    const body: FileDiffBody = overCap
      ? { kind: "tooLarge", bytes: total, limitBytes: MAX_PATCH_BYTES }
      : await this.#materializeDiffBody(session, parseFileDiffBody(bytes));
    // A `tooLarge` result is not cached by size (there is nothing to bound it by — `total` can
    // be far larger than the cap) but is small and cheap to recompute, so caching it anyway
    // under its (small) actual byte footprint is still correct and simple: use `bytes.length`.
    session.diffCache.set(cacheKey, body, overCap ? 0 : bytes.length);
    return { sha, parentIndex, baseSha, change, body };
  }

  /** Resolves a `binary` patch's two blob oids into byte sizes via the already-open
   *  `--batch-check` process (`CatFileSession.check`) — no blob content ever crosses the pipe
   *  for a size nobody asked to see the bytes of. */
  async #materializeDiffBody(
    session: RepoSession,
    parsed: ParsedFileDiffBody,
  ): Promise<FileDiffBody> {
    switch (parsed.kind) {
      case "text":
        return { kind: "text", hunks: parsed.hunks };
      case "lfsPointer":
        return { kind: "lfsPointer", oid: parsed.oid, bytes: parsed.bytes };
      case "empty":
        return { kind: "empty", reason: parsed.reason };
      case "binary": {
        const [oldBytes, newBytes] = await Promise.all([
          this.#resolveBlobSize(session, parsed.oldOid),
          this.#resolveBlobSize(session, parsed.newOid),
        ]);
        return { kind: "binary", oldBytes, newBytes };
      }
    }
  }

  async #resolveBlobSize(
    session: RepoSession,
    oid: string | undefined,
  ): Promise<number | undefined> {
    if (oid === undefined) return undefined;
    const result = await session.driver.catFile.check(oid);
    return result.kind === "missing" ? undefined : result.size;
  }

  /** For the virtual document source (W5/W6): `<rev>:<path>`'s content, or why there is none.
   *  Not cached — `catFile.ts`'s own persistent `--batch`/`--batch-check` processes already
   *  make a repeat read of the same blob free. A `path` containing a newline (legal in git, W2)
   *  cannot be expressed in `cat-file --batch`'s one-request-per-line protocol at all, so it is
   *  routed to the one-shot fallback below instead of the persistent session. */
  async blob(repoId: string, rev: string, path: string): Promise<BlobResult> {
    const session = this.#requireSession(repoId);
    if (path.includes("\n")) return this.#blobViaOneShotShow(session, rev, path);
    const result = await session.driver.catFile.read(`${rev}:${path}`);
    switch (result.kind) {
      case "missing":
        return { kind: "missing" };
      case "tooLarge":
        return { kind: "tooLarge", bytes: result.size, limitBytes: DEFAULT_MAX_BLOB_BYTES };
      case "found":
        if (looksBinary(result.content)) return { kind: "binary" };
        return { kind: "found", content: decoder.decode(result.content) };
    }
  }

  /**
   * §4.4/W2's "vanishingly rare path with a `\n` in it" fallback: a plain `git show <rev>:<path>`
   * spawn, argv only, no line-oriented request framing to break. No `--batch-check` probe first
   * — reading the whole blob before judging its size is the right tradeoff for a path this rare;
   * `blob()`'s normal, common-case route still probes size before ever reading content. A failed
   * spawn (the path does not resolve at `rev`, among other reasons `git show` can exit non-zero)
   * is reported as `missing` — the same "no skipped validation, but no wrong-shaped answer either"
   * choice `worktreeDiff` above makes for a refinement that cannot run.
   */
  async #blobViaOneShotShow(session: RepoSession, rev: string, path: string): Promise<BlobResult> {
    try {
      const read = session.driver.read(["show", `${rev}:${path}`]);
      const { bytes, total, overCap } = await collectWithCap(read.bytes, DEFAULT_MAX_BLOB_BYTES);
      await read.done;
      if (overCap) return { kind: "tooLarge", bytes: total, limitBytes: DEFAULT_MAX_BLOB_BYTES };
      if (looksBinary(bytes)) return { kind: "binary" };
      return { kind: "found", content: decoder.decode(bytes) };
    } catch {
      return { kind: "missing" };
    }
  }

  /**
   * D14a's drift re-map, and the one command in this phase that diffs against something
   * mutable: `<rev>` vs. the working tree (§4.4). Returns `null` — meaning *do not re-map*,
   * never an error — for: no output at all (the on-disk file is byte-identical to
   * `<rev>:<path>`); no post-image (the path is untracked or ignored, so git cannot see it even
   * though `pathExistsInCheckout` found a file there); over the shared 1 MB patch cap; or a
   * failed spawn. Deliberately not cached (§5.5): this answer changes on every keystroke in the
   * user's editor, and a cache here would need the one piece of invalidation machinery the
   * other two caches are structured to avoid, to save a single spawn on an action that happens
   * at human speed.
   */
  async worktreeDiff(
    repoId: string,
    rev: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<readonly DiffHunk[] | null> {
    const session = this.#requireSession(repoId);
    try {
      const read = session.driver.read(worktreeDiffArgs(rev, path), signal ? { signal } : {});
      const { bytes, total, overCap } = await collectWithCap(read.bytes, MAX_PATCH_BYTES);
      await read.done;
      if (overCap || total === 0 || hasDeletedPostImage(bytes)) return null;
      const parsed = parseFileDiffBody(bytes);
      return parsed.kind === "text" ? parsed.hunks : null;
    } catch {
      // A refinement that cannot run must never turn a working "Go to file" into an error.
      return null;
    }
  }

  /**
   * The whole of D14a's live-vs-virtual decision: is there a file on disk at `path`. Deliberately
   * *not* `git ls-files` or `cat-file -e HEAD:<path>` — the index and HEAD both answer a
   * different question, and would get a tracked-but-worktree-deleted file, or an untracked
   * file, wrong. `path` arrives from the webview, so a value that escapes `repoId`'s root after
   * normalization is refused rather than resolved.
   */
  pathExistsInCheckout(repoId: string, path: string): boolean {
    const session = this.#requireSession(repoId);
    const root = resolve(session.identity.root);
    const candidate = resolve(join(session.identity.root, path));
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      this.#logger.log("warn", "pathExistsInCheckout: rejected a path escaping the repo root", {
        repoId,
        path,
      });
      return false;
    }
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------

  #openSession(identity: RepoIdentity): RepoSession {
    const git = this.#git();
    const catFile = openCatFileSession(git, this.#deps.runner, identity.root);
    const driver = openGitDriver(git, this.#deps.runner, identity.root, catFile);
    const watcher = watchRepo(this.#deps.fileWatcher, identity);

    const session: RepoSession = {
      repoId: identity.root,
      identity,
      driver,
      logSession: this.#openLogSession(identity),
      store: new CommitStoreImpl(),
      watcher,
      dictionaryMarks: initialDictionaryMarks(),
      staleReason: undefined,
      lastRemaining: 0,
      nextSeq: 0,
      evictTimer: undefined,
      subscriptions: [],
      detailCache: new CountCappedLru(this.#detailCacheMaxEntries),
      diffCache: new ByteCappedLru(this.#diffCacheMaxBytes),
    };

    session.subscriptions.push(watcher.onSignal((signal) => this.#handleSignal(session, signal)));
    // §4.3: a completed write bumps `generation` and invalidates the graph cache the same way a
    // refs-changed filesystem event does — both funnel through the one handler.
    session.subscriptions.push(
      driver.onInvalidated(() => this.#handleSignal(session, "refsChanged")),
    );

    return session;
  }

  #openLogSession(identity: RepoIdentity): LogSession {
    return openLogSession(this.#git(), this.#deps.runner, identity.root, {
      scope: this.#deps.settings["kiraVersion.graph.scope"],
      pageSize: this.#deps.settings["kiraVersion.graph.pageSize"],
    });
  }

  #requireSession(repoId: string): RepoSession {
    const session = this.#sessions.get(repoId);
    if (!session) throw new Error(`RepoService: no open repo '${repoId}'`);
    return session;
  }

  #handleSignal(session: RepoSession, kind: WatchSignal): void {
    if (kind === "refsChanged") {
      session.staleReason = "refsChanged";
      // §5.5: `decoration` is the one field of a cached `CommitDetail` that is not immutable.
      session.detailCache.clear();
    }
    for (const listener of this.#changeListeners) listener({ repoId: session.repoId, kind });
  }

  /** Drops the store and swaps in a fresh `LogSession` when `session.staleReason` is set — the
   *  §5.4 recovery for both a watcher-observed `refsChanged` and a `logSession.readPage` "stale"
   *  outcome (see `#readPageIntoStore`). A no-op when nothing is stale. */
  async #ensureFresh(session: RepoSession): Promise<void> {
    if (!session.staleReason) return;
    session.staleReason = undefined;
    this.#resetSession(session);
  }

  #resetSession(session: RepoSession): void {
    session.store.clear();
    session.dictionaryMarks = initialDictionaryMarks();
    session.lastRemaining = 0;
    session.logSession.dispose();
    session.logSession = this.#openLogSession(session.identity);
  }

  async #readPageIntoStore(session: RepoSession, signal?: AbortSignal): Promise<void> {
    const outcome = await session.logSession.readPage(
      (record) => session.store.append(record),
      signal ? { signal } : {},
    );
    if (outcome.kind === "stale") {
      // P2's spliced-page guard: refs moved while this session was paused. Reset exactly as a
      // watcher-observed refsChanged would, then retry once against the now-current refs — the
      // caller sees the resulting rows as part of the same page read, starting over at row 0.
      this.#handleSignal(session, "refsChanged");
      await this.#ensureFresh(session);
      await session.logSession.readPage(
        (record) => session.store.append(record),
        signal ? { signal } : {},
      );
    }
    // `loadMore()` calls this without ever emitting a chunk (#emitRange is the only other
    // place `lastRemaining` gets refreshed) — status() would otherwise report a remaining
    // count frozen at whatever it was the last time this repo was actually streamed.
    session.lastRemaining = await session.logSession.remaining();
  }

  /** Packs and emits exactly one chunk, `[from, to)`, using the caller-supplied dictionary base
   *  for that specific row range — never a session-wide running cursor (W2's fix) — and records
   *  the resulting size as `to`'s mark. Returns the next base, so a caller walking forward
   *  through several ranges can thread it without a second map lookup. */
  async #emitRange(
    session: RepoSession,
    from: number,
    to: number,
    dictionaryBase: number,
    source: "git" | "cache",
    onChunk: (chunk: GraphChunkPayload) => Promise<void>,
  ): Promise<number> {
    const commits = session.store.packSlice(from, to, dictionaryBase);
    const nextBase = dictionaryBase + commits.dictionary.length;
    session.dictionaryMarks.set(to, nextBase);
    // Cached internally by `LogSession` after its first call ("run once per refresh") — this
    // does not spawn a process on every chunk, or on a cache-only replay after the first stream.
    const remaining = await session.logSession.remaining();
    session.lastRemaining = remaining;
    await onChunk({
      repoId: session.repoId,
      seq: session.nextSeq++,
      from,
      to,
      source,
      remaining,
      exhausted: session.logSession.exhausted,
      commits,
    });
    return nextBase;
  }

  #armEvictTimer(session: RepoSession): void {
    this.#clearEvictTimer(session);
    session.evictTimer = setTimeout(() => this.#evict(session), this.#evictMs);
  }

  #clearEvictTimer(session: RepoSession): void {
    if (session.evictTimer !== undefined) {
      clearTimeout(session.evictTimer);
      session.evictTimer = undefined;
    }
  }

  #evict(session: RepoSession): void {
    session.evictTimer = undefined;
    this.#resetSession(session);
    session.watcher.pause();
    this.#logger.log("debug", "evicted hidden repo", { repoId: session.repoId });
  }
}
