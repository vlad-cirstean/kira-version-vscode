import type { CommitRecord, DecorationRef } from "@kira-version/core";
import { topology } from "./topology.ts";
import type { Scenario } from "./types.ts";

/**
 * `docs/plans/P4.md` W12's visual-regression scenario: one repository exercising every
 * decoration kind, a two-parent merge, an octopus (3+ parent) merge, and a branch that is never
 * merged back — on adjacent rows, per W12's own wording, so `graph.spec.ts` (W13) captures all of
 * it in one screenshot rather than several. `clean` stays the smoke scenario untouched by this.
 *
 * `topology()`'s spec format has no way to attach a `DecorationRef` to an entry, so this builds
 * the plain commit graph first and layers decorations on afterwards, keyed by `subject` (which
 * `topology()` sets to the spec entry's own name, so no separate name→sha bookkeeping is needed).
 */
const COMMIT_SPEC = [
  "root",
  "base:root",
  "remote-point:base",
  "tag-point:remote-point",
  // A detached HEAD's decoration (`kind: "head"`) with no branch alongside it, per
  // `refBadges.ts`'s own doc comment on why that badge shape exists at all — this repository's
  // own `repoOpen.head` stays "branch: main" regardless (see below): the scenario exists to
  // exercise every decoration *kind* the badge renderer switches on, not to model one single
  // internally-consistent real git checkout state.
  "detached-point:tag-point",
  // Branches off `detached-point` and is never referenced as a parent again — an open lane that
  // stays open for the rest of the graph, W12's "an unmerged branch".
  "unmerged-tip:detached-point",
  "trunk-a:detached-point",
  "feature-x:trunk-a",
  "merge-point:trunk-a,feature-x",
  "feature-y:merge-point",
  "feature-z:merge-point",
  // Three parents: the octopus.
  "octopus-point:merge-point,feature-y,feature-z",
  "stash-point:octopus-point",
  "many-refs-point:stash-point",
  "tip:many-refs-point",
];

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  "remote-point": [{ kind: "remoteBranch", name: "origin/main" }],
  "tag-point": [{ kind: "tag", name: "v1.0.0" }],
  "detached-point": [{ kind: "head" }],
  "unmerged-tip": [{ kind: "branch", name: "experiment", isHead: false }],
  "stash-point": [{ kind: "stash", index: 0 }],
  // Six refs on one row (§6.2's "a row with more than three badges collapses into a +N badge",
  // exercised here as +3): two local branches, two remote branches, two tags.
  "many-refs-point": [
    { kind: "branch", name: "release/1.0", isHead: false },
    { kind: "branch", name: "release/1.1", isHead: false },
    { kind: "remoteBranch", name: "origin/release/1.0" },
    { kind: "remoteBranch", name: "origin/release/1.1" },
    { kind: "tag", name: "v1.0.0-rc1" },
    { kind: "tag", name: "v1.0.0-rc2" },
  ],
  tip: [{ kind: "branch", name: "main", isHead: true }],
};

function decorate(records: readonly CommitRecord[]): CommitRecord[] {
  return records.map((record) => {
    const decoration = DECORATIONS[record.subject];
    return decoration ? { ...record, decoration } : record;
  });
}

const commits = decorate(topology(COMMIT_SPEC));

export const badges: Scenario = {
  name: "badges",
  git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
  repoOpen: {
    kind: "ok",
    repo: {
      repoId: "/repos/badges",
      root: "/repos/badges",
      gitDir: "/repos/badges/.git",
      commonDir: "/repos/badges/.git",
      isBare: false,
      isLinkedWorktree: false,
      head: { kind: "branch", name: "main" },
    },
  },
  commits,
};
