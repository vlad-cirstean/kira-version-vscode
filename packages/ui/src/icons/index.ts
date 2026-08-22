/** Mapping of actions to codicon class names (§3.4). Grows as components gain actions. */
export const ACTION_ICONS = {
  refresh: "codicon-refresh",
  search: "codicon-search",
} as const;

export type IconAction = keyof typeof ACTION_ICONS;
