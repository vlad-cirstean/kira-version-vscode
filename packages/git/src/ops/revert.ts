/**
 * §7.10's revert argv builder. One invocation for every sha in the request — §7.10's
 * all-or-nothing guarantee is `--abort` restoring the pre-revert state, not this file chunking
 * the list into several spawns. `--no-edit` always: v1 has no commit-message editor of its own
 * and `GIT_EDITOR=true` (W6) would otherwise accept whatever git's own default message is
 * silently — `--no-edit` states that choice in the argv itself rather than leaving it implicit
 * in an env var a reader of this file would not see.
 */

export function revertArgs(
  shas: readonly string[],
  opts: { mainline?: number; noCommit?: boolean } = {},
): string[] {
  return [
    "revert",
    "--no-edit",
    ...(opts.mainline !== undefined ? ["-m", String(opts.mainline)] : []),
    ...(opts.noCommit ? ["--no-commit"] : []),
    ...shas,
  ];
}
