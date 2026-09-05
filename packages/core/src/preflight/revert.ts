/**
 * §7.10's revert classifier. Every merge among `shas` needs an explicit mainline (§7.10: "rather
 * than guessing -m 1"); the dirty tree and any in-progress operation block; a detached HEAD is a
 * note, not a blocker; the `merge-tree --merge-base` prediction (`git/src/parse/mergeTree.ts`)
 * is scoped to `shas[0]` and `predictedFor` says so.
 */
import type { InProgressOperation } from "../model/operation.ts";
import type { RevertParentChoice, RevertPreflight, RevertPrediction } from "./types.ts";

export function classifyRevert(input: {
  readonly shas: readonly string[];
  /** Parent lists for every MERGE commit among `shas` (a non-merge has no entry here) — every
   *  parent's sha and subject, so the picker never re-queries. */
  readonly mergeParents: ReadonlyMap<string, readonly RevertParentChoice[]>;
  /** The single mainline number already chosen for this whole invocation (git's `-m` is one flag
   *  for the entire multi-sha revert), or `undefined` if none has been chosen yet. */
  readonly mainline: number | undefined;
  readonly dirtyPaths: readonly string[];
  readonly inProgress: InProgressOperation | null;
  readonly detachedHead: boolean;
  /** The `merge-tree` prediction for `shas[0]` only. */
  readonly prediction: RevertPrediction;
}): RevertPreflight {
  const mainlineRequired =
    input.mainline === undefined
      ? input.shas
          .filter((sha) => input.mergeParents.has(sha))
          .map((sha) => ({ sha, parents: input.mergeParents.get(sha) ?? [] }))
      : [];

  const blockers: Array<"dirtyWorktree" | "inProgressOperation" | "mainlineRequired"> = [];
  if (input.inProgress !== null) blockers.push("inProgressOperation");
  if (mainlineRequired.length > 0) blockers.push("mainlineRequired");
  if (input.dirtyPaths.length > 0) blockers.push("dirtyWorktree");

  const verdict: RevertPreflight["verdict"] =
    blockers.length > 0 ? "blocked" : input.prediction.kind === "conflicts" ? "willConflict" : "clean";

  return {
    shas: input.shas,
    mainlineRequired,
    dirtyPaths: input.dirtyPaths,
    inProgress: input.inProgress,
    prediction: input.prediction,
    predictedFor: input.shas.length > 0 ? (input.shas[0] ?? null) : null,
    detachedHead: input.detachedHead,
    verdict,
    blockers,
  };
}
