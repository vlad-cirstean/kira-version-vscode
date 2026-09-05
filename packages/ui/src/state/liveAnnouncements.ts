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
import type { CheckoutPreflight, OpErrorKind } from "@kira-version/ipc";

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
