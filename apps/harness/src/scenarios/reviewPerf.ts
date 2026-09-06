import type { CommitRecord, DecorationRef } from "@kira-version/core";
import { commitByName } from "./topology.ts";
import type { Scenario } from "./types.ts";

/**
 * `docs/plans/P7.md` W18 — §10's own budget row ("first commits painted ≤300 ms on a 200-commit
 * range") measured by `tests/perf/graphUi.ts`'s `reviewFirstPaintMs`. The plan's own text names
 * `?view=review&scenario=review` "extended to 200 commits" as the fixture; `review.ts`'s existing
 * ten commits carry deliberate, named edge cases (a merge, a rename, a binary file, an LFS
 * pointer) that dozens of already-baselined `review*.spec.ts` tests and visual snapshots key off
 * by exact subject and exact count — bulking that scenario itself out to 200 would drag every one
 * of those along for a perf fixture's sake. `reviewPaged.ts` (W16) already set the precedent for
 * exactly this situation (`pagedBranch.ts`'s own trade-off, restated there): a dedicated,
 * `HIDDEN_SCENARIOS`-only fixture built with `commitByName()` rather than `topology()`'s
 * spec-string parser (which does not scale past a few dozen entries), so this file is that same
 * shape at a tenth the size.
 *
 * `main` is a single root commit; `feature` forks from it with `FEATURE_COUNT` commits, none of
 * them in `main`'s ancestry — the whole branch is the 200-commit range `review.resolveBase`
 * walks, with `main` a `kiraVersion.review.baseCandidates` default so resolution needs no
 * upstream fixture, mirroring `review.ts`'s own setup.
 */
const FEATURE_COUNT = 200;

function buildCommits(): CommitRecord[] {
  let index = 0;
  const root = commitByName("root", [], index++);
  const feature: CommitRecord[] = [];
  for (let i = 0; i < FEATURE_COUNT; i++) {
    const parents = i === 0 ? ["root"] : [`feature-${i - 1}`];
    feature.push(commitByName(`feature-${i}`, parents, index++));
  }
  // Oldest-first for `commitByName()`'s own parent-must-already-exist convention, reversed once
  // at the end into the newest-first order `CommitStore` expects.
  return [root, ...feature].reverse();
}

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  root: [{ kind: "branch", name: "main", isHead: true }],
  [`feature-${FEATURE_COUNT - 1}`]: [{ kind: "branch", name: "feature", isHead: false }],
};

function decorate(records: readonly CommitRecord[]): CommitRecord[] {
  return records.map((record) => {
    const decoration = DECORATIONS[record.subject];
    return decoration ? { ...record, decoration } : record;
  });
}

export function reviewPerf(): Scenario {
  const commits = decorate(buildCommits());
  const mainTip = commits.find((c) => c.subject === "root");
  const featureTip = commits.find((c) => c.subject === `feature-${FEATURE_COUNT - 1}`);
  if (!mainTip || !featureTip) throw new Error("reviewPerf: topology build is missing a tip");
  return {
    name: "reviewPerf",
    git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
    repoOpen: {
      kind: "ok",
      repo: {
        repoId: "/repos/review-perf",
        root: "/repos/review-perf",
        gitDir: "/repos/review-perf/.git",
        commonDir: "/repos/review-perf/.git",
        isBare: false,
        isLinkedWorktree: false,
        head: { kind: "branch", name: "main" },
      },
    },
    commits,
    refs: {
      branches: [
        {
          refname: "refs/heads/main",
          kind: "branch",
          shortName: "main",
          objectId: mainTip.sha,
          peeledObjectId: undefined,
          upstream: undefined,
          track: undefined,
          committerDate: 1_700_000_000,
          isHead: true,
          checkedOutIn: undefined,
          annotation: undefined,
        },
        {
          refname: "refs/heads/feature",
          kind: "branch",
          shortName: "feature",
          objectId: featureTip.sha,
          peeledObjectId: undefined,
          upstream: undefined,
          track: undefined,
          committerDate: 1_700_100_000,
          isHead: false,
          checkedOutIn: undefined,
          annotation: undefined,
        },
      ],
      remoteBranches: [],
      tags: [],
    },
  };
}
