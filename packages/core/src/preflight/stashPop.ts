/**
 * §7.6's stash-pop classifier, plus `stash branch`'s own composed one. Pure — every set the
 * classifier intersects is read by the caller (a real spawn each), never computed here.
 */
import type { InProgressOperation } from "../model/operation.ts";
import type { StashEntry } from "../model/stash.ts";
import { validateRefName } from "./tag.ts";
import type {
  CheckoutPreflight,
  DirtyPath,
  MergeOutcomePrediction,
  StashBranchPreflight,
  StashPopBlocker,
  StashPopPreflight,
} from "./types.ts";

export function classifyStashPop(input: {
  readonly stash: StashEntry;
  readonly targetSha: string;
  /** From `predictMerge(driver, target, stash.sha, {mergeBase: stash.baseSha})` — computed by the
   *  caller because it needs a spawn. Always predicted with `--merge-base=<stash^>` (probe 2);
   *  there is no variant of this classifier that accepts a prediction computed without it. */
  readonly prediction: MergeOutcomePrediction;
  /** Paths the stash changes (tracked half), from `stash show --name-only`. */
  readonly stashPaths: readonly string[];
  /** `ls-tree -r --name-only <stash>^3`, empty when `-u` was not used (probe 1). */
  readonly stashUntrackedPaths: readonly string[];
  /** From `status --porcelain=v2` — the same `DirtyPath[]` §7.5 already builds. */
  readonly dirty: readonly DirtyPath[];
  /** Which of `stashUntrackedPaths` currently exist in the worktree. A path can collide while
   *  being neither tracked nor reported dirty — an ignored file, or one status elides — so
   *  membership in `dirty` is NOT a sufficient test (probe 3). */
  readonly existingPaths: readonly string[];
  readonly inProgress: InProgressOperation | null;
}): StashPopPreflight {
  const existingSet = new Set(input.existingPaths);
  const untrackedCollisionPaths = input.stashUntrackedPaths.filter((p) => existingSet.has(p));

  const dirtyTrackedSet = new Set(input.dirty.filter((d) => d.tracked).map((d) => d.path));
  const localOverwritePaths = input.stashPaths.filter((p) => dirtyTrackedSet.has(p));

  // Ordered exactly like `CheckoutBlocker`'s own documented ordering: `inProgressOperation` first
  // (it moots every other remedy), then `untrackedCollision`, then
  // `localChangesWouldBeOverwritten`.
  const blockers: StashPopBlocker[] = [];
  if (input.inProgress !== null) {
    blockers.push({ kind: "inProgressOperation", operation: input.inProgress });
  }
  if (untrackedCollisionPaths.length > 0) {
    blockers.push({ kind: "untrackedCollision", paths: untrackedCollisionPaths });
  }
  if (localOverwritePaths.length > 0) {
    blockers.push({
      kind: "localChangesWouldBeOverwritten",
      paths: localOverwritePaths,
    });
  }

  // `unknown` is never `clean` — the UI states the reason and lets the user proceed, exactly as
  // P6's revert dialog does for the same prediction shape.
  const verdict: StashPopPreflight["verdict"] =
    blockers.length > 0 ? "blocked" : input.prediction.kind === "clean" ? "clean" : "willConflict";

  return {
    stashSha: input.stash.sha,
    stashIndex: input.stash.index,
    targetSha: input.targetSha,
    prediction: input.prediction,
    blockers,
    verdict,
  };
}

/**
 * `stash branch <name> <sha>` creates the branch AT THE STASH'S OWN BASE, then applies the stash
 * against that same base — so the apply half is clean by construction and gets no merge-tree
 * prediction (probe 11's own finding; a later reader adding one back would be solving a problem
 * that cannot occur). What CAN fail is the branch-creation half, exactly like any other checkout —
 * hence the composed `CheckoutPreflight` here, not a bespoke set of blockers.
 */
export function classifyStashBranch(input: {
  readonly name: string;
  readonly existingBranchNames: ReadonlySet<string>;
  readonly checkout: CheckoutPreflight;
}): StashBranchPreflight {
  const { valid, error } = validateRefName(input.name);
  const exists = input.existingBranchNames.has(input.name);

  if (!valid) {
    return {
      name: { valid: false, error, exists },
      checkout: input.checkout,
      verdict: "invalidName",
    };
  }
  if (exists) {
    return {
      name: { valid: true, error: "A branch with this name already exists.", exists },
      checkout: input.checkout,
      verdict: "invalidName",
    };
  }

  const verdict: StashBranchPreflight["verdict"] =
    input.checkout.blockers.length > 0 ? "blocked" : "clean";

  return {
    name: { valid: true, error: undefined, exists },
    checkout: input.checkout,
    verdict,
  };
}
