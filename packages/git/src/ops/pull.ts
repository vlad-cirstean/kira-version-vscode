/**
 * P8/W9 — the decomposed-pull side of `docs/plans/P8.md`'s §7.3: argv builders for the
 * `pull.rebase`/`pull.ff`/`branch.<name>.rebase` config read and for each of the three
 * integration strategies, plus the one guard that decides whether ff-only is even worth
 * spawning. No policy of its own — `core/src/preflight/pull.ts`'s `resolvePullStrategy` already
 * decided *which* strategy applies; this file only shapes the spawn for whichever one that is.
 *
 * The actual "fetch, then exactly one integration" sequencing (`docs/plans/P8.md`'s W9 prose)
 * lives in `RepoService.runRemoteOp` (W14), not here — this package's `ops/*.ts` files are pure
 * argv builders and parsers only (`fetch.ts`/`push.ts`/`checkout.ts` all follow the same shape);
 * `repoService.ts` is the one place that actually owns a `GitDriver` and sequences spawns.
 */
import type { PullConfigValues } from "@kira-version/core";

/**
 * `git config --null --get-regexp '^(branch\.<branch>\.rebase|pull\.rebase|pull\.ff)$'` — one
 * spawn for all three keys the strategy ladder's steps 3-5 read (§7.3: "three separate `--get`
 * spawns for that would be silly"). `branch` is escaped for every regex metacharacter git's
 * `--get-regexp` understands; `/` needs no escaping (it is not special in an ERE) but a branch
 * name can otherwise contain `.`, `*`, `+`, `?`, `^`, `$`, `(`, `)`, `|`, `[`, `]`, `{`, `}`, `\`.
 */
export function pullConfigArgs(branch: string): string[] {
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    "config",
    "--null",
    "--get-regexp",
    `^(branch\\.${escaped}\\.rebase|pull\\.rebase|pull\\.ff)$`,
  ];
}

/**
 * Parses `pullConfigArgs`'s `--null`-framed stdout: one NUL-terminated entry per matching key,
 * `key\nvalue` when a value is present, or a bare `key` (no embedded newline at all) for a
 * valueless boolean entry (`[pull]\n\trebase` with no `= value`) — confirmed against real git:
 * such an entry round-trips through `--null --get-regexp` as `pull.rebase\0`, no `\n` at all, and
 * `git config --bool --get` on it reads `true` (pseudo-boolean semantics), so this parser maps
 * "no newline" to the string `"true"` rather than leaving it `undefined`. When the same key
 * appears more than once (multiple config files, or duplicate stanzas in one), later entries
 * overwrite earlier ones in the loop below, matching `git config --get`'s own "last one wins".
 */
export function parsePullConfig(stdout: string): PullConfigValues {
  const values: { branchRebase?: string; pullRebase?: string; pullFf?: string } = {};
  for (const entry of stdout.split("\0")) {
    if (entry.length === 0) continue;
    const nl = entry.indexOf("\n");
    const key = nl === -1 ? entry : entry.slice(0, nl);
    const value = nl === -1 ? "true" : entry.slice(nl + 1);
    if (key === "pull.rebase") values.pullRebase = value;
    else if (key === "pull.ff") values.pullFf = value;
    else if (key.startsWith("branch.") && key.endsWith(".rebase")) values.branchRebase = value;
  }
  return values;
}

/** `git merge --ff-only <upstream>` — the ladder's default and step-5 outcome. `<upstream>` is
 *  always the already-fetched remote-tracking ref (e.g. `origin/main`), never `FETCH_HEAD`: the
 *  fetch that ran immediately before this is a plain `git fetch`, not `git pull`'s own implicit
 *  one, so `FETCH_HEAD` may not even point at the ref this branch tracks. */
export function mergeFfOnlyArgs(upstream: string): string[] {
  return ["merge", "--ff-only", upstream];
}

/** `git merge --no-edit <upstream>` — step 3/4's "merge" outcome. `--no-edit` for the same reason
 *  `revert.ts` always passes it: v1 has no commit-message editor of its own, and leaving it out
 *  would let `GIT_EDITOR=true` (W6) silently accept whatever git's own default merge message is
 *  rather than stating that choice in the argv a reader of this file can see. */
export function mergeArgs(upstream: string): string[] {
  return ["merge", "--no-edit", upstream];
}

/** `git rebase <upstream>` — step 3/4's "rebase" outcome. Never `--interactive`: v1 offers no
 *  editor for that either, and `pull.strategy`'s "rebase" value already collapses `interactive`
 *  and `merges` variants down to a plain rebase (`core/src/preflight/pull.ts`'s `mapRebaseValue`
 *  doc comment says so explicitly). */
export function rebaseArgs(upstream: string): string[] {
  return ["rebase", upstream];
}

/**
 * §7.3's guard: ff-only can only ever *not* be offered a real fast-forward when the branch has
 * also diverged (local commits of its own) — `ahead > 0 && behind > 0`. A behind-only branch (not
 * ahead) always fast-forwards cleanly; an ahead-only branch (not behind) has nothing to
 * integrate at all. `RepoService.runRemoteOp` checks this *before* spawning `mergeFfOnlyArgs` and
 * fails the whole op with `NonFastForward` rather than letting git's own merge refuse it — the
 * decomposed-pull feature's entire point is offering the other two strategies as an explicit
 * choice, not surfacing git's stock non-fast-forward message and stopping there.
 */
export function ffOnlyWouldDiverge(ahead: number, behind: number): boolean {
  return ahead > 0 && behind > 0;
}
