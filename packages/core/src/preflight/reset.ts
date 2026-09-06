/**
 * `docs/plans/P10.md` §7.7's reset classifier. Unlike `classifyRevert`/`classifyCheckout`, there
 * is no dirty-worktree blocker here at all — a dirty tree is exactly what `soft`/`mixed` are FOR
 * (probe 1), and `hard`'s destruction of it is `destroys` plus `requiresTypedConfirmation`, an
 * advisory the dialog surfaces, not a refusal. The only real blockers are an in-progress operation
 * (probe 3: git does not refuse a mid-merge reset on its own, so this classifier is the one place
 * that does) and an unresolved target.
 */
import type { InProgressOperation, ResetMode } from "../model/operation.ts";
import type { ResetPreflight } from "./types.ts";

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

export function classifyReset(input: {
  readonly target: string;
  readonly targetSubject: string;
  readonly mode: ResetMode;
  readonly currentHead: string;
  readonly branch: string | null;
  readonly leaving: number;
  readonly gaining: number;
  readonly leavingCommits: readonly { readonly sha: string; readonly subject: string }[];
  readonly leavingTruncated: boolean;
  readonly dirty: {
    readonly staged: readonly string[];
    readonly unstaged: readonly string[];
    readonly untracked: readonly string[];
  };
  /** Staged-but-uncommitted NEW files (status `A.`/`A?`) — probe 1's third finding: `--hard`
   *  destroys these, though they look untracked to a naive reading. */
  readonly stagedNew: readonly string[];
  readonly inProgress: InProgressOperation | null;
  readonly targetResolves: boolean;
}): ResetPreflight {
  const destroys =
    input.mode === "hard"
      ? unique([...input.dirty.staged, ...input.dirty.unstaged, ...input.stagedNew])
      : [];
  const requiresTypedConfirmation = input.mode === "hard" && destroys.length > 0;

  const blockers: Array<"inProgressOperation" | "unknownTarget"> = [];
  if (input.inProgress !== null) blockers.push("inProgressOperation");
  if (!input.targetResolves) blockers.push("unknownTarget");

  const verdict: ResetPreflight["verdict"] =
    blockers.length > 0 ? "blocked" : destroys.length > 0 ? "destructive" : "clean";

  return {
    target: input.target,
    targetSubject: input.targetSubject,
    mode: input.mode,
    currentHead: input.currentHead,
    branch: input.branch,
    leaving: input.leaving,
    gaining: input.gaining,
    leavingCommits: input.leaving > 0 ? input.leavingCommits : [],
    leavingTruncated: input.leaving > 0 && input.leavingTruncated,
    dirty: input.dirty,
    destroys,
    inProgress: input.inProgress,
    requiresTypedConfirmation,
    routes: destroys.length > 0 ? ["stashFirst"] : [],
    verdict,
    blockers,
  };
}
