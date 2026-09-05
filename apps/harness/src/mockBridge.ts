import type { DocumentRef, FileChange } from "@kira-version/core";
import { CommitStore, defaultSettings, mapLineAcrossDiff, UNDO_POLICY } from "@kira-version/core";
import type {
  CheckoutBlocker,
  CheckoutPreflight,
  HeadState,
  InProgressOperation,
  MessageChannelLike,
  OpErrorKind,
  OpRequest,
  OpResult,
  RefKind,
  RefRow,
  RequestHandler,
  RevertParentChoice,
  RevertPreflight,
  ServerHandlers,
  SettingsSnapshot,
  StatusSummary,
  StreamChunkOf,
  StreamHandler,
  Transport,
  UndoSlotSnapshot,
} from "@kira-version/ipc";
import { CONTRACT_VERSION, createRpcClient, createRpcServer } from "@kira-version/ipc";
import { diffKey } from "./scenarios/diffKey.ts";
import { loadScenario } from "./scenarios/index.ts";
import type { Scenario } from "./scenarios/types.ts";

/**
 * Wires a real `createRpcServer`/`createRpcClient` pair over an in-memory channel to a
 * hand-written `ServerHandlers` (P3 W14) — not `@kira-version/git`'s `createRepoHandlers`,
 * which `biome.json`'s `noRestrictedImports` override forbids `apps/harness/**` from
 * importing (grouped with `packages/ui`'s own "core + ipc only" restriction, B3, §3.1). The
 * handlers below are this file's own translation from a `Scenario`'s fixture data to the same
 * wire shapes `packages/git/src/rpcHandlers.ts` produces, mirroring `RepoService.streamGraph`'s
 * cache-then-fresh-page split conceptually rather than by shared code — there is a real repo
 * fixture (`Scenario.commits`) but no real git process behind it.
 */

/** How many rows one `graph.stream` chunk carries, whether replayed from the mock's own
 *  `CommitStore` (`source: "cache"`) or newly "read" out of `Scenario.commits`
 *  (`source: "git"`) — the same constant `RepoService.CHUNK_ROWS` uses, kept independent since
 *  the harness may not import `@kira-version/git`. */
const CHUNK_ROWS = 500;

/** How many commits one simulated "page" adds — `defaultSettings()`'s own
 *  `kiraVersion.graph.pageSize`, so `hugeRepo`'s `graph.loadMore` genuinely needs more than one
 *  call to reach exhaustion, matching what a real host would do with the same setting. */
const PAGE_SIZE = defaultSettings()["kiraVersion.graph.pageSize"];

/** Browser-safe `basename` — `node:path` is not an option here (`topology.ts`'s own doc comment
 *  on why Vite silently stubs `node:` built-ins to `{}` in a browser bundle applies just as much
 *  here as it does there). */
function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** One `editor.openDiff`/`editor.goToFile` call, as the mock recorded it — the harness's model of
 *  "what the host's editor did" (P5 W12's own wording: "the harness models an editor, and this is
 *  in character rather than a test hook"). Read by W13's Playwright suite off
 *  `window.__kiraHarness.lastEditorAction`; there is no real editor behind it to assert against
 *  instead. */
export type HarnessEditorAction =
  | {
      readonly kind: "openDiff";
      readonly left: DocumentRef;
      readonly right: DocumentRef;
      readonly title: string;
    }
  | { readonly kind: "reveal"; readonly ref: DocumentRef; readonly line: number }
  | { readonly kind: "resolveConflict"; readonly path: string };

/** Looks up the one `FileChange` a `commit.fileDiff`/`editor.openDiff` request needs, from
 *  `Scenario.details`'s fixture — thrown, not invented, when the fixture does not cover the
 *  request, matching `requireSession`'s own convention for "this is a fixture bug, not a real
 *  outcome to model". */
function requireFileChange(
  scenario: Scenario,
  sha: string,
  path: string,
  parentIndex: number,
): FileChange {
  const change = scenario.details?.[sha]?.[parentIndex]?.files.find((f) => f.path === path);
  if (!change) {
    throw new Error(
      `mock bridge: no FileChange fixture for sha '${sha}' path '${path}' parentIndex ${parentIndex}`,
    );
  }
  return change;
}

/** `service.blob`'s stand-in for D14a's "not in the checkout" branch: the harness has no real
 *  object database, so a path's blob is "found" at `rev` exactly when `Scenario.diffs` fixtures
 *  a `commit.fileDiff` body for `(rev, path)` — deliberately independent of whether that path
 *  also appears in some commit's `CommitDetailFixture.files`, so one scenario can list a path as
 *  "touched" (for the file tree) while still fixturing its blob as unresolvable (`goToFile`'s own
 *  fifth case, "blob missing entirely"). Binary/too-large blobs are not modelled: the real UI
 *  never calls `editor.goToFile` for one (W10 hides the action), so no scenario needs to
 *  exercise those two `GoToFileOutcome.reason` values through this path. */
function blobExistsAtRev(scenario: Scenario, rev: string, path: string): boolean {
  return scenario.diffs?.[diffKey(rev, path)] !== undefined;
}

// ---------------------------------------------------------------------------------------
// P6 W18: refs, status, pre-flight, the op executor, and the undo slot — the harness's own
// translation from `Scenario`'s canned fixtures (and, for `op.run`, real in-memory mutation) to
// the same eight requests `packages/git/src/rpcHandlers.ts` serves against a real repository.
// ---------------------------------------------------------------------------------------

/** FNV-1a-ish, seeded stand-in for a sha the mock invents at request time (a new branch's ref,
 *  an annotated tag's own object, `undo.run`'s restored ref) — deterministic per `seed` and good
 *  enough to be visibly "a sha" in the UI; not cryptographic, and never compared against a real
 *  git object because there is no real object database behind this mock. */
function fakeSha(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const word = hash.toString(16).padStart(8, "0");
  return (word + word + word + word + word).slice(0, 40);
}

/** One `op.run` call's restore recipe, kept entirely in the mock (the wire only ever carries
 *  `UndoSlotSnapshot`, which has no argv to replay) — `restore()` is this session's equivalent of
 *  W8's captured `UndoRecord.replay`. */
interface PendingUndo {
  readonly snapshot: UndoSlotSnapshot;
  restore(): void;
}

interface RefsState {
  branches: RefRow[];
  remoteBranches: RefRow[];
  tags: RefRow[];
}

function cloneRefs(refs: Scenario["refs"]): RefsState {
  return {
    branches: refs?.branches.map((row) => ({ ...row })) ?? [],
    remoteBranches: refs?.remoteBranches.map((row) => ({ ...row })) ?? [],
    tags: refs?.tags.map((row) => ({ ...row })) ?? [],
  };
}

interface StatusState {
  upstream: StatusSummary["upstream"];
  counts: StatusSummary["counts"];
  isClean: boolean;
  dirtyPaths: string[];
  dirtyTruncated: boolean;
}

function cloneStatus(status: Scenario["status"]): StatusState {
  return status
    ? {
        upstream: status.upstream,
        counts: { ...status.counts },
        isClean: status.isClean,
        dirtyPaths: [...status.dirtyPaths],
        dirtyTruncated: status.dirtyTruncated,
      }
    : {
        upstream: undefined,
        counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0 },
        isClean: true,
        dirtyPaths: [],
        dirtyTruncated: false,
      };
}

/** One ref by short name or full refname, across all three sections — `op.run`'s and the default
 *  pre-flight's shared lookup, mirroring `resolveCheckoutTarget`'s branches → tags →
 *  remoteBranches order (`packages/git/src/repoService.ts`). */
function findRef(
  refs: RefsState,
  name: string,
): { readonly kind: RefKind; readonly row: RefRow } | undefined {
  const branch = refs.branches.find((r) => r.shortName === name || r.refname === name);
  if (branch) return { kind: "branch", row: branch };
  const tag = refs.tags.find((r) => r.shortName === name || r.refname === name);
  if (tag) return { kind: "tag", row: tag };
  const remote = refs.remoteBranches.find((r) => r.shortName === name || r.refname === name);
  if (remote) return { kind: "remoteBranch", row: remote };
  return undefined;
}

function updateIsHeadFlags(refs: RefsState, head: HeadState): void {
  for (const row of refs.branches) {
    (row as { isHead: boolean }).isHead = head.kind === "branch" && row.shortName === head.name;
  }
}

/** `preflight.checkout`'s default when the scenario states no exact fixture for this `target`
 *  (`Scenario.preflight.checkout`'s own doc comment) — a plain, unblocked classification good
 *  enough for every scenario that predates P6 and every "just check out a branch" click a
 *  hazard-focused scenario's test does not care to fixture by hand. */
function defaultCheckoutPreflight(
  session: RepoSession,
  target: string,
  mode: "switch" | "detach",
): CheckoutPreflight {
  const found = findRef(session.refs, target);
  const kind = found?.kind ?? "sha";
  const detaches = mode === "detach" || kind === "tag" || kind === "remoteBranch";
  const blockers: CheckoutBlocker[] = [];
  if (session.inProgress) {
    blockers.push({ kind: "inProgressOperation", operation: session.inProgress });
  }
  if (kind === "branch" && found?.row.checkedOutIn) {
    blockers.push({
      kind: "worktreeConflict",
      branch: found.row.shortName,
      worktreePath: found.row.checkedOutIn,
    });
  }
  const dirty = session.status.dirtyPaths.length > 0 && blockers.length === 0;
  return {
    target: { kind, name: target },
    detaches,
    createsTracking: undefined,
    carried: dirty ? session.status.dirtyPaths : [],
    blockers,
    verdict: blockers.length > 0 ? "blocked" : dirty ? "cleanCarry" : "clean",
    routes: [],
  };
}

/** `preflight.revert`'s default, same posture as `defaultCheckoutPreflight` — a merge commit
 *  among `shas` with no `mainline` still requires the picker (§7.10's own rule, not something a
 *  scenario should have to restate for every merge commit it names). */
function defaultRevertPreflight(
  session: RepoSession,
  scenario: Scenario,
  shas: readonly string[],
  mainline: number | undefined,
): RevertPreflight {
  const first = scenario.commits.find((c) => c.sha === shas[0]);
  if (!first) throw new Error(`mock bridge: preflight.revert: unknown sha '${shas[0]}'`);
  const isMerge = first.parents.length > 1;
  const mainlineRequired =
    isMerge && mainline === undefined
      ? [
          {
            sha: first.sha,
            parents: first.parents.map(
              (sha, index): RevertParentChoice => ({
                parentNumber: index + 1,
                sha,
                subject: scenario.commits.find((c) => c.sha === sha)?.subject ?? sha,
              }),
            ),
          },
        ]
      : [];
  const blockers: ("dirtyWorktree" | "inProgressOperation" | "mainlineRequired")[] = [];
  if (session.status.dirtyPaths.length > 0) blockers.push("dirtyWorktree");
  if (session.inProgress) blockers.push("inProgressOperation");
  if (mainlineRequired.length > 0) blockers.push("mainlineRequired");
  return {
    shas,
    mainlineRequired,
    dirtyPaths: session.status.dirtyPaths,
    inProgress: session.inProgress,
    prediction: { kind: "clean" },
    predictedFor: first.sha,
    detachedHead: session.head.kind !== "branch",
    verdict: blockers.length > 0 ? "blocked" : "clean",
    blockers,
  };
}

function opError(session: RepoSession, kind: OpErrorKind, message: string): OpResult {
  session.pendingUndo = null;
  return {
    ok: false,
    error: { kind, message },
    undo: null,
    head: session.head,
    inProgress: session.inProgress,
  };
}

function opOk(session: RepoSession, pendingUndo: PendingUndo | null = null): OpResult {
  session.pendingUndo = pendingUndo;
  return {
    ok: true,
    error: undefined,
    undo: pendingUndo?.snapshot ?? null,
    head: session.head,
    inProgress: session.inProgress,
  };
}

/** Applies one `OpRequest` to `session`'s in-memory refs/status/head — `mockBridge.ts`'s own
 *  behaviour model (this file's own doc comment): real mutation and a real `repo.changed`, not a
 *  stub at step 3 of the four-step reconcile. Returns the `OpResult` and the `repo.changed` kind
 *  to emit on success (`undefined` on failure — a failed op still reads back `head`/`inProgress`,
 *  but nothing actually changed for the watcher to report). */
function applyOp(
  session: RepoSession,
  scenario: Scenario,
  op: OpRequest,
): { readonly result: OpResult; readonly changed?: "refsChanged" | "worktreeChanged" } {
  const nowSeconds = Math.floor(Date.now() / 1000);
  switch (op.kind) {
    case "checkout": {
      const found = findRef(session.refs, op.target);
      if (op.discardLocalChanges) {
        session.status = {
          upstream: session.status.upstream,
          counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0 },
          isClean: true,
          dirtyPaths: [],
          dirtyTruncated: false,
        };
      }
      session.head =
        found && found.kind === "branch" && op.mode === "switch"
          ? { kind: "branch", name: found.row.shortName }
          : { kind: "detached", sha: found?.row.objectId ?? op.target };
      updateIsHeadFlags(session.refs, session.head);
      return { result: opOk(session), changed: "worktreeChanged" };
    }
    case "branchCreate": {
      if (session.refs.branches.some((b) => b.shortName === op.name)) {
        return { result: opError(session, "AlreadyExists", `branch '${op.name}' already exists`) };
      }
      const startSha = findRef(session.refs, op.startPoint)?.row.objectId ?? op.startPoint;
      const row: RefRow = {
        refname: `refs/heads/${op.name}`,
        kind: "branch",
        shortName: op.name,
        objectId: startSha,
        peeledObjectId: undefined,
        upstream: op.track,
        track: op.track ? { ahead: 0, behind: 0 } : undefined,
        committerDate: nowSeconds,
        isHead: op.checkout,
        checkedOutIn: undefined,
        annotation: undefined,
      };
      session.refs.branches.push(row);
      if (op.checkout) {
        session.head = { kind: "branch", name: op.name };
        updateIsHeadFlags(session.refs, session.head);
      }
      return { result: opOk(session), changed: "refsChanged" };
    }
    case "branchDelete": {
      if (!op.force && (scenario.notFullyMergedBranches ?? []).includes(op.name)) {
        return {
          result: opError(session, "NotFullyMerged", `branch '${op.name}' is not fully merged`),
        };
      }
      const idx = session.refs.branches.findIndex((b) => b.shortName === op.name);
      if (idx === -1)
        return { result: opError(session, "NotFound", `branch '${op.name}' not found`) };
      const [removed] = session.refs.branches.splice(idx, 1) as [RefRow];
      const snapshot: UndoSlotSnapshot = {
        id: fakeSha(`undo:${op.name}:${Date.now()}`),
        label: `Undo delete of branch ${op.name}`,
        recoverySha: removed.objectId,
        createdAt: Date.now(),
      };
      const pendingUndo: PendingUndo = {
        snapshot,
        restore: () => {
          session.refs.branches.push({ ...removed });
        },
      };
      return { result: opOk(session, pendingUndo), changed: "refsChanged" };
    }
    case "branchRename": {
      const idx = session.refs.branches.findIndex((b) => b.shortName === op.from);
      if (idx === -1)
        return { result: opError(session, "NotFound", `no branch named '${op.from}'`) };
      if (session.refs.branches.some((b) => b.shortName === op.to)) {
        return { result: opError(session, "AlreadyExists", `branch '${op.to}' already exists`) };
      }
      const existing = session.refs.branches[idx] as RefRow;
      session.refs.branches[idx] = {
        ...existing,
        refname: `refs/heads/${op.to}`,
        shortName: op.to,
      };
      if (session.head.kind === "branch" && session.head.name === op.from) {
        session.head = { kind: "branch", name: op.to };
      }
      return { result: opOk(session), changed: "refsChanged" };
    }
    case "tagCreate": {
      const existingIdx = session.refs.tags.findIndex((t) => t.shortName === op.name);
      if (existingIdx !== -1 && !op.force) {
        return { result: opError(session, "AlreadyExists", `tag '${op.name}' already exists`) };
      }
      const targetSha = findRef(session.refs, op.target)?.row.objectId ?? op.target;
      const row: RefRow = {
        refname: `refs/tags/${op.name}`,
        kind: "tag",
        shortName: op.name,
        objectId: op.message ? fakeSha(`tagobj:${op.name}:${Date.now()}`) : targetSha,
        peeledObjectId: op.message ? targetSha : undefined,
        upstream: undefined,
        track: undefined,
        committerDate: nowSeconds,
        isHead: false,
        checkedOutIn: undefined,
        annotation: op.message
          ? {
              tagger: "Kira Fixture <fixture@kira-version.test>",
              date: nowSeconds,
              subject: op.message,
            }
          : undefined,
      };
      if (existingIdx !== -1) session.refs.tags.splice(existingIdx, 1, row);
      else session.refs.tags.push(row);
      return { result: opOk(session), changed: "refsChanged" };
    }
    case "tagDelete": {
      const idx = session.refs.tags.findIndex((t) => t.shortName === op.name);
      if (idx === -1) return { result: opError(session, "NotFound", `tag '${op.name}' not found`) };
      const [removed] = session.refs.tags.splice(idx, 1) as [RefRow];
      const snapshot: UndoSlotSnapshot = {
        id: fakeSha(`undo:${op.name}:${Date.now()}`),
        label: `Undo delete of tag ${op.name}`,
        recoverySha: removed.objectId,
        createdAt: Date.now(),
      };
      const pendingUndo: PendingUndo = {
        snapshot,
        restore: () => {
          session.refs.tags.push({ ...removed });
        },
      };
      return { result: opOk(session, pendingUndo), changed: "refsChanged" };
    }
    case "tagPush":
    case "tagDeleteRemote":
      // Neither mutates a *local* ref (§7.12: "a push is not undone locally"); the mock has no
      // remote to model, so there is nothing else to change.
      return { result: opOk(session) };
    case "revert": {
      const key = op.shas.join(",");
      const preflight =
        scenario.preflight?.revert?.[key] ??
        defaultRevertPreflight(session, scenario, op.shas, op.mainline);
      if (preflight.prediction.kind === "conflicts") {
        session.inProgress = {
          kind: "revert",
          otherSha: op.shas[0],
          headName: undefined,
          conflictedPaths: preflight.prediction.paths,
          canContinue: true,
          canAbort: true,
          isSequence: op.shas.length > 1,
          unmergedCount: preflight.prediction.paths.length,
        };
        return {
          result: opError(
            session,
            "Conflict",
            "error: could not apply — conflict in the files listed above",
          ),
          changed: "worktreeChanged",
        };
      }
      // A successful revert would advance HEAD to a new commit; the mock has no commit-graph
      // writer behind it, so it advances the checked-out branch's own ref to a fabricated sha —
      // real enough for the toolbar/refs list to show movement, not a claim that `graph.stream`
      // would show the new commit too (recorded in P6's Findings).
      if (session.head.kind === "branch") {
        const headName = session.head.name;
        const idx = session.refs.branches.findIndex((b) => b.shortName === headName);
        if (idx !== -1) {
          const existing = session.refs.branches[idx] as RefRow;
          session.refs.branches[idx] = {
            ...existing,
            objectId: fakeSha(`revert:${key}:${Date.now()}`),
          };
        }
      }
      return { result: opOk(session), changed: "worktreeChanged" };
    }
    case "opContinue": {
      if (!session.inProgress?.canContinue || session.inProgress.unmergedCount > 0) {
        return {
          result: opError(session, "Unknown", "This operation offers no Continue right now."),
        };
      }
      session.inProgress = null;
      return { result: opOk(session), changed: "worktreeChanged" };
    }
    case "opAbort": {
      if (!session.inProgress?.canAbort) {
        return { result: opError(session, "Unknown", "This operation offers no Abort right now.") };
      }
      session.inProgress = null;
      return { result: opOk(session), changed: "worktreeChanged" };
    }
  }
}

function toSettingsSnapshot(): SettingsSnapshot {
  const settings = defaultSettings();
  return {
    "kiraVersion.git.path": settings["kiraVersion.git.path"],
    "kiraVersion.graph.pageSize": settings["kiraVersion.graph.pageSize"],
    "kiraVersion.graph.scope": settings["kiraVersion.graph.scope"],
    "kiraVersion.log.level": settings["kiraVersion.log.level"],
  };
}

/** A harness-local copy of `packages/ipc/src/rpc.test.ts`'s own `createInMemoryChannelPair` —
 *  a real in-memory pipe using `structuredClone` (with transfer support) so posting on one end
 *  synchronously invokes the other, mimicking real `postMessage`/transfer-detach semantics
 *  closely enough that `createRpcClient`/`createRpcServer` cannot tell this from a real host
 *  channel. */
function createInMemoryChannelPair(): readonly [MessageChannelLike, MessageChannelLike] {
  let handlerA: ((message: unknown) => void) | undefined;
  let handlerB: ((message: unknown) => void) | undefined;
  let closedA = false;
  let closedB = false;

  const a: MessageChannelLike = {
    post(message, transfer) {
      if (closedA) return;
      const cloned = transfer
        ? structuredClone(message, { transfer: transfer as ArrayBuffer[] })
        : structuredClone(message);
      handlerB?.(cloned);
    },
    onMessage(handler) {
      handlerA = handler;
      return () => {
        if (handlerA === handler) handlerA = undefined;
      };
    },
    close() {
      closedA = true;
    },
  };
  const b: MessageChannelLike = {
    post(message, transfer) {
      if (closedB) return;
      const cloned = transfer
        ? structuredClone(message, { transfer: transfer as ArrayBuffer[] })
        : structuredClone(message);
      handlerA?.(cloned);
    },
    onMessage(handler) {
      handlerB = handler;
      return () => {
        if (handlerB === handler) handlerB = undefined;
      };
    },
    close() {
      closedB = true;
    },
  };
  return [a, b];
}

/** Row 0 always packs from an empty dictionary — the one mark every session starts with, and
 *  the one `#resetSession`-equivalent below restores on a refresh (`packages/git/src/
 *  repoService.ts`'s own `initialDictionaryMarks`, mirrored here). */
function initialDictionaryMarks(): Map<number, number> {
  return new Map([[0, 0]]);
}

interface RepoSession {
  readonly repoId: string;
  readonly commits: Scenario["commits"];
  readonly store: CommitStore;
  /** `packSlice`'s dictionary base for each row this session has ever emitted a chunk up to,
   *  keyed by that row — never a single session-wide running cursor. A client that resets its
   *  own store (the repo picker's "open a different candidate", `App.vue`'s `handleRepoOpened`,
   *  W11) reopens `graph.stream` with `resumeThroughRow: 0` while this session's own `store`
   *  still holds every previously-cached row — replaying that cache with whatever dictionary
   *  cursor the *previous* stream had reached by then would pack row 0's chunk against a
   *  dictionary base the fresh client's interner (size 0) has never seen, tripping
   *  `CommitStore.appendPacked`'s ordering assert. Resolving the base from *this row's own* mark
   *  instead means a replay from row 0 always resolves to the row-0 mark (always 0), regardless
   *  of how far a previous stream over this same session had walked the dictionary forward —
   *  `packages/git/src/repoService.ts`'s own `streamGraph`/`#emitRange` already carry this exact
   *  fix (its doc comments call it out as "W2's fix"); this mock never had the equivalent until
   *  P4 W13's Playwright suite exercised a repo-picker reopen against an already-cached session
   *  for the first time and surfaced the gap. */
  dictionaryMarks: Map<number, number>;
  nextSeq: number;
  /** P6 W18: mutable refs/status/in-progress/undo state — see this file's own "refs, status,
   *  pre-flight, the op executor" section for how `op.run` changes these in place. */
  head: HeadState;
  refs: RefsState;
  status: StatusState;
  inProgress: InProgressOperation | null;
  pendingUndo: PendingUndo | null;
}

function createSession(repoId: string, scenario: Scenario, head: HeadState): RepoSession {
  return {
    repoId,
    commits: scenario.commits,
    store: new CommitStore(),
    dictionaryMarks: initialDictionaryMarks(),
    nextSeq: 0,
    head,
    refs: cloneRefs(scenario.refs),
    status: cloneStatus(scenario.status),
    inProgress: scenario.status?.inProgress ?? null,
    pendingUndo: null,
  };
}

function requireSession(sessions: Map<string, RepoSession>, repoId: string): RepoSession {
  const session = sessions.get(repoId);
  if (!session) throw new Error(`mock bridge: no open repo '${repoId}'`);
  return session;
}

/** Appends exactly one page's worth of `session.commits` into `session.store`, or none if the
 *  scenario's fixture is already fully loaded — the mock's stand-in for `RepoService`'s
 *  "read one page from git into the store". */
function readPageIntoStore(session: RepoSession): void {
  const loaded = session.store.rowCount;
  const count = Math.min(PAGE_SIZE, session.commits.length - loaded);
  if (count <= 0) return;
  session.store.appendPage(session.commits.slice(loaded, loaded + count));
}

/** Packs and emits exactly one chunk, `[from, to)`, using the caller-supplied dictionary base
 *  for that specific row range, and records the resulting size as `to`'s mark — mirrors
 *  `RepoService#emitRange`'s own doc comment almost verbatim. Returns the next base so a caller
 *  walking forward through several ranges in one `graph.stream` call can thread it without a
 *  second map lookup. */
async function emitRange(
  session: RepoSession,
  from: number,
  to: number,
  dictionaryBase: number,
  source: "git" | "cache",
  emit: (chunk: StreamChunkOf<"graph.stream">) => Promise<void>,
): Promise<number> {
  const commits = session.store.packSlice(from, to, dictionaryBase);
  const nextBase = dictionaryBase + commits.dictionary.length;
  session.dictionaryMarks.set(to, nextBase);
  const remaining = session.commits.length - session.store.rowCount;
  await emit({
    repoId: session.repoId,
    seq: session.nextSeq++,
    from,
    to,
    source,
    remaining,
    exhausted: remaining === 0,
    commits,
  });
  return nextBase;
}

/** One `op.run` call as the mock recorded it — the wire-level `OpRequest` the UI actually sent,
 *  paired with the `OpResult` it got back. P6 W19's own "argv contract" analogue for a mock with
 *  no real git spawn behind it (`RowContextMenu`/`BranchPicker`/dialog specs assert on this the
 *  same way `packages/git`'s own unit tests assert on real argv — see `refOps.spec.ts`'s and
 *  `undo.spec.ts`'s own doc comments). */
export interface RecordedOp {
  readonly request: OpRequest;
  readonly result: OpResult;
}

/** One `undo.run` call as the mock recorded it — kept distinct from `RecordedOp` since `undo.run`
 *  is its own RPC entry, not an `OpRequest` variant. */
export interface RecordedUndo {
  readonly id: string;
  readonly result: OpResult;
}

/** `createHandlers`'s own `ServerHandlers` plus a way to read its private `activeRepoId` closure
 *  variable from outside (P4 W12) — `createMockBridge`'s `triggerRefsChanged` hook needs to know
 *  which repo, if any, is open, without duplicating that tracking at its own level. */
interface MockHandlers {
  readonly serverHandlers: ServerHandlers;
  getActiveRepoId(): string | null;
  /** P5 W12's own hook — see `HarnessEditorAction`'s doc comment. */
  getLastEditorAction(): HarnessEditorAction | undefined;
  /** P6 W19's own hook — see `RecordedOp`'s doc comment. */
  getLastOp(): RecordedOp | undefined;
  /** P6 W19's own hook — see `RecordedUndo`'s doc comment. */
  getLastUndo(): RecordedUndo | undefined;
  /** P6 W19: `conflicted.ts`'s own doc comment already flagged this gap — "Continue re-enables
   *  once the mock's `op.run`/`status.get` loop reflects [conflicts] resolved, which this
   *  scenario cannot fake without a real index". This is that fake: marks one conflicted path
   *  resolved on the active repo's `inProgress` (as `git add <path>` would), decrementing
   *  `unmergedCount`, and fires the same `worktreeChanged` event a real index touch would —
   *  `OpsState.refreshStatus`'s own `repo.changed` subscription is what actually re-enables
   *  `ConflictBanner.vue`'s Continue button, exactly as `conflictBanner.spec.ts` needs to prove
   *  happens with no manual refresh. Returns whether there was a conflicted path to resolve. */
  resolveOneConflictedPath(): boolean;
}

function createHandlers(
  scenario: Scenario,
  notifyChanged: (repoId: string, kind: "refsChanged" | "worktreeChanged") => void,
): MockHandlers {
  const sessions = new Map<string, RepoSession>();
  let activeRepoId: string | null = null;
  let lastEditorAction: HarnessEditorAction | undefined;
  let lastOp: RecordedOp | undefined;
  let lastUndo: RecordedUndo | undefined;

  const appInit: RequestHandler<"app.init"> = async () => ({
    host: "harness",
    contractVersion: CONTRACT_VERSION,
    settings: toSettingsSnapshot(),
    git: scenario.git,
    capabilities: scenario.capabilities ?? {
      openInEditor: true,
      goToFile: true,
      clipboard: true,
      resolveConflict: true,
    },
  });

  const repoList: RequestHandler<"repo.list"> = async () => ({
    candidates: scenario.candidates ?? [],
    activeRepoId,
  });

  const repoPick: RequestHandler<"repo.pick"> = async () => ({ path: null });

  // Ignores `path` deliberately: the mock has exactly one repo per scenario (`Scenario`'s own
  // doc comment), so there is nothing to branch on — every call returns the same fixed outcome.
  const repoOpen: RequestHandler<"repo.open"> = async () => {
    if (scenario.repoOpen.kind === "ok") {
      const { repoId, head } = scenario.repoOpen.repo;
      if (!sessions.has(repoId)) sessions.set(repoId, createSession(repoId, scenario, head));
      activeRepoId = repoId;
    }
    return scenario.repoOpen;
  };

  const repoClose: RequestHandler<"repo.close"> = async ({ repoId }) => {
    sessions.delete(repoId);
    if (activeRepoId === repoId) activeRepoId = null;
    return {};
  };

  const graphStatus: RequestHandler<"graph.status"> = async ({ repoId }) => {
    const session = requireSession(sessions, repoId);
    const remaining = session.commits.length - session.store.rowCount;
    return { loaded: session.store.rowCount, remaining, exhausted: remaining === 0 };
  };

  const graphLoadMore: RequestHandler<"graph.loadMore"> = async ({ repoId, pages }) => {
    const session = requireSession(sessions, repoId);
    if (session.store.rowCount >= session.commits.length) return { started: false };
    for (let i = 0; i < (pages ?? 1); i++) readPageIntoStore(session);
    return { started: true };
  };

  // Mirrors `RepoService.refresh`'s observable effect (§6.2), simplified for a fixture-backed
  // session with no watcher and no lazy "next stream re-walks" staging: there is nothing to
  // re-query here (`Scenario.commits` is static), so the mock resets the store eagerly rather
  // than through a `staleReason` latch consumed on the next stream — the client sees the same
  // "next stream starts at `from: 0` with `source: git`" either way.
  const graphRefresh: RequestHandler<"graph.refresh"> = async ({ repoId }) => {
    const session = sessions.get(repoId);
    if (!session) return { restarted: false };
    session.store.clear();
    session.dictionaryMarks = initialDictionaryMarks();
    return { restarted: true };
  };

  // Mirrors `RepoService.streamGraph`'s cache-then-fresh-page split (see this file's own doc
  // comment): replay whatever this session's store already holds in `CHUNK_ROWS` chunks
  // (`source: "cache"`), then — only on this repo's very first stream, exactly as the real
  // service does — pull one page out of the scenario's fixture and stream the rows that adds.
  const graphStream: StreamHandler<"graph.stream"> = async ({ repoId, resumeThroughRow }, ctx) => {
    const session = requireSession(sessions, repoId);

    // Clamped, not trusted verbatim (`RepoService.streamGraph`'s own comment): a caller-supplied
    // `resumeThroughRow` from before a client-side reset would otherwise point past the (still
    // fully cached) store. The dictionary base for that row is resolved from `dictionaryMarks`,
    // not guessed — see this session field's own doc comment for why a running cursor is wrong
    // here specifically.
    const requestedRow = Math.min(resumeThroughRow ?? 0, session.store.rowCount);
    const mark = session.dictionaryMarks.get(requestedRow);
    let cursor = mark !== undefined ? requestedRow : 0;
    let dictionaryBase = mark ?? 0;
    const cachedThrough = session.store.rowCount;

    while (cursor < cachedThrough) {
      if (ctx.signal.aborted) return;
      const to = Math.min(cursor + CHUNK_ROWS, cachedThrough);
      dictionaryBase = await emitRange(session, cursor, to, dictionaryBase, "cache", ctx.emit);
      cursor = to;
    }
    if (ctx.signal.aborted) return;

    if (cachedThrough === 0 && session.store.rowCount < session.commits.length) {
      readPageIntoStore(session);
    }

    while (cursor < session.store.rowCount) {
      if (ctx.signal.aborted) return;
      const to = Math.min(cursor + CHUNK_ROWS, session.store.rowCount);
      dictionaryBase = await emitRange(session, cursor, to, dictionaryBase, "git", ctx.emit);
      cursor = to;
    }
  };

  const commitDetail: RequestHandler<"commit.detail"> = async ({ repoId, sha, parentIndex }) => {
    requireSession(sessions, repoId);
    const record = scenario.commits.find((c) => c.sha === sha);
    if (!record) throw new Error(`mock bridge: commit.detail: unknown sha '${sha}'`);
    const index = parentIndex ?? 0;
    // Unlike `requireFileChange`/`blobExistsAtRev` (whose whole point is a *specific* file's
    // content, which cannot be honestly guessed), a commit's own metadata already has a true
    // empty default: "this scenario doesn't model this commit's body/trailers/signature/files"
    // is not invented data, it's an accurate statement about scenarios (`clean`, `hugeRepo`,
    // `badges`, …) authored before P5 existed, for which every commit must still be selectable
    // without a hand-written `CommitDetailFixture` per sha — `hugeRepo`'s 20,000 commits chief
    // among them. Scenarios that exist to test detail content itself (`detail`, `merge`,
    // `goToFile`, `noCapabilities`) supply real fixtures and never hit this fallback.
    const fixture = scenario.details?.[sha]?.[index];
    return {
      sha: record.sha,
      parents: record.parents,
      author: record.author,
      committer: record.committer,
      subject: record.subject,
      decoration: record.decoration,
      body: fixture?.body ?? "",
      trailers: fixture?.trailers ?? [],
      signature: fixture?.signature ?? { status: "N", signer: "" },
      parentIndex: index,
      files: fixture?.files ?? [],
    };
  };

  const commitFileDiff: RequestHandler<"commit.fileDiff"> = async ({
    repoId,
    sha,
    path,
    parentIndex,
  }) => {
    requireSession(sessions, repoId);
    const record = scenario.commits.find((c) => c.sha === sha);
    if (!record) throw new Error(`mock bridge: commit.fileDiff: unknown sha '${sha}'`);
    const index = parentIndex ?? 0;
    const change = requireFileChange(scenario, sha, path, index);
    const baseSha = record.parents[index] ?? null;
    const body = scenario.diffs?.[diffKey(sha, path)];
    if (!body) {
      throw new Error(`mock bridge: no FileDiffBody fixture for sha '${sha}' path '${path}'`);
    }
    return { sha, parentIndex: index, baseSha, change, body };
  };

  // Mirrors `packages/git/src/rpcHandlers.ts`'s own `editorOpenDiffImpl` almost line for line —
  // this file's own doc comment on why: "the harness models an editor, and this is in character
  // rather than a test hook" (P5 W12).
  const editorOpenDiff: RequestHandler<"editor.openDiff"> = async ({
    repoId,
    sha,
    path,
    originalPath,
    parentIndex,
  }) => {
    requireSession(sessions, repoId);
    const record = scenario.commits.find((c) => c.sha === sha);
    if (!record) throw new Error(`mock bridge: editor.openDiff: unknown sha '${sha}'`);
    const index = parentIndex ?? 0;
    const change = requireFileChange(scenario, sha, path, index);
    const baseSha = record.parents[index] ?? null;
    const leftPath = change.originalPath ?? originalPath ?? path;
    const left: DocumentRef =
      baseSha === null
        ? { kind: "empty", label: basenameOf(leftPath) }
        : { kind: "virtual", key: diffKey(baseSha, leftPath), label: basenameOf(leftPath) };
    const right: DocumentRef =
      change.kind === "deleted"
        ? { kind: "empty", label: basenameOf(path) }
        : { kind: "virtual", key: diffKey(sha, path), label: basenameOf(path) };
    const shortSha = sha.slice(0, 7);
    lastEditorAction = {
      kind: "openDiff",
      left,
      right,
      title: `${basenameOf(path)} (${shortSha}^ ↔ ${shortSha})`,
    };
    return {};
  };

  // D14a's decision procedure, run in the *same order* as `packages/git/src/rpcHandlers.ts`'s
  // `editorGoToFileImpl` (that file's own doc comment points back here) — `checkoutPaths`
  // standing in for `fs.existsSync`, `worktreeDrift` for `worktreeDiff`, and `blobExistsAtRev`
  // for `service.blob`'s found/missing split (see that function's own doc comment for why the
  // harness does not model `binary`/`tooLarge`).
  const editorGoToFile: RequestHandler<"editor.goToFile"> = async ({ repoId, rev, path, line }) => {
    requireSession(sessions, repoId);

    if ((scenario.checkoutPaths ?? []).includes(path)) {
      const hunks = scenario.worktreeDrift?.[diffKey(rev, path)];
      const finalLine = hunks === undefined ? line : mapLineAcrossDiff(hunks, line, "old");
      lastEditorAction = {
        kind: "reveal",
        ref: { kind: "file", path: `${repoId}/${path}` },
        line: finalLine,
      };
      return { kind: "liveFile", path, line: finalLine };
    }

    if (!blobExistsAtRev(scenario, rev, path)) {
      return { kind: "unavailable", reason: "notInRevision" };
    }
    const key = diffKey(rev, path);
    lastEditorAction = {
      kind: "reveal",
      ref: { kind: "virtual", key, label: basenameOf(path) },
      line,
    };
    return { kind: "virtualBlob", path, rev, line };
  };

  const clipboardWrite: RequestHandler<"clipboard.write"> = async ({ text }) => {
    await navigator.clipboard.writeText(text);
    return {};
  };

  const editorResolveConflict: RequestHandler<"editor.resolveConflict"> = async ({
    repoId,
    path,
  }) => {
    requireSession(sessions, repoId);
    lastEditorAction = { kind: "resolveConflict", path };
    return {};
  };

  const refsList: RequestHandler<"refs.list"> = async ({ repoId }) => {
    const session = requireSession(sessions, repoId);
    return {
      branches: session.refs.branches,
      remoteBranches: session.refs.remoteBranches,
      tags: session.refs.tags,
      head: session.head,
    };
  };

  const statusGet: RequestHandler<"status.get"> = async ({ repoId }) => {
    const session = requireSession(sessions, repoId);
    return {
      head: session.head,
      upstream: session.status.upstream,
      counts: session.status.counts,
      isClean: session.status.isClean,
      dirtyPaths: session.status.dirtyPaths,
      dirtyTruncated: session.status.dirtyTruncated,
      inProgress: session.inProgress,
    };
  };

  const preflightCheckout: RequestHandler<"preflight.checkout"> = async ({
    repoId,
    target,
    mode,
  }) => {
    const session = requireSession(sessions, repoId);
    return (
      scenario.preflight?.checkout?.[target] ?? defaultCheckoutPreflight(session, target, mode)
    );
  };

  const preflightRevert: RequestHandler<"preflight.revert"> = async ({
    repoId,
    shas,
    mainline,
  }) => {
    const session = requireSession(sessions, repoId);
    const key = shas.join(",");
    return (
      scenario.preflight?.revert?.[key] ?? defaultRevertPreflight(session, scenario, shas, mainline)
    );
  };

  const opRun: RequestHandler<"op.run"> = async ({ repoId, op }) => {
    const session = requireSession(sessions, repoId);
    const { result, changed } = applyOp(session, scenario, op);
    // The same safety net W8's real executor applies (`repoService.ts`'s own `runOp` doc
    // comment): a captured record is only ever honoured for a kind `UNDO_POLICY` calls
    // undoable, even though every `applyOp` branch above already agrees with that table.
    if (UNDO_POLICY[op.kind].kind !== "undoable") session.pendingUndo = null;
    if (changed) notifyChanged(repoId, changed);
    lastOp = { request: op, result };
    return result;
  };

  const undoPeek: RequestHandler<"undo.peek"> = async ({ repoId }) => {
    const session = requireSession(sessions, repoId);
    return { slot: session.pendingUndo?.snapshot ?? null };
  };

  const undoRun: RequestHandler<"undo.run"> = async ({ repoId, id }) => {
    const session = requireSession(sessions, repoId);
    const pending = session.pendingUndo;
    if (!pending || pending.snapshot.id !== id) {
      const result = opError(session, "NotFound", "This undo record is no longer available.");
      lastUndo = { id, result };
      return result;
    }
    pending.restore();
    session.pendingUndo = null;
    notifyChanged(repoId, "refsChanged");
    const result = opOk(session);
    lastUndo = { id, result };
    return result;
  };

  function resolveOneConflictedPath(): boolean {
    if (activeRepoId === null) return false;
    const session = sessions.get(activeRepoId);
    const inProgress = session?.inProgress;
    if (!session || !inProgress || inProgress.conflictedPaths.length === 0) return false;
    const [, ...rest] = inProgress.conflictedPaths;
    session.inProgress = {
      ...inProgress,
      conflictedPaths: rest,
      unmergedCount: Math.max(0, inProgress.unmergedCount - 1),
    };
    notifyChanged(activeRepoId, "worktreeChanged");
    return true;
  }

  return {
    serverHandlers: {
      requests: {
        "app.init": appInit,
        "repo.list": repoList,
        "repo.pick": repoPick,
        "repo.open": repoOpen,
        "repo.close": repoClose,
        "graph.status": graphStatus,
        "graph.loadMore": graphLoadMore,
        "graph.refresh": graphRefresh,
        "commit.detail": commitDetail,
        "commit.fileDiff": commitFileDiff,
        "editor.openDiff": editorOpenDiff,
        "editor.goToFile": editorGoToFile,
        "editor.resolveConflict": editorResolveConflict,
        "clipboard.write": clipboardWrite,
        "refs.list": refsList,
        "status.get": statusGet,
        "preflight.checkout": preflightCheckout,
        "preflight.revert": preflightRevert,
        "op.run": opRun,
        "undo.peek": undoPeek,
        "undo.run": undoRun,
      },
      streams: {
        "graph.stream": graphStream,
      },
    },
    getActiveRepoId: () => activeRepoId,
    getLastEditorAction: () => lastEditorAction,
    getLastOp: () => lastOp,
    getLastUndo: () => lastUndo,
    resolveOneConflictedPath,
  };
}

/** `Transport` plus one test-only hook (P4 W12) the harness's own `main.ts` wires to
 *  `window.__kiraHarness.triggerRefsChanged` — `W13`'s Playwright suite asserts the Refresh
 *  button's stale dot off this without waiting on (or building) a real filesystem watcher. */
export interface MockBridge extends Transport {
  /** Simulates the host noticing `.git/refs` changed underneath the currently open repo — a
   *  no-op with no repo open, matching `RepoState`'s own `repo.changed` handling, which ignores
   *  events for a repo that is not (or no longer) the active one. */
  triggerRefsChanged(): void;
  /** P5 W12: the most recent `editor.openDiff`/`editor.goToFile` action the mock recorded, or
   *  `undefined` if neither has fired yet this session — `main.ts` exposes this as
   *  `window.__kiraHarness.lastEditorAction` for W13's Playwright suite. */
  getLastEditorAction(): HarnessEditorAction | undefined;
  /** P6 W19: the most recent `op.run` call the mock recorded (the `OpRequest` the UI actually
   *  sent, and the `OpResult` it got back) — `main.ts` exposes this as
   *  `window.__kiraHarness.lastOp`, letting a Playwright spec assert on the wire-level "argv"
   *  (e.g. `branchDelete`'s `force`, `tagCreate`'s `message`/`force`) the same way `packages/git`'s
   *  own unit tests assert on real argv. */
  getLastOp(): RecordedOp | undefined;
  /** P6 W19: the most recent `undo.run` call the mock recorded — `main.ts` exposes this as
   *  `window.__kiraHarness.lastUndo`. */
  getLastUndo(): RecordedUndo | undefined;
  /** P6 W19: `main.ts` exposes this as `window.__kiraHarness.resolveOneConflictedPath` — see
   *  `MockHandlers`'s own doc comment on why this exists. */
  resolveOneConflictedPath(): boolean;
}

export function createMockBridge(scenarioName: string): MockBridge {
  const scenario = loadScenario(scenarioName);
  const [serverChannel, clientChannel] = createInMemoryChannelPair();
  // `createHandlers` needs to emit through `server`, and `server` needs `serverHandlers` to
  // exist — broken by handing it an indirection that starts as a no-op and is pointed at the
  // real `server.emit` the moment `server` exists, a few lines below.
  let emitChanged: (repoId: string, kind: "refsChanged" | "worktreeChanged") => void = () => {};
  const {
    serverHandlers,
    getActiveRepoId,
    getLastEditorAction,
    getLastOp,
    getLastUndo,
    resolveOneConflictedPath,
  } = createHandlers(scenario, (repoId, kind) => emitChanged(repoId, kind));
  const server = createRpcServer(serverChannel, serverHandlers);
  const client = createRpcClient(clientChannel);
  emitChanged = (repoId, kind) => server.emit("repo.changed", { repoId, kind });

  return {
    ...client,
    dispose(): void {
      client.dispose();
      server.dispose();
    },
    triggerRefsChanged(): void {
      const repoId = getActiveRepoId();
      if (repoId === null) return;
      server.emit("repo.changed", { repoId, kind: "refsChanged" });
    },
    getLastEditorAction,
    getLastOp,
    getLastUndo,
    resolveOneConflictedPath,
  };
}
