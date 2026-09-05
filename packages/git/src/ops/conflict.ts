/**
 * §7.11/§9's in-progress state reader, plus the `--continue`/`--abort` argv table (Ordering:
 * "The in-progress state machine" in `docs/plans/P6.md`). The reader is the one file in `ops/`
 * that is not a pure argv builder — it reads `.git`'s state files off disk and hands the result
 * to `classifyInProgress` (`core/src/model/operation.ts`) as plain data, which is what makes the
 * precedence table a named unit test per row instead of an integration-only fact.
 *
 * Three constraints, all from the plan:
 * 1. Reads the per-worktree `gitDir`, never `commonDir` — every one of these six files lives in
 *    the checked-out worktree's own git dir (`.git/worktrees/<name>/` for a linked one).
 *    `discovery.ts` already resolved this path at open.
 * 2. Plain `node:fs/promises` reads, no new port — a missing file is `undefined`/`false`, never
 *    a throw; a directory's presence is a `stat`-and-swallow.
 * 3. `rebase-merge/head-name` and `rebase-merge/onto` are read as content, trimmed, because the
 *    banner names the branch being rebased and §9's "report a rebase in progress" is empty
 *    without it.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { InProgressKind, InProgressStateFiles } from "@kira-version/core";

async function readTrimmed(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf-8");
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Reads all six state files (plus the two rebase-content reads) off `gitDir` in parallel — one
 *  `Promise.all`, not six sequential awaits, since these are independent stats/reads with no
 *  ordering dependency on each other. */
export async function readInProgressStateFiles(gitDir: string): Promise<InProgressStateFiles> {
  const [
    mergeHead,
    cherryPickHead,
    revertHead,
    bisectLog,
    rebaseMergeDir,
    rebaseApplyDir,
    rebaseHeadName,
    rebaseOnto,
    sequencerDir,
  ] = await Promise.all([
    readTrimmed(join(gitDir, "MERGE_HEAD")),
    readTrimmed(join(gitDir, "CHERRY_PICK_HEAD")),
    readTrimmed(join(gitDir, "REVERT_HEAD")),
    pathExists(join(gitDir, "BISECT_LOG")),
    pathExists(join(gitDir, "rebase-merge")),
    pathExists(join(gitDir, "rebase-apply")),
    readTrimmed(join(gitDir, "rebase-merge", "head-name")),
    readTrimmed(join(gitDir, "rebase-merge", "onto")),
    pathExists(join(gitDir, "sequencer")),
  ]);

  return {
    mergeHead,
    cherryPickHead,
    revertHead,
    bisectLog,
    rebaseMergeDir,
    rebaseApplyDir,
    rebaseHeadName,
    rebaseOnto,
    sequencerDir,
  };
}

/** The Ordering table's `--continue` column: `undefined` for the two kinds v1 never offers it
 *  for (`rebase` — §9's report-only instruction; `bisect` — nothing to continue) and for
 *  `unmergedOnly` (no state file at all to advance). The caller (`RepoService.runOp`, W8) treats
 *  `undefined` as "refuse before spawning", matching `InProgressOperation.canContinue`. */
export function continueArgs(kind: InProgressKind): string[] | undefined {
  switch (kind) {
    case "merge":
      return ["merge", "--continue"];
    case "cherryPick":
      return ["cherry-pick", "--continue"];
    case "revert":
      return ["revert", "--continue"];
    case "rebase":
    case "bisect":
    case "unmergedOnly":
      return undefined;
  }
}

/** The Ordering table's `--abort` column: every kind except `unmergedOnly` (there is no state
 *  file there for git to abort — `InProgressOperation.canAbort` is false for exactly that kind).
 *  `bisect`'s "abort" is `git bisect reset`, not `git bisect --abort` (bisect has no such flag). */
export function abortArgs(kind: InProgressKind): string[] | undefined {
  switch (kind) {
    case "merge":
      return ["merge", "--abort"];
    case "cherryPick":
      return ["cherry-pick", "--abort"];
    case "revert":
      return ["revert", "--abort"];
    case "rebase":
      return ["rebase", "--abort"];
    case "bisect":
      return ["bisect", "reset"];
    case "unmergedOnly":
      return undefined;
  }
}
