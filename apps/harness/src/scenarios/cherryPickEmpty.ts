import { conflicted } from "./conflicted.ts";
import type { Scenario } from "./types.ts";

/**
 * `docs/plans/P10.md` W13's `conflictBanner.spec.ts` case: a cherry-pick that reached
 * `CHERRY_PICK_HEAD` present, zero unmerged paths — probe 6's own "empty pick" state, the one
 * `canSkip` exists for. Built the same way `conflictedNoResolve.ts` builds off `conflicted.ts`
 * (spread the base scenario, override what differs) rather than from scratch, since the ref/
 * commit topology is incidental here — only `status.inProgress`/`status.counts`/`dirtyPaths`
 * matter to this state. Deliberately **not** registered in `index.ts`'s `SCENARIOS` (this file's
 * own single spec is the only thing that needs to name it — `index.ts`'s own doc comment on
 * `HIDDEN_SCENARIOS`).
 */
export const cherryPickEmpty: Scenario = {
  ...conflicted,
  name: "cherryPickEmpty",
  repoOpen:
    conflicted.repoOpen.kind === "ok"
      ? {
          kind: "ok",
          repo: { ...conflicted.repoOpen.repo, repoId: "/repos/cherryPickEmpty" },
        }
      : conflicted.repoOpen,
  status: {
    upstream: undefined,
    counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0 },
    isClean: true,
    dirtyPaths: [],
    dirtyTruncated: false,
    inProgress: {
      kind: "cherryPick",
      otherSha: conflicted.status?.inProgress?.otherSha,
      headName: undefined,
      conflictedPaths: [],
      canContinue: true,
      canAbort: true,
      isSequence: false,
      unmergedCount: 0,
      canSkip: true,
    },
  },
};
