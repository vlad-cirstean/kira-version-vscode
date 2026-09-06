/**
 * §7.11's in-progress state machine and §7's `OpRequest`/`OpResult` union — the types the whole
 * phase is typed against. Pure data and pure functions only; `git/src/ops/conflict.ts` is the
 * only thing that reads `.git`'s state files off disk, and it hands its result to
 * `classifyInProgress` below as plain data (`InProgressStateFiles`), which is what makes the
 * precedence table a named unit test per row instead of an integration-only fact.
 */

/** `HeadState` is already `core`'s own (`model/repo.ts`) — not re-declared here. */
import type { HeadState } from "./repo.ts";

export type InProgressKind =
  | "merge"
  | "cherryPick"
  | "revert"
  | "rebase"
  | "bisect"
  | "unmergedOnly";

export interface InProgressOperation {
  readonly kind: InProgressKind;
  /** MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD's content, or rebase's `onto`. */
  readonly otherSha: string | undefined;
  /** rebase only: `rebase-merge/head-name`'s content, e.g. `refs/heads/side`. */
  readonly headName: string | undefined;
  readonly conflictedPaths: readonly string[];
  /** True only where `git <op> --continue` exists AND v1 offers it — false for rebase (§9) and
   *  bisect. Kept independent of `unmergedCount`: the *enablement* is
   *  `canContinue && unmergedCount === 0`, which is what lets the banner say "resolve the
   *  remaining N files, then Continue" rather than hiding the button outright. */
  readonly canContinue: boolean;
  readonly canAbort: boolean;
  /** `.git/sequencer/` present: a multi-commit revert or cherry-pick mid-run, where `--abort`
   *  is what delivers §7.10's all-or-nothing. */
  readonly isSequence: boolean;
  /** Continue is *enabled* only when this is 0 (§7.11). Kept separate from
   *  `conflictedPaths.length` so a host that caps the path list cannot accidentally enable it. */
  readonly unmergedCount: number;
  /** P10 probe 6: true for `cherryPick` and `revert` only — the two sequencer operations git
   *  gives a `--skip`. Without this the banner would offer a Continue that cannot succeed on an
   *  empty pick (`CHERRY_PICK_HEAD` present, zero unmerged paths — Continue refuses, `--skip` is
   *  git's own named remedy). */
  readonly canSkip: boolean;
}

/** What `git/src/ops/conflict.ts` reads off disk (per-worktree `gitDir`, never `commonDir` —
 *  D12) — deliberately plain data, so `classifyInProgress` needs no I/O to test. A missing file
 *  is `undefined`/`false`, never a throw. */
export interface InProgressStateFiles {
  /** `MERGE_HEAD`'s content, trimmed. */
  readonly mergeHead: string | undefined;
  readonly cherryPickHead: string | undefined;
  readonly revertHead: string | undefined;
  /** Presence only — v1 never reads `BISECT_LOG`'s content (report-only, §9). */
  readonly bisectLog: boolean;
  readonly rebaseMergeDir: boolean;
  readonly rebaseApplyDir: boolean;
  /** `rebase-merge/head-name`'s content, trimmed, e.g. `refs/heads/side`. */
  readonly rebaseHeadName: string | undefined;
  /** `rebase-merge/onto`'s content, trimmed — a sha. */
  readonly rebaseOnto: string | undefined;
  readonly sequencerDir: boolean;
}

function operationOf(
  kind: InProgressKind,
  input: {
    readonly otherSha: string | undefined;
    readonly headName: string | undefined;
    readonly canContinue: boolean;
    readonly canAbort: boolean;
    readonly isSequence: boolean;
    readonly unmergedPaths: readonly string[];
  },
): InProgressOperation {
  return {
    kind,
    otherSha: input.otherSha,
    headName: input.headName,
    conflictedPaths: input.unmergedPaths,
    canContinue: input.canContinue,
    canAbort: input.canAbort,
    isSequence: input.isSequence,
    unmergedCount: input.unmergedPaths.length,
    canSkip: kind === "cherryPick" || kind === "revert",
  };
}

/**
 * §7.11's precedence table, exactly: rebase shadows everything else (a rebase stopped on a
 * conflict also leaves the sequencer files a cherry-pick would), then merge, cherry-pick,
 * revert, bisect, and finally a bare "unmerged paths with none of the six state files present"
 * fallback (a resolved-then-reset state, or `git checkout -m`). `AUTO_MERGE` is deliberately not
 * an input here — probe P4 found it left behind after an aborted cherry-pick, so it is a stale
 * artefact, not a state signal.
 */
export function classifyInProgress(input: {
  readonly stateFiles: InProgressStateFiles;
  readonly unmergedPaths: readonly string[];
}): InProgressOperation | null {
  const { stateFiles: s, unmergedPaths } = input;

  if (s.rebaseMergeDir || s.rebaseApplyDir) {
    return operationOf("rebase", {
      otherSha: s.rebaseOnto,
      headName: s.rebaseHeadName,
      canContinue: false,
      canAbort: true,
      isSequence: s.sequencerDir,
      unmergedPaths,
    });
  }
  if (s.mergeHead !== undefined) {
    return operationOf("merge", {
      otherSha: s.mergeHead,
      headName: undefined,
      canContinue: true,
      canAbort: true,
      isSequence: s.sequencerDir,
      unmergedPaths,
    });
  }
  if (s.cherryPickHead !== undefined) {
    return operationOf("cherryPick", {
      otherSha: s.cherryPickHead,
      headName: undefined,
      canContinue: true,
      canAbort: true,
      isSequence: s.sequencerDir,
      unmergedPaths,
    });
  }
  if (s.revertHead !== undefined) {
    return operationOf("revert", {
      otherSha: s.revertHead,
      headName: undefined,
      canContinue: true,
      canAbort: true,
      isSequence: s.sequencerDir,
      unmergedPaths,
    });
  }
  if (s.bisectLog) {
    return operationOf("bisect", {
      otherSha: undefined,
      headName: undefined,
      canContinue: false,
      canAbort: true,
      isSequence: s.sequencerDir,
      unmergedPaths,
    });
  }
  if (unmergedPaths.length > 0) {
    return operationOf("unmergedOnly", {
      otherSha: undefined,
      headName: undefined,
      canContinue: false,
      canAbort: false,
      isSequence: s.sequencerDir,
      unmergedPaths,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// §7's op.run union, and the undo slot's own wire-shaped snapshot (structurally copied onto
// the wire by packages/ipc — see that package's contract.ts).
// ---------------------------------------------------------------------------------------

/** §7.7's three reset modes, named exactly as git's own flags. */
export type ResetMode = "soft" | "mixed" | "hard";

export type OpRequest =
  | {
      readonly kind: "checkout";
      readonly target: string;
      readonly mode: "switch" | "detach";
      /** §7.5's "discard" route: `git switch --discard-changes`. Cannot clear an untracked
       *  block (probe P9) — the UI never offers it for one. */
      readonly discardLocalChanges: boolean;
    }
  | {
      readonly kind: "branchCreate";
      readonly name: string;
      readonly startPoint: string;
      readonly checkout: boolean;
      readonly track: string | undefined;
    }
  | { readonly kind: "branchDelete"; readonly name: string; readonly force: boolean }
  | { readonly kind: "branchRename"; readonly from: string; readonly to: string }
  | {
      readonly kind: "tagCreate";
      readonly name: string;
      readonly target: string;
      /** Present ⇒ annotated (`-a -m`). Absent ⇒ lightweight. On `force`, an annotated tag
       *  MUST re-supply this or `-f` downgrades it to lightweight (probe P3). */
      readonly message: string | undefined;
      readonly force: boolean;
    }
  | { readonly kind: "tagDelete"; readonly name: string }
  | { readonly kind: "tagPush"; readonly remote: string; readonly names: readonly string[] | "all" }
  | { readonly kind: "tagDeleteRemote"; readonly remote: string; readonly name: string }
  | {
      readonly kind: "revert";
      readonly shas: readonly string[];
      readonly mainline: number | undefined;
      readonly noCommit: boolean;
    }
  | { readonly kind: "opContinue" }
  | { readonly kind: "opAbort" }
  | {
      readonly kind: "stashPush";
      /** Undefined → git's own `WIP on <branch>: …`. */
      readonly message: string | undefined;
      readonly includeUntracked: boolean;
      readonly keepIndex: boolean;
      /** Joined after a literal `--`. Empty ⇒ the whole worktree. */
      readonly paths: readonly string[];
    }
  /** `apply` accepts a raw sha, so this addresses by sha and needs no index guard (probe 8). */
  | { readonly kind: "stashApply"; readonly sha: string; readonly restoreIndex: boolean }
  /** `pop` REFUSES a raw sha, so the argv must use `stash@{index}` and the service verifies
   *  `rev-parse stash@{index} === sha` immediately before writing (probe 8). */
  | {
      readonly kind: "stashPop";
      readonly sha: string;
      readonly index: number;
      readonly restoreIndex: boolean;
    }
  | { readonly kind: "stashDrop"; readonly sha: string; readonly index: number }
  /** Addressed by `stash@{index}`: given a raw sha, `stash branch` applies but silently never
   *  drops (probe 8). */
  | {
      readonly kind: "stashBranch";
      readonly branch: string;
      readonly sha: string;
      readonly index: number;
    }
  | {
      readonly kind: "reset";
      readonly mode: ResetMode;
      /** A sha, always — resolved by the caller from the graph row. Never a ref name: the
       *  pre-flight resolved and counted against this exact object, and re-resolving a name
       *  host-side could move the target between advice and act. */
      readonly target: string;
      /** §7.7's typed confirmation, required (and re-checked host-side, hard part 2) exactly when
       *  `mode === "hard"` and the pre-flight's `destroys` was non-empty. The short sha of
       *  `target`, mirroring `ForcePushDialog`'s branch-name token (D19/D52). */
      readonly confirmToken: string | undefined;
    }
  | {
      readonly kind: "cherryPick";
      readonly sha: string;
      /** Required for a merge commit — probe 8: `is a merge but no -m option was given`. */
      readonly mainline: number | undefined;
      readonly noCommit: boolean;
    }
  /** §7.13/probe 6: the sequencer's own named remedy for an empty pick or revert — distinct from
   *  `opContinue`, which git refuses outright when `CHERRY_PICK_HEAD`/`REVERT_HEAD` is present but
   *  the change is already applied (`canSkip` is what the banner uses to know this is offered). */
  | { readonly kind: "opSkip" };

export type OpErrorKind =
  | "AuthFailed"
  | "NonFastForward"
  | "Conflict"
  | "DirtyWorktree"
  | "UntrackedWouldBeOverwritten"
  | "LockHeld"
  | "NotFound"
  | "AlreadyExists"
  | "NotFullyMerged"
  | "WorktreeConflict"
  | "OperationInProgress"
  | "RemoteRefMissing"
  | "HookRejected"
  /** P8: `git`'s own `(stale info)` — the bare `--force-with-lease` lease was violated because
   *  the remote moved and we never fetched it. Probe 1, rows 1-2. */
  | "LeaseViolation"
  /** P8: `git`'s own `(remote ref updated since checkout)` — `--force-if-includes` caught a
   *  remote move we DID fetch but have not integrated. Probe 1, row 3. Kept distinct from
   *  `LeaseViolation`: the remedies differ (fetch-and-look vs. you-already-saw-this). */
  | "RemoteRefUpdated"
  /** P8: a transport-level failure (`Could not resolve host`, `Connection refused/timed out`) —
   *  never git's own decision, always the network. */
  | "NetworkFailed"
  /** P8: the remote itself does not exist (`Repository not found`, "does not appear to be a
   *  git repository"). */
  | "RemoteNotFound"
  /** P8: neither git says this nor could it — the confirmation token `remote.run` requires for
   *  a protected-branch force-push/delete was absent or did not match (D52). */
  | "ProtectedBranch"
  /** P8: a remote op was cancelled mid-flight (D50) — never a git-reported failure either. */
  | "Cancelled"
  /** P9: a pop/apply merged with conflicts. Deliberately NOT detected from a stderr pattern — a
   *  conflicting pop writes to stdout and leaves stderr empty (probe 5) — `RepoService`
   *  classifies it from `exitCode !== 0` plus a post-op status read-back finding unmerged paths.
   *  The stash is ALWAYS kept (§7.6); the message says so. */
  | "StashConflict"
  /** P9: `apply --index`/`pop --index` onto an already-conflicted index —
   *  `error: conflicts in index. Try without --index.` (probe 10). Distinct from `StashConflict`
   *  because the remedy is different and git names it exactly: retry the same op with
   *  `restoreIndex: false`. */
  | "StashIndexConflict"
  /** P9: untracked files in the way of restoring the stash's own untracked half — the ONE
   *  non-atomic failure in the phase: the tracked half was already applied and the stash was
   *  kept (probe 3). */
  | "StashUntrackedCollision"
  /** P10 probe 6: `cherry-pick`/`revert` refused because the change is already present — nothing
   *  left to commit, and `--skip` (not `--continue`) is git's own remedy (`canSkip`). */
  | "EmptyCherryPick"
  /** P10: the typed confirmation a destructive `reset --hard` requires was absent or did not
   *  match, re-checked host-side. Deliberately NOT `ProtectedBranch` (D52's pattern is reused;
   *  its kind is not — the taxonomy should not claim a branch protection that does not exist). */
  | "ConfirmationRequired"
  /** P10 probe 2: cherry-picking/reverting a merge commit without `-m` — git's own
   *  `is a merge but no -m option was given`. */
  | "MainlineRequired"
  | "Unknown";

export interface UndoSlotSnapshot {
  readonly id: string;
  /** "Deleted branch feature" — §7.12's "labelled with what it will undo". */
  readonly label: string;
  /** "was d657c6e" — §7.12's "captured recovery sha is shown alongside the button". */
  readonly recoverySha: string;
  readonly createdAt: number;
}

export interface OpResult {
  readonly ok: boolean;
  readonly error: { readonly kind: OpErrorKind; readonly message: string } | undefined;
  /** The slot AFTER this op: a new record for an undoable op, `null` for any other (which
   *  clears it — §7.12's "performing another operation clears the undo slot"). */
  readonly undo: UndoSlotSnapshot | null;
  /** Read back after the op, success or failure — the reconcile step. */
  readonly head: HeadState;
  readonly inProgress: InProgressOperation | null;
}

// ---------------------------------------------------------------------------------------
// The gate (§7.11): "operations that git would refuse anyway" while an operation is in
// progress. Probed exhaustively — git refuses switch during merge/cherry-pick/rebase/revert,
// and would refuse reset and another revert; it does NOT refuse branch/tag creation. So the
// gate is scoped to exactly checkout and revert at P6, plus, at P9, stashPop/stashApply/
// stashBranch — `classifyStashPop` already emits an `inProgressOperation` blocker for these
// three, and GATED_OP_KINDS is what additionally makes the toolbar disable them. `stashPush`
// and `stashDrop` are deliberately NOT gated: stashing during a conflicted state is a
// legitimate escape hatch, and dropping touches only the stash stack, never the worktree.
// P10 probe 3 adds `reset`: git does NOT refuse `reset --mixed`/`--hard` mid-merge/mid-pick — it
// silently succeeds and abandons the sequencer state — so this gate is the ONLY thing standing
// between a user and that data loss, unlike every op above it, which merely mirrors git's own
// refusal. `cherryPick` is gated for the ordinary reason (git does refuse a second cherry-pick
// mid-sequence). `opSkip` is deliberately NOT gated: it is only ever offered *from within* the
// gated state itself (`canSkip`), never a way to bypass it.
// ---------------------------------------------------------------------------------------

const GATED_OP_KINDS: ReadonlySet<OpRequest["kind"]> = new Set([
  "checkout",
  "revert",
  "stashPop",
  "stashApply",
  "stashBranch",
  "reset",
  "cherryPick",
]);

/** Pure predicate over `(inProgress, opKind)` — no component may reimplement this as a chain of
 *  `v-if`s (W12's own "Done when"). */
export function canRunOp(
  inProgress: InProgressOperation | null,
  opKind: OpRequest["kind"],
): boolean {
  if (inProgress === null) return true;
  return !GATED_OP_KINDS.has(opKind);
}

const KIND_LABEL: Record<InProgressKind, string> = {
  merge: "Merging",
  cherryPick: "Cherry-picking",
  revert: "Reverting",
  rebase: "Rebasing",
  bisect: "Bisecting",
  unmergedOnly: "Unresolved conflict",
};

/** The one sentence naming an in-progress operation in the user's terms — shared by the banner
 *  and every gated control's disabled tooltip, so the two can never disagree about the reason
 *  (§7.11: "disabled with the banner as the explanation"). */
export function describeInProgress(op: InProgressOperation): string {
  if (op.kind === "rebase") {
    const branch = op.headName?.replace(/^refs\/heads\//, "");
    return branch ? `Rebasing ${branch}` : "Rebasing";
  }
  if (op.kind === "unmergedOnly") return "Unresolved conflict";
  const shortSha = op.otherSha ? ` \`${op.otherSha.slice(0, 7)}\`` : "";
  return `${KIND_LABEL[op.kind]}${shortSha}`;
}
