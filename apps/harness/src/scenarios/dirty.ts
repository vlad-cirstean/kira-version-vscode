import type { CommitRecord, DecorationRef } from "@kira-version/core";
import type { CheckoutPreflight, RefRow } from "@kira-version/ipc";
import { topology } from "./topology.ts";
import type { Scenario } from "./types.ts";

/**
 * `docs/plans/P6.md` W18: a real dirty working tree — replaces the P0 `Proxy` stub. Exercises
 * §7.5's checkout pre-flight in full: four branches, one per verdict the classifier can produce,
 * so `CheckoutDialog.vue`/`BranchPicker.vue` each have something real to demonstrate rather than
 * every click falling through to `mockBridge.ts`'s own generic default.
 */
const COMMIT_SPEC = ["root", "main:root", "feature-clean:main", "feature-carry:main"];
const commits = topology(COMMIT_SPEC);

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  main: [{ kind: "branch", name: "main", isHead: true }],
  "feature-clean": [{ kind: "branch", name: "feature-clean", isHead: false }],
  "feature-carry": [{ kind: "branch", name: "feature-carry", isHead: false }],
};

function decorate(records: readonly CommitRecord[]): CommitRecord[] {
  return records.map((record) => {
    const decoration = DECORATIONS[record.subject];
    return decoration ? { ...record, decoration } : record;
  });
}

const decorated = decorate(commits);
function shaOf(subject: string): string {
  const commit = decorated.find((c) => c.subject === subject);
  if (!commit) throw new Error(`dirty scenario: no commit named '${subject}'`);
  return commit.sha;
}

function branchRow(
  name: string,
  isHead: boolean,
  objectId = shaOf(name),
  // P6 W19's `undo.spec.ts`: `feature-carry` carries real upstream-tracking metadata precisely so
  // deleting it and undoing has something beyond the bare ref to prove came back — the mock's own
  // analogue of `repoService.test.ts`'s real-git "branchDelete undo restores upstream tracking
  // config" test, at the UI/wire layer instead of `packages/git`'s.
  tracking?: { readonly upstream: string; readonly track: RefRow["track"] },
): RefRow {
  return {
    refname: `refs/heads/${name}`,
    kind: "branch",
    shortName: name,
    objectId,
    peeledObjectId: undefined,
    upstream: tracking?.upstream,
    track: tracking?.track,
    committerDate: 1_700_003_600,
    isHead,
    checkedOutIn: undefined,
    annotation: undefined,
  };
}

const DIRTY_PATHS = ["src/tracked.ts", "README.md"];
const UNTRACKED_PATHS = ["src/scratch.ts"];

// §7.5's four verdicts, keyed by the branch a click asks to check out — `mockBridge.ts`'s
// `preflight.checkout` reads this map first and only falls back to its own default classifier
// for a target this scenario does not name.
const preflightByTarget: Readonly<Record<string, CheckoutPreflight>> = {
  "feature-clean": {
    target: { kind: "branch", name: "feature-clean" },
    detaches: false,
    createsTracking: undefined,
    carried: [],
    blockers: [],
    verdict: "clean",
    routes: [],
  },
  "feature-carry": {
    target: { kind: "branch", name: "feature-carry" },
    detaches: false,
    createsTracking: undefined,
    carried: DIRTY_PATHS,
    blockers: [],
    verdict: "cleanCarry",
    routes: [],
  },
  "feature-blocked-tracked": {
    target: { kind: "branch", name: "feature-blocked-tracked" },
    detaches: false,
    createsTracking: undefined,
    carried: [],
    blockers: [{ kind: "blockedByTracked", paths: DIRTY_PATHS }],
    verdict: "blocked",
    routes: ["discard"],
  },
  "feature-blocked-untracked": {
    target: { kind: "branch", name: "feature-blocked-untracked" },
    detaches: false,
    createsTracking: undefined,
    carried: [],
    blockers: [{ kind: "blockedByUntracked", paths: UNTRACKED_PATHS }],
    verdict: "blocked",
    routes: [],
  },
};

export const dirty: Scenario = {
  name: "dirty",
  git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
  repoOpen: {
    kind: "ok",
    repo: {
      repoId: "/repos/dirty",
      root: "/repos/dirty",
      gitDir: "/repos/dirty/.git",
      commonDir: "/repos/dirty/.git",
      isBare: false,
      isLinkedWorktree: false,
      head: { kind: "branch", name: "main" },
    },
  },
  commits: decorated,
  refs: {
    branches: [
      branchRow("main", true),
      branchRow("feature-clean", false),
      branchRow("feature-carry", false, undefined, {
        upstream: "origin/feature-carry",
        track: { ahead: 0, behind: 2 },
      }),
      // These two exist only as pre-flight targets above — `feature-blocked-tracked`'s and
      // `feature-blocked-untracked`'s own `objectId` resolve to `main`'s tip rather than each
      // needing its own commit; the fixture only needs a real ref for the branch picker to
      // list, not a distinct history.
      branchRow("feature-blocked-tracked", false, shaOf("main")),
      branchRow("feature-blocked-untracked", false, shaOf("main")),
      // P6 W19's `refOps.spec.ts`: the not-fully-merged force-delete path — see
      // `notFullyMergedBranches` below and `types.ts`'s own doc comment on why this is a named
      // fixture rather than something the mock derives from real ancestry.
      branchRow("feature-unmerged", false, shaOf("main")),
    ],
    remoteBranches: [],
    tags: [],
  },
  status: {
    upstream: undefined,
    counts: { staged: 1, unstaged: 1, untracked: 1, unmerged: 0 },
    isClean: false,
    dirtyPaths: DIRTY_PATHS,
    dirtyTruncated: false,
    inProgress: null,
  },
  preflight: { checkout: preflightByTarget },
  notFullyMergedBranches: ["feature-unmerged"],
};
