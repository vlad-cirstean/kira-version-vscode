/**
 * `docs/plans/P10.md` §7.13's cherry-pick argv builder — mirrors `revertArgs` exactly, minus
 * `--no-edit` (a pick never opens a message editor to suppress in the first place; it reuses the
 * original commit's own message).
 */

export function cherryPickArgs(
  sha: string,
  opts: { mainline?: number; noCommit?: boolean } = {},
): string[] {
  const argv = ["cherry-pick"];
  if (opts.mainline !== undefined) argv.push("-m", String(opts.mainline));
  if (opts.noCommit) argv.push("--no-commit");
  argv.push(sha);
  return argv;
}
