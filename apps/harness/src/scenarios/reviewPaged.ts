import type { CommitRecord, DecorationRef } from "@kira-version/core";
import { commitByName } from "./topology.ts";
import type { Scenario } from "./types.ts";

/**
 * `docs/plans/P7.md` W16's "Load more appends without moving the scroll position" needs a review
 * range wider than `kiraVersion.graph.pageSize`'s default (5,000) — none of `review.ts`'s own ten
 * commits get there. Mirrors `pagedBranch.ts`'s own trade-off (`commitByName()`, not `topology()`'s
 * spec-string parser, which does not scale to thousands of entries) and its own reason for being a
 * function, not a top-level value, in `HIDDEN_SCENARIOS`: importing `scenarios/index.ts` must
 * never pay this scenario's 5,011-commit build cost, only `loadScenario("reviewPaged")` should.
 *
 * `main` is a single root commit; `feature` forks from it with `FEATURE_COUNT` commits, all of
 * them outside `main`'s ancestry — the whole branch is the range, `FEATURE_COUNT` = one page
 * (5,000) plus a remainder (10), so `graph.status`'s `remaining` is nonzero after the first
 * `graph.stream` and a real `Load more` click has a second page to fetch.
 */
const FEATURE_COUNT = 5010;

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

export function reviewPaged(): Scenario {
  const commits = decorate(buildCommits());
  const mainTip = commits.find((c) => c.subject === "root");
  const featureTip = commits.find((c) => c.subject === `feature-${FEATURE_COUNT - 1}`);
  if (!mainTip || !featureTip) throw new Error("reviewPaged: topology build is missing a tip");
  return {
    name: "reviewPaged",
    git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
    repoOpen: {
      kind: "ok",
      repo: {
        repoId: "/repos/review-paged",
        root: "/repos/review-paged",
        gitDir: "/repos/review-paged/.git",
        commonDir: "/repos/review-paged/.git",
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
