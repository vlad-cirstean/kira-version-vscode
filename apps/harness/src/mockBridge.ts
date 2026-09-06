import type {
  CommitRecord,
  DocumentRef,
  FileChange,
  RefRecord,
  StashEntry,
} from "@kira-version/core";
import {
  buildPullPreflight,
  CommitStore,
  classifyPush,
  classifyStashBranch,
  classifyStashPop,
  resolveBase as coreResolveBase,
  defaultSettings,
  mapLineAcrossDiff,
  matchProtectedBranch,
  resolvePullStrategy,
  UNDO_POLICY,
} from "@kira-version/core";
import type {
  BaseResolutionReason,
  CheckoutBlocker,
  CheckoutPreflight,
  CommitRange,
  HeadState,
  InProgressOperation,
  MessageChannelLike,
  OpErrorKind,
  OpRequest,
  OpResult,
  RefKind,
  RefRow,
  RemoteOpParams,
  RemoteOpResult,
  RequestHandler,
  RevertParentChoice,
  RevertPreflight,
  ReviewRangeState,
  ServerHandlers,
  SettingsSnapshot,
  StashBranchPreflight,
  StashPopPreflight,
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

/** The sha HEAD currently resolves to — `stashPush`'s base commit, and `preflight.stashPop`'s
 *  default target when the wire request omits `targetSha`. A branch head that has somehow lost
 *  its own ref row (should not happen — `checkout`/`branchRename` keep them in sync) falls back
 *  to a fabricated sha rather than throwing, matching this file's general "never crash on a
 *  fixture gap" posture. */
function headSha(session: RepoSession): string {
  switch (session.head.kind) {
    case "branch":
      return (
        findRef(session.refs, session.head.name)?.row.objectId ??
        fakeSha(`head:${session.head.name}`)
      );
    case "detached":
      return session.head.sha;
    case "unborn":
      // No commit exists yet — real git refuses `stash push` here entirely; nothing in this mock
      // calls `headSha` for an unborn HEAD today, but a fabricated sha is still a safer fallback
      // than throwing, matching this file's general posture.
      return fakeSha(`unborn:${session.head.name}`);
  }
}

function updateIsHeadFlags(refs: RefsState, head: HeadState): void {
  for (const row of refs.branches) {
    (row as { isHead: boolean }).isHead = head.kind === "branch" && row.shortName === head.name;
  }
}

// ---------------------------------------------------------------------------------------
// P7 W6/W15 — Branch review. `review.resolveBase` reuses `core`'s own `resolveBase` against
// the mock's own ref rows (never a hand-rolled re-implementation of §6.8's policy — the plan's
// own words on why: "so the harness agrees with the resolver, not with a copy of it"), and a
// range's walkability is computed from `Scenario.commits`' real parent links rather than
// invented, since every scenario already carries a real, if small, commit DAG.
//
// This is an interim, generic implementation — W15 replaces it with each scenario's own
// declared `review` fixture (`docs/plans/P7.md`'s W15 section), which lets a scenario state an
// exact `reason`/`range` outcome without needing a ref graph shaped just so to produce it. Until
// then, this gives the harness a real, working resolver rather than a stub with no scenario to
// exercise it yet.
// ---------------------------------------------------------------------------------------

/** `RefRow` (the wire shape `Scenario.refs` fixtures) has no `objectType` — `core`'s
 *  `resolveBase` never reads it (only `shortName`/`upstream`/`isHead`/`kind`), so a filler value
 *  here is never observed; kept as its own tiny function so that fact is documented once. */
function toRefRecordLike(row: RefRow): RefRecord {
  return { ...row, objectType: "commit" };
}

/** Every sha reachable from `tip` by following `parents` transitively (`tip` included) — the
 *  mock's own `merge-base`/`rev-list --count <base>..<branch>` stand-in, computed directly over
 *  `Scenario.commits`' real parent links rather than declared separately. */
function ancestorShas(commits: readonly CommitRecord[], tip: string): Set<string> {
  const bySha = new Map(commits.map((c) => [c.sha, c] as const));
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const record = bySha.get(sha);
    if (record) stack.push(...record.parents);
  }
  return seen;
}

function resolveRefTipSha(refs: RefsState, name: string): string | undefined {
  return findRef(refs, name)?.row.objectId;
}

/** §6.8's four-outcome decision's *range* half — the same question
 *  `RepoService.resolveReviewBase`'s `merge-base`/`rev-list --count` pair answers host-side,
 *  answered here from the DAG directly: `unrelated` when the two tips share no ancestor at all,
 *  `empty` when the branch adds nothing over the base, else `ready` with the ordered range
 *  (newest-first, matching `Scenario.commits`' own convention) and its count. */
function computeReviewRange(
  commits: readonly CommitRecord[],
  refs: RefsState,
  range: CommitRange,
): { readonly records: readonly CommitRecord[]; readonly state: ReviewRangeState } {
  const baseSha = resolveRefTipSha(refs, range.base);
  const branchSha = resolveRefTipSha(refs, range.branch);
  if (baseSha === undefined || branchSha === undefined) {
    return { records: [], state: { kind: "unrelated" } };
  }
  const baseAncestors = ancestorShas(commits, baseSha);
  const branchAncestors = ancestorShas(commits, branchSha);
  const sharesAncestor = [...branchAncestors].some((sha) => baseAncestors.has(sha));
  if (!sharesAncestor) return { records: [], state: { kind: "unrelated" } };
  const records = commits.filter((c) => branchAncestors.has(c.sha) && !baseAncestors.has(c.sha));
  if (records.length === 0) return { records, state: { kind: "empty" } };
  return { records, state: { kind: "ready", commitCount: records.length } };
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

/** `preflight.stashPop`'s default (no scenario fixture hook exists yet — see `RepoSession.stash`'s
 *  own doc comment): the two real, computable blockers (`untrackedCollision`,
 *  `localChangesWouldBeOverwritten`) still work — they are set intersections over state this mock
 *  actually tracks — but the merge-tree prediction itself is always `{kind: "clean"}`, since there
 *  is no real git behind this to predict a genuine conflict with (`classifyStashPop`'s own W11
 *  reuse is exactly this: the mock supplies the sets, the real classifier decides the verdict). */
function defaultStashPopPreflight(
  session: RepoSession,
  stash: StashEntry,
  targetSha: string,
): StashPopPreflight {
  const stashPaths = session.stashedPaths.get(stash.sha) ?? [];
  return classifyStashPop({
    stash,
    targetSha,
    prediction: { kind: "clean" },
    stashPaths,
    stashUntrackedPaths: [],
    dirty: session.status.dirtyPaths.map((path) => ({ path, tracked: true })),
    existingPaths: [],
    inProgress: session.inProgress,
  });
}

/** `preflight.stashBranch`'s default — composes `defaultCheckoutPreflight` against the stash's
 *  own base commit, same posture as `defaultStashPopPreflight` (`classifyStashBranch` needs no
 *  merge-tree prediction at all, per its own doc comment: the apply half is clean by
 *  construction). */
function defaultStashBranchPreflight(
  session: RepoSession,
  stash: StashEntry,
  branch: string,
): StashBranchPreflight {
  const checkout = defaultCheckoutPreflight(session, stash.baseSha, "switch");
  return classifyStashBranch({
    name: branch,
    existingBranchNames: new Set(session.refs.branches.map((b) => b.shortName)),
    checkout,
  });
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
    // ---- P9 W11: Stash -----------------------------------------------------------------
    case "stashPush": {
      const candidates =
        op.paths.length > 0
          ? session.status.dirtyPaths.filter((p) => op.paths.includes(p))
          : session.status.dirtyPaths;
      if (candidates.length === 0) {
        // git's own `rc=0` "No local changes to save" — a no-op success, never an error
        // (probe 10, this plan's exit-criteria table). Nothing changed, so no `changed` kind.
        return { result: opOk(session) };
      }
      const stashed = new Set(candidates);
      const baseSha = headSha(session);
      const sha = fakeSha(`stash:push:${session.repoId}:${Date.now()}:${session.stash.length}`);
      const indexSha = fakeSha(`stashindex:${sha}`);
      const untrackedSha = op.includeUntracked ? fakeSha(`stashuntracked:${sha}`) : undefined;
      const branch = session.head.kind === "branch" ? session.head.name : null;
      const message =
        op.message ??
        (branch !== null
          ? `WIP on ${branch}: ${baseSha.slice(0, 7)} stash`
          : `WIP on (no branch): ${baseSha.slice(0, 7)} stash`);
      const entry: StashEntry = {
        index: 0,
        sha,
        baseSha,
        indexSha,
        untrackedSha,
        message,
        branch,
        timestamp: nowSeconds,
        fileCount: candidates.length,
        includedUntracked: op.includeUntracked,
      };
      session.stash = [entry, ...session.stash.map((s) => ({ ...s, index: s.index + 1 }))];
      session.stashedPaths.set(sha, candidates);
      session.status = {
        ...session.status,
        dirtyPaths: session.status.dirtyPaths.filter((p) => !stashed.has(p)),
        isClean: session.status.dirtyPaths.every((p) => stashed.has(p)),
      };
      return { result: opOk(session), changed: "worktreeChanged" };
    }
    case "stashApply": {
      const stash = session.stash.find((s) => s.sha === op.sha);
      if (!stash) {
        return {
          result: opError(session, "NotFound", `'${op.sha}' is not a valid stash reference`),
        };
      }
      const restored = session.stashedPaths.get(stash.sha) ?? [];
      session.status = {
        ...session.status,
        dirtyPaths: [...new Set([...session.status.dirtyPaths, ...restored])],
        isClean: restored.length === 0 && session.status.isClean,
      };
      return { result: opOk(session), changed: "worktreeChanged" };
    }
    case "stashPop": {
      const idx = session.stash.findIndex((s) => s.sha === op.sha && s.index === op.index);
      if (idx === -1) {
        return {
          result: opError(
            session,
            "NotFound",
            `log for 'stash' only has ${session.stash.length} entries`,
          ),
        };
      }
      const [removed] = session.stash.splice(idx, 1) as [StashEntry];
      session.stash = session.stash.map((s, i) => ({ ...s, index: i }));
      const restored = session.stashedPaths.get(removed.sha) ?? [];
      session.stashedPaths.delete(removed.sha);
      session.status = {
        ...session.status,
        dirtyPaths: [...new Set([...session.status.dirtyPaths, ...restored])],
        isClean: restored.length === 0 && session.status.isClean,
      };
      return { result: opOk(session), changed: "worktreeChanged" };
    }
    case "stashDrop": {
      const idx = session.stash.findIndex((s) => s.sha === op.sha && s.index === op.index);
      if (idx === -1) {
        return {
          result: opError(
            session,
            "NotFound",
            `log for 'stash' only has ${session.stash.length} entries`,
          ),
        };
      }
      const [removed] = session.stash.splice(idx, 1) as [StashEntry];
      session.stash = session.stash.map((s, i) => ({ ...s, index: i }));
      const restorePaths = session.stashedPaths.get(removed.sha);
      session.stashedPaths.delete(removed.sha);
      // `%gs` (this file's own comment on `StashEntry.message`) — matches
      // `RepoService.#captureStashDropUndo`'s label format exactly.
      const snapshot: UndoSlotSnapshot = {
        id: fakeSha(`undo:stash:${removed.sha}:${Date.now()}`),
        label: `Dropped stash@{${removed.index}}: ${removed.message}`,
        recoverySha: removed.sha,
        createdAt: Date.now(),
      };
      const pendingUndo: PendingUndo = {
        snapshot,
        restore: () => {
          // `stash store` always lands at stash@{0} (W15's own announcement text) — reinsert
          // there and shift everything else back, same as `stashPush`'s own ordering.
          session.stash = [
            { ...removed, index: 0 },
            ...session.stash.map((s) => ({ ...s, index: s.index + 1 })),
          ];
          if (restorePaths) session.stashedPaths.set(removed.sha, restorePaths);
        },
      };
      return { result: opOk(session, pendingUndo), changed: "worktreeChanged" };
    }
    case "stashBranch": {
      const stash = session.stash.find((s) => s.sha === op.sha && s.index === op.index);
      if (!stash) {
        return {
          result: opError(
            session,
            "NotFound",
            `log for 'stash' only has ${session.stash.length} entries`,
          ),
        };
      }
      if (session.refs.branches.some((b) => b.shortName === op.branch)) {
        return {
          result: opError(session, "AlreadyExists", `branch '${op.branch}' already exists`),
        };
      }
      const row: RefRow = {
        refname: `refs/heads/${op.branch}`,
        kind: "branch",
        shortName: op.branch,
        objectId: stash.baseSha,
        peeledObjectId: undefined,
        upstream: undefined,
        track: undefined,
        committerDate: nowSeconds,
        isHead: true,
        checkedOutIn: undefined,
        annotation: undefined,
      };
      session.refs.branches.push(row);
      session.head = { kind: "branch", name: op.branch };
      updateIsHeadFlags(session.refs, session.head);
      // Clean by construction (§7.6/`classifyStashBranch`'s own doc comment) ⇒ git always drops
      // the stash on success, exactly like a successful pop.
      const restored = session.stashedPaths.get(stash.sha) ?? [];
      session.stashedPaths.delete(stash.sha);
      session.stash = session.stash
        .filter((s) => s.sha !== stash.sha)
        .map((s, i) => ({ ...s, index: i }));
      session.status = {
        ...session.status,
        dirtyPaths: [...new Set([...session.status.dirtyPaths, ...restored])],
        isClean: restored.length === 0 && session.status.isClean,
      };
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
    "kiraVersion.review.baseCandidates": settings["kiraVersion.review.baseCandidates"],
    "kiraVersion.fetch.autoInterval": settings["kiraVersion.fetch.autoInterval"],
    "kiraVersion.pull.strategy": settings["kiraVersion.pull.strategy"],
    "kiraVersion.protectedBranches": settings["kiraVersion.protectedBranches"],
    "kiraVersion.stash.includeUntracked": settings["kiraVersion.stash.includeUntracked"],
    "kiraVersion.stash.showInGraph": settings["kiraVersion.stash.showInGraph"],
  };
}

/** A harness-local copy of `packages/ipc/src/rpc.test.ts`'s own `createInMemoryChannelPair` —
 *  a real in-memory pipe using `structuredClone` (with transfer support) so posting on one end
 *  synchronously invokes the other, mimicking real `postMessage`/transfer-detach semantics
 *  closely enough that `createRpcClient`/`createRpcServer` cannot tell this from a real host
 *  channel. Declares `bufferEncoding: "native"` (P15's W6): `structuredClone` genuinely carries
 *  an `ArrayBuffer`, so nothing about this pipe's behaviour needed to change. */
function createInMemoryChannelPair(): readonly [MessageChannelLike, MessageChannelLike] {
  let handlerA: ((message: unknown) => void) | undefined;
  let handlerB: ((message: unknown) => void) | undefined;
  let closedA = false;
  let closedB = false;

  const a: MessageChannelLike = {
    bufferEncoding: "native",
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
    bufferEncoding: "native",
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
  /** P7 W6/W15 — Branch review's own, isolated second walk(s), keyed by `<base>..<branch>`.
   *  Deliberately not sharing `store`/`dictionaryMarks`/`nextSeq` with the fields above —
   *  D38's isolation requirement, mirrored here from `RepoService`'s own `reviewWalk` slot. */
  reviewWalks: Map<string, ReviewWalkState>;
  /** P9 W11 — the mock's in-memory stash stack, `stash@{0}` first (matches `stash list`'s own
   *  order, and `StashEntry.index`'s own meaning). No scenario fixtures this yet (W16 is real-git
   *  integration fixtures, not a harness scenario field) — every session starts empty and is
   *  populated purely by `stashPush`, exactly like `refs`/`status` are by their own op cases. */
  stash: StashEntry[];
  /** Sha -> the paths `stashPush` moved out of `status.dirtyPaths` for that entry. This mock does
   *  not distinguish tracked from untracked, model a pathspec's partial-tree effect beyond "which
   *  paths", or predict real merge conflicts — apply/pop simply puts these back. As this file's
   *  own W11 doc comment says: real merge semantics are `tests/integration`'s job, not the
   *  harness's; this exists only so every stash surface is reachable with no real git present. */
  stashedPaths: Map<string, readonly string[]>;
}

/** P7 W6/W15 — one open review walk (`ReviewWalk`'s mock-side counterpart): its own `CommitStore`
 *  and dictionary marks, paged over `records` (the full range, already resolved, newest-first) —
 *  never the session's own `store`/`dictionaryMarks`. */
interface ReviewWalkState {
  readonly records: readonly CommitRecord[];
  readonly store: CommitStore;
  dictionaryMarks: Map<number, number>;
  nextSeq: number;
}

function reviewWalkKey(range: CommitRange): string {
  return `${range.base}..${range.branch}`;
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
    reviewWalks: new Map(),
    stash: [],
    stashedPaths: new Map(),
  };
}

/** Returns the open review walk for `range`, resolving and caching it on first use — mirrors
 *  `RepoService.#ensureReviewWalk` (P7 W4): reused for the same range, never rebuilt mid-review. */
function ensureReviewWalk(session: RepoSession, range: CommitRange): ReviewWalkState {
  const key = reviewWalkKey(range);
  const existing = session.reviewWalks.get(key);
  if (existing) return existing;
  const { records } = computeReviewRange(session.commits, session.refs, range);
  const walk: ReviewWalkState = {
    records,
    store: new CommitStore(),
    dictionaryMarks: initialDictionaryMarks(),
    nextSeq: 0,
  };
  session.reviewWalks.set(key, walk);
  return walk;
}

/** `readPageIntoStore`'s own review-walk counterpart — same page-at-a-time shape, over `walk.
 *  records` instead of `session.commits`. */
function readReviewPageIntoStore(walk: ReviewWalkState): void {
  const loaded = walk.store.rowCount;
  const count = Math.min(PAGE_SIZE, walk.records.length - loaded);
  if (count <= 0) return;
  walk.store.appendPage(walk.records.slice(loaded, loaded + count));
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

/** `emitRange`'s own review-walk counterpart: same packing, over `walk` (its own `store`/
 *  `dictionaryMarks`/`nextSeq`, its own `records.length` as "total") rather than `session`'s.
 *  Kept as its own small function rather than sharing one implementation with `emitRange` — this
 *  file's own module doc comment already states its philosophy ("mirroring … conceptually rather
 *  than by shared code"); `repoService.ts`'s real `WalkLike` abstraction is what the production
 *  code actually shares, this mock does not need to. */
async function emitReviewRange(
  repoId: string,
  walk: ReviewWalkState,
  from: number,
  to: number,
  dictionaryBase: number,
  source: "git" | "cache",
  emit: (chunk: StreamChunkOf<"graph.stream">) => Promise<void>,
): Promise<number> {
  const commits = walk.store.packSlice(from, to, dictionaryBase);
  const nextBase = dictionaryBase + commits.dictionary.length;
  walk.dictionaryMarks.set(to, nextBase);
  const remaining = walk.records.length - walk.store.rowCount;
  await emit({
    repoId,
    seq: walk.nextSeq++,
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

/** One `remote.run` call as the mock recorded it — `RecordedOp`'s own P8 analogue (`docs/plans/P8.md`
 *  W21). Kept distinct from `RecordedOp` rather than folded into it, mirroring `OpsState`'s own
 *  `#runRemote`/`#runSimple` split (D51): a `RemoteOpParams` is not an `OpRequest`, and a
 *  `RemoteOpResult` carries no `undo` field. `remoteOps.spec.ts` asserts on this the same way
 *  `refOps.spec.ts` asserts on `lastOp` — the wire-level request the toolbar/dialogs actually
 *  built (which strategy, which `confirmToken`, `plainForce`) alongside what the mock decided. */
export interface RecordedRemoteOp {
  readonly request: RemoteOpParams;
  readonly result: RemoteOpResult;
}

/** One `review.open` call as the mock recorded it — `docs/plans/P7.md` W16's "both entry points
 *  open the review on the right branch" needs something to assert against even though the
 *  harness serves one view per page load and so cannot literally reveal a second one
 *  (`reviewOpen`'s own doc comment): a spec drives the panel's "Review branch changes" menu,
 *  reads this back, and opens a second harness page at `?view=review&branch=<recorded branch>`
 *  to prove the request the menu actually sent was the right one. */
export interface RecordedReviewOpen {
  readonly repoId: string;
  readonly branch: string;
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
  /** P8 W21's own hook — see `RecordedRemoteOp`'s doc comment. */
  getLastRemoteOp(): RecordedRemoteOp | undefined;
  /** P7 W15/W16's own hook — see `RecordedReviewOpen`'s doc comment. */
  getLastReviewOpen(): RecordedReviewOpen | undefined;
  /** `docs/plans/P7.md` W16's "a collapsed-then-re-expanded row does not re-request" — `sha`'s
   *  own call count to `commit.detail`, so a spec can assert it stays at 1 across a
   *  toggle/re-toggle instead of inferring "no re-fetch" from the absence of a visible symptom.
   *  Keyed by sha alone (globally unique within one scenario's `topology()`), not by repoId. */
  getCommitDetailCallCount(sha: string): number;
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
  let lastRemoteOp: RecordedRemoteOp | undefined;
  let lastReviewOpen: RecordedReviewOpen | undefined;
  const commitDetailCallCounts = new Map<string, number>();

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

  const graphStatus: RequestHandler<"graph.status"> = async ({ repoId, range }) => {
    const session = requireSession(sessions, repoId);
    if (range) {
      const walk = session.reviewWalks.get(reviewWalkKey(range));
      if (!walk) return { loaded: 0, remaining: 0, exhausted: false };
      const remaining = walk.records.length - walk.store.rowCount;
      return { loaded: walk.store.rowCount, remaining, exhausted: remaining === 0 };
    }
    const remaining = session.commits.length - session.store.rowCount;
    return { loaded: session.store.rowCount, remaining, exhausted: remaining === 0 };
  };

  const graphLoadMore: RequestHandler<"graph.loadMore"> = async ({ repoId, pages, range }) => {
    const session = requireSession(sessions, repoId);
    if (range) {
      const walk = ensureReviewWalk(session, range);
      if (walk.store.rowCount >= walk.records.length) return { started: false };
      for (let i = 0; i < (pages ?? 1); i++) readReviewPageIntoStore(walk);
      return { started: true };
    }
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
  const graphStream: StreamHandler<"graph.stream"> = async (
    { repoId, resumeThroughRow, range },
    ctx,
  ) => {
    const session = requireSession(sessions, repoId);

    // P7 W6/W15 — the ranged half (`docs/plans/P7.md`'s "the ranged half of streamGraph"):
    // `resumeThroughRow` is ignored entirely, exactly as the real service ignores it — a review
    // walk has no cache to resume from. Always emits from row 0, `source: "git"`.
    if (range) {
      const walk = ensureReviewWalk(session, range);
      if (walk.store.rowCount === 0 && walk.store.rowCount < walk.records.length) {
        readReviewPageIntoStore(walk);
      }
      let cursor = 0;
      let dictionaryBase = 0;
      while (cursor < walk.store.rowCount) {
        if (ctx.signal.aborted) return;
        const to = Math.min(cursor + CHUNK_ROWS, walk.store.rowCount);
        dictionaryBase = await emitReviewRange(
          session.repoId,
          walk,
          cursor,
          to,
          dictionaryBase,
          "git",
          ctx.emit,
        );
        cursor = to;
      }
      return;
    }

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
    commitDetailCallCounts.set(sha, (commitDetailCallCounts.get(sha) ?? 0) + 1);
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

  // ---- P7 W6/W15: Branch review -----------------------------------------------------------

  const reviewResolveBase: RequestHandler<"review.resolveBase"> = async ({
    repoId,
    branch,
    base,
  }) => {
    const session = requireSession(sessions, repoId);
    const branchMatch = findRef(session.refs, branch);
    if (!branchMatch || branchMatch.kind === "tag") {
      return { branch, base: null, reason: "none", range: { kind: "ask" }, candidates: [] };
    }

    const branchRecord = toRefRecordLike(branchMatch.row);
    const natural = coreResolveBase({
      branch: branchRecord,
      branches: session.refs.branches.map(toRefRecordLike),
      remoteBranches: session.refs.remoteBranches.map(toRefRecordLike),
      // The mock models no `origin/HEAD` equivalent (`RefsState` has no symbolic-ref slot) —
      // resolution falls through step 1 straight to `candidates` when upstream does not apply,
      // same as a real repo with no `origin/HEAD` set (V1).
      originHead: undefined,
      candidates: defaultSettings()["kiraVersion.review.baseCandidates"],
    });

    const resolvedBase = base !== undefined ? base : natural.base;
    const reason: BaseResolutionReason = base !== undefined ? "override" : natural.reason;
    const candidates = natural.candidates;

    if (resolvedBase === null) {
      return { branch, base: null, reason, range: { kind: "ask" }, candidates };
    }
    const { state } = computeReviewRange(session.commits, session.refs, {
      base: resolvedBase,
      branch,
    });
    return { branch, base: resolvedBase, reason, range: state, candidates };
  };

  /** D40: the harness serves one view per page load, so there is no second, already-rendered
   *  view for this to literally "switch" the way the real `reviewView.ts` host does — this
   *  records `{repoId, branch}` instead (`RecordedReviewOpen`'s own doc comment says why, and how
   *  a Playwright spec uses it) and otherwise resolves as a correct no-op. */
  const reviewOpen: RequestHandler<"review.open"> = async ({ repoId, branch }) => {
    lastReviewOpen = { repoId, branch };
    return {};
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

  // ---- P9 W11: Stash ---------------------------------------------------------------------

  const stashList: RequestHandler<"stash.list"> = async ({ repoId }) => {
    const session = requireSession(sessions, repoId);
    return { entries: session.stash };
  };

  const stashShow: RequestHandler<"stash.show"> = async ({ repoId, sha }) => {
    const session = requireSession(sessions, repoId);
    const stash = session.stash.find((s) => s.sha === sha);
    if (!stash) throw new Error(`mock bridge: stash.show: unknown stash '${sha}'`);
    // No per-stash diff-body fixture exists yet (`RepoSession.stashedPaths`'s own doc comment) —
    // every path is reported "modified" with no line counts, enough to populate the detail
    // pane's file tree, not its diff body.
    const paths = session.stashedPaths.get(sha) ?? [];
    const changes: FileChange[] = paths.map((path) => ({
      kind: "modified",
      path,
      originalPath: undefined,
      similarity: undefined,
      additions: undefined,
      deletions: undefined,
      isBinary: false,
    }));
    return { sha, changes };
  };

  const preflightStashPop: RequestHandler<"preflight.stashPop"> = async ({
    repoId,
    sha,
    index,
    targetSha,
  }) => {
    const session = requireSession(sessions, repoId);
    const stash = session.stash.find((s) => s.sha === sha && s.index === index);
    if (!stash) {
      throw new Error(`mock bridge: preflight.stashPop: unknown stash '${sha}'@{${index}}`);
    }
    return defaultStashPopPreflight(session, stash, targetSha ?? headSha(session));
  };

  const preflightStashBranch: RequestHandler<"preflight.stashBranch"> = async ({
    repoId,
    sha,
    branch,
  }) => {
    const session = requireSession(sessions, repoId);
    const stash = session.stash.find((s) => s.sha === sha);
    if (!stash) throw new Error(`mock bridge: preflight.stashBranch: unknown stash '${sha}'`);
    return defaultStashBranchPreflight(session, stash, branch);
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

  // ---------------------------------------------------------------------------------------
  // P8 W16/W21 — Remote ops. The harness models no second git process at the other end of
  // "the remote": `session.refs.remoteBranches` (a `RefRow` per `<remote>/<branch>`) *is* the
  // remote's state as far as this mock is concerned, the same way `applyOp` mutates
  // `session.refs.branches`/`session.status` in place rather than replaying a real spawn.
  // A consequence worth stating once: `fetch` never discovers anything a scenario didn't
  // already put in `remoteBranches` — there is no separate remote timeline to have diverged
  // from it — so it always succeeds with no updates. A scenario that wants a real
  // "someone else pushed first" story needs a dedicated fixture hook; none exists yet (no W16
  // work item asked for one), so this is left for W21's own Playwright specs to add if a test
  // needs it, the same deferral `preflight.checkout`/`preflight.revert`'s own doc comments
  // already model for their hazard-shaped cases.
  //
  // `defaultSettings()` stands in for `kiraVersion.pull.strategy`/`protectedBranches` — the
  // harness has no per-scenario settings override mechanism yet (`toSettingsSnapshot` above is
  // likewise always the same fixed snapshot), so every scenario sees the same defaults here.
  // ---------------------------------------------------------------------------------------

  function currentBranchName(session: RepoSession): string | undefined {
    return session.head.kind === "branch" ? session.head.name : undefined;
  }

  function remoteRefName(remote: string, branch: string): string {
    return `${remote}/${branch}`;
  }

  function remoteOpError(kind: OpErrorKind, message: string): RemoteOpResultLike {
    return { ok: false, error: { kind, message, remoteMessage: undefined }, updates: [] };
  }

  /** The shape every `remote.run` branch below returns before `head`/`inProgress` are filled in
   *  from the session at the very end — kept separate so each branch only states what it
   *  actually decided (ok/error/updates), matching `opOk`/`opError`'s own split. */
  interface RemoteOpResultLike {
    readonly ok: boolean;
    readonly error:
      | { readonly kind: OpErrorKind; readonly message: string; readonly remoteMessage: undefined }
      | undefined;
    readonly updates: readonly {
      from: string | null;
      to: string | null;
      ref: string;
      forced: boolean;
    }[];
  }

  // `branch` mirrors the real `RepoService.preflightPull`'s own signature (it reads
  // `branch.<name>.rebase` for that one branch) but is otherwise unused here: the mock has no
  // git config to read, and `session.status.upstream` already reports ahead/behind for
  // whichever branch is checked out, the same "current branch only" assumption the real
  // implementation's own doc comment states for `preflightPush`.
  const remotePullPreflight: RequestHandler<"remote.pullPreflight"> = async ({
    repoId,
    branch: _branch,
  }) => {
    const session = requireSession(sessions, repoId);
    const { strategy, source } = resolvePullStrategy({
      settingStrategy: defaultSettings()["kiraVersion.pull.strategy"],
      gitConfig: {},
    });
    const upstream = session.status.upstream;
    return buildPullPreflight({
      strategy,
      source,
      upstream: upstream?.name ?? null,
      ahead: upstream?.ahead ?? 0,
      behind: upstream?.behind ?? 0,
      dirty: !session.status.isClean,
    });
  };

  const remotePushPreflight: RequestHandler<"remote.pushPreflight"> = async ({
    repoId,
    branch,
    remote,
  }) => {
    const session = requireSession(sessions, repoId);
    const upstream = session.status.upstream;
    const remoteRow = findRef(session.refs, remoteRefName(remote, branch));
    return classifyPush({
      branch,
      upstream: upstream?.name ?? null,
      ahead: upstream?.ahead ?? 0,
      behind: upstream?.behind ?? 0,
      remoteTip: remoteRow?.row.objectId ?? null,
      protectedBranches: defaultSettings()["kiraVersion.protectedBranches"],
    });
  };

  function applyRemoteOp(
    session: RepoSession,
    request: {
      readonly kind: "fetch" | "push" | "pull" | "forcePush" | "deleteRemoteBranch";
      readonly remote: string;
      readonly branch: string | undefined;
      readonly expectedRemoteTip: string | null | undefined;
      readonly confirmToken: string | undefined;
    },
  ): RemoteOpResultLike {
    if (request.kind === "fetch") return { ok: true, error: undefined, updates: [] };

    const branch = request.branch ?? currentBranchName(session);
    if (branch === undefined) {
      return remoteOpError("NotFound", "No branch is checked out.");
    }
    const refName = remoteRefName(request.remote, branch);

    if (request.kind === "forcePush" || request.kind === "deleteRemoteBranch") {
      const match = matchProtectedBranch(
        branch,
        defaultSettings()["kiraVersion.protectedBranches"],
      );
      if (match && request.confirmToken !== branch) {
        return remoteOpError("ProtectedBranch", `${branch} is a protected branch.`);
      }
    }

    if (request.kind === "deleteRemoteBranch") {
      const existing = findRef(session.refs, refName);
      if (!existing) return remoteOpError("RemoteRefMissing", `${refName} does not exist.`);
      session.refs.remoteBranches = session.refs.remoteBranches.filter(
        (r) => r.shortName !== existing.row.shortName,
      );
      return {
        ok: true,
        error: undefined,
        updates: [{ ref: refName, from: existing.row.objectId, to: null, forced: false }],
      };
    }

    const localRow = findRef(session.refs, branch);
    if (!localRow) return remoteOpError("NotFound", `${branch} does not exist locally.`);
    const remoteRow = findRef(session.refs, refName);

    if (request.kind === "forcePush") {
      const actualTip = remoteRow?.row.objectId ?? null;
      if (request.expectedRemoteTip !== undefined && request.expectedRemoteTip !== actualTip) {
        return remoteOpError(
          "LeaseViolation",
          "The remote moved since this was checked; fetch and try again.",
        );
      }
      updateRemoteBranchTip(session, refName, localRow.row.objectId);
      return {
        ok: true,
        error: undefined,
        updates: [{ ref: refName, from: actualTip, to: localRow.row.objectId, forced: true }],
      };
    }

    if (request.kind === "push") {
      const upstream = session.status.upstream;
      if (upstream !== undefined && upstream.behind > 0) {
        return remoteOpError(
          "NonFastForward",
          "Updates were rejected because the remote contains work you do not have locally.",
        );
      }
      const from = remoteRow?.row.objectId ?? null;
      updateRemoteBranchTip(session, refName, localRow.row.objectId);
      session.status.upstream = { name: refName, ahead: 0, behind: 0 };
      return {
        ok: true,
        error: undefined,
        updates: [{ ref: refName, from, to: localRow.row.objectId, forced: false }],
      };
    }

    // pull: the fetch phase above never finds anything new (this mock's own doc comment above
    // explains why), so integration only ever has to reconcile against what `remoteBranches`
    // already states. ff-only when there is something to bring in, else a no-op "up to date".
    const upstream = session.status.upstream;
    if (upstream === undefined || upstream.behind === 0) {
      return { ok: true, error: undefined, updates: [] };
    }
    if (!session.status.isClean) {
      return remoteOpError("DirtyWorktree", "The working tree has local changes.");
    }
    if (!remoteRow) return remoteOpError("RemoteRefMissing", `${refName} does not exist.`);
    const from = localRow.row.objectId;
    (localRow.row as { objectId: string }).objectId = remoteRow.row.objectId;
    session.status.upstream = { name: refName, ahead: upstream.ahead, behind: 0 };
    return {
      ok: true,
      error: undefined,
      updates: [{ ref: branch, from, to: remoteRow.row.objectId, forced: false }],
    };
  }

  function updateRemoteBranchTip(session: RepoSession, refName: string, sha: string): void {
    const existing = session.refs.remoteBranches.find((r) => r.shortName === refName);
    if (existing) {
      (existing as { objectId: string }).objectId = sha;
      return;
    }
    session.refs.remoteBranches.push({
      refname: `refs/remotes/${refName}`,
      kind: "remoteBranch",
      shortName: refName,
      objectId: sha,
      peeledObjectId: undefined,
      upstream: undefined,
      track: undefined,
      committerDate: Date.now() / 1000,
      isHead: false,
      checkedOutIn: undefined,
      annotation: undefined,
    });
  }

  const remoteRun: RequestHandler<"remote.run"> = async ({ repoId, ...request }) => {
    const session = requireSession(sessions, repoId);
    const outcome = applyRemoteOp(session, request);
    if (outcome.ok && outcome.updates.length > 0) notifyChanged(repoId, "refsChanged");
    const result: RemoteOpResult = {
      ok: outcome.ok,
      error: outcome.error,
      updates: outcome.updates,
      head: session.head,
      inProgress: session.inProgress,
    };
    lastRemoteOp = { request: { repoId, ...request }, result };
    return result;
  };

  // Every mock remote op above completes synchronously within the same request/response —
  // there is never anything left running for `remote.cancel` to find, unlike the real
  // `RepoService` (a live child process it can sensibly interrupt). `false` here is that real
  // difference showing through honestly rather than a stub pretending to cancel something.
  const remoteCancel: RequestHandler<"remote.cancel"> = async (_params) => ({ cancelled: false });

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
        "stash.list": stashList,
        "stash.show": stashShow,
        "preflight.stashPop": preflightStashPop,
        "preflight.stashBranch": preflightStashBranch,
        "op.run": opRun,
        "undo.peek": undoPeek,
        "undo.run": undoRun,
        "review.resolveBase": reviewResolveBase,
        "review.open": reviewOpen,
        "remote.pullPreflight": remotePullPreflight,
        "remote.pushPreflight": remotePushPreflight,
        "remote.run": remoteRun,
        "remote.cancel": remoteCancel,
      },
      streams: {
        "graph.stream": graphStream,
      },
    },
    getActiveRepoId: () => activeRepoId,
    getLastEditorAction: () => lastEditorAction,
    getLastOp: () => lastOp,
    getLastUndo: () => lastUndo,
    getLastRemoteOp: () => lastRemoteOp,
    getLastReviewOpen: () => lastReviewOpen,
    getCommitDetailCallCount: (sha) => commitDetailCallCounts.get(sha) ?? 0,
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
  /** P8 W21: the most recent `remote.run` call the mock recorded — `main.ts` exposes this as
   *  `window.__kiraHarness.lastRemoteOp`. See `RecordedRemoteOp`'s own doc comment. */
  getLastRemoteOp(): RecordedRemoteOp | undefined;
  /** P7 W15/W16: the most recent `review.open` call the mock recorded — `main.ts` exposes this
   *  as `window.__kiraHarness.lastReviewOpen`. See `RecordedReviewOpen`'s own doc comment. */
  getLastReviewOpen(): RecordedReviewOpen | undefined;
  /** `docs/plans/P7.md` W16's own hook — see `MockHandlers.getCommitDetailCallCount`'s doc
   *  comment. `main.ts` exposes this as `window.__kiraHarness.getCommitDetailCallCount`. */
  getCommitDetailCallCount(sha: string): number;
  /** P6 W19: `main.ts` exposes this as `window.__kiraHarness.resolveOneConflictedPath` — see
   *  `MockHandlers`'s own doc comment on why this exists. */
  resolveOneConflictedPath(): boolean;
  /** P7 W15: pushes `review.target` — `main.ts` exposes this as
   *  `window.__kiraHarness.pushReviewTarget`, letting a Playwright spec exercise D40's
   *  "already-open view" arm (the panel's own "Review branch changes" menu, or the palette
   *  command revealing an already-live view) without a second webview to drive. */
  pushReviewTarget(repoId: string, branch: string): void;
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
    getLastRemoteOp,
    getLastReviewOpen,
    getCommitDetailCallCount,
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
    getLastRemoteOp,
    getLastReviewOpen,
    getCommitDetailCallCount,
    resolveOneConflictedPath,
    pushReviewTarget(repoId: string, branch: string): void {
      server.emit("review.target", { repoId, branch });
    },
  };
}
