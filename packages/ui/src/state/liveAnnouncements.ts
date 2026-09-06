/**
 * `docs/plans/P4.md` W14's "one polite live region" — pure text composition for the two events it
 * announces (Load-more's own doc comment in `LoadMoreButton.vue` names both: "the Load-more result
 * ... and Refresh completion"). Kept separate from `App.vue`, which only owns *when* to set the
 * region's text (watching `GraphViewState.loading`'s transitions back to `"idle"`), so the exact
 * wording is unit-testable on its own, the same split `rowAccessibility.ts` makes for a row's
 * accessible name.
 *
 * `docs/plans/P6.md` W12 adds the op-outcome half: every announcement `ops.ts` produces — success
 * or failure — is composed here too, per that phase's own rule that a destructive action which
 * silently does nothing is the same failure mode §6.4 already named for the clipboard.
 */
import type {
  CheckoutPreflight,
  OpErrorKind,
  OpResult,
  ResetMode,
  StashEntry,
} from "@kira-version/ipc";

const COUNT_FORMATTER = new Intl.NumberFormat();

/** `LoadMoreButton.vue`'s own `fmt` helper, duplicated rather than imported: that one is a private
 *  detail of a `.vue` SFC's `<script setup>` block, not an exported function, and both call sites
 *  want the same "grouped thousands" formatting the plan's own example ("5,000 more loaded,
 *  122,400 remaining") shows. */
export function formatCount(count: number): string {
  return COUNT_FORMATTER.format(count);
}

/** The plan's own worked example, generalized: "N more loaded, M remaining" — or, once the
 *  history is fully loaded, "N more loaded, history fully loaded" rather than "0 remaining",
 *  which reads as if nothing happened. */
export function composeLoadMoreAnnouncement(
  added: number,
  remaining: number,
  exhausted: boolean,
): string {
  const addedText = `${formatCount(added)} more loaded`;
  return exhausted
    ? `${addedText}, history fully loaded`
    : `${addedText}, ${formatCount(remaining)} remaining`;
}

/** §6.2's refresh action, completed: a keyboard user who cannot see the toolbar spinner stop has
 *  no other way to learn a refresh finished (or how many commits it re-walked). */
export function composeRefreshAnnouncement(totalLoaded: number): string {
  const noun = totalLoaded === 1 ? "commit" : "commits";
  return `Refreshed — ${formatCount(totalLoaded)} ${noun} loaded`;
}

/** A short name for `target`, the way every P6 confirmation reads it: a raw sha is shortened,
 *  anything else (a branch, tag, or remote-branch name) is shown exactly as given. */
function shortTarget(target: string): string {
  return /^[0-9a-f]{20,40}$/i.test(target) ? target.slice(0, 7) : target;
}

/** §7.5's own two silent-success verdicts, given a voice: `cleanCarry` is "proceed with no
 *  prompt", not "proceed with no acknowledgement" — the carried files are still worth a sentence,
 *  just not a dialog. */
export function composeCheckoutAnnouncement(preflight: CheckoutPreflight, target: string): string {
  const where = preflight.detaches ? `${shortTarget(target)} (detached)` : shortTarget(target);
  if (preflight.verdict === "cleanCarry") {
    const n = preflight.carried.length;
    return `Checked out ${where} — ${n} local ${n === 1 ? "change" : "changes"} carried over`;
  }
  return `Checked out ${where}`;
}

/** §7.10: a `noCommit` revert stages rather than commits, and the toolbar's live region is the
 *  only way a keyboard/screen-reader user learns which one just happened. */
export function composeRevertAnnouncement(shas: readonly string[], noCommit: boolean): string {
  const subject =
    shas.length === 1 ? `commit ${shortTarget(shas[0] ?? "")}` : `${shas.length} commits`;
  return noCommit ? `Reverted ${subject} — changes staged, not committed` : `Reverted ${subject}`;
}

/** `docs/plans/P10.md` W10: §7.7's own reset, given a voice — the target's subject is not carried
 *  here (the live region names *what was done*, not the full advisory the dialog already showed
 *  and the user already read before confirming). */
export function composeResetAnnouncement(mode: ResetMode, target: string): string {
  return `Reset (${mode}) to ${shortTarget(target)}`;
}

/** `docs/plans/P10.md` W10, §7.10's own `noCommit` wording reused verbatim for cherry-pick
 *  (§7.13 states the same "staged, not committed" outcome for `--no-commit`). */
export function composeCherryPickAnnouncement(sha: string, noCommit: boolean): string {
  const subject = `commit ${shortTarget(sha)}`;
  return noCommit
    ? `Cherry-picked ${subject} — changes staged, not committed`
    : `Cherry-picked ${subject}`;
}

/** `docs/plans/P10.md` W10, hard part 7's own answer, given a voice: `CherryPickPreflight`'s
 *  `merge-tree` prediction inherits D57's whole posture (P9's own stash-pop precedent) — exact
 *  about the merge, reconciled after the fact by `runOp`'s read-back, never swallowed. No
 *  `stashKept` half exists here (unlike `StashPredictionMismatch`): a cherry-pick never touches
 *  the stash, so this is its own, one-field-simpler shape rather than a forced reuse. */
export interface CherryPickPredictionMismatch {
  readonly predicted: "clean" | "conflicts";
  readonly actual: "clean" | "conflicts" | "refused";
}

export function composeCherryPickMismatchAnnouncement(
  mismatch: CherryPickPredictionMismatch,
): string {
  const predictedText = mismatch.predicted === "clean" ? "a clean apply" : "conflicts";
  const actualText =
    mismatch.actual === "clean"
      ? "applied cleanly"
      : mismatch.actual === "conflicts"
        ? "conflicted"
        : "was refused";
  return (
    `This cherry-pick ${actualText}, though the pre-flight predicted ${predictedText} — the tree ` +
    "changed in between."
  );
}

const OP_ERROR_TEXT: Record<OpErrorKind, string> = {
  AuthFailed: "authentication failed",
  NonFastForward: "not a fast-forward",
  Conflict: "conflicts need resolving",
  DirtyWorktree: "the working tree has local changes",
  UntrackedWouldBeOverwritten: "untracked files would be overwritten",
  LockHeld: "the repository is locked by another process",
  NotFound: "not found",
  AlreadyExists: "already exists",
  NotFullyMerged: "not fully merged",
  WorktreeConflict: "checked out in another worktree",
  OperationInProgress: "another operation is in progress",
  RemoteRefMissing: "the remote ref is missing",
  HookRejected: "a hook rejected it",
  LeaseViolation: "the remote moved since it was last checked",
  RemoteRefUpdated: "the remote moved since it was last fetched",
  NetworkFailed: "a network error occurred",
  RemoteNotFound: "the remote repository was not found",
  ProtectedBranch: "the branch is protected",
  Cancelled: "it was cancelled",
  StashConflict: "it merged with conflicts — the stash was kept",
  StashIndexConflict: "the index already has conflicts — try again without restoring it",
  StashUntrackedCollision: "untracked files were in the way — the stash was kept",
  ConfirmationRequired: "the typed confirmation was missing or did not match",
  EmptyCherryPick: "this change is already present on this branch",
  MainlineRequired: "a merge commit needs a parent chosen first",
  Unknown: "an unexpected error occurred",
};

/** Every op failure the live region reports — including one that never reached git at all (a
 *  gated action, `op.run`'s own guard) — reads the same way: what was attempted, then why it
 *  didn't happen. A silent failure is the clipboard's own failure mode (§6.4), applied here. */
export function composeOpFailureAnnouncement(
  action: string,
  error: { readonly kind: OpErrorKind; readonly message: string } | undefined,
): string {
  if (!error) return `${action} failed.`;
  return `${action} failed — ${OP_ERROR_TEXT[error.kind]}.`;
}

/** `docs/plans/P9.md` W13: git's own `No local changes to save` no-op (probe 10) exits 0 with no
 *  error, so a plain "succeeded" announcement would be the silent-no-op failure mode §6.4 already
 *  named for the clipboard — `pushed` is `ops.ts`'s own before/after stash-count comparison,
 *  the only way to tell the two outcomes apart. */
export function composeStashPushAnnouncement(pushed: boolean): string {
  return pushed ? "Changes stashed" : "Nothing to stash — the working tree matched HEAD";
}

/** §7.6's concrete answer to hard part 1: non-null only when an executed pop/apply disagreed with
 *  the prediction the user was shown (a race between pre-flight and write, or a gap pre-flight
 *  could not see — never a false positive, since `composeStashAnnouncement` never compares at all
 *  when the prediction itself was `"unknown"`). `stashKept` is a fact for every failure mode P9
 *  probed (conflict, untracked collision, local-overwrite refusal) — the stash always survives —
 *  except a genuinely CLEAN `pop` (as opposed to `apply`), which removes it exactly as intended
 *  even when that clean outcome is itself the surprise (`predicted: "conflicts"`). */
export interface StashPredictionMismatch {
  readonly predicted: "clean" | "conflicts";
  readonly actual: "clean" | "conflicts" | "refused";
  readonly stashKept: boolean;
}

const STASH_DROP_UNDO_LABEL_PREFIX = "Dropped stash@{";

/** `docs/plans/P9.md` W15: undoing a dropped stash does not restore it to its old stack position
 *  — probe 9 found it always lands back at `stash@{0}` — so the generic "Undone: `<label>`" text
 *  would read as if `stash@{2}` (say) came back exactly as it was, which a user watching for that
 *  position would take as a sign the undo failed. Detected from the slot's own `label` rather
 *  than a dedicated field: `UndoSlotSnapshot` carries no "kind" to switch on, and
 *  `RepoService`'s stash-drop undo capture is the only call site that ever begins a label this
 *  way (mirrored exactly in the harness's own mock bridge). */
export function composeUndoAnnouncement(label: string): string {
  return label.startsWith(STASH_DROP_UNDO_LABEL_PREFIX)
    ? "Restored as stash@{0}"
    : `Undone: ${label}`;
}

/** §7.6's own worked example, given a voice: *"This pop conflicted, though the pre-flight
 *  predicted a clean apply — the tree changed in between. Your stash was kept."* A `mismatch`
 *  takes priority over the plain success/failure text — it is the more specific, more surprising
 *  fact, and staying silent about it (rendering only the generic failure text `StashConflict`
 *  already has in `OP_ERROR_TEXT`) is exactly the "silently rendering the outcome" §7.6 rules
 *  out. With no mismatch, this reads exactly like `composeOpFailureAnnouncement`'s own output for
 *  a failure, or a short "Applied"/"Popped" sentence for a plain, agreeing success. */
export function composeStashAnnouncement(
  verb: "apply" | "pop",
  entry: StashEntry,
  result: OpResult,
  mismatch: StashPredictionMismatch | null,
): string {
  const label = `stash@{${entry.index}}`;
  const actionLabel = verb === "apply" ? "Stash apply" : "Stash pop";
  if (mismatch) {
    const predictedText = mismatch.predicted === "clean" ? "a clean apply" : "conflicts";
    const actualText =
      mismatch.actual === "clean"
        ? "applied cleanly"
        : mismatch.actual === "conflicts"
          ? "conflicted"
          : "was refused";
    const keptText = mismatch.stashKept ? " Your stash was kept." : "";
    return (
      `This ${verb} ${actualText}, though the pre-flight predicted ${predictedText} — the tree ` +
      `changed in between.${keptText}`
    );
  }
  if (!result.ok) return composeOpFailureAnnouncement(actionLabel, result.error);
  return verb === "apply" ? `Applied ${label}` : `Popped ${label}`;
}
