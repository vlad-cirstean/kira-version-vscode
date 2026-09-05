/**
 * §7.5's checkout classifier — a *set intersection*, not a merge simulation (see `docs/plans/P6.md`'s
 * "The hard parts": probe P1/2c shows a byte-identical local edit is still refused by git, which
 * rules out a content-aware predictor as wrong, not merely unnecessary work).
 *
 *   D = dirty paths (tracked + untracked)              — from `status`
 *   T = paths the checkout would rewrite                — `git diff --name-only -z HEAD <target>`
 *   D ∩ T = ∅  → clean carry, no prompt
 *   D ∩ T ≠ ∅  → blocked, naming the exact files
 */
import type { InProgressOperation } from "../model/operation.ts";
import type { RefKind } from "../model/ref.ts";
import type { CheckoutBlocker, CheckoutPreflight, DirtyPath } from "./types.ts";

export function classifyCheckout(input: {
  readonly target: { readonly kind: RefKind | "sha"; readonly name: string };
  /** The wire request's own explicit choice (`preflight.checkout`'s `mode`) — "detach" is what
   *  turns an otherwise-trackable remote branch into a plain detached checkout with no tracking
   *  branch created (§7.9's row-menu "checkout this commit" always sends "detach"; the branch
   *  picker's plain checkout entry always sends "switch"). Not derivable from `target.kind`
   *  alone: a `remoteBranch` target can go either way depending on which the user asked for. */
  readonly mode: "switch" | "detach";
  readonly dirty: readonly DirtyPath[];
  /** T: paths the checkout would rewrite (`git diff --name-only -z HEAD <target>`). */
  readonly rewritten: readonly string[];
  /** Reserved for a future caller with a real target-tree path set (a stash pop, a reset). Always
   *  `null` at P6 — the untracked test uses `rewritten` alone (see the file-level comment in
   *  `docs/plans/P6.md`'s W2 section: every path in `T` is, by construction, one the target tree
   *  either changes or adds, so "in `T`" and "in the target tree" coincide for this caller). */
  readonly targetTreePaths: ReadonlySet<string> | null;
  readonly inProgress: InProgressOperation | null;
  /** D12: set when the target ref is checked out in a linked worktree that is NOT this session's
   *  own — the absolute path of that worktree. */
  readonly checkedOutIn: string | undefined;
  /** false at P6; P9 flips it once stash-and-carry exists. */
  readonly stashAvailable: boolean;
}): CheckoutPreflight {
  const rewrittenSet = new Set(input.rewritten);
  const trackedBlocked = input.dirty
    .filter((d) => d.tracked && rewrittenSet.has(d.path))
    .map((d) => d.path);
  const untrackedBlocked = input.dirty
    .filter((d) => !d.tracked && rewrittenSet.has(d.path))
    .map((d) => d.path);
  const carried = input.dirty.filter((d) => !rewrittenSet.has(d.path)).map((d) => d.path);

  const blockers: CheckoutBlocker[] = [];
  if (input.inProgress !== null) {
    blockers.push({ kind: "inProgressOperation", operation: input.inProgress });
  }
  if (input.checkedOutIn !== undefined) {
    blockers.push({
      kind: "worktreeConflict",
      branch: input.target.name,
      worktreePath: input.checkedOutIn,
    });
  }
  if (untrackedBlocked.length > 0) {
    blockers.push({ kind: "blockedByUntracked", paths: untrackedBlocked });
  }
  if (trackedBlocked.length > 0) {
    blockers.push({ kind: "blockedByTracked", paths: trackedBlocked });
  }

  const verdict: CheckoutPreflight["verdict"] =
    blockers.length > 0 ? "blocked" : carried.length > 0 ? "cleanCarry" : "clean";

  // Discard cannot clear an untracked block (probe P9) — if one is present, no route helps,
  // regardless of whether a tracked block is present alongside it.
  const routes: CheckoutPreflight["routes"] =
    trackedBlocked.length > 0 && untrackedBlocked.length === 0
      ? input.stashAvailable
        ? ["discard", "stashAndCarry"]
        : ["discard"]
      : [];

  // A tag or a raw sha always detaches regardless of the requested mode (git itself refuses a
  // plain `switch` to either); a branch or remote-branch target detaches only when the caller
  // explicitly asked for "detach" mode (§7.9's row-menu "checkout this commit"). Tracking-branch
  // creation is the DWIM-avoidance path for a *default* checkout of a bare remote ref — an
  // explicit detach is asking to skip landing on a branch at all, so no tracking branch is
  // created even though the target is a `remoteBranch`.
  const detaches =
    input.mode === "detach" || input.target.kind === "tag" || input.target.kind === "sha";
  const createsTracking =
    input.mode === "switch" && input.target.kind === "remoteBranch"
      ? { branch: stripRemotePrefix(input.target.name), upstream: input.target.name }
      : undefined;

  return {
    target: input.target,
    detaches,
    createsTracking,
    carried,
    blockers,
    verdict,
    routes,
  };
}

/** `origin/topic` → `topic`. A heuristic (a remote name with a slash in it defeats it), good
 *  enough because the label always states which branch it will create rather than acting on the
 *  guess silently (judgment call 3). */
function stripRemotePrefix(remoteBranchName: string): string {
  const slash = remoteBranchName.indexOf("/");
  return slash === -1 ? remoteBranchName : remoteBranchName.slice(slash + 1);
}
