/**
 * §7.3's decomposed-pull pre-flight and its strategy-resolution ladder — `docs/plans/P8.md`'s
 * "Pull: decomposition and the strategy resolution order", W9. Pure: `git/src/ops/pull.ts`
 * gathers the ahead/behind/dirty/config facts (one `for-each-ref`/`status` and one
 * `config --null --get-regexp` spawn) and hands them here.
 */
import type { PullStrategy, PullStrategySource } from "../model/remote.ts";
import type { PullBlocker, PullPreflight } from "./types.ts";

/** The raw (still git-syntax) values of the three config keys the ladder's steps 3-5 read, all
 *  from one `git config --null --get-regexp` spawn (§7.3: "three separate `--get` spawns for
 *  that would be silly"). `undefined` when that key is unset. */
export interface PullConfigValues {
  /** `branch.<name>.rebase` — `"true"`, `"false"`, `"interactive"`, or `"merges"`. */
  readonly branchRebase?: string;
  /** `pull.rebase` — same value space as `branch.<name>.rebase`. */
  readonly pullRebase?: string;
  /** `pull.ff` — only `"only"` changes the resolution; every other value (`"true"`, `"false"`,
   *  unset) falls through to the ff-only default anyway. */
  readonly pullFf?: string;
}

/** `true`/`interactive`/`merges` -> rebase; `false` -> merge; anything else (including an
 *  unrecognised string) -> not a decision this key makes. */
function mapRebaseValue(raw: string | undefined): PullStrategy | undefined {
  if (raw === "false") return "merge";
  if (raw === "true" || raw === "interactive" || raw === "merges") return "rebase";
  return undefined;
}

/**
 * The six-step, first-match-wins ladder (`docs/plans/P8.md`'s "The hard parts" §5):
 *   1. an explicit choice for this one invocation
 *   2. `kiraVersion.pull.strategy`, unless `"auto"`
 *   3. `branch.<name>.rebase`
 *   4. `pull.rebase`
 *   5. `pull.ff=only`
 *   6. fallback: ff-only
 */
export function resolvePullStrategy(input: {
  readonly explicit?: PullStrategy;
  readonly settingStrategy: "auto" | PullStrategy;
  readonly gitConfig: PullConfigValues;
}): { readonly strategy: PullStrategy; readonly source: PullStrategySource } {
  if (input.explicit !== undefined) return { strategy: input.explicit, source: "explicit" };
  if (input.settingStrategy !== "auto") {
    return { strategy: input.settingStrategy, source: "setting" };
  }
  const branchMapped = mapRebaseValue(input.gitConfig.branchRebase);
  if (branchMapped !== undefined) return { strategy: branchMapped, source: "branchConfig" };
  const pullRebaseMapped = mapRebaseValue(input.gitConfig.pullRebase);
  if (pullRebaseMapped !== undefined) return { strategy: pullRebaseMapped, source: "pullConfig" };
  if (input.gitConfig.pullFf === "only") return { strategy: "ff-only", source: "pullConfig" };
  return { strategy: "ff-only", source: "default" };
}

export function buildPullPreflight(input: {
  readonly strategy: PullStrategy;
  readonly source: PullStrategySource;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly dirty: boolean;
}): PullPreflight {
  const diverged = input.behind > 0 && input.ahead > 0;
  const wouldRewriteHistory = input.strategy !== "ff-only" ? diverged || input.behind > 0 : false;
  const blockers: PullBlocker[] = [];
  // §7.3: a dirty tree plus a pull that will actually integrate something (merge/rebase, or an
  // ff-only that is really a no-op) is the one case P9's stash seam exists for — flagged here so
  // the UI can name it before the op runs, not discovered as a mid-op `DirtyWorktree` failure.
  if (input.dirty && wouldRewriteHistory) blockers.push("dirtyNonFastForward");
  // P9/W10: `dirtyNonFastForward` is the only `PullBlocker` there is, so "the only blocker is
  // dirtyNonFastForward" reduces to "there is a blocker at all" — offer the route whenever one
  // exists, exactly `CheckoutPreflight.routes`'s own "blockedByTracked with no untracked block"
  // shape, one blocker kind simpler.
  const routes: PullPreflight["routes"] = blockers.length > 0 ? ["stashAndCarry"] : [];
  return {
    strategy: input.strategy,
    source: input.source,
    upstream: input.upstream,
    ahead: input.ahead,
    behind: input.behind,
    dirty: input.dirty,
    routes,
    blockers,
  };
}
