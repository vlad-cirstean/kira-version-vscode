/**
 * `docs/plans/P10.md` §7.13's cherry-pick classifier — the direct structural sibling of
 * `classifyRevert`, with different blockers (probe 7): there is no blanket dirty-worktree
 * blocker here. Probe 7A found a clean pick proceeds even with an unrelated dirty file present,
 * so every blocker below is a set intersection against the picked commit's OWN paths (mirroring
 * `classifyCheckout`'s D∩T pattern), except `stagedChanges`, which git refuses no matter what it
 * touches (probe 7 B/D).
 */
import type { InProgressOperation } from "../model/operation.ts";
import type {
  CherryPickBlocker,
  CherryPickPreflight,
  MergeOutcomePrediction,
  RevertParentChoice,
} from "./types.ts";

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b);
  return a.filter((path) => set.has(path));
}

export function classifyCherryPick(input: {
  readonly sha: string;
  readonly subject: string;
  /** Empty ⇒ not a merge commit. */
  readonly mergeParents: readonly RevertParentChoice[];
  readonly mainline: number | undefined;
  /** The picked commit's own changed paths (`diff-tree --name-only -r <sha>^<m> <sha>`), split
   *  into "modified/deleted" and "added" — the two halves probe 7C and 7E intersect against. */
  readonly commitPaths: { readonly touched: readonly string[]; readonly added: readonly string[] };
  readonly dirty: {
    readonly staged: readonly string[];
    readonly unstaged: readonly string[];
    readonly untracked: readonly string[];
  };
  readonly prediction: MergeOutcomePrediction;
  readonly alreadyApplied: boolean;
  readonly inProgress: InProgressOperation | null;
  readonly detachedHead: boolean;
}): CherryPickPreflight {
  const mainlineRequired =
    input.mergeParents.length > 0 && input.mainline === undefined ? input.mergeParents : [];

  const blockers: CherryPickBlocker[] = [];
  if (input.inProgress !== null) {
    blockers.push({ kind: "inProgressOperation", operation: input.inProgress });
  }
  if (mainlineRequired.length > 0) {
    blockers.push({ kind: "mainlineRequired", parents: mainlineRequired });
  }
  if (input.dirty.staged.length > 0) {
    blockers.push({ kind: "stagedChanges", paths: input.dirty.staged });
  }
  const untrackedHit = intersect(input.dirty.untracked, input.commitPaths.added);
  if (untrackedHit.length > 0) {
    blockers.push({ kind: "untrackedWouldBeOverwritten", paths: untrackedHit });
  }
  const unstagedHit = intersect(input.dirty.unstaged, input.commitPaths.touched);
  if (unstagedHit.length > 0) {
    blockers.push({ kind: "localChangesWouldBeOverwritten", paths: unstagedHit });
  }

  const verdict: CherryPickPreflight["verdict"] =
    blockers.length > 0
      ? "blocked"
      : input.prediction.kind === "conflicts"
        ? "willConflict"
        : "clean";

  return {
    sha: input.sha,
    subject: input.subject,
    mainlineRequired,
    prediction: input.prediction,
    alreadyApplied: input.alreadyApplied,
    inProgress: input.inProgress,
    detachedHead: input.detachedHead,
    verdict,
    blockers,
  };
}
