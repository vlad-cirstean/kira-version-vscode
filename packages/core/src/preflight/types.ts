/**
 * §7's pre-flight result shapes — pure data, produced by `checkout.ts` / `revert.ts` / `tag.ts`'s
 * classifiers and rendered as-is by the dialogs. `CheckoutPreflight` and `RevertPreflight` are
 * also the two the wire carries (`packages/ipc`'s structural copies); `TagCreatePreflight` never
 * crosses the wire — tag-name validation is cheap enough, and needs nothing but the already-
 * loaded ref list, to run client-side (`ui/src/state/ops.ts` imports `classifyTagCreate`
 * directly).
 */
import type { InProgressOperation, ResetMode } from "../model/operation.ts";
import type { RefKind } from "../model/ref.ts";
import type { PullStrategy, PullStrategySource } from "../model/remote.ts";

/** One path from `status`, discriminated by whether it is tracked — the two halves §7.5 says
 *  produce different blockers and different remedies. */
export interface DirtyPath {
  readonly path: string;
  readonly tracked: boolean;
}

export type CheckoutBlocker =
  | { readonly kind: "blockedByTracked"; readonly paths: readonly string[] }
  | { readonly kind: "blockedByUntracked"; readonly paths: readonly string[] }
  | { readonly kind: "inProgressOperation"; readonly operation: InProgressOperation }
  | { readonly kind: "worktreeConflict"; readonly branch: string; readonly worktreePath: string };

export interface CheckoutPreflight {
  readonly target: { readonly kind: RefKind | "sha"; readonly name: string };
  /** True when the result is a detached HEAD: a tag, a raw sha, or an explicitly detached
   *  checkout of a remote-tracking ref. §7.9: checking out a tag "says plainly that it results
   *  in a detached HEAD". */
  readonly detaches: boolean;
  /** Set when the only way to land ON A BRANCH is to create one tracking a remote — the DWIM
   *  case (probe P7), surfaced as an explicit choice instead of happening silently. */
  readonly createsTracking: { readonly branch: string; readonly upstream: string } | undefined;
  /** D \ T: the local changes that will survive the switch. Empty on a clean tree. */
  readonly carried: readonly string[];
  /** Ordered: `inProgressOperation` first (it makes every other remedy moot), then
   *  `worktreeConflict`, then `blockedByUntracked`, then `blockedByTracked` — the dialog renders
   *  the first blocker as its headline and the rest as detail. */
  readonly blockers: readonly CheckoutBlocker[];
  /** "clean" = nothing local at all. "cleanCarry" = §7.5's carry case; still no prompt, but the
   *  confirmation copy differs and the UI announces what carried. */
  readonly verdict: "clean" | "cleanCarry" | "blocked";
  /** Which routes the UI may offer for a `blockedByTracked` verdict. P6 emits `["discard"]` (or
   *  `[]` when an untracked block is also present — discard cannot clear that, probe P9). P9
   *  adds `"stashAndCarry"` here rather than in the component (§7.5). */
  readonly routes: readonly ("discard" | "stashAndCarry")[];
}

export interface RevertParentChoice {
  readonly parentNumber: number; // 1-based, as `-m` takes it
  readonly sha: string;
  readonly subject: string;
}

/** One `merge-tree` outcome. Named for what it *is* now that two phases produce it — P6's revert
 *  prediction and P9's stash-pop prediction are the same three-armed shape from the same call.
 *  `RevertPrediction` stays as an alias so P6's imports are untouched (OQ11). */
export type MergeOutcomePrediction =
  | { readonly kind: "clean" }
  | { readonly kind: "conflicts"; readonly paths: readonly string[] }
  | { readonly kind: "unknown"; readonly reason: string };
export type RevertPrediction = MergeOutcomePrediction;

export interface RevertPreflight {
  readonly shas: readonly string[];
  /** Non-empty ⇒ the user MUST pick before the op is offered (§7.10: "rather than guessing
   *  -m 1"). One entry per merge commit among `shas` whose mainline is not already resolved. */
  readonly mainlineRequired: readonly {
    readonly sha: string;
    readonly parents: readonly RevertParentChoice[];
  }[];
  readonly dirtyPaths: readonly string[];
  readonly inProgress: InProgressOperation | null;
  /** §7.10's merge-tree prediction. Scoped to `shas[0]` — `predictedFor` says so, and the UI
   *  quotes it when `shas.length > 1`. */
  readonly prediction: RevertPrediction;
  readonly predictedFor: string | null;
  /** §7.10: allowed, with a note. Not a blocker. */
  readonly detachedHead: boolean;
  readonly verdict: "clean" | "willConflict" | "blocked";
  readonly blockers: readonly ("dirtyWorktree" | "inProgressOperation" | "mainlineRequired")[];
}

// ---------------------------------------------------------------------------------------
// P8 — pull and push pre-flight (§7.3/§7.4). Also the two the wire carries.
// ---------------------------------------------------------------------------------------

/** P9's autostash seam — empty at P8 (`docs/plans/P8.md`'s "Pull: decomposition and the strategy
 *  resolution order" — mirrors `CheckoutPreflight.routes`'s own precedent exactly); P9's
 *  `buildPullPreflight` offers it whenever `blockers` is non-empty, since `dirtyNonFastForward`
 *  is the only `PullBlocker` there is. */
export type PullRoute = "stashAndCarry";

export type PullBlocker = "dirtyNonFastForward";

export interface PullPreflight {
  readonly strategy: PullStrategy;
  readonly source: PullStrategySource;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly dirty: boolean;
  /** Empty through P8. P9's `buildPullPreflight` populates `["stashAndCarry"]` exactly when
   *  `blockers` is non-empty — see `PullRoute`'s own doc comment. */
  readonly routes: readonly PullRoute[];
  readonly blockers: readonly PullBlocker[];
}

export interface PushPreflight {
  readonly upstream: string | null;
  readonly wouldSetUpstream: boolean;
  readonly ahead: number;
  readonly behind: number;
  /** The remote-tracking sha the lease will be checked against — read here and shown in the
   *  dialog, so "you are about to overwrite <sha>" is a fact, not a guess. `null` when the
   *  remote-tracking ref does not exist yet (nothing to overwrite). */
  readonly remoteTip: string | null;
  /** The matched protected pattern, or `null` — never a bare boolean (D52's own reasoning,
   *  `matchProtectedBranch`'s doc comment). */
  readonly protectedBy: string | null;
  readonly fastForward: boolean;
}

/** Never wire-carried — see the file header. `existing`/`existingIsAnnotated` are what let the
 *  dialog phrase the "move it" confirmation and, for an annotated tag, refuse to proceed without
 *  a re-supplied message (probe P3: `git tag -f <name> <sha>` silently downgrades it). */
export interface TagCreatePreflight {
  readonly nameValid: boolean;
  readonly nameError: string | undefined;
  readonly exists: boolean;
  readonly existingIsAnnotated: boolean;
  readonly requiresAnnotationToPreserve: boolean;
  readonly verdict: "clean" | "invalidName" | "blockedByExisting" | "movesWithForce";
}

// ---------------------------------------------------------------------------------------
// P9 — stash pop / stash branch pre-flight (§7.6). Both are wire-carried.
// ---------------------------------------------------------------------------------------

/** §7.6's two pre-flight blockers, same D∩T pattern as `CheckoutBlocker` — `untrackedCollision`
 *  is non-atomic (probe 4: git restores the untracked files it *can*, then fails), while
 *  `localChangesWouldBeOverwritten` is atomic (probe 5: git refuses before touching anything). */
export type StashPopBlocker =
  | { readonly kind: "untrackedCollision"; readonly paths: readonly string[] }
  | { readonly kind: "localChangesWouldBeOverwritten"; readonly paths: readonly string[] }
  | { readonly kind: "inProgressOperation"; readonly operation: InProgressOperation };

export interface StashPopPreflight {
  readonly stashSha: string;
  readonly stashIndex: number;
  readonly targetSha: string;
  /** Always predicted with `--merge-base=<stash^>` (probe 2) — never omit this, see
   *  `MergeOutcomePrediction`'s own callers in `repoService.ts`. */
  readonly prediction: RevertPrediction;
  readonly blockers: readonly StashPopBlocker[];
  readonly verdict: "clean" | "willConflict" | "blocked";
}

/** `stash branch <name> <sha>` gets no pop prediction — checking out the stash's base then
 *  applying it against that same base is clean by construction (§7.6) — but it is still
 *  non-atomic on failure (OQ6: no auto-rollback), which is why this still has a `checkout`
 *  pre-flight nested in it: the branch-creation half can be blocked exactly like any checkout. */
export interface StashBranchPreflight {
  readonly name: {
    readonly valid: boolean;
    readonly error: string | undefined;
    readonly exists: boolean;
  };
  readonly checkout: CheckoutPreflight;
  readonly verdict: "clean" | "invalidName" | "blocked";
}

// ---------------------------------------------------------------------------------------
// P10 — reset and cherry-pick pre-flight (§7.7/§7.13). Both are wire-carried.
// ---------------------------------------------------------------------------------------

export interface ResetPreflight {
  /** Resolved sha of the target and its subject — the dialog names what it is moving TO. */
  readonly target: string;
  readonly targetSubject: string;
  readonly mode: ResetMode;
  readonly currentHead: string;
  /** `null` on a detached HEAD — §7.7's "moving nothing but HEAD" (hard part 8). */
  readonly branch: string | null;
  /** Both halves of `rev-list --count --left-right <target>...HEAD` in one spawn (probe 4).
   *  `leaving` is §7.7's stated count; `gaining` is what makes a diverged target legible. */
  readonly leaving: number;
  readonly gaining: number;
  /** Up to 10, from a second spawn, and only when `leaving > 0`. `leavingTruncated` when the
   *  real count exceeds the cap. */
  readonly leavingCommits: readonly { readonly sha: string; readonly subject: string }[];
  readonly leavingTruncated: boolean;
  readonly dirty: {
    readonly staged: readonly string[];
    readonly unstaged: readonly string[];
    readonly untracked: readonly string[];
  };
  /** Probe 1: what `--hard` will actually destroy — staged ∪ unstaged tracked paths ∪
   *  staged-but-uncommitted new files. **Excludes untracked and ignored files**, which `--hard`
   *  leaves alone. Empty for `soft`/`mixed`, always. */
  readonly destroys: readonly string[];
  readonly inProgress: InProgressOperation | null;
  /** hard part 2: `mode === "hard" && destroys.length > 0`. */
  readonly requiresTypedConfirmation: boolean;
  /** §7.7's "stash first", offered whenever `destroys` is non-empty. A stash-then-stop, NOT
   *  P9's `stashAndCarry` (hard part 3) — the union member name says so. */
  readonly routes: readonly "stashFirst"[];
  readonly verdict: "clean" | "destructive" | "blocked";
  readonly blockers: readonly ("inProgressOperation" | "unknownTarget")[];
}

export type CherryPickBlocker =
  | { readonly kind: "inProgressOperation"; readonly operation: InProgressOperation }
  | { readonly kind: "mainlineRequired"; readonly parents: readonly RevertParentChoice[] }
  /** Probe 7 B/D: git refuses ANY staged change, related to the pick or not. */
  | { readonly kind: "stagedChanges"; readonly paths: readonly string[] }
  /** Probe 7C: unstaged dirt ∩ the commit's own paths. Atomic — nothing is applied. */
  | { readonly kind: "localChangesWouldBeOverwritten"; readonly paths: readonly string[] }
  /** Probe 7E: untracked files ∩ the paths the commit adds. Also atomic, and refused even when
   *  the content is byte-identical. */
  | { readonly kind: "untrackedWouldBeOverwritten"; readonly paths: readonly string[] };

export interface CherryPickPreflight {
  readonly sha: string;
  readonly subject: string;
  /** Non-empty parents ⇒ the user MUST pick before the op is offered. Same shape and same
   *  producer (`revertMergeParents`) as `RevertPreflight.mainlineRequired` — probe 8. */
  readonly mainlineRequired: readonly RevertParentChoice[];
  /** ALWAYS predicted with `--merge-base=<sha>^<mainline|1>` — probe 2. Never omit it. */
  readonly prediction: MergeOutcomePrediction;
  /** `git merge-base --is-ancestor <sha> HEAD` — the change is already in this history, so the
   *  pick will be empty (probe 6). Advisory, not a blocker: picking it anyway is legal. */
  readonly alreadyApplied: boolean;
  readonly inProgress: InProgressOperation | null;
  readonly detachedHead: boolean;
  readonly verdict: "clean" | "willConflict" | "blocked";
  /** Ordered: `inProgressOperation`, `mainlineRequired`, `stagedChanges`,
   *  `untrackedWouldBeOverwritten`, `localChangesWouldBeOverwritten` — mirroring
   *  `classifyRevert`'s own "first blocker is the headline" convention. */
  readonly blockers: readonly CherryPickBlocker[];
}
