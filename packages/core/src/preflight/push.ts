/**
 * §7.4's push pre-flight — `docs/plans/P8.md`'s W10. Pure: `git/src/ops/push.ts` gathers the
 * ahead/behind/upstream/remote-tip facts (one `for-each-ref` spawn covering both the local branch
 * and its remote-tracking ref) and hands them here, alongside the raw `kiraVersion.protectedBranches`
 * pattern list. `remoteTip` is D48's re-read-and-compare mitigation: it is read here, at
 * pre-flight time, so the confirmation dialog can name the sha it is about to overwrite — and
 * `remote.run` re-reads it again immediately before the actual force-push spawn, so a remote that
 * moved in between is still caught by `--force-with-lease --force-if-includes` itself rather than
 * by trusting this stale copy.
 */
import { matchProtectedBranch } from "../model/protectedBranch.ts";
import type { PushPreflight } from "./types.ts";

export function classifyPush(input: {
  readonly branch: string;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  /** The remote-tracking ref's sha, or `null` when it does not exist (nothing to overwrite, and
   *  nothing a lease could be checked against — a plain push sets it for the first time). */
  readonly remoteTip: string | null;
  readonly protectedBranches: readonly string[];
}): PushPreflight {
  const match = matchProtectedBranch(input.branch, input.protectedBranches);
  return {
    upstream: input.upstream,
    wouldSetUpstream: input.upstream === null,
    ahead: input.ahead,
    behind: input.behind,
    remoteTip: input.remoteTip,
    protectedBy: match?.pattern ?? null,
    fastForward: input.behind === 0,
  };
}
