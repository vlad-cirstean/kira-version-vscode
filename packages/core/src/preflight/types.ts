/**
 * §7's pre-flight result shapes — pure data, produced by `checkout.ts` / `revert.ts` / `tag.ts`'s
 * classifiers and rendered as-is by the dialogs. `CheckoutPreflight` and `RevertPreflight` are
 * also the two the wire carries (`packages/ipc`'s structural copies); `TagCreatePreflight` never
 * crosses the wire — tag-name validation is cheap enough, and needs nothing but the already-
 * loaded ref list, to run client-side (`ui/src/state/ops.ts` imports `classifyTagCreate`
 * directly).
 */
import type { InProgressOperation } from "../model/operation.ts";
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

export type RevertPrediction =
  | { readonly kind: "clean" }
  | { readonly kind: "conflicts"; readonly paths: readonly string[] }
  | { readonly kind: "unknown"; readonly reason: string };

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

/** P9's autostash seam, empty at P8 (`docs/plans/P8.md`'s "Pull: decomposition and the strategy
 *  resolution order" — mirrors `CheckoutPreflight.routes`'s own precedent exactly). */
export type PullRoute = "stashAndCarry";

export type PullBlocker = "dirtyNonFastForward";

export interface PullPreflight {
  readonly strategy: PullStrategy;
  readonly source: PullStrategySource;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly dirty: boolean;
  /** Empty at P8 — see `PullRoute`'s own doc comment. */
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
