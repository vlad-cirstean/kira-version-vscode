/**
 * P8/W8 — `git push`'s argv, in three flavors: plain, lease-based force, and plain `--force`.
 * `parseRefUpdates` (`fetch.ts`) is reused verbatim for push's own trailing ref-update line —
 * the same `To <url>` / per-ref-line shape fetch's `From <url>` block has (probe 1 row 4's
 * `+ 3a55c77...d462520 main -> main (forced update)` is exactly this parser's forced case).
 *
 * Every flavor uses the **explicit refspec** `<branch>:<branch>`, never a bare `<branch>` —
 * §4.1's config-fidelity rule is about *respecting* `push.default`, not about letting it silently
 * redirect a destructive operation out from under an explicit choice the user just made.
 */

export function pushArgs(params: {
  readonly remote: string;
  readonly branch: string;
  readonly setUpstream: boolean;
}): string[] {
  const args = ["push", "--progress"];
  if (params.setUpstream) args.push("--set-upstream");
  args.push(params.remote, `${params.branch}:${params.branch}`);
  return args;
}

/**
 * D48: bare `--force-with-lease --force-if-includes`, never an explicit
 * `--force-with-lease=<ref>:<sha>` — an explicit expected sha satisfies the lease on its own and
 * makes `--force-if-includes` inert (probe 1), which is precisely the hazard `--force-if-includes`
 * exists to close. The residual "background fetch silently satisfies the lease between dialog-open
 * and spawn" hazard §7.4 worried about is mitigated instead by re-reading and comparing the
 * remote-tracking tip immediately before this spawns (`core/src/preflight/push.ts`'s own doc
 * comment) and by suspending auto-fetch while a force-push confirmation is open.
 */
export function forcePushLeaseArgs(params: {
  readonly remote: string;
  readonly branch: string;
}): string[] {
  return [
    "push",
    "--progress",
    "--force-with-lease",
    "--force-if-includes",
    params.remote,
    `${params.branch}:${params.branch}`,
  ];
}

/** Plain `--force`, gated behind §7.4's own second, harder-worded confirmation on top of the
 *  typed-branch-name one every protected-branch force-push already requires (D-decision: ships
 *  in v1 alongside the lease-based path, per the pre-resolved OQ11). */
export function forcePushPlainArgs(params: {
  readonly remote: string;
  readonly branch: string;
}): string[] {
  return ["push", "--progress", "--force", params.remote, `${params.branch}:${params.branch}`];
}

/** `git push <remote> --delete <branch>` — no `--progress` needed in practice (a delete is a
 *  single tiny round trip), and never killable (§4.3's cancellability table: an unknowable
 *  remote outcome once sent). */
export function deleteRemoteBranchArgs(params: {
  readonly remote: string;
  readonly branch: string;
}): string[] {
  return ["push", params.remote, "--delete", params.branch];
}

export { parseRefUpdates } from "./fetch.ts";
