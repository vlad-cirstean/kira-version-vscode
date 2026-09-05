/**
 * §7.5's checkout argv builders, plus the one read the classifier needs (T — the paths the
 * checkout would rewrite). No policy: every decision about *whether* to run these, and with
 * which mode, was made by `core/src/preflight/checkout.ts` — this file only shapes the spawn.
 *
 * `--no-guess` on every `switch` (probe P7, judgment call 3): without it, `git switch topic`
 * silently creates a local branch tracking `origin/topic` when only the remote-tracking ref
 * exists. `CheckoutPreflight.createsTracking` turns that same case into a labelled choice
 * instead, so this file must never let git make it silently.
 */

/** `git switch --no-guess <branch>`, with `--discard-changes` when the chosen route is discard
 *  (§7.5's `blockedByTracked` remedy — never offered for an untracked block, probe P9). */
export function switchArgs(branch: string, opts: { discard?: boolean } = {}): string[] {
  return opts.discard
    ? ["switch", "--no-guess", "--discard-changes", branch]
    : ["switch", "--no-guess", branch];
}

/** `git switch --detach <target>` — a tag, a raw sha, or an explicitly detached remote-tracking
 *  checkout (`CheckoutPreflight.detaches`). `--no-guess` has no effect on `--detach` (there is
 *  nothing to guess a branch name from) but costs nothing to keep for a uniform argv shape. */
export function switchDetachArgs(target: string): string[] {
  return ["switch", "--detach", target];
}

/** T: the paths `<target>`'s checkout would rewrite relative to HEAD — a read, never a write.
 *  `-z` for the same NUL-safe framing every other path-list read in this package uses. */
export function rewrittenPathsArgs(target: string): string[] {
  return ["diff", "--name-only", "-z", "HEAD", target];
}
