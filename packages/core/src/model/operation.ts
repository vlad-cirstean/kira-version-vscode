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
  | { readonly kind: "opAbort" };

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
// gate is scoped to exactly checkout and revert (reset/stash-pop join it at P9/P10, when
// `OpRequest` actually gains those members).
// ---------------------------------------------------------------------------------------

const GATED_OP_KINDS: ReadonlySet<OpRequest["kind"]> = new Set(["checkout", "revert"]);

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
