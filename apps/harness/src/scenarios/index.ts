import { authFailure } from "./authFailure.ts";
import { badges } from "./badges.ts";
import { ceiling } from "./ceiling.ts";
import { clean } from "./clean.ts";
import { conflicted } from "./conflicted.ts";
import { conflictedNoResolve } from "./conflictedNoResolve.ts";
import { detail } from "./detail.ts";
import { dirty } from "./dirty.ts";
import { goToFile } from "./goToFile.ts";
import { hugeRepo } from "./hugeRepo.ts";
import { merge } from "./merge.ts";
import { noCapabilities } from "./noCapabilities.ts";
import { pagedBranch } from "./pagedBranch.ts";
import { rebasing } from "./rebasing.ts";
import { remoteOps, remoteOpsDiverged, remoteOpsPull } from "./remoteOps.ts";
import { review } from "./review.ts";
import { reviewAsk } from "./reviewAsk.ts";
import { reviewMerged } from "./reviewMerged.ts";
import { reviewMergeFromBase } from "./reviewMergeFromBase.ts";
import { reviewPaged } from "./reviewPaged.ts";
import { reviewPerf } from "./reviewPerf.ts";
import { reviewUpstream } from "./reviewUpstream.ts";
import { tags } from "./tags.ts";
import { tooOld } from "./tooOld.ts";
import type { Scenario } from "./types.ts";
import { worktrees } from "./worktrees.ts";

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  clean,
  dirty,
  conflicted,
  hugeRepo,
  authFailure,
  badges,
  tooOld,
  detail,
  merge,
  goToFile,
  noCapabilities,
  rebasing,
  worktrees,
  tags,
  review,
  reviewUpstream,
  reviewMerged,
  reviewMergeFromBase,
  reviewAsk,
  remoteOps,
  remoteOpsPull,
  remoteOpsDiverged,
};

/** Loadable by exact name via `?scenario=<name>` but deliberately left out of `SCENARIOS` above
 *  (P4 W12) — never enumerated as "known" (the error message below only lists `SCENARIOS`'
 *  keys), so nothing that surfaces "the scenario picker" lists it, but still reachable by
 *  whoever already knows the name. Each entry is a function, not a value, so importing this
 *  module never pays a hidden scenario's own build cost — only calling `loadScenario` with its
 *  exact name does. `ceiling`'s caller is expected to be `tests/perf/graphUi.ts` (W15);
 *  `pagedBranch`'s (P4 W13) is `graph.spec.ts`'s own "screenshot after a Load more" scenario;
 *  `reviewPaged`'s (P7 W16) is `review.spec.ts`'s own "Load more" test; `reviewPerf`'s (P7 W18)
 *  is `tests/perf/graphUi.ts`'s own `reviewFirstPaintMs` metric — all four are single-purpose
 *  fixtures nobody browsing scenarios by hand needs to stumble on. */
const HIDDEN_SCENARIOS: Readonly<Record<string, () => Scenario>> = {
  ceiling,
  pagedBranch,
  reviewPaged,
  reviewPerf,
  conflictedNoResolve: () => conflictedNoResolve,
};

export function loadScenario(name: string): Scenario {
  const scenario = SCENARIOS[name];
  if (scenario) return scenario;
  const hidden = HIDDEN_SCENARIOS[name];
  if (hidden) return hidden();
  throw new Error(`unknown scenario '${name}'; known: ${Object.keys(SCENARIOS).join(", ")}`);
}

export type { Scenario } from "./types.ts";
