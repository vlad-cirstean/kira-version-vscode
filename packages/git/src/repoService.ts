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
  BaseCandidate,
  BaseResolutionReason,
  CheckoutPreflight,
  CommitDetail,
  CommitRecord,
  CommitStore,
  CredentialPrompt,
  DiffHunk,
  Disposable,
  FileChange,
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
  PullConfigValues,
  PullPreflight,
  PushPreflight,
  RefKind,
  RefRecord,
  RefUpdate,
  RemoteOpRequest,
  RemoteOpResult,
  RepoIdentity,
  RevertPrediction,
  RevertPreflight,
  Settings,
  StashBranchPreflight,
  StashEntry,
  StashPopPreflight,
  StashRowFilter,
  StatusResult,
  StatusSummary,
  UndoRecord,
  UndoSlotSnapshot,
} from "@kira-version/core";
import {
  applyStashRowFilter,
  assertDefined,
  buildPullPreflight,
  buildStashRowFilter,
  CommitStore as CommitStoreImpl,
  classifyCheckout,
  classifyInProgress,
  classifyPush,
  classifyRevert,
  classifyStashBranch,
  classifyStashPop,
  describeInProgress,
  dirtyPathsFrom,
  matchProtectedBranch,
  resolveBase,
  resolvePullStrategy,
  summarizeStatus,
  UNDO_POLICY,
  UndoSlot,
} from "@kira-version/core";
import { AskpassBroker, type AskpassSession, shouldInterposeAskpass } from "./askpass.ts";
import { DEFAULT_MAX_BLOB_BYTES, openCatFileSession } from "./catFile.ts";
import type { GitResolution, GitVersion, ResolvedGit } from "./discovery.ts";
import { locateGit, resolveRepoIdentity } from "./discovery.ts";
import type { GitDriver, GitRead, GitWriteResult } from "./driver.ts";
import { openGitDriver } from "./driver.ts";
import { GitCancelled, GitError } from "./errors.ts";
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
import { fetchArgs, parseRefUpdates } from "./ops/fetch.ts";
import {
  ffOnlyWouldDiverge,
  mergeArgs,
  mergeFfOnlyArgs,
  parsePullConfig,
  pullConfigArgs,
  rebaseArgs,
} from "./ops/pull.ts";
import {
  deleteRemoteBranchArgs,
  forcePushLeaseArgs,
  forcePushPlainArgs,
  pushArgs,
} from "./ops/push.ts";
import { revertArgs } from "./ops/revert.ts";
import {
  stashApplyArgs,
  stashBranchArgs,
  stashDropArgs,
  stashPopArgs,
  stashPushArgs,
  stashRevParseArgs,
  stashStoreArgs,
} from "./ops/stash.ts";
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
import { stashShowNameOnlyArgs, stashUntrackedPathsArgs } from "./parse/stash.ts";
import type { ParsedProgress } from "./progress.ts";
import { createProgressParser } from "./progress.ts";
import type { RefsSnapshot } from "./queries.ts";
import {
  commitDetail,
  countRange,
  detectDefaultBranch,
  refsSnapshot as fetchRefsSnapshot,
  mergeBase,
  predictMerge,
  revertMergeParents,
  stashList as stashListQuery,
  stashShow as stashShowQuery,
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

// ---------------------------------------------------------------------------------------
// P8 — Remote ops' local wire-shaped types (see the module doc comment for why local, not ipc's).
// ---------------------------------------------------------------------------------------

/** `GitDriver.writeStreaming`'s `onStderr` tee, fanned out to every `onOpProgress` subscriber —
 *  `ParsedProgress` (`progress.ts`) plus the `repoId` a driver-level event has no way to know on
 *  its own. ipc's own `RemoteProgress` (`contract.ts`) adds nothing beyond that same pair. */
export interface RemoteOpProgress extends ParsedProgress {
  readonly repoId: string;
}

// ---------------------------------------------------------------------------------------
// P7 — Branch review's wire-shaped types (see the module doc comment for why local, not ipc's).
// ---------------------------------------------------------------------------------------

/** A `<base>..<branch>` two-dot range, both short ref names (§6.8/D30). */
export interface CommitRange {
  readonly base: string;
  readonly branch: string;
}

/** §6.8's four mutually-exclusive states, decided before the first row is painted — see
 *  `docs/plans/P7.md`'s "Base resolution has four outcomes" for why an empty walk cannot answer
 *  this question on its own. */
export type ReviewRangeState =
  | { readonly kind: "ready"; readonly commitCount: number }
  | { readonly kind: "empty" }
  | { readonly kind: "unrelated" }
  | { readonly kind: "ask" };

export interface BaseResolution {
  readonly branch: string;
  /** `null` iff `reason === "none"`. */
  readonly base: string | null;
  readonly reason: BaseResolutionReason;
  readonly range: ReviewRangeState;
  readonly candidates: readonly BaseCandidate[];
}

function rangeEquals(a: CommitRange, b: CommitRange): boolean {
  return a.base === b.base && a.branch === b.branch;
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
  /** P8/W15: a thunk, not a frozen snapshot — matches `RepoHandlersDeps.settings`'s own shape so
   *  `extension.ts` can pass the exact same closure to both. Every read site calls it fresh
   *  (`this.#deps.settings()["kiraVersion.X"]`) rather than caching a value at construction time;
   *  the one caller that actually depends on this is the auto-fetch scheduler (`#autoFetchTick`),
   *  whose whole "re-arms on settings change" behaviour (§ W15 item 3) falls out for free by
   *  simply re-reading `kiraVersion.fetch.autoInterval` on every poll rather than needing a
   *  separate settings-changed push into this service — before this, `Settings` was frozen at
   *  `create()` time, so changing `kiraVersion.fetch.autoInterval` from `0` without a window
   *  reload would never have taken effect at all. */
  readonly settings: () => Settings;
  readonly configuredGitCandidates: readonly string[];
  /** P8/W14: optional so the many existing call sites that already build `RepoServiceDeps` need
   *  not all learn about it at once. Absent means a remote op that needs a credential never
   *  interposes the askpass broker — git's own `GIT_TERMINAL_PROMPT=0` (`driver.ts`'s
   *  `buildGitEnv`, §4.3) still guarantees no hang either way; it just fails with `AuthFailed`
   *  instead of ever having anywhere to route a prompt. */
  readonly credentialPrompt?: CredentialPrompt;
}

/** How many rows one `streamGraph` chunk carries, whether replayed from cache or freshly read
 *  from git — §5.1's "first commits painted" budget, not §5.1.1's page size. Exported so a test
 *  building a small generated repo can assert chunk boundaries without hard-coding 500. */
export const CHUNK_ROWS = 500;

/** §5.4/§5.5: how long a hidden repo's state survives before `setUiVisible(false)` evicts it.
 *  An exported named constant, not a literal in a closure — deliberately not a setting; see this
 *  file's `#evict` for what eviction actually discards. */
export const HIDDEN_EVICT_MS = 5 * 60 * 1000;

/** P8/OQ10: how often a remote op's progress may fan out to `onOpProgress` subscribers, at most —
 *  see `#createProgressEmitter`. */
export const PROGRESS_THROTTLE_MS = 100;

/**
 * P8/W15: the auto-fetch scheduler's own poll cadence — how often it re-evaluates every open
 * session against the live `kiraVersion.fetch.autoInterval` setting and the current
 * focused/visible flags, real minutes converted via `AUTO_FETCH_MS_PER_MINUTE` below. A polling
 * design, not a single `setTimeout` slept for the full configured interval and re-armed on
 * demand, is the deliberate choice here: `RepoServiceDeps.settings` is a pull-based thunk with no
 * push notification when it changes, so a sleep-and-re-arm design would need a *new* "settings
 * changed" method on this service that every host remembers to call; a cheap, frequent poll gets
 * "re-arms on settings change" (and on focus/visibility change — see `setHostFocused`/
 * `setUiVisible`) for free, correctly, from every host, with nothing further to wire. The poll
 * itself is nearly free (a settings read plus a `Date.now()` comparison per open session), so
 * running it for the life of the service — even while auto-fetch is off, the common case — rather
 * than starting and stopping it costs nothing worth optimising for.
 */
export const AUTO_FETCH_POLL_MS = 30_000;

/** P8/W15: `kiraVersion.fetch.autoInterval`'s unit (OQ3) is minutes; this is what a test overrides
 *  to make "1 minute" a handful of real milliseconds rather than an actual 60,000. */
export const AUTO_FETCH_MS_PER_MINUTE = 60_000;

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
  /** Testability hook for `AUTO_FETCH_POLL_MS` (W15) — lets a test observe several polls without
   *  a real 30-second wait. Additive, defaults to the real constant. */
  readonly autoFetchPollMs?: number;
  /** Testability hook for `AUTO_FETCH_MS_PER_MINUTE` (W15) — lets a test express
   *  `kiraVersion.fetch.autoInterval: 1` as a few real milliseconds instead of a real minute.
   *  Additive, defaults to the real constant. */
  readonly autoFetchMsPerMinute?: number;
  /** Testability hook for `DEFAULT_ASKPASS_TIMEOUT_MS` (W13/W19) — lets a test that never answers
   *  a credential prompt observe the broker's own timeout-to-`AuthFailed` path inside a normal
   *  test timeout, rather than the real 120s. Additive, defaults to the real constant. */
  readonly askpassTimeoutMs?: number;
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
  /** P8/W14: the one remote op this session may have in flight — a second concurrent one on the
   *  same repo is rejected with `OperationInProgress` rather than queued (OQ7). `undefined` when
   *  none is running. `killable` starts `true` for `fetch`/`pull` and `false` for everything else
   *  (D50's cancellability table), and `#runPull` flips it to `false` itself once its own fetch
   *  phase hands off to the non-killable merge/rebase phase — `cancelRemoteOp` consults it so a
   *  cancel past that point is reported as refused rather than silently doing nothing. */
  activeRemoteOp:
    | { readonly opId: string; readonly controller: AbortController; killable: boolean }
    | undefined;
  /** P8/W15: when this session last ran (or was last due to run, if it was skipped for being
   *  busy) a silent auto-fetch — initialized to session-open time so "the first tick waits a full
   *  interval" (plan text) holds even for a repo opened seconds before the scheduler's next poll,
   *  not just after this session's first successful fetch. */
  autoFetchLastAt: number;
  /** P8/W15: latched `true` the first time this session's own silent auto-fetch fails (§7.1:
   *  "disables itself for the session"), never cleared short of closing and re-opening the repo —
   *  a toolbar can render this subtly (D-none: no exit criterion names the exact affordance). */
  autoFetchDisabled: boolean;
  /** P7 W4 — Branch review's own, deliberately ephemeral second walk. `undefined` when no review
   *  is open for this repo. Never a `RepoSession`: it has no driver, watcher, caches or undo slot
   *  of its own — see `docs/plans/P7.md`'s "the streaming machinery is a singleton" for why this
   *  is exactly six fields and not a second copy of the object above it. */
  reviewWalk: ReviewWalk | undefined;
  /** The most recent `resolveReviewBase`'s `ready` outcome, so opening the review walk right
   *  after doesn't re-run `rev-list --count` for the same range a second time in the same
   *  second. Cleared implicitly whenever a *different* range is resolved (nothing reads a stale
   *  entry: `#ensureReviewWalk` only consults it when the ranges still match). */
  lastReviewResolution: { readonly range: CommitRange; readonly commitCount: number } | undefined;
  /** P9/W8, refreshed by W12: the sha -> entry map from the most recent `stash list` read — used
   *  by `#captureStashDropUndo` (the drop-undo replay needs the dropped entry's own message) and
   *  by `#refreshStashGraphInputs` to build `stashRowFilter` below. Populated as a side effect of
   *  `stashList()`/`preflightStashPop()`/`preflightStashBranch()` (each spawns its own fresh
   *  `stash list`) AND, since W12, of every `#openSession`/`#resetSession` — the graph's own walk
   *  cannot show anything past `stash@{0}` without first knowing the full list itself (see
   *  `revSetArgs`'s own doc comment), so opening or refreshing the panel now keeps this at least
   *  as fresh as the graph currently on screen, not merely "as fresh as the most recent explicit
   *  stash RPC" as it was through W8 alone. Still best-effort: a failed `stash list` (should not
   *  happen — it is a plain read) degrades to "no stashes known yet" rather than failing the
   *  whole repo open. */
  stashShapes: ReadonlyMap<string, StashEntry>;
  /** P9 W12: derived from `stashShapes` (via `buildStashRowFilter`) every time it refreshes above
   *  — the graph's own page-read post-pass reads this, never `stashShapes` directly, so the
   *  "empty ⇒ pass-through" and "`kiraVersion.stash.showInGraph` gates the walk, never the undo
   *  path" rules live in exactly one place (`#refreshStashGraphInputs`). */
  stashRowFilter: StashRowFilter;
}

/**
 * P7 W4: exactly the fields a walk needs to append rows and pack chunks, whether that walk is
 * the panel's own scoped one (a `RepoSession` satisfies this structurally, unchanged) or a
 * `ReviewWalk` — `#emitRange` is written against this rather than against `RepoSession` so one
 * implementation serves both walks without either being able to reach the other's fields.
 */
interface WalkLike {
  readonly store: CommitStore;
  dictionaryMarks: Map<number, number>;
  nextSeq: number;
  lastRemaining: number;
  readonly logSession: LogSession;
}

/** P7 W4 — Branch review's own walk. Deliberately not a `RepoSession`: no driver of its own (it
 *  borrows the session's), no watcher, no caches, no undo slot, no head — the honest statement
 *  of what a second walk actually is (`docs/plans/P7.md`'s own phrasing). */
interface ReviewWalk extends WalkLike {
  /** What this walk IS — the key `#ensureReviewWalk` uses to decide "same range?" before
   *  deciding whether to reuse it or dispose and rebuild. */
  readonly range: CommitRange;
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
  /** P8/W14. */
  readonly #progressListeners = new Set<(e: RemoteOpProgress) => void>();
  /** P8/W14: one broker for the whole service (its own doc comment: "either lifetime is fine"),
   *  started lazily on first use so a `RepoService` that never touches a remote op never pays for
   *  the temp dir + unix socket `AskpassBroker.start()` sets up. `#askpassSessionPromise` — not a
   *  plain resolved value — so two remote ops (different repos) racing to be first still share
   *  one `start()` call rather than each kicking off their own. */
  #askpassBroker: AskpassBroker | undefined;
  #askpassSessionPromise: Promise<AskpassSession> | undefined;
  /** P8/W15: §7.1's auto-fetch guardrail — no port for either of these (module doc: "the host
   *  pushing a fact in, the same direction `setUiVisible` already goes"). Both default `true`: a
   *  service is normally constructed only once its host already knows its own focus/visibility,
   *  and every existing test defaults `kiraVersion.fetch.autoInterval` to `0` (off) regardless, so
   *  a permissive default here changes nothing for a caller that never touches either setter. */
  #hostFocused = true;
  #uiVisible = true;
  readonly #autoFetchPollMs: number;
  readonly #autoFetchMsPerMinute: number;
  readonly #autoFetchTimer: ReturnType<typeof setInterval>;
  readonly #askpassTimeoutMs: number | undefined;

  readonly git: GitStatus;

  private constructor(
    deps: RepoServiceDeps,
    resolution: GitResolution,
    evictMs: number,
    diffCacheMaxBytes: number,
    detailCacheMaxEntries: number,
    autoFetchPollMs: number,
    autoFetchMsPerMinute: number,
    askpassTimeoutMs: number | undefined,
  ) {
    this.#deps = deps;
    this.#resolution = resolution;
    this.#evictMs = evictMs;
    this.#diffCacheMaxBytes = diffCacheMaxBytes;
    this.#detailCacheMaxEntries = detailCacheMaxEntries;
    this.#logger = deps.logger.child("repoService");
    this.git = toGitStatus(resolution);
    this.#autoFetchPollMs = autoFetchPollMs;
    this.#autoFetchMsPerMinute = autoFetchMsPerMinute;
    this.#askpassTimeoutMs = askpassTimeoutMs;
    // `unref()`: a pending poll must never be the reason a process (the harness under bun, a test
    // runner) stays alive — every other timer in this file (`evictTimer`) is a plain `setTimeout`
    // an explicit `close()`/test teardown clears; this one lives for the service's whole lifetime
    // instead, so it unrefs itself rather than asking every caller to remember `dispose()`.
    this.#autoFetchTimer = setInterval(() => this.#autoFetchTick(), this.#autoFetchPollMs);
    this.#autoFetchTimer.unref?.();
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
      opts.autoFetchPollMs ?? AUTO_FETCH_POLL_MS,
      opts.autoFetchMsPerMinute ?? AUTO_FETCH_MS_PER_MINUTE,
      opts.askpassTimeoutMs,
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

    const session = await this.#openSession(identity);
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
    session.reviewWalk?.logSession.dispose();
    session.driver.dispose();
  }

  /** §6.8's own `range`-less `status()` and its ranged sibling, in one method: `range` present
   *  reports the review walk's own counters (a zeroed status if none is open for exactly this
   *  range yet — the caller opens one via `streamGraph`/`loadMore` before this could matter). */
  status(
    repoId: string,
    range?: CommitRange,
  ): { loaded: number; remaining: number; exhausted: boolean } {
    const session = this.#requireSession(repoId);
    if (range) {
      const walk = session.reviewWalk;
      if (!walk || !rangeEquals(walk.range, range)) {
        return { loaded: 0, remaining: 0, exhausted: false };
      }
      return {
        loaded: walk.store.rowCount,
        remaining: walk.lastRemaining,
        exhausted: walk.logSession.exhausted,
      };
    }
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
      /** P7 W4: present ⇒ walk `<base>..<branch>` against this repo's own separate review walk
       *  instead of its `graph.scope` rev set. `resumeThroughRow` is ignored entirely in this
       *  branch — a ranged walk has no cache to resume from (§5.4's exclusion, made structural,
       *  `docs/plans/P7.md`'s own section by that name). */
      range?: CommitRange;
      onChunk: (chunk: GraphChunkPayload) => Promise<void>;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    const session = this.#requireSession(repoId);

    if (opts.range) {
      await this.#streamReviewGraph(session, opts.range, opts.onChunk, opts.signal);
      return;
    }

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
        session.repoId,
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
        session.repoId,
        cursor,
        to,
        dictionaryBase,
        "git",
        opts.onChunk,
      );
      cursor = to;
    }
  }

  /** The ranged half of `streamGraph` (P7 W4). Never consults `staleReason`/`#ensureFresh` — the
   *  review walk is not part of the graph's invalidation story (see open question 5's
   *  resolution: a mid-review `refsChanged` re-resolves quietly in the background instead, which
   *  is the review view's own job, not this method's). Always emits from row 0 with
   *  `source: "git"`; a re-open of the *same* range replays what the walk's store already holds
   *  rather than re-spawning (the ordinary `loadMore`-then-reopen round trip, not §5.4
   *  rehydration — the walk is dropped whole on `endReview`/hide). */
  async #streamReviewGraph(
    session: RepoSession,
    range: CommitRange,
    onChunk: (chunk: GraphChunkPayload) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const walk = this.#ensureReviewWalk(session, range);
    if (walk.store.rowCount === 0 && !walk.logSession.exhausted) {
      await this.#readReviewPage(session, walk, signal);
    }

    let cursor = 0;
    let dictionaryBase = 0;
    while (cursor < walk.store.rowCount) {
      if (signal?.aborted) return;
      const to = Math.min(cursor + CHUNK_ROWS, walk.store.rowCount);
      dictionaryBase = await this.#emitRange(
        walk,
        session.repoId,
        cursor,
        to,
        dictionaryBase,
        "git",
        onChunk,
      );
      cursor = to;
    }
  }

  async loadMore(
    repoId: string,
    pages = 1,
    signal?: AbortSignal,
    range?: CommitRange,
  ): Promise<void> {
    const session = this.#requireSession(repoId);

    if (range) {
      const walk = this.#ensureReviewWalk(session, range);
      for (let i = 0; i < pages && !walk.logSession.exhausted; i++) {
        if (signal?.aborted) return;
        await this.#readReviewPage(session, walk, signal);
      }
      return;
    }

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
    this.#uiVisible = visible;
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

  /** P8/W15: `extension.ts` wires `window.onDidChangeWindowState`; the harness wires
   *  `document.visibilityState`'s own focus-adjacent signal. No new port (module doc) — this is
   *  the host pushing a fact in, exactly like `setUiVisible` already does. The auto-fetch
   *  scheduler's next poll (at most `AUTO_FETCH_POLL_MS` away) picks this up on its own; nothing
   *  further needs telling. */
  setHostFocused(focused: boolean): void {
    this.#hostFocused = focused;
  }

  dispose(): void {
    clearInterval(this.#autoFetchTimer);
    for (const repoId of [...this.#sessions.keys()]) this.close(repoId);
    // Best-effort, same as `AskpassSession.dispose()`'s own contract: if `start()` never
    // resolved (no remote op ever ran), there is nothing to dispose in the first place.
    this.#askpassSessionPromise?.then((session) => session.dispose()).catch(() => {});
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
      // See classifyCheckout's own doc comment on this field: `T` (rewritten, above) already
      // coincides with the target tree for a plain checkout, so there is nothing this call site
      // would compute that the classifier does not already derive from `rewritten` alone.
      targetTreePaths: null,
      inProgress,
      checkedOutIn,
      // P9/W9: the one-line flip — `classifyCheckout`'s own `routes` logic has gated
      // `"stashAndCarry"` on this since it was written (W1-W4); this was the only site left
      // still passing `false`.
      stashAvailable: true,
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
    return this.#zPathList(session, rewrittenPathsArgs(target));
  }

  /** A `-z`-terminated path list from any argv, decoded and with the trailing empty fragment
   *  `read.records(0x00)` always yields after the last real record dropped. Shared by
   *  `#rewrittenPaths` (checkout's T) and P9's `classifyStashPop` gathering (`stashPaths` from
   *  `stashShowNameOnlyArgs`, `stashUntrackedPaths` from `stashUntrackedPathsArgs`) — all three
   *  are "run this diff-shaped command, get a flat path list back", nothing more. */
  async #zPathList(session: RepoSession, argv: readonly string[]): Promise<string[]> {
    const read = session.driver.read(argv);
    const paths: string[] = [];
    for await (const record of read.records(0x00)) {
      if (record.length > 0) paths.push(decoder.decode(record));
    }
    await read.done;
    return paths;
  }

  /** §7.6's `existingPaths` — a bounded `existsSync` per candidate path, never a worktree scan
   *  (mirrors `pathExistsInCheckout`'s own mechanism above; not delegated to it directly since
   *  these paths come from git itself — `ls-tree` on the stash's own untracked tree — not from
   *  the webview, so no path-escape guarding is needed here). */
  #existingStashPaths(session: RepoSession, paths: readonly string[]): string[] {
    const root = session.identity.root;
    return paths.filter((p) => {
      try {
        return existsSync(join(root, p));
      } catch {
        return false;
      }
    });
  }

  /** `git rev-parse HEAD` — the default `targetSha` for `preflightStashPop` when the wire request
   *  omits one (only the `stashAndCarry` route, W10/W13, ever supplies its own). */
  async #resolveHead(session: RepoSession): Promise<string> {
    const bytes = await collectOneShotBytes(session.driver.read(["rev-parse", "HEAD"]));
    return decoder.decode(bytes).trim();
  }

  /** `stash.list` (probe 12): one spawn for the whole stack, tracked file counts included. Also
   *  refreshes `session.stashShapes` — see that field's own doc comment for who reads it and why
   *  this is the one place (of three) that happens to double as its refresh. */
  async stashList(repoId: string): Promise<{ readonly entries: readonly StashEntry[] }> {
    const session = this.#requireSession(repoId);
    const entries = await stashListQuery(session.driver);
    session.stashShapes = new Map(entries.map((e) => [e.sha, e]));
    return { entries };
  }

  /** `stash.show` — the stash's own file list for the detail pane. A thin delegation to
   *  `queries.ts`'s own `stashShow` (two spawns, joined by the existing `combineFileChanges`) —
   *  no stash-specific diff parser exists, per probe 12. */
  async stashShow(
    repoId: string,
    sha: string,
  ): Promise<{ readonly sha: string; readonly changes: readonly FileChange[] }> {
    const session = this.#requireSession(repoId);
    return stashShowQuery(session.driver, sha);
  }

  /** Looks a stash entry up by BOTH its sha and its stack index — the same pair
   *  `preflight.stashPop`'s own wire request carries (mirroring every stack-mutating op's own
   *  `sha`/`index` addressing), so a stale request (the stack changed since the caller's last
   *  `stash.list`) is refused here with the same honesty `#verifyStashPosition` insists on
   *  immediately before a write, rather than silently classifying against the wrong entry. */
  #findStash(entries: readonly StashEntry[], sha: string, index: number): StashEntry {
    return assertDefined(
      entries.find((e) => e.sha === sha && e.index === index),
      `stash@{${index}} (${sha.slice(0, 7)}) is no longer at that position — refresh and try again`,
    );
  }

  /** `preflight.stashBranch`'s own wire request carries only `sha`, never an index (§7.6's
   *  contract table — there is nothing to guard against a stack reshuffle here: this is a read,
   *  and the write path re-verifies position on its own regardless). */
  #findStashBySha(entries: readonly StashEntry[], sha: string): StashEntry {
    return assertDefined(
      entries.find((e) => e.sha === sha),
      `stash ${sha.slice(0, 7)} is no longer in the stack — refresh and try again`,
    );
  }

  /** §7.6's pre-flight orchestration for `stashPop`/`stashApply`: gather, then delegate to the
   *  pure classifier. `targetSha` is supplied by the `stashAndCarry` route (W10/W13), which
   *  predicts against the commit it is about to switch to rather than HEAD. */
  async preflightStashPop(
    repoId: string,
    sha: string,
    index: number,
    targetSha?: string,
  ): Promise<StashPopPreflight> {
    const session = this.#requireSession(repoId);
    const [entries, { statusResult, inProgress }] = await Promise.all([
      stashListQuery(session.driver),
      this.#statusAndInProgress(session),
    ]);
    session.stashShapes = new Map(entries.map((e) => [e.sha, e]));
    const stash = this.#findStash(entries, sha, index);

    const target = targetSha ?? (await this.#resolveHead(session));
    const [prediction, stashPaths, stashUntrackedPaths] = await Promise.all([
      // NEVER without mergeBase (probe 2) — `predictMerge` already reinterprets merge-tree's
      // exit 1 as a conflicts result rather than a thrown `GitError`; no second read path exists.
      predictMerge(session.driver, target, stash.sha, { mergeBase: stash.baseSha }),
      this.#zPathList(session, stashShowNameOnlyArgs(stash.sha)),
      stash.untrackedSha !== undefined
        ? this.#zPathList(session, stashUntrackedPathsArgs(stash.untrackedSha))
        : Promise.resolve([]),
    ]);
    const existingPaths = this.#existingStashPaths(session, stashUntrackedPaths);

    return classifyStashPop({
      stash,
      targetSha: target,
      prediction,
      stashPaths,
      stashUntrackedPaths,
      dirty: dirtyPathsFrom(statusResult),
      existingPaths,
      inProgress,
    });
  }

  /** §7.6's pre-flight orchestration for `stash branch`: the branch is created AT THE STASH'S
   *  OWN BASE (`stash.baseSha`), so the checkout half this composes models a switch onto that sha
   *  — the apply half gets no merge-tree prediction of its own (probe 11: clean by construction).
   *  `target.kind: "sha"` makes the composed `CheckoutPreflight.detaches` read `true`, which is not
   *  quite accurate (`stash branch` always lands on a new named branch, never detached) — there is
   *  no `RefKind` for "a branch about to be created", `classifyStashBranch` itself never reads
   *  `detaches`, and no exit criterion depends on it, so this is a known, deliberate imprecision
   *  rather than a modelled case. `stashAvailable: false`: offering a `stashAndCarry` route while
   *  already resolving a stash op would be circular. */
  async preflightStashBranch(
    repoId: string,
    sha: string,
    branch: string,
  ): Promise<StashBranchPreflight> {
    const session = this.#requireSession(repoId);
    const [entries, snapshot, { statusResult, inProgress }] = await Promise.all([
      stashListQuery(session.driver),
      fetchRefsSnapshot(session.driver),
      this.#statusAndInProgress(session),
    ]);
    session.stashShapes = new Map(entries.map((e) => [e.sha, e]));
    const stash = this.#findStashBySha(entries, sha);

    const rewritten = await this.#rewrittenPaths(session, stash.baseSha);
    const checkout = classifyCheckout({
      target: { kind: "sha", name: stash.baseSha },
      mode: "switch",
      dirty: dirtyPathsFrom(statusResult),
      rewritten,
      targetTreePaths: null,
      inProgress,
      checkedOutIn: undefined,
      stashAvailable: false,
    });
    const existingBranchNames = new Set(snapshot.branches.map((b) => b.shortName));
    return classifyStashBranch({ name: branch, existingBranchNames, checkout });
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

    // P9/W8: a conflicting `stash pop`/`apply` writes its conflict markers to STDOUT and leaves
    // stderr EMPTY (probe 5) — `classifyGitError` has no pattern that could ever match it, so it
    // falls through to `Unknown` (`errors.ts`'s own `StashConflict` doc comment states this is
    // deliberate). This is the one place that refines that guess: `error` is already `Unknown`,
    // the op just ran was a pop/apply, and the read-back this method takes unconditionally shows
    // exactly the unmerged-index shape a conflicting pop leaves (no MERGE_HEAD or sibling state
    // file is ever written — the "unmergedOnly" fallback in `classifyInProgress`'s own precedence
    // table is what a stash conflict actually looks like on disk).
    if (
      error !== undefined &&
      error.kind === "Unknown" &&
      (op.kind === "stashPop" || op.kind === "stashApply") &&
      inProgress?.kind === "unmergedOnly"
    ) {
      error = {
        kind: "StashConflict",
        message: `Merged with conflicts in ${inProgress.conflictedPaths.join(", ")} — the stash was kept.`,
      };
    }

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

  // ---------------------------------------------------------------------------------------
  // P8/W14 — remote ops: fetch, push, pull, force-push, delete-remote-branch. See
  // `docs/plans/P8.md`'s "The hard parts" §1-§5 and W7-W14 for the design this implements.
  // ---------------------------------------------------------------------------------------

  /** §7.3's pull pre-flight: resolves the strategy (the same ladder `#runPull` re-runs after its
   *  own fetch — the git config it reads from cannot change merely by fetching) and reuses
   *  `#statusAndInProgress`'s existing `status()` read for ahead/behind/upstream/dirty rather than
   *  a second spawn (module doc / W14's own notes on reusing `StatusBranchInfo`). */
  async preflightPull(repoId: string, branch: string): Promise<PullPreflight> {
    const session = this.#requireSession(repoId);
    const [{ statusResult, inProgress }, gitConfig] = await Promise.all([
      this.#statusAndInProgress(session),
      this.#readPullConfig(session, branch),
    ]);
    const settingStrategy = this.#deps.settings()["kiraVersion.pull.strategy"];
    const { strategy, source } = resolvePullStrategy({ settingStrategy, gitConfig });
    return buildPullPreflight({
      strategy,
      source,
      upstream: statusResult.branch.upstream ?? null,
      ahead: statusResult.branch.ahead ?? 0,
      behind: statusResult.branch.behind ?? 0,
      dirty: !summarizeStatus(statusResult, inProgress).isClean,
    });
  }

  /** §7.4's push pre-flight. `branch` is assumed to be HEAD's current branch — `status --branch`
   *  (`#statusAndInProgress`) is the one spawn this reuses for ahead/behind/upstream, and it only
   *  ever reports those for whichever branch HEAD is on; pushing anything else is out of scope
   *  for P8's toolbar (§3.5), which only ever offers push for the checked-out branch. */
  async preflightPush(repoId: string, branch: string, remote: string): Promise<PushPreflight> {
    const session = this.#requireSession(repoId);
    const [{ statusResult }, remoteTip] = await Promise.all([
      this.#statusAndInProgress(session),
      this.#readRemoteTrackingTip(session, remote, branch),
    ]);
    return classifyPush({
      branch,
      upstream: statusResult.branch.upstream ?? null,
      ahead: statusResult.branch.ahead ?? 0,
      behind: statusResult.branch.behind ?? 0,
      remoteTip,
      protectedBranches: this.#deps.settings()["kiraVersion.protectedBranches"],
    });
  }

  /**
   * `remote.run`'s executor. **Deliberately not routed through `runOp`**: `runOp`'s executor
   * unconditionally calls `session.undo.set(...)` on every path (`#prepareOp`'s early-error branch
   * clears it; the normal path sets a record or clears it per `UNDO_POLICY`) — folding a remote op
   * into that would force a choice between polluting the undo slot for an operation §7.12 says
   * never touches it in either direction (OQ6 — confirmed; see `RemoteOpResult`'s own doc comment)
   * or growing `runOp` a special case that defeats its own simplicity. Progress correlation,
   * killability, and the concurrency guard below are D51's three further reasons for a wholly
   * separate path.
   *
   * `opId` is generated UI-side (so `remote.progress` can be correlated before this resolves) and
   * threaded through to the askpass broker's `withOp` — never generated here.
   */
  async runRemoteOp(
    repoId: string,
    opId: string,
    request: RemoteOpRequest,
  ): Promise<RemoteOpResult> {
    const session = this.#requireSession(repoId);

    // OQ7: reject a second concurrent remote op on this repo outright rather than queue it.
    if (session.activeRemoteOp !== undefined) {
      return this.#remoteOpFailure(
        session,
        "OperationInProgress",
        "Another remote operation is already running for this repository.",
      );
    }

    // D52: protected-branch enforcement gates force-push (both flavors) and remote-branch
    // deletion only — re-checked here because a pre-flight is advice, not a lock, and
    // `confirmToken` from the wire is never trusted on its own.
    if (
      (request.kind === "forcePush" || request.kind === "deleteRemoteBranch") &&
      request.branch !== undefined
    ) {
      const match = matchProtectedBranch(
        request.branch,
        this.#deps.settings()["kiraVersion.protectedBranches"],
      );
      if (match !== null && request.confirmToken !== request.branch) {
        return this.#remoteOpFailure(
          session,
          "ProtectedBranch",
          `"${request.branch}" is protected by the pattern "${match.pattern}" — type the branch name to confirm.`,
        );
      }
    }

    const controller = new AbortController();
    // D50's cancellability table: fetch and pull's own fetch phase are killable; everything else
    // — including pull's later merge/rebase phase, which `#runPull` flips this to `false` itself
    // once the fetch phase hands off — is not.
    const killable = request.kind === "fetch" || request.kind === "pull";
    session.activeRemoteOp = { opId, controller, killable };
    try {
      return await this.#executeRemoteOp(session, opId, request, controller);
    } finally {
      session.activeRemoteOp = undefined;
    }
  }

  /** `remote.cancel`. `false` — never an error — when there is nothing to cancel: no remote op is
   *  running for `repoId`, or the running one is past its killable phase (D50) and an abort here
   *  would be a silent no-op per `StreamingWriteOptions`' own contract; reporting that honestly
   *  (rather than claiming success) is exactly W19's "cancel is refused mid-push" criterion. */
  cancelRemoteOp(repoId: string): boolean {
    const session = this.#sessions.get(repoId);
    const active = session?.activeRemoteOp;
    if (active === undefined || !active.killable) return false;
    active.controller.abort();
    return true;
  }

  /** P8/W14/W16: `panelView.ts` subscribes to fan `remote.progress` out to its own channel;
   *  `reviewView.ts` deliberately does not (D41's precedent: that view renders no operation UI). */
  onOpProgress(fn: (e: RemoteOpProgress) => void): Disposable {
    this.#progressListeners.add(fn);
    return { dispose: () => this.#progressListeners.delete(fn) };
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
      case "stashPush": {
        const opts: {
          message?: string;
          includeUntracked?: boolean;
          keepIndex?: boolean;
          paths?: readonly string[];
        } = { includeUntracked: op.includeUntracked, keepIndex: op.keepIndex };
        if (op.message !== undefined) opts.message = op.message;
        if (op.paths.length > 0) opts.paths = op.paths;
        return { argvList: [stashPushArgs(opts)], undo: null };
      }
      // `apply` accepts a raw sha (probe 8) — no stack-position guard needed, unlike the three
      // stack-mutating cases below.
      case "stashApply":
        return {
          argvList: [stashApplyArgs(op.sha, { restoreIndex: op.restoreIndex })],
          undo: null,
        };
      case "stashPop": {
        const mismatch = await this.#verifyStashPosition(session, op.index, op.sha);
        if (mismatch) return { argvList: [], undo: null, earlyError: mismatch };
        return {
          argvList: [stashPopArgs(op.index, { restoreIndex: op.restoreIndex })],
          undo: null,
        };
      }
      case "stashDrop": {
        const mismatch = await this.#verifyStashPosition(session, op.index, op.sha);
        if (mismatch) return { argvList: [], undo: null, earlyError: mismatch };
        const undo = await this.#captureStashDropUndo(session, op.sha, op.index);
        return { argvList: [stashDropArgs(op.index)], undo };
      }
      case "stashBranch": {
        const mismatch = await this.#verifyStashPosition(session, op.index, op.sha);
        if (mismatch) return { argvList: [], undo: null, earlyError: mismatch };
        return { argvList: [stashBranchArgs(op.branch, op.index)], undo: null };
      }
    }
  }

  /** The pre-write guard every stack-mutating stash op (`pop`/`drop`/`branch`) runs immediately
   *  before writing: resolve `stash@{index}` and compare it to the sha the request carried. A
   *  mismatch — someone else changed the stack since the caller's last `stash.list`, or the
   *  index no longer exists at all (`fatal: log for 'stash' only has N entries`, rc=128, which
   *  `classifyGitError` has no pattern for and would otherwise fall through to `Unknown`) —
   *  becomes an `earlyError` of kind `NotFound` with NO write ever spawned, rather than mutating
   *  whatever now happens to sit at that index (probe 8). Using `#prepareOp`'s existing
   *  `earlyError` channel (not a thrown error) is what makes "no write ever runs" a guarantee the
   *  caller (`runOp`) enforces uniformly, the same way it already does for `opContinue`/`opAbort`
   *  with nothing in progress. */
  async #verifyStashPosition(
    session: RepoSession,
    index: number,
    expectedSha: string,
  ): Promise<{ readonly kind: OpErrorKind; readonly message: string } | null> {
    const refused = {
      kind: "NotFound" as const,
      message: `That stash is no longer at stash@{${index}} — the list changed. Refresh and try again.`,
    };
    try {
      const bytes = await collectOneShotBytes(session.driver.read(stashRevParseArgs(index)));
      const actualSha = decoder.decode(bytes).trim();
      return actualSha === expectedSha ? null : refused;
    } catch (err) {
      if (err instanceof GitError) return refused;
      throw err;
    }
  }

  /** §7.12's stash row. Captured BEFORE the drop, like every other undo capture: `stash store`
   *  needs the commit sha (still resolvable in the odb after the drop — only the reflog entry
   *  goes away) and the reflog subject `%gs` written back verbatim (probe 9 — see `parse/stash.ts`'s
   *  `STASH_FORMAT` doc comment for why `%gs`, never `%s`). Best-effort: a sha not present in
   *  `session.stashShapes` (its freshness is exactly as good as the most recent `stash.list`/
   *  `preflightStashPop`/`preflightStashBranch` call — see that field's own doc comment) yields
   *  `null`, and the drop's own outcome speaks for itself regardless. */
  async #captureStashDropUndo(
    session: RepoSession,
    sha: string,
    index: number,
  ): Promise<UndoRecord | null> {
    const entry = session.stashShapes.get(sha);
    if (entry === undefined) return null;
    return {
      id: randomId(),
      createdAt: Date.now(),
      label: `Dropped stash@{${index}}: ${entry.message}`,
      recoverySha: sha,
      replay: [stashStoreArgs(entry.message, sha)],
    };
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
  // P8/W14 — remote ops' own internals.
  // ---------------------------------------------------------------------------------------

  /** `runRemoteOp`'s per-kind dispatch, once the concurrency guard and the protected-branch gate
   *  have both already passed. `pull` is decomposed into its own two-phase method; the other four
   *  kinds share one spawn-then-parse-ref-updates shape. */
  async #executeRemoteOp(
    session: RepoSession,
    opId: string,
    request: RemoteOpRequest,
    controller: AbortController,
  ): Promise<RemoteOpResult> {
    const emit = this.#createProgressEmitter(session.repoId);

    if (request.kind === "pull") {
      return this.#runPull(session, opId, request, controller, emit);
    }

    if (request.kind === "forcePush") {
      const branch = assertDefined(request.branch, "forcePush requires a branch");
      // D48's residual-hazard mitigation: re-read the remote-tracking tip immediately before
      // spawning and compare against what the confirmation dialog actually showed the user
      // (`RemoteOpRequest.expectedRemoteTip`'s own doc comment) — independent of, and stricter
      // than, whatever git's own bare `--force-with-lease --force-if-includes` would itself
      // catch, since a background auto-fetch can silently satisfy that lease in between.
      const currentTip = await this.#readRemoteTrackingTip(session, request.remote, branch);
      const expected = request.expectedRemoteTip ?? null;
      if (currentTip !== expected) {
        return this.#remoteOpFailure(
          session,
          "LeaseViolation",
          "The remote moved since you confirmed this force-push — refusing to overwrite it. Fetch and try again.",
        );
      }
    }

    const { argv, killable } = this.#buildSimpleRemoteArgv(request);
    let result: GitWriteResult;
    try {
      result = await this.#writeRemote(session, opId, argv, {
        killable,
        signal: controller.signal,
        onStderr: emit,
      });
    } catch (err) {
      return this.#remoteOpFailureFromThrown(session, err);
    }

    const updates = parseRefUpdates(
      new TextDecoder("utf-8", { fatal: false }).decode(result.stderr),
    );
    const inProgress = await this.#currentInProgress(session);
    return { ok: true, error: undefined, updates, head: session.head, inProgress };
  }

  /** Builds the one-spawn argv for every `RemoteOpKind` except `pull` (`#runPull`'s own method) —
   *  `forcePush`'s own lease-vs-plain choice included. Never called for `pull`; the `pull` arm
   *  exists only so the switch stays exhaustive over `RemoteOpKind`. */
  #buildSimpleRemoteArgv(request: RemoteOpRequest): {
    readonly argv: readonly string[];
    readonly killable: boolean;
  } {
    switch (request.kind) {
      case "fetch":
        return {
          argv: fetchArgs({
            remote: request.remote,
            prune: request.prune,
            pruneTags: request.pruneTags,
          }),
          killable: true,
        };
      case "push": {
        const branch = assertDefined(request.branch, "push requires a branch");
        return {
          argv: pushArgs({ remote: request.remote, branch, setUpstream: request.setUpstream }),
          killable: false,
        };
      }
      case "forcePush": {
        const branch = assertDefined(request.branch, "forcePush requires a branch");
        return {
          argv:
            request.plainForce === true
              ? forcePushPlainArgs({ remote: request.remote, branch })
              : forcePushLeaseArgs({ remote: request.remote, branch }),
          killable: false,
        };
      }
      case "deleteRemoteBranch": {
        const branch = assertDefined(request.branch, "deleteRemoteBranch requires a branch");
        return {
          argv: deleteRemoteBranchArgs({ remote: request.remote, branch }),
          killable: false,
        };
      }
      case "pull":
        throw new Error(
          "unreachable: pull is dispatched to #runPull, never #buildSimpleRemoteArgv",
        );
    }
  }

  /**
   * §7.3/§9's decomposed pull: fetch (killable) then, unless the branch is already up to date,
   * exactly one of `git merge --ff-only` / `git merge --no-edit` / `git rebase` against the
   * already-fetched upstream ref — never `FETCH_HEAD` (the strategy is resolved fresh, post-fetch,
   * against the branch's real ahead/behind, not a stale pre-fetch guess). The ff-only guard fails
   * with `NonFastForward` before ever spawning a merge — the whole point of decomposing pull is
   * that the user then chooses, rather than either silently doing nothing or git refusing with its
   * own wording.
   */
  async #runPull(
    session: RepoSession,
    opId: string,
    request: RemoteOpRequest,
    controller: AbortController,
    emit: (chunk: Uint8Array) => void,
  ): Promise<RemoteOpResult> {
    const branch = assertDefined(request.branch, "pull requires a branch");

    let fetchResult: GitWriteResult;
    try {
      fetchResult = await this.#writeRemote(
        session,
        opId,
        fetchArgs({ remote: request.remote, prune: request.prune, pruneTags: request.pruneTags }),
        { killable: true, signal: controller.signal, onStderr: emit },
      );
    } catch (err) {
      return this.#remoteOpFailureFromThrown(session, err);
    }
    const updates = parseRefUpdates(
      new TextDecoder("utf-8", { fatal: false }).decode(fetchResult.stderr),
    );

    // The fetch's own killable window is over — §4.3's "never killed" rule is back in force from
    // here (D50: pull's merge/rebase phase is not killable). `cancelRemoteOp` consults this flag,
    // not just `activeRemoteOp`'s mere existence, to report a cancel past this point as refused.
    if (session.activeRemoteOp !== undefined) session.activeRemoteOp.killable = false;

    const [{ statusResult, inProgress: preInProgress }, gitConfig] = await Promise.all([
      this.#statusAndInProgress(session),
      this.#readPullConfig(session, branch),
    ]);
    const settingStrategy = this.#deps.settings()["kiraVersion.pull.strategy"];
    const { strategy } = resolvePullStrategy({
      // `exactOptionalPropertyTypes`: `explicit` is an optional property (absent, not
      // `undefined`), so the key itself must be omitted rather than set to `undefined`.
      ...(request.strategy !== undefined ? { explicit: request.strategy } : {}),
      settingStrategy,
      gitConfig,
    });

    const ahead = statusResult.branch.ahead ?? 0;
    const behind = statusResult.branch.behind ?? 0;
    const upstream = statusResult.branch.upstream;

    if (upstream === undefined) {
      return {
        ok: false,
        error: {
          kind: "RemoteRefMissing",
          message: "This branch has no upstream to pull from.",
          remoteMessage: undefined,
        },
        updates,
        head: session.head,
        inProgress: preInProgress,
      };
    }

    if (strategy === "ff-only" && ffOnlyWouldDiverge(ahead, behind)) {
      return {
        ok: false,
        error: {
          kind: "NonFastForward",
          message:
            "Fast-forward only: your branch has diverged from its upstream. Choose merge or rebase instead.",
          remoteMessage: undefined,
        },
        updates,
        head: session.head,
        inProgress: preInProgress,
      };
    }

    if (behind === 0) {
      // Already up to date — the fetch alone was the whole pull; no merge/rebase spawn at all.
      return { ok: true, error: undefined, updates, head: session.head, inProgress: preInProgress };
    }

    const integrationArgv =
      strategy === "ff-only"
        ? mergeFfOnlyArgs(upstream)
        : strategy === "merge"
          ? mergeArgs(upstream)
          : rebaseArgs(upstream);

    try {
      await this.#writeRemote(session, opId, integrationArgv, {
        killable: false,
        signal: controller.signal,
        onStderr: emit,
      });
    } catch (err) {
      if (err instanceof GitCancelled) {
        return this.#remoteOpFailure(session, "Cancelled", "The operation was cancelled.", updates);
      }
      if (err instanceof GitError) {
        const inProgress = await this.#currentInProgress(session);
        // A real merge/rebase conflict's own "CONFLICT (" text lands on stdout, not stderr
        // (errors.ts's own documented gap: classifyGitError only ever sees stderr), so it falls
        // back to `Unknown` here rather than matching `Conflict`'s pattern — but the sequencer
        // state files left behind (`MERGE_HEAD` / `rebase-merge`) are unambiguous, so an
        // in-progress operation after a failed integration IS the conflict regardless of what
        // classifyGitError made of stderr alone (mirrors P6's own sequencer-state precedent for
        // revert/cherry-pick's conflicts, `classifyInProgress`).
        const kind = inProgress !== null ? "Conflict" : err.kind;
        return {
          ok: false,
          error: {
            kind,
            message: err.stderr.trim() || err.message,
            remoteMessage: err.remoteMessage,
          },
          updates,
          head: session.head,
          inProgress,
        };
      }
      throw err;
    }

    const inProgress = await this.#currentInProgress(session);
    return { ok: true, error: undefined, updates, head: session.head, inProgress };
  }

  /** A `RemoteOpResult` failure that never spawned anything — the concurrency guard, the
   *  protected-branch gate, and the force-push lease re-check all fail this way, before any git
   *  process runs. Always reads `inProgress` fresh (no write happened to invalidate anything, but
   *  a caller polling a failed `remote.run` still deserves an accurate answer, exactly like
   *  `runOp`'s own early-error path). */
  async #remoteOpFailure(
    session: RepoSession,
    kind: OpErrorKind,
    message: string,
    updates: readonly RefUpdate[] = [],
  ): Promise<RemoteOpResult> {
    const inProgress = await this.#currentInProgress(session);
    return {
      ok: false,
      error: { kind, message, remoteMessage: undefined },
      updates,
      head: session.head,
      inProgress,
    };
  }

  /** Maps a `writeStreaming` rejection to a `RemoteOpResult` — `GitCancelled` becomes `Cancelled`
   *  (a remote op resolves on cancellation, per W19's exit criterion 7, rather than rejecting the
   *  way a plain `read()`'s cancellation does everywhere else) and `GitError` becomes its own
   *  `kind`/`message`/`remoteMessage` verbatim. Anything else (`GitSpawnFailed` included) keeps
   *  propagating, same as `runOp`'s own catch. */
  async #remoteOpFailureFromThrown(
    session: RepoSession,
    err: unknown,
    updates: readonly RefUpdate[] = [],
  ): Promise<RemoteOpResult> {
    if (err instanceof GitCancelled) {
      return this.#remoteOpFailure(session, "Cancelled", "The operation was cancelled.", updates);
    }
    if (err instanceof GitError) {
      const inProgress = await this.#currentInProgress(session);
      return {
        ok: false,
        error: {
          kind: err.kind,
          message: err.stderr.trim() || err.message,
          remoteMessage: err.remoteMessage,
        },
        updates,
        head: session.head,
        inProgress,
      };
    }
    throw err;
  }

  /** The one place a remote op's argv actually spawns: wraps `driver.writeStreaming` in the
   *  askpass broker's `withOp` when — and only when — this repo should have one interposed at all
   *  (`#maybeAskpassEnv`'s gate). When it should not (no `credentialPrompt` configured, or the
   *  user already has their own `core.askPass`/`GIT_ASKPASS`, §4.1), this is a bare passthrough. */
  async #writeRemote(
    session: RepoSession,
    opId: string,
    argv: readonly string[],
    opts: {
      readonly killable: boolean;
      readonly signal: AbortSignal;
      readonly onStderr: (chunk: Uint8Array) => void;
    },
  ): Promise<GitWriteResult> {
    const askpassEnv = await this.#maybeAskpassEnv(session);
    if (askpassEnv === undefined) {
      return session.driver.writeStreaming(argv, opts);
    }
    const broker = assertDefined(
      this.#askpassBroker,
      "askpass broker must be started once #maybeAskpassEnv returns an env",
    );
    const credentialPrompt = assertDefined(
      this.#deps.credentialPrompt,
      "credentialPrompt must be configured once #maybeAskpassEnv returns an env",
    );
    return broker.withOp(opId, credentialPrompt, (opEnv) =>
      session.driver.writeStreaming(argv, { ...opts, env: { ...askpassEnv, ...opEnv } }),
    );
  }

  /** `RepoService`'s own gate (§4.1's config-fidelity rule): `undefined` — never interpose — when
   *  no `credentialPrompt` was configured at all, or when `shouldInterposeAskpass` says the user
   *  already has their own `core.askPass`/`GIT_ASKPASS`. Starts the broker lazily on first actual
   *  need. */
  async #maybeAskpassEnv(
    session: RepoSession,
  ): Promise<Readonly<Record<string, string>> | undefined> {
    if (this.#deps.credentialPrompt === undefined) return undefined;
    const coreAskPass = await this.#coreAskPass(session);
    const inheritedGitAskpass = process.env.GIT_ASKPASS;
    if (!shouldInterposeAskpass({ coreAskPass, inheritedGitAskpass })) return undefined;
    const session_ = await this.#ensureAskpassSession();
    return session_.env;
  }

  async #ensureAskpassSession(): Promise<AskpassSession> {
    if (this.#askpassSessionPromise === undefined) {
      const broker = new AskpassBroker(
        this.#askpassTimeoutMs !== undefined ? { timeoutMs: this.#askpassTimeoutMs } : {},
      );
      this.#askpassBroker = broker;
      this.#askpassSessionPromise = broker.start();
    }
    return this.#askpassSessionPromise;
  }

  async #coreAskPass(session: RepoSession): Promise<string | undefined> {
    try {
      const bytes = await collectOneShotBytes(
        session.driver.read(["config", "--get", "core.askPass"]),
      );
      const value = new TextDecoder().decode(bytes).trim();
      return value.length > 0 ? value : undefined;
    } catch {
      // `config --get` on an unset key exits 1 with empty output — not configured, not an error.
      return undefined;
    }
  }

  /** `git config --null --get-regexp`'s three pull-relevant keys, tolerating "none of them are
   *  set" (exit 1, empty output) exactly like `#captureBranchDeleteUndo`'s own config read. */
  async #readPullConfig(session: RepoSession, branch: string): Promise<PullConfigValues> {
    try {
      const bytes = await collectOneShotBytes(session.driver.read(pullConfigArgs(branch)));
      return parsePullConfig(new TextDecoder().decode(bytes));
    } catch {
      return {};
    }
  }

  /** The remote-tracking ref's actual tip — `PushPreflight.remoteTip` (read here) and D48's
   *  force-push re-read-and-compare mitigation (read again here, immediately before spawning)
   *  both go through this one method so the two reads can never drift in how they treat a ref
   *  that does not exist yet. `null`, not a throw: `rev-parse --verify -q` exits non-zero with no
   *  output for a remote-tracking ref that has never been fetched — "nothing to overwrite" is the
   *  honest reading of that, not a failure. */
  async #readRemoteTrackingTip(
    session: RepoSession,
    remote: string,
    branch: string,
  ): Promise<string | null> {
    try {
      const bytes = await collectOneShotBytes(
        session.driver.read(["rev-parse", "--verify", "-q", `refs/remotes/${remote}/${branch}`]),
      );
      const sha = new TextDecoder().decode(bytes).trim();
      return sha.length > 0 ? sha : null;
    } catch {
      return null;
    }
  }

  /** `GitDriver.writeStreaming`'s `onStderr` tee for one remote op: `progress.ts`'s pure decoder,
   *  fanned out to every `onOpProgress` subscriber, throttled to `PROGRESS_THROTTLE_MS` (OQ10) —
   *  a real fetch can emit dozens of percent-ticks a second and every webview repaint they'd drive
   *  is wasted once the toolbar can't visibly keep up anyway. The very first update for an op
   *  always gets through (`lastEmit` starts at `0`), so a fast, small operation's one-and-only
   *  update is never the one throttling drops. */
  #createProgressEmitter(repoId: string): (chunk: Uint8Array) => void {
    let lastEmit = 0;
    return createProgressParser((progress) => {
      const now = Date.now();
      if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
      lastEmit = now;
      for (const listener of this.#progressListeners) {
        listener({ repoId, ...progress });
      }
    });
  }

  // ---------------------------------------------------------------------------------------
  // P8/W15 — the auto-fetch scheduler. One poll timer for the whole service (constructor); each
  // tick re-reads live settings/focus/visibility (module doc on `RepoServiceDeps.settings` and on
  // `AUTO_FETCH_POLL_MS`) and, independently per open session, decides whether that session's own
  // silent `fetch --prune` is due.
  // ---------------------------------------------------------------------------------------

  /** Every `#autoFetchPollMs`. Cheap on every session that is not due (a subtraction and a
   *  comparison) — see `AUTO_FETCH_POLL_MS`'s doc comment for why this runs unconditionally
   *  rather than starting and stopping itself around the settings/focus/visibility gate below. */
  #autoFetchTick(): void {
    if (this.#sessions.size === 0) return;
    const settings = this.#deps.settings();
    const intervalMinutes = settings["kiraVersion.fetch.autoInterval"];
    if (intervalMinutes <= 0 || !this.#hostFocused || !this.#uiVisible) return;
    const intervalMs = intervalMinutes * this.#autoFetchMsPerMinute;
    const now = Date.now();
    for (const session of this.#sessions.values()) {
      if (session.autoFetchDisabled) continue;
      if (now - session.autoFetchLastAt < intervalMs) continue;
      // Busy or already mid-remote-op: skip this poll, not queue behind it — the next poll (at
      // most `AUTO_FETCH_POLL_MS` later) re-checks, exactly like a session that was merely not
      // due yet. `autoFetchLastAt` is deliberately left untouched on a skip, so a session that is
      // busy every single poll for a while still runs the moment it frees up, rather than that
      // silently pushing its "due" time forward without ever actually fetching.
      if (session.driver.busy || session.activeRemoteOp !== undefined) continue;
      void this.#runSilentAutoFetch(session);
    }
  }

  /** Fire-and-forget from `#autoFetchTick`'s own perspective (never awaited there — one slow
   *  fetch on one session must not delay the poll's decision for every other open session), but
   *  self-contained: claims `activeRemoteOp` for the duration (so a concurrent user-initiated
   *  `runRemoteOp`/second poll correctly sees this repo as busy — the exact same field, the exact
   *  same mutual exclusion, reused rather than inventing a parallel flag) and always resolves. */
  async #runSilentAutoFetch(session: RepoSession): Promise<void> {
    const remote = await this.#remoteForAutoFetch(session);
    if (remote === undefined) {
      // No upstream to fetch against — not a failure (§7.1 only disables on a real git failure),
      // just nothing to do yet. Wait another full interval before asking again.
      session.autoFetchLastAt = Date.now();
      return;
    }
    const controller = new AbortController();
    session.activeRemoteOp = { opId: "auto-fetch", controller, killable: true };
    try {
      // Deliberately `session.driver.writeStreaming` directly, not `#writeRemote`: an unattended
      // background fetch that popped an interactive credential prompt would be a surprise, not a
      // convenience, and `GIT_TERMINAL_PROMPT=0` (`driver.ts`) already guarantees this fails
      // cleanly with `AuthFailed` rather than hanging when a credential is genuinely needed — at
      // which point disabling for the session (below) is exactly the right outcome anyway. Progress
      // is deliberately not wired either (§7.1: "no progress events") — `onStderr` is a no-op.
      await session.driver.writeStreaming(fetchArgs({ remote, prune: true, pruneTags: false }), {
        killable: true,
        signal: controller.signal,
        onStderr: () => {},
      });
      session.autoFetchLastAt = Date.now();
    } catch (err) {
      session.autoFetchLastAt = Date.now();
      session.autoFetchDisabled = true;
      this.#logger.log("warn", "auto-fetch failed; disabling for this session", {
        repoId: session.repoId,
        remote,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      session.activeRemoteOp = undefined;
    }
  }

  /** §7.1's "the current remote" for a background fetch nothing prompted: P8 has no remote
   *  management (scope boundary) and assumes one remote in the common case, so the least
   *  surprising choice with no UI input at all is the current branch's own configured upstream
   *  (`status --branch`'s `upstream`, e.g. `"origin/main"`) — the remote this branch already has a
   *  relationship with — rather than guessing at "origin" or the first remote alphabetically.
   *  `undefined` when HEAD has no upstream (a fresh branch, a detached HEAD): there is nothing a
   *  silent background fetch could safely target, so that tick is skipped, not treated as a
   *  failure (`#runSilentAutoFetch`'s own doc comment). */
  async #remoteForAutoFetch(session: RepoSession): Promise<string | undefined> {
    const { statusResult } = await this.#statusAndInProgress(session);
    const upstream = statusResult.branch.upstream;
    if (upstream === undefined) return undefined;
    const slash = upstream.indexOf("/");
    if (slash <= 0) return undefined;
    return upstream.slice(0, slash);
  }

  // ---------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------

  async #openSession(identity: RepoIdentity): Promise<RepoSession> {
    const git = this.#git();
    const catFile = openCatFileSession(git, this.#deps.runner, identity.root);
    const driver = openGitDriver(git, this.#deps.runner, identity.root, catFile);
    const watcher = watchRepo(this.#deps.fileWatcher, identity);
    const { stashShapes, stashShas, rowFilter } = await this.#refreshStashGraphInputs(driver);

    const session: RepoSession = {
      repoId: identity.root,
      identity,
      driver,
      logSession: this.#openLogSession(identity, stashShas),
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
      reviewWalk: undefined,
      lastReviewResolution: undefined,
      activeRemoteOp: undefined,
      autoFetchLastAt: Date.now(),
      autoFetchDisabled: false,
      stashShapes,
      stashRowFilter: rowFilter,
    };

    session.subscriptions.push(watcher.onSignal((signal) => this.#handleSignal(session, signal)));
    // §4.3: a completed write bumps `generation` and invalidates the graph cache the same way a
    // refs-changed filesystem event does — both funnel through the one handler.
    session.subscriptions.push(
      driver.onInvalidated(() => this.#handleSignal(session, "refsChanged")),
    );

    return session;
  }

  #openLogSession(identity: RepoIdentity, stashShas: readonly string[]): LogSession {
    return openLogSession(this.#git(), this.#deps.runner, identity.root, {
      walk: {
        kind: "scope",
        scope: this.#deps.settings()["kiraVersion.graph.scope"],
        stashShas,
        includeStash: this.#deps.settings()["kiraVersion.stash.showInGraph"],
      },
      pageSize: this.#deps.settings()["kiraVersion.graph.pageSize"],
    });
  }

  /** P9 W12: the one place that reads `stash list` for the graph's own sake — `#openSession` and
   *  `#resetSession` both call this before building this session's `WalkSpec`, since every stash
   *  beyond `stash@{0}` must be named as an explicit positional rev to be walkable at all
   *  (`revSetArgs`'s own doc comment). Also refreshes `stashShapes` (the drop-undo capture's own
   *  dependency, `RepoSession.stashShapes`'s doc comment) — deliberately unconditional on
   *  `kiraVersion.stash.showInGraph`, so turning the graph's stash visibility off never degrades
   *  undo. Only `stashShas`/`rowFilter` (the graph-visible half) are gated by the setting.
   *  Best-effort: a failed `stash list` (should not happen — it is a plain read) degrades to "no
   *  stashes known this session" rather than failing the repo open/refresh outright. */
  async #refreshStashGraphInputs(driver: GitDriver): Promise<{
    readonly stashShapes: ReadonlyMap<string, StashEntry>;
    readonly stashShas: readonly string[];
    readonly rowFilter: StashRowFilter;
  }> {
    let entries: readonly StashEntry[] = [];
    try {
      entries = await stashListQuery(driver);
    } catch {
      entries = [];
    }
    const stashShapes = new Map(entries.map((e) => [e.sha, e] as const));
    const showInGraph = this.#deps.settings()["kiraVersion.stash.showInGraph"];
    const graphEntries = showInGraph ? entries : [];
    return {
      stashShapes,
      stashShas: graphEntries.map((e) => e.sha),
      rowFilter: buildStashRowFilter(graphEntries),
    };
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
    await this.#resetSession(session);
  }

  /** Resets exactly the panel's own walk state. Deliberately does NOT touch `session.reviewWalk`
   *  (P7/D38): a `refsChanged`/`refresh()` invalidation of the graph's own scoped walk must never
   *  disturb an independently-open review walk on the same repo, and vice versa — the two are
   *  invalidated by entirely separate paths (`#handleSignal`'s `staleReason` here; the review
   *  view's own quiet re-resolve, per open question 5, for the review walk).
   *
   *  P9 W12: also re-reads the stash list (`#refreshStashGraphInputs`) before rebuilding the log
   *  session — a stash push/pop/drop is itself a write, so it already reaches here through the
   *  exact same `refsChanged` path any other ref-moving op does (`driver.onInvalidated`, §4.3);
   *  this is what keeps the graph's stash rows in sync with no bespoke invalidation of their own. */
  async #resetSession(session: RepoSession): Promise<void> {
    session.store.clear();
    session.dictionaryMarks = initialDictionaryMarks();
    session.lastRemaining = 0;
    session.logSession.dispose();
    const { stashShapes, stashShas, rowFilter } = await this.#refreshStashGraphInputs(
      session.driver,
    );
    session.stashShapes = stashShapes;
    session.stashRowFilter = rowFilter;
    session.logSession = this.#openLogSession(session.identity, stashShas);
  }

  /** P9 W12's own chunk-build post-pass (`graph/stashRows.ts`'s doc comment): applied to every
   *  record a page read yields, before it ever reaches `session.store` — a dropped helper-commit
   *  row is simply never appended. */
  #appendFilteredRecord(session: RepoSession, record: CommitRecord): void {
    const filtered = applyStashRowFilter(record, session.stashRowFilter);
    if (filtered) session.store.append(filtered);
  }

  async #readPageIntoStore(session: RepoSession, signal?: AbortSignal): Promise<void> {
    const outcome = await session.logSession.readPage(
      (record) => this.#appendFilteredRecord(session, record),
      signal ? { signal } : {},
    );
    if (outcome.kind === "stale") {
      // P2's spliced-page guard: refs moved while this session was paused. Reset exactly as a
      // watcher-observed refsChanged would, then retry once against the now-current refs — the
      // caller sees the resulting rows as part of the same page read, starting over at row 0.
      this.#handleSignal(session, "refsChanged");
      await this.#ensureFresh(session);
      await session.logSession.readPage(
        (record) => this.#appendFilteredRecord(session, record),
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
   *  through several ranges can thread it without a second map lookup. Written against `WalkLike`
   *  rather than `RepoSession` (P7 W4) so the panel's own walk and a `ReviewWalk` share this one
   *  implementation; `repoId` is threaded separately since only `RepoSession` itself carries it. */
  async #emitRange(
    walk: WalkLike,
    repoId: string,
    from: number,
    to: number,
    dictionaryBase: number,
    source: "git" | "cache",
    onChunk: (chunk: GraphChunkPayload) => Promise<void>,
  ): Promise<number> {
    const commits = walk.store.packSlice(from, to, dictionaryBase);
    const nextBase = dictionaryBase + commits.dictionary.length;
    walk.dictionaryMarks.set(to, nextBase);
    // Cached internally by `LogSession` after its first call ("run once per refresh") — this
    // does not spawn a process on every chunk, or on a cache-only replay after the first stream.
    const remaining = await walk.logSession.remaining();
    walk.lastRemaining = remaining;
    await onChunk({
      repoId,
      seq: walk.nextSeq++,
      from,
      to,
      source,
      remaining,
      exhausted: walk.logSession.exhausted,
      commits,
    });
    return nextBase;
  }

  /** P7 W4 — returns the open review walk for `range`, reusing it if already open for exactly
   *  this `<base>..<branch>` pair, else disposing whatever was open (a different range, or none)
   *  and starting a fresh one. `precomputedTotal` is threaded from `resolveReviewBase`'s own
   *  `rev-list --count` when it was computed for this exact range moments ago — the ordinary
   *  case (`resolveReviewBase` then `streamGraph`/`loadMore` in the same round trip) never pays
   *  for a second count spawn. */
  #ensureReviewWalk(session: RepoSession, range: CommitRange): ReviewWalk {
    const existing = session.reviewWalk;
    if (existing && rangeEquals(existing.range, range)) return existing;
    if (existing) existing.logSession.dispose();

    const precomputedTotal =
      session.lastReviewResolution && rangeEquals(session.lastReviewResolution.range, range)
        ? session.lastReviewResolution.commitCount
        : undefined;

    const logSession = openLogSession(this.#git(), this.#deps.runner, session.identity.root, {
      walk: { kind: "range", base: range.base, branch: range.branch },
      pageSize: this.#deps.settings()["kiraVersion.graph.pageSize"],
      ...(precomputedTotal !== undefined ? { precomputedTotal } : {}),
    });

    const walk: ReviewWalk = {
      range,
      logSession,
      store: new CommitStoreImpl(),
      dictionaryMarks: initialDictionaryMarks(),
      nextSeq: 0,
      lastRemaining: 0,
    };
    session.reviewWalk = walk;
    return walk;
  }

  /** P7 W4 — one page of a review walk, mirroring `#readPageIntoStore`'s own stale-retry shape
   *  but scoped to `walk` alone: a review walk's own staleness (the narrowed guard on `range`,
   *  §6.8 W3) never touches `session.staleReason` or the panel's own `logSession`/`store` — this
   *  is exactly the isolation D38 requires. On `stale`, the walk is dropped and rebuilt fresh
   *  (from row 0 — a review walk has no `--skip` cache to preserve across that boundary, same as
   *  a full `#resetSession` for the panel's own walk) and the caller's page is retried once
   *  against the new one. */
  async #readReviewPage(
    session: RepoSession,
    walk: ReviewWalk,
    signal?: AbortSignal,
  ): Promise<void> {
    const outcome = await walk.logSession.readPage(
      (record) => walk.store.append(record),
      signal ? { signal } : {},
    );
    if (outcome.kind === "stale") {
      walk.logSession.dispose();
      session.reviewWalk = undefined;
      const fresh = this.#ensureReviewWalk(session, walk.range);
      await fresh.logSession.readPage(
        (record) => fresh.store.append(record),
        signal ? { signal } : {},
      );
      fresh.lastRemaining = await fresh.logSession.remaining();
      return;
    }
    walk.lastRemaining = await walk.logSession.remaining();
  }

  /** P7 W4 — probes whether rule 1 (the branch's own upstream) already resolves before ever
   *  spawning `detectDefaultBranch`: a cheap, git-free call to `resolveBase` with `originHead:
   *  undefined` first, and only when that falls through (`reason !== "upstream"`) does the real,
   *  spawn-bearing resolution run — "one spawn, only when rule 1 falls through" (§6.8). Both calls
   *  share the same `candidates` setting, so the real call's `candidates` list is always complete
   *  even though the probe's own is deliberately built with an empty one (a probe result is never
   *  returned to a caller, so its candidate list is never observed). */
  async #naturalResolution(
    session: RepoSession,
    branchRef: RefRecord,
    refsResult: RefsResult,
  ): Promise<{
    readonly base: string | null;
    readonly reason: BaseResolutionReason;
    readonly candidates: readonly BaseCandidate[];
  }> {
    const baseCandidatesSetting = this.#deps.settings()["kiraVersion.review.baseCandidates"];
    const probe = resolveBase({
      branch: branchRef,
      branches: refsResult.branches,
      remoteBranches: refsResult.remoteBranches,
      originHead: undefined,
      candidates: [],
    });
    const originHead =
      probe.reason === "upstream" ? undefined : await detectDefaultBranch(session.driver);
    return resolveBase({
      branch: branchRef,
      branches: refsResult.branches,
      remoteBranches: refsResult.remoteBranches,
      originHead,
      candidates: baseCandidatesSetting,
    });
  }

  /** `review.resolveBase` (§6.8): the whole of the four-outcome decision — which base, why, and
   *  whether the resulting range is `ready`/`empty`/`unrelated`/`ask` — computed fresh on every
   *  call, before any row is painted. `base` overrides the natural resolution (an explicit pick
   *  from `BaseSelector`) without disturbing `candidates`, which always reflects the branch's own
   *  natural list regardless of what the caller ultimately picked. A `ready` outcome's commit
   *  count is remembered on the session (`lastReviewResolution`) so `#ensureReviewWalk`'s first
   *  open for the same range skips a redundant `rev-list --count`. */
  async resolveReviewBase(repoId: string, branch: string, base?: string): Promise<BaseResolution> {
    const session = this.#requireSession(repoId);
    const refsResult = await this.refs(repoId);
    const branchRef =
      refsResult.branches.find((r) => r.shortName === branch) ??
      refsResult.remoteBranches.find((r) => r.shortName === branch);

    if (!branchRef) {
      return { branch, base: null, reason: "none", range: { kind: "ask" }, candidates: [] };
    }

    const natural = await this.#naturalResolution(session, branchRef, refsResult);
    const resolvedBase = base !== undefined ? base : natural.base;
    const reason: BaseResolutionReason = base !== undefined ? "override" : natural.reason;
    const candidates = natural.candidates;

    if (resolvedBase === null) {
      return { branch, base: null, reason, range: { kind: "ask" }, candidates };
    }

    const [mergeBaseSha, commitCount] = await Promise.all([
      mergeBase(session.driver, resolvedBase, branch),
      countRange(session.driver, resolvedBase, branch),
    ]);

    if (mergeBaseSha === null) {
      return { branch, base: resolvedBase, reason, range: { kind: "unrelated" }, candidates };
    }
    if (commitCount === 0) {
      return { branch, base: resolvedBase, reason, range: { kind: "empty" }, candidates };
    }
    session.lastReviewResolution = { range: { base: resolvedBase, branch }, commitCount };
    return {
      branch,
      base: resolvedBase,
      reason,
      range: { kind: "ready", commitCount },
      candidates,
    };
  }

  /** Ends a branch review: disposes the review walk (if any) and clears the slot. Idempotent, and
   *  a silent no-op — never a throw — for a `repoId` with no open session at all, mirroring
   *  `refresh()`'s own precedent: by the time this is called the panel may already be closing. */
  endReview(repoId: string): void {
    const session = this.#sessions.get(repoId);
    if (!session) return;
    session.reviewWalk?.logSession.dispose();
    session.reviewWalk = undefined;
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
    // Fire-and-forget: `#resetSession` cannot reject (`#refreshStashGraphInputs`'s own
    // best-effort try/catch, `openLogSession` itself never throws), and this timer callback has
    // no caller to propagate a rejection to regardless — same posture as every other synchronous
    // side effect this method performs below.
    void this.#resetSession(session);
    // P7/D38: a review's own view (the sidebar) is a *separate* webview from the panel this
    // eviction timer is armed by — hiding the panel must not silently leave a review walk running
    // forever in the background, so it is disposed here alongside everything else this evicts.
    session.reviewWalk?.logSession.dispose();
    session.reviewWalk = undefined;
    session.watcher.pause();
    this.#logger.log("debug", "evicted hidden repo", { repoId: session.repoId });
  }
}
