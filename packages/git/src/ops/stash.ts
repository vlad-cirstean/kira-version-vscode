/**
 * §7.6's argv table. The addressing split is not stylistic: `git stash pop`/`drop` REFUSE a raw
 * sha (`error: '<sha>' is not a stash reference`), and `git stash branch <name> <sha>` is worse —
 * it succeeds, applies the stash, and silently skips the drop (P9 probe 8). So every stack-
 * mutating argv here takes a stack *index*, never a sha, and `RepoService` (W8) verifies
 * immediately before writing that `stash@{index}` still resolves to the sha the request carried
 * (`stashRevParseArgs` below is that read).
 */

export function stashPushArgs(
  opts: {
    readonly message?: string;
    readonly includeUntracked?: boolean;
    readonly keepIndex?: boolean;
    readonly paths?: readonly string[];
  } = {},
): string[] {
  const argv = ["stash", "push"];
  if (opts.includeUntracked) argv.push("-u");
  if (opts.keepIndex) argv.push("--keep-index");
  if (opts.message !== undefined) argv.push("-m", opts.message);
  if (opts.paths?.length) argv.push("--", ...opts.paths);
  return argv;
}

/** `apply` accepts a raw sha (unlike `pop`/`drop`/`branch`) — it never mutates the stack, so
 *  there is nothing for an index to guard (P9 probe 8). */
export function stashApplyArgs(
  sha: string,
  opts: { readonly restoreIndex?: boolean } = {},
): string[] {
  return ["stash", "apply", ...(opts.restoreIndex ? ["--index"] : []), sha];
}

export function stashPopArgs(
  index: number,
  opts: { readonly restoreIndex?: boolean } = {},
): string[] {
  return ["stash", "pop", ...(opts.restoreIndex ? ["--index"] : []), stashRef(index)];
}

export function stashDropArgs(index: number): string[] {
  return ["stash", "drop", stashRef(index)];
}

export function stashBranchArgs(branch: string, index: number): string[] {
  return ["stash", "branch", branch, stashRef(index)];
}

/** The undo replay for a dropped stash (§7.12's own table row). `-m` is written VERBATIM as the
 *  new reflog subject, so the caller must pass the captured `%gs`, not `%s` (P9 probe 9) — see
 *  `parse/stash.ts`'s `STASH_FORMAT` doc comment. The entry comes back at `stash@{0}`, not at its
 *  old stack position — the undo announcement must say so rather than let the user discover it. */
export function stashStoreArgs(message: string, sha: string): string[] {
  return ["stash", "store", "-m", message, sha];
}

/** The pre-write guard every stack-mutating op runs immediately before writing: resolve
 *  `stash@{index}` and compare it to the sha the request carried. A mismatch means someone else
 *  changed the stack since the pre-flight read — `RepoService` turns that into an `earlyError`
 *  with no write spawned at all, rather than mutating the wrong entry (P9 probe 8). */
export function stashRevParseArgs(index: number): string[] {
  return ["rev-parse", stashRef(index)];
}

const stashRef = (index: number): string => `stash@{${index}}`;
