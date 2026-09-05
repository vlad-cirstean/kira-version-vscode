import { conflicted } from "./conflicted.ts";
import type { Scenario } from "./types.ts";

/**
 * P6 W19's `conflictBanner.spec.ts`: the same mid-merge fixture as `conflicted`, with
 * `resolveConflict: false` — so "Resolve in VS Code" is absent from the banner rather than merely
 * disabled, exactly `noCapabilities.ts`'s own pattern (spread the base scenario, override
 * `capabilities`) applied to a scenario that actually has an `inProgress` state for the banner to
 * render at all. Deliberately **not** registered in `index.ts`'s `SCENARIOS` — like `pagedBranch`/
 * `ceiling`, this exists for exactly one spec file to name by hand, not for anyone browsing
 * scenarios to stumble on (`index.ts`'s own doc comment on `HIDDEN_SCENARIOS`).
 */
export const conflictedNoResolve: Scenario = {
  ...conflicted,
  name: "conflictedNoResolve",
  repoOpen:
    conflicted.repoOpen.kind === "ok"
      ? {
          kind: "ok",
          repo: { ...conflicted.repoOpen.repo, repoId: "/repos/conflictedNoResolve" },
        }
      : conflicted.repoOpen,
  capabilities: { openInEditor: true, goToFile: true, clipboard: true, resolveConflict: false },
};
