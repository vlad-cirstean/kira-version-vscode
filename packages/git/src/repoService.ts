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
  CheckoutPreflight,
  CommitDetail,
  CommitStore,
  DiffHunk,
  Disposable,
  FileDiff,
  FileDiffBody,
  FileWatcher,
  HeadState,
  InProgressOperation,
  Logger,
  OpErrorKind,
  OpRequest,
  OpResult,
  PackedCommitChunk,
  ProcessRunner,
  RefKind,
  RefRecord,
  RepoIdentity,
  RevertPreflight,
  RevertPrediction,
  Settings,
  StatusResult,
  StatusSummary,
  UndoRecord,
  UndoSlotSnapshot,
} from "@kira-version/core";
import {
  assertDefined,
  classifyCheckout,
  classifyInProgress,
  classifyRevert,
  CommitStore as CommitStoreImpl,
  describeInProgress,
  dirtyPathsFrom,
  summarizeStatus,
  UNDO_POLICY,
  UndoSlot,
} from "@kira-version/core";
import { DEFAULT_MAX_BLOB_BYTES, openCatFileSession } from "./catFile.ts";
import type { GitResolution, GitVersion, ResolvedGit } from "./discovery.ts";
import { locateGit, resolveRepoIdentity } from "./discovery.ts";
import type { GitDriver, GitRead } from "./driver.ts";
import { openGitDriver } from "./driver.ts";
import { GitError } from "./errors.ts";
import type { LogSession } from "./logSession.ts";
import { openLogSession } from "./logSession.ts";
import {
  branchConfigRegexpArgs,
  branchCreateAndSwitchArgs,
  branchCreateArgs,
  branchDeleteArgs,
  branchRenameArgs,
  branchRevParseArgs,
} from "./ops/branch.ts";
import {
  rewrittenPathsArgs,
  switchArgs,
  switchCreateTrackingArgs,
  switchDetachArgs,
} from "./ops/checkout.ts";
import { abortArgs, continueArgs, readInProgressStateFiles } from "./ops/conflict.ts";
import { revertArgs } from "./ops/revert.ts";
import {
  tagCreateArgs,
  tagDeleteArgs,
  tagDeleteRemoteArgs,
  tagPushArgs,
  undoAnnotatedTagArgs,
  undoLightweightTagArgs,
} from "./ops/tag.ts";
import type { ParsedFileDiffBody } from "./parse/diff.ts";
import {
  fileDiffArgs,
  hasDeletedPostImage,
  parseFileDiffBody,
  worktreeDiffArgs,
} from "./parse/diff.ts";
import { parseRefRecord, REFS_FORMAT, REFS_RECORD_DELIMITER } from "./parse/refs.ts";
import type { RefsSnapshot } from "./queries.ts";
import {
  commitDetail,
  predictMerge,
  refsSnapshot as fetchRefsSnapshot,
  revertMergeParents,
  status,
} from "./queries.ts";
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
// P6/W8 — refs, status, pre-flight and the op executor. Local wire-shaped result types for the
// same reason `GitStatus`/`RepoOpenOutcome` above are: no consumer across the wire exists until
// `rpcHandlers.ts` (W11) binds this service to `@kira-version/ipc`'s contract.
// ---------------------------------------------------------------------------------------

export interface RefsResult {
  readonly branches: readonly RefRecord[];
  readonly remoteBranches: readonly RefRecord[];
  readonly tags: readonly RefRecord[];
  readonly head: HeadState;
}

/** §7.5's D \ T display cap (200): the *verdict* is always computed over the full, uncapped set
 *  (`dirtyPathsFrom`/`summarizeStatus` never truncate) — only the list a dialog would ever try to
 *  render gets capped, and only here, at the one layer that knows what "too many to show" means. */
const DIRTY_PATHS_DISPLAY_CAP = 200;

function capPaths(paths: readonly string[]): {
  readonly paths: string[];
  readonly truncated: boolean;
} {
  if (paths.length <= DIRTY_PATHS_DISPLAY_CAP) return { paths: [...paths], truncated: false };
  return { paths: paths.slice(0, DIRTY_PATHS_DISPLAY_CAP), truncated: true };
}

/** D12: `%(worktreepath)` is populated for a ref checked out in ANY worktree, including this
 *  session's own — subtracting the session's own toplevel here is what turns that raw field into
 *  "checked out ELSEWHERE" (`RefRecord.checkedOutIn`'s own doc comment; `parse/refs.ts`'s header
 *  comment says the same). Compared via `resolve()` on both sides so a trailing separator or a
 *  non-normalized root can never produce a false "elsewhere". */
function subtractOwnWorktree(records: readonly RefRecord[], ownRoot: string): RefRecord[] {
  const root = resolve(ownRoot);
  return records.map((r) =>
    r.checkedOutIn !== undefined && resolve(r.checkedOutIn) === root
      ? { ...r, checkedOutIn: undefined }
      : r,
  );
}

/** Every path `status` reports as unmerged — `classifyInProgress`'s `unmergedPaths` input, shared
 *  by `statusSummary`, both pre-flights and the executor's post-op read-back, so the four never
 *  drift on what "unmerged" means. */
function unmergedPathsFrom(result: StatusResult): string[] {
  return result.entries.filter((e) => e.kind === "unmerged").map((e) => e.path);
}

/**
 * Resolves the wire's bare `target: string` (`preflight.checkout`/`op.run`'s checkout) against a
 * ref snapshot into the `{kind, name}` shape `classifyCheckout` expects — branches checked before
 * tags before remote branches, so a local branch always wins a same-named ambiguity (the exact
 * case `checkout.test.ts`'s "a remote-branch target WITH a local counterpart" comment describes:
 * *this* is where that decision is actually made, not in the classifier). Anything matching
 * neither is a raw sha, passed through verbatim — `classifyCheckout`'s `sha` kind always detaches
 * and git itself will reject a target that resolves to nothing at all when the argv actually runs.
 */
function resolveCheckoutTarget(
  snapshot: RefsSnapshot,
  target: string,
): {
  readonly kind: RefKind | "sha";
  readonly name: string;
  readonly checkedOutIn: string | undefined;
} {
  const branch = snapshot.branches.find((r) => r.shortName === target);
  if (branch !== undefined) {
    return { kind: "branch", name: branch.shortName, checkedOutIn: branch.checkedOutIn };
  }
  const tag = snapshot.tags.find((r) => r.shortName === target);
  if (tag !== undefined) return { kind: "tag", name: tag.shortName, checkedOutIn: undefined };
  const remoteBranch = snapshot.remoteBranches.find((r) => r.shortName === target);
  if (remoteBranch !== undefined) {
    return { kind: "remoteBranch", name: remoteBranch.shortName, checkedOutIn: undefined };
  }
  return { kind: "sha", name: target, checkedOutIn: undefined };
}

/** `origin/topic` -> `topic` — the same heuristic `classifyCheckout`'s own module uses for the
 *  label; duplicated rather than imported because that one is `core`'s pure-data concern and this
 *  one picks the actual branch name the executor's `switch -c` argv will create. */
function localNameForRemoteBranch(remoteBranchName: string): string {
  const slash = remoteBranchName.indexOf("/");
  return slash === -1 ? remoteBranchName : remoteBranchName.slice(slash + 1);
}

function toUndoSnapshot(record: UndoRecord): UndoSlotSnapshot {
  return {
    id: record.id,
    label: record.label,
    recoverySha: record.recoverySha,
    createdAt: record.createdAt,
  };
}

/** One id per captured undo record — `crypto.randomUUID()` (available on both Node's and Bun's
 *  `globalThis`) is more than enough entropy for a value that only ever needs to match against
 *  the single record a session's one `UndoSlot` currently holds. */
function randomId(): string {
  return globalThis.crypto.randomUUID();
}

/** A plain one-shot collector, like `queries.ts`'s own `collectBytes` — duplicated rather than
 *  imported because that one is not exported (an internal helper of a file this one does not
 *  otherwise need), and this is a three-line function. */
async function collectOneShotBytes(read: GitRead): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of read.bytes) {
    chunks.push(chunk);
    total += chunk.length;
  }
  await read.done;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** A single `for-each-ref` record for exactly one refname — the undo-capture read a tag delete
 *  needs immediately before it runs (never `session.refsCache`, which may be stale by the time an
 *  op actually executes). `undefined` when the ref no longer resolves (a race with something else
 *  deleting it first) rather than a throw — for-each-ref exits 0 with empty output for a refname
 *  that matches nothing, so there is no error to catch here in the first place. */
async function collectSingleRefRecord(
  driver: GitDriver,
  refname: string,
): Promise<Uint8Array | undefined> {
  const read = driver.read(["for-each-ref", `--format=${REFS_FORMAT}`, refname]);
  const records: Uint8Array[] = [];
  for await (const record of read.records(REFS_RECORD_DELIMITER)) records.push(record);
  await read.done;
  return records.find((r) => r.length > 0);
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
  /** P6/W8: the last authoritative `HeadState`. Seeded from `identity.head` at open; refreshed
   *  by every one of `refs`/`statusSummary`/`runOp` that can see it for free, so a caller of
   *  `refs()` between two of those still gets *some* answer instead of nothing, even in the one
   *  narrow window (HEAD moves to a newly detached state from outside this session, between
   *  calls) `for-each-ref` cannot see at all — see this file's module doc / the Findings section
   *  of `docs/plans/P6.md` for the judgment call. */
  head: HeadState;
  /** P6/W8: `refs()`'s own cache, dropped on `refsChanged` alongside `detailCache` — a ref's
   *  identity is stable; its `track` and its `worktreepath` are not (mirrors `detailCache`'s own
   *  reasoning above, one level up). */
  refsCache: RefsResult | undefined;
  /** P6/W8 (§7.12): one undo record per session, replacing itself on every op the executor runs. */
  readonly undo: UndoSlot;
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
  // P6/W8 — refs, status, pre-flight, and the op executor (§7's four-step shape's host half).
  // ---------------------------------------------------------------------------------------

  /** §4.4/D12: two spawns (`refsSnapshot`), cached on the session and dropped on `refsChanged`
   *  (`#handleSignal`) — the same policy as `detailCache`, one level up. `head` comes from
   *  `for-each-ref`'s own `%(HEAD)` marker when a branch is checked out (authoritative for the
   *  overwhelmingly common case, and free — no third spawn); a detached or unborn HEAD is
   *  invisible to `for-each-ref` entirely, so those fall back to the session's cached `head`,
   *  itself refreshed by `statusSummary`/`runOp` below. */
  async refs(repoId: string): Promise<RefsResult> {
    const session = this.#requireSession(repoId);
    if (session.refsCache) return session.refsCache;

    const snapshot = await fetchRefsSnapshot(session.driver);
    const headBranch = snapshot.branches.find((r) => r.isHead);
    if (headBranch !== undefined) session.head = { kind: "branch", name: headBranch.shortName };

    const result: RefsResult = {
      branches: subtractOwnWorktree(snapshot.branches, session.identity.root),
      remoteBranches: subtractOwnWorktree(snapshot.remoteBranches, session.identity.root),
      tags: snapshot.tags,
      head: session.head,
    };
    session.refsCache = result;
    return result;
  }

  /** §4.4/§7.11: `status()` (P1) plus `ops/conflict.ts`'s state files, folded through
   *  `classifyInProgress` and `core`'s `summarizeStatus` — the wire-shaped `StatusSummary`.
   *  `dirtyPaths` is capped for display at 200 (`capPaths`); the *verdict* other callers
   *  (pre-flight) need is always computed over the full, uncapped set, never this one. */
  async statusSummary(repoId: string): Promise<StatusSummary> {
    const session = this.#requireSession(repoId);
    const { statusResult, inProgress } = await this.#statusAndInProgress(session);
    const summary = summarizeStatus(statusResult, inProgress);
    const { paths, truncated } = capPaths(summary.dirtyPaths);
    return { ...summary, dirtyPaths: paths, dirtyTruncated: truncated };
  }

  /** §7's pre-flight orchestration for checkout: gather the reads in parallel, resolve the
   *  wire's bare `target` string against the current ref snapshot (§7.5/§7.9 — this is where a
   *  same-named local branch wins over a remote-tracking one, per `resolveCheckoutTarget`'s own
   *  comment), call the pure classifier, return. No decisions here beyond "which query" — see
   *  the module doc on `classifyCheckout`'s `mode` parameter for why `mode` must be threaded
   *  through rather than derived from `target.kind` alone. */
  async preflightCheckout(
    repoId: string,
    target: string,
    mode: "switch" | "detach",
  ): Promise<CheckoutPreflight> {
    const session = this.#requireSession(repoId);
    const snapshot = await fetchRefsSnapshot(session.driver);
    const resolved = resolveCheckoutTarget(snapshot, target);
    const ownRoot = resolve(session.identity.root);
    const checkedOutIn =
      resolved.checkedOutIn !== undefined && resolve(resolved.checkedOutIn) !== ownRoot
        ? resolved.checkedOutIn
        : undefined;

    const [{ statusResult, inProgress }, rewritten] = await Promise.all([
      this.#statusAndInProgress(session),
      this.#rewrittenPaths(session, resolved.name),
    ]);

    return classifyCheckout({
      target: { kind: resolved.kind, name: resolved.name },
      mode,
      dirty: dirtyPathsFrom(statusResult),
      rewritten,
      targetTreePaths: null,
      inProgress,
      checkedOutIn,
      stashAvailable: false,
    });
  }

  /** §7's pre-flight orchestration for revert. `mergeParents` (one `show -s` per requested sha,
   *  plus one per distinct merge parent — `revertMergeParents`) is the wire's own missing half:
   *  `preflight.revert`'s request carries only `shas` and an optional already-chosen `mainline`,
   *  never the parent lists the mainline picker needs, so this is where they are looked up. The
   *  `merge-tree` prediction (§7.10) is scoped to `shas[0]` and only ever attempted once a single
   *  mainline is actually known for it — a merge commit with no mainline chosen yet has no one
   *  "other" tree to diff against, so `reason` says so rather than guessing `-m 1`. */
  async preflightRevert(
    repoId: string,
    shas: readonly string[],
    mainline?: number,
  ): Promise<RevertPreflight> {
    const session = this.#requireSession(repoId);
    const [{ statusResult, inProgress }, mergeParents] = await Promise.all([
      this.#statusAndInProgress(session),
      revertMergeParents(session.driver, shas),
    ]);

    const firstSha = shas[0];
    const prediction = await this.#predictRevert(session, firstSha, mergeParents, mainline);

    return classifyRevert({
      shas,
      mergeParents,
      mainline,
      dirtyPaths: dirtyPathsFrom(statusResult).map((d) => d.path),
      inProgress,
      detachedHead: session.head.kind === "detached",
      prediction,
    });
  }

  async #predictRevert(
    session: RepoSession,
    firstSha: string | undefined,
    mergeParents: ReadonlyMap<string, unknown>,
    mainline: number | undefined,
  ): Promise<RevertPrediction> {
    if (firstSha === undefined) return { kind: "unknown", reason: "no commit selected" };
    const isMerge = mergeParents.has(firstSha);
    if (isMerge && mainline === undefined) {
      return {
        kind: "unknown",
        reason: "a mainline parent must be chosen before predicting this merge commit's revert",
      };
    }
    const effectiveMainline = isMerge ? (mainline as number) : 1;
    try {
      return await predictMerge(session.driver, "HEAD", `${firstSha}^${effectiveMainline}`, {
        mergeBase: firstSha,
      });
    } catch (err) {
      return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** T for `classifyCheckout` — `git diff --name-only -z HEAD <target>`, collected into a plain
   *  path list. A failed spawn (an unresolvable `target`) propagates: pre-flight cannot honestly
   *  classify a target git itself cannot resolve, and the caller offered it from a ref list or a
   *  sha the UI already validated some other way. */
  async #rewrittenPaths(session: RepoSession, target: string): Promise<string[]> {
    const read = session.driver.read(rewrittenPathsArgs(target));
    const paths: string[] = [];
    const decoder2 = new TextDecoder("utf-8", { fatal: false });
    for await (const record of read.records(0x00)) {
      if (record.length > 0) paths.push(decoder2.decode(record));
    }
    await read.done;
    return paths;
  }

  /** §7.11's classification, shared by `statusSummary`, both pre-flights, and `runOp`/`undoRun`'s
   *  pre- and post-op reads — the one place `status()`, `readInProgressStateFiles` and
   *  `classifyInProgress` are joined, so no caller pays for a second `status` spawn just to get
   *  the same in-progress answer a sibling call already computed, and none of them can disagree
   *  on what "in progress" means. Also refreshes `session.head` as a side effect — every one of
   *  these callers already has a fresh `StatusResult` in hand, so this is the one place the cache
   *  can be kept honest for free (see `RepoSession.head`'s own doc comment on the narrow window
   *  this does not cover). */
  async #statusAndInProgress(session: RepoSession): Promise<{
    readonly statusResult: StatusResult;
    readonly inProgress: InProgressOperation | null;
  }> {
    const [statusResult, stateFiles] = await Promise.all([
      status(session.driver),
      readInProgressStateFiles(session.identity.gitDir),
    ]);
    const inProgress = classifyInProgress({
      stateFiles,
      unmergedPaths: unmergedPathsFrom(statusResult),
    });
    session.head = summarizeStatus(statusResult, inProgress).head;
    return { statusResult, inProgress };
  }

  /** Convenience over `#statusAndInProgress` for a caller that only needs the classification
   *  (the executor's early-abort/not-found paths) — still exactly one `status` spawn. */
  async #currentInProgress(session: RepoSession): Promise<InProgressOperation | null> {
    return (await this.#statusAndInProgress(session)).inProgress;
  }

  /**
   * §7's executor, in the plan's exact order:
   *   1. build argv          (no policy — `ops/*`)
   *   2. capture undo        (`UNDO_POLICY[op.kind] === "undoable"` → read the sha/config FIRST)
   *   3. `driver.write(argv)` (serialized; bumps `generation`; fires `onInvalidated` on success)
   *   4. read back           head + in-progress state, ALWAYS — success or failure
   *   5. `slot.set(record | null)` (null clears — §7.12)
   *   6. return `OpResult`
   *
   * Step 2 before step 3 is the entire correctness of undo: the sha must be read while the ref
   * still exists. Step 4 after *both* outcomes is what makes a conflicting revert — which fails
   * with `Conflict` and *leaves* `REVERT_HEAD` — produce an `OpResult` whose `inProgress` is
   * populated, so the banner appears from the operation's own reply, not a watcher tick.
   *
   * A `GitError` from step 3 is caught and mapped to `OpResult.error`, never rethrown: this is
   * the one request in the contract where a git failure is an expected outcome with a rendering,
   * not an exception. `GitCancelled` and `GitSpawnFailed` keep propagating, as everywhere else.
   */
  async runOp(repoId: string, op: OpRequest): Promise<OpResult> {
    const session = this.#requireSession(repoId);
    const prepared = await this.#prepareOp(session, op);

    if (prepared.earlyError) {
      // Nothing to git: e.g. `opContinue` with no operation in progress at all. No write ever
      // ran, so no generation bump and no undo-slot mutation beyond the usual clearing.
      session.undo.set(null);
      const inProgress = await this.#currentInProgress(session);
      return { ok: false, error: prepared.earlyError, undo: null, head: session.head, inProgress };
    }

    let error: OpResult["error"];
    try {
      for (const argv of prepared.argvList) {
        await session.driver.write(argv);
      }
    } catch (err) {
      if (err instanceof GitError) {
        error = { kind: err.kind, message: err.stderr.trim() || err.message };
      } else {
        throw err;
      }
    }

    const ok = error === undefined;
    // `UNDO_POLICY` is the actual authority consulted here, not just which `#prepareOp` branch
    // happened to build a record: a record from a kind `UNDO_POLICY` marks `notUndoable` is
    // dropped rather than trusted, so the total mapping stays the one place this can never
    // silently drift from the executor's own per-kind capture logic.
    const record = ok && UNDO_POLICY[op.kind].kind === "undoable" ? prepared.undo : null;
    session.undo.set(record);

    // Step 4: read back head + in-progress state, ALWAYS — success or failure (a conflicting
    // revert fails with `Conflict` and *leaves* `REVERT_HEAD`; this is what surfaces it here
    // rather than waiting on a watcher tick).
    const { inProgress } = await this.#statusAndInProgress(session);

    return {
      ok,
      error,
      undo: record ? toUndoSnapshot(record) : null,
      head: session.head,
      inProgress,
    };
  }

  /** `undo.peek` — the current slot, or `null`. Never mutates it. */
  undoPeek(repoId: string): UndoSlotSnapshot | null {
    const session = this.#requireSession(repoId);
    const record = session.undo.peek();
    return record ? toUndoSnapshot(record) : null;
  }

  /** `undo.run` — takes the record (so a replayed undo cannot be replayed twice), checks the
   *  captured recovery sha still resolves (`cat-file -e <sha>^{commit}`; §7.12's "so the user can
   *  recover manually even after the slot is cleared" only holds if a stale sha is refused rather
   *  than replayed against something else entirely), then replays its argv list in order. Reuses
   *  `runOp`'s own read-back/error-mapping shape rather than duplicating it. */
  async undoRun(repoId: string, id: string): Promise<OpResult> {
    const session = this.#requireSession(repoId);
    const record = session.undo.take(id);
    if (record === null) {
      const inProgress = await this.#currentInProgress(session);
      return {
        ok: false,
        error: { kind: "NotFound", message: "This undo is no longer available." },
        undo: null,
        head: session.head,
        inProgress,
      };
    }

    const stillResolves = await session.driver.catFile.check(`${record.recoverySha}^{commit}`);
    if (stillResolves.kind === "missing") {
      const inProgress = await this.#currentInProgress(session);
      return {
        ok: false,
        error: {
          kind: "NotFound",
          message: `The recovered commit ${record.recoverySha.slice(0, 7)} no longer exists.`,
        },
        undo: null,
        head: session.head,
        inProgress,
      };
    }

    let error: OpResult["error"];
    try {
      for (const argv of record.replay) {
        await session.driver.write(argv);
      }
    } catch (err) {
      if (err instanceof GitError) {
        error = { kind: err.kind, message: err.stderr.trim() || err.message };
      } else {
        throw err;
      }
    }

    const { inProgress } = await this.#statusAndInProgress(session);

    return { ok: error === undefined, error, undo: null, head: session.head, inProgress };
  }

  /** Step 1+2 of `runOp`'s executor: builds the argv list (one entry, except `branchCreate` with
   *  an explicit `track` that differs from plain DWIM-on-`startPoint`, which is create-and-switch
   *  plus one `--set-upstream-to`) and — for exactly the two op kinds `UNDO_POLICY` marks
   *  `"undoable"` — captures the pre-op state the eventual undo replay needs. Both happen before
   *  any write. `earlyError` is set instead of an argv list only for `opContinue`/`opAbort` with
   *  no operation in progress to act on at all — there is no subcommand to even pick without
   *  knowing the current kind, so this is caught here rather than spawning something arbitrary. */
  async #prepareOp(
    session: RepoSession,
    op: OpRequest,
  ): Promise<{
    readonly argvList: readonly (readonly string[])[];
    readonly undo: UndoRecord | null;
    readonly earlyError?: { readonly kind: OpErrorKind; readonly message: string };
  }> {
    switch (op.kind) {
      case "checkout": {
        const snapshot = await fetchRefsSnapshot(session.driver);
        const resolved = resolveCheckoutTarget(snapshot, op.target);
        const willDetach =
          op.mode === "detach" || resolved.kind === "tag" || resolved.kind === "sha";
        const discard = op.discardLocalChanges;
        if (willDetach) {
          return { argvList: [switchDetachArgs(resolved.name, { discard })], undo: null };
        }
        if (resolved.kind === "remoteBranch") {
          const branch = localNameForRemoteBranch(resolved.name);
          return {
            argvList: [switchCreateTrackingArgs(branch, resolved.name, { discard })],
            undo: null,
          };
        }
        return { argvList: [switchArgs(resolved.name, { discard })], undo: null };
      }
      case "branchCreate": {
        if (!op.checkout) {
          const trackOpt = op.track !== undefined ? { track: op.track } : {};
          return { argvList: [branchCreateArgs(op.name, op.startPoint, trackOpt)], undo: null };
        }
        const argvList: string[][] = [branchCreateAndSwitchArgs(op.name, op.startPoint)];
        if (op.track !== undefined) {
          argvList.push(["branch", `--set-upstream-to=${op.track}`, op.name]);
        }
        return { argvList, undo: null };
      }
      case "branchDelete": {
        const undo = await this.#captureBranchDeleteUndo(session, op.name);
        return { argvList: [branchDeleteArgs(op.name, { force: op.force })], undo };
      }
      case "branchRename":
        return { argvList: [branchRenameArgs(op.from, op.to)], undo: null };
      case "tagCreate": {
        const opts: { message?: string; force?: boolean } = { force: op.force };
        if (op.message !== undefined) opts.message = op.message;
        return { argvList: [tagCreateArgs(op.name, op.target, opts)], undo: null };
      }
      case "tagDelete": {
        const undo = await this.#captureTagDeleteUndo(session, op.name);
        return { argvList: [tagDeleteArgs(op.name)], undo };
      }
      case "tagPush":
        return { argvList: [tagPushArgs(op.remote, op.names)], undo: null };
      case "tagDeleteRemote":
        return { argvList: [tagDeleteRemoteArgs(op.remote, op.name)], undo: null };
      case "revert": {
        const opts: { mainline?: number; noCommit?: boolean } = { noCommit: op.noCommit };
        if (op.mainline !== undefined) opts.mainline = op.mainline;
        return { argvList: [revertArgs(op.shas, opts)], undo: null };
      }
      case "opContinue":
      case "opAbort": {
        const inProgress = await this.#currentInProgress(session);
        const verb = op.kind === "opContinue" ? "Continue" : "Abort";
        if (inProgress === null) {
          return {
            argvList: [],
            undo: null,
            earlyError: {
              kind: "Unknown",
              message: `No operation is currently in progress to ${verb.toLowerCase()}.`,
            },
          };
        }
        const argv =
          op.kind === "opContinue" ? continueArgs(inProgress.kind) : abortArgs(inProgress.kind);
        if (argv === undefined) {
          return {
            argvList: [],
            undo: null,
            earlyError: {
              kind: "Unknown",
              message: `${describeInProgress(inProgress)} offers no ${verb}.`,
            },
          };
        }
        return { argvList: [argv], undo: null };
      }
    }
  }

  /** Undo-capture for a branch delete (probe P4): the branch's current tip (still resolvable
   *  immediately before the delete — this is what makes the recovery sha the one right before it,
   *  not a stale guess) plus every `branch.<name>.*` config line, replayed back in order on undo.
   *  Best-effort: a branch that fails to resolve here (a race with something else deleting it)
   *  yields `null` — the delete itself will then simply fail with `NotFound`, and there is nothing
   *  to capture regardless. */
  async #captureBranchDeleteUndo(session: RepoSession, name: string): Promise<UndoRecord | null> {
    let sha: string;
    try {
      const bytes = await collectOneShotBytes(session.driver.read(branchRevParseArgs(name)));
      sha = new TextDecoder().decode(bytes).trim();
      if (sha.length === 0) return null;
    } catch {
      return null;
    }

    let configLines: string[] = [];
    try {
      const bytes = await collectOneShotBytes(session.driver.read(branchConfigRegexpArgs(name)));
      configLines = new TextDecoder()
        .decode(bytes)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    } catch {
      // `--get-regexp` exits 1 with empty output when the branch has no config at all — not an
      // error, just nothing to replay beyond the ref itself.
      configLines = [];
    }

    const replay: string[][] = [["update-ref", `refs/heads/${name}`, sha]];
    for (const line of configLines) {
      const space = line.indexOf(" ");
      if (space === -1) continue;
      replay.push(["config", line.slice(0, space), line.slice(space + 1)]);
    }

    return {
      id: randomId(),
      label: `Deleted branch ${name}`,
      recoverySha: sha,
      createdAt: Date.now(),
      replay,
    };
  }

  /** Undo-capture for a tag delete (probe P3): reads the ref fresh (never from `refsCache`, which
   *  may be stale) right before the delete, so the annotated-vs-lightweight replay choice — and
   *  the sha it replays at — reflect the tag as it stood at that instant, not whenever it was
   *  last listed. */
  async #captureTagDeleteUndo(session: RepoSession, name: string): Promise<UndoRecord | null> {
    let record: RefRecord;
    try {
      const bytes = await collectSingleRefRecord(session.driver, `refs/tags/${name}`);
      if (bytes === undefined) return null;
      record = parseRefRecord(bytes);
    } catch {
      return null;
    }

    const replay =
      record.objectType === "tag"
        ? [undoAnnotatedTagArgs(name, record.objectId)]
        : [undoLightweightTagArgs(name, record.objectId)];

    return {
      id: randomId(),
      label: `Deleted tag ${name}`,
      recoverySha: record.objectId,
      createdAt: Date.now(),
      replay,
    };
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
      head: identity.head,
      refsCache: undefined,
      undo: new UndoSlot(),
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
      // P6/W8: same policy, one level up — a ref's `track`/`worktreepath` are not immutable either.
      session.refsCache = undefined;
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
