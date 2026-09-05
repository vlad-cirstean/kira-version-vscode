/** Mapping of actions to codicon class names (§3.4). Grows as components gain actions. */
export const ACTION_ICONS = {
  refresh: "codicon-refresh",
  search: "codicon-search",
  copy: "codicon-copy",
  chevronRight: "codicon-chevron-right",
  back: "codicon-chevron-left",
  renameArrow: "codicon-arrow-small-right",
} as const;

export type IconAction = keyof typeof ACTION_ICONS;

/** Mapping of `refBadges.ts`'s badge kinds to codicon class names (P4 W7, §6.2's table) — kept
 *  separate from `ACTION_ICONS` because these decorate a `DecorationRef` kind, not an action. */
export const BADGE_ICONS = {
  localBranch: "codicon-git-branch",
  remoteBranch: "codicon-cloud",
  tag: "codicon-tag",
  stash: "codicon-archive",
} as const;

/** Icons for `RepoPicker.vue` and the P4 W10 "no graph" panels — kept separate from
 *  `ACTION_ICONS` for the same reason `BADGE_ICONS` is: these decorate a surface, not an
 *  action a click performs. */
export const STATE_ICONS = {
  repo: "codicon-repo",
  chevronDown: "codicon-chevron-down",
  check: "codicon-check",
  openFolder: "codicon-folder-opened",
  warning: "codicon-warning",
  commit: "codicon-git-commit",
} as const;
