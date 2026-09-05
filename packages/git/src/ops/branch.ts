/**
 * §7.9's branch argv builders, plus the two undo-capture reads probe P4 settled: restoring a
 * deleted branch is a ref write (`update-ref`, done by the undo replay itself, not here) plus
 * whatever `branch.<name>.remote`/`.merge` config it had — `git branch -d` deletes the ref but
 * never touches that config, so it survives on disk and must be read BEFORE the delete (§7.12's
 * whole "capture before write" ordering, `RepoService.runOp`, W8).
 */

export function branchCreateArgs(
  name: string,
  startPoint: string,
  opts: { track?: string } = {},
): string[] {
  const argv = ["branch", name, startPoint];
  if (opts.track !== undefined) argv.push("-t", opts.track);
  return argv;
}

export function branchCreateAndSwitchArgs(name: string, startPoint: string): string[] {
  return ["switch", "-c", name, startPoint];
}

export function branchDeleteArgs(name: string, opts: { force?: boolean } = {}): string[] {
  return ["branch", opts.force ? "-D" : "-d", name];
}

export function branchRenameArgs(from: string, to: string): string[] {
  return ["branch", "-m", from, to];
}

/** Undo-capture read #1: does the branch even still resolve (it always will, immediately before
 *  a delete — this is what makes the *recovery* sha the one that existed right before the
 *  delete, not a stale guess). */
export function branchRevParseArgs(name: string): string[] {
  return ["rev-parse", "--verify", `refs/heads/${name}`];
}

/** Undo-capture read #2: every `branch.<name>.*` config line, verbatim — replayed back through
 *  `git config` on undo so `.remote`/`.merge` (and anything else a user set under that prefix)
 *  comes back exactly, not just the two keys probe P4 happened to name. A literal `.` in `name`
 *  is not escaped for regex purposes here — `--get-regexp` treats the whole pattern as a POSIX
 *  ERE, but a branch name containing regex metacharacters only widens the match (matching a
 *  config section that merely starts the same), never narrows it to miss the real one, and the
 *  replay path (`config --add`) uses the returned key verbatim rather than reconstructing it. */
export function branchConfigRegexpArgs(name: string): string[] {
  return ["config", "--get-regexp", `^branch\\.${name}\\.`];
}
