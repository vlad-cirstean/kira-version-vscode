import type { PullStrategy, PullStrategySource } from "@kira-version/ipc";

/**
 * `docs/plans/P8.md` §7.3: "the resolved strategy and its provenance are always shown before the
 * op runs" — this is the one place that provenance text is composed, so the toolbar caption and
 * `PullStrategyPicker.vue`'s own popover never drift into two different wordings for the same
 * `PullStrategySource`.
 */
export function describePullStrategySource(source: PullStrategySource): string {
  switch (source) {
    case "explicit":
      return "picked for this pull";
    case "setting":
      return "from your pull.strategy setting";
    case "branchConfig":
      return "from this branch's rebase config";
    case "pullConfig":
      return "from your pull.rebase/pull.ff config";
    case "default":
      return "kira-version default";
  }
}

export const PULL_STRATEGY_LABELS: Record<PullStrategy, string> = {
  "ff-only": "Fast-forward only",
  merge: "Merge",
  rebase: "Rebase",
};
