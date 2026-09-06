import type { CommitRecord, DecorationRef } from "@kira-version/core";
import type { RefRow, StatusSummary } from "@kira-version/ipc";
import { topology } from "./topology.ts";
import type { Scenario } from "./types.ts";

/**
 * `docs/plans/P8.md` W21: three named scenarios `remoteOps.spec.ts` drives, all built from the
 * same shared history and all sharing one `origin` remote so the toolbar's `defaultRemote`
 * (`rowMenuModel.ts`'s `remoteNamesFrom`) always resolves. Separate scenarios, not one scenario a
 * spec switches branches inside of: `mockBridge.ts`'s `applyOp`'s own `"checkout"` branch never
 * touches `session.status.upstream` (it is seeded once from the scenario and only ever mutated by
 * a remote op itself), so a Playwright test that checked out a second branch in place would still
 * see the *first* branch's ahead/behind counts — a real limitation of the mock's "current branch
 * only" status model, not something worth teaching it to recompute for three tests.
 *
 * `mockBridge.ts`'s own `applyRemoteOp` has no real git plumbing behind it (no merge, no actual
 * fast-forward check) — §7.3's strategy ladder and §7.4's lease/protected-branch gating are
 * both real logic reused from `@kira-version/core` (`resolvePullStrategy`, `classifyPush`,
 * `matchProtectedBranch`), but the pull outcome itself is a bare "does the remote have something
 * new" reset. What these scenarios exist to prove is the wire the UI builds and the dialogs it
 * opens — not git's own merge semantics, which is P8's integration suite's own job
 * (`tests/integration/repoService.test.ts`'s W19 scenarios). `window.__kiraHarness.lastRemoteOp`
 * is this file's `refOps.spec.ts`-style "argv" hook (see `mockBridge.ts`'s own `RecordedRemoteOp`
 * doc comment).
 *
 * - **`remoteOps`** — `main` checked out, protected by the default `kiraVersion.protectedBranches`
 *   pattern `"main"`, one commit ahead of `origin/main` and nothing behind: fetch, a plain
 *   (ungated) push, and the protected-branch typed-confirmation force-push route.
 * - **`remoteOpsPull`** — `feature-behind` checked out, even with its own base but two commits
 *   behind `origin/feature-behind`: Pull's default (ff-only, no local git config to override it)
 *   has something to bring in.
 * - **`remoteOpsDiverged`** — `feature-diverged` checked out, one commit ahead of and one behind
 *   `origin/feature-diverged`: a plain push here is `NonFastForward` (§7.2's "offer fetch, not
 *   force"); not protected, so this is also the non-protected force-push target (the branch-name
 *   confirmation field never renders).
 */
const COMMIT_SPEC = [
  "root",
  "main-local:root",
  "fb-base:root",
  "fb-remote-1:fb-base",
  "fb-remote-2:fb-remote-1",
  "fd-base:root",
  "fd-remote:fd-base",
  "fd-local:fd-base",
];
const commits = topology(COMMIT_SPEC);

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  root: [{ kind: "remoteBranch", name: "origin/main" }],
  "fb-remote-2": [{ kind: "remoteBranch", name: "origin/feature-behind" }],
  "fd-remote": [{ kind: "remoteBranch", name: "origin/feature-diverged" }],
};

function decorate(records: readonly CommitRecord[], headBranch: string): CommitRecord[] {
  const headTip: Readonly<Record<string, string>> = {
    main: "main-local",
    "feature-behind": "fb-base",
    "feature-diverged": "fd-local",
  };
  return records.map((record) => {
    let decoration = DECORATIONS[record.subject] ?? [];
    if (record.subject === headTip[headBranch]) {
      decoration = [...decoration, { kind: "branch", name: headBranch, isHead: true }];
    }
    return decoration.length > 0 ? { ...record, decoration } : record;
  });
}

function shaOf(records: readonly CommitRecord[], subject: string): string {
  const commit = records.find((c) => c.subject === subject);
  if (!commit) throw new Error(`remoteOps scenario: no commit named '${subject}'`);
  return commit.sha;
}

function branchRow(
  name: string,
  objectId: string,
  isHead: boolean,
  tracking: { readonly upstream: string; readonly ahead: number; readonly behind: number },
): RefRow {
  return {
    refname: `refs/heads/${name}`,
    kind: "branch",
    shortName: name,
    objectId,
    peeledObjectId: undefined,
    upstream: tracking.upstream,
    track: { ahead: tracking.ahead, behind: tracking.behind },
    committerDate: 1_700_003_600,
    isHead,
    checkedOutIn: undefined,
    annotation: undefined,
  };
}

function remoteBranchRow(name: string, objectId: string): RefRow {
  return {
    refname: `refs/remotes/${name}`,
    kind: "remoteBranch",
    shortName: name,
    objectId,
    peeledObjectId: undefined,
    upstream: undefined,
    track: undefined,
    committerDate: 1_700_003_600,
    isHead: false,
    checkedOutIn: undefined,
    annotation: undefined,
  };
}

function buildScenario(
  scenarioName: string,
  headBranch: "main" | "feature-behind" | "feature-diverged",
  upstream: StatusSummary["upstream"],
): Scenario {
  const decorated = decorate(commits, headBranch);
  const sha = (subject: string) => shaOf(decorated, subject);
  return {
    name: scenarioName,
    git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
    repoOpen: {
      kind: "ok",
      repo: {
        repoId: `/repos/${scenarioName}`,
        root: `/repos/${scenarioName}`,
        gitDir: `/repos/${scenarioName}/.git`,
        commonDir: `/repos/${scenarioName}/.git`,
        isBare: false,
        isLinkedWorktree: false,
        head: { kind: "branch", name: headBranch },
      },
    },
    commits: decorated,
    refs: {
      branches: [
        branchRow("main", sha("main-local"), headBranch === "main", {
          upstream: "origin/main",
          ahead: 1,
          behind: 0,
        }),
        branchRow("feature-behind", sha("fb-base"), headBranch === "feature-behind", {
          upstream: "origin/feature-behind",
          ahead: 0,
          behind: 2,
        }),
        branchRow("feature-diverged", sha("fd-local"), headBranch === "feature-diverged", {
          upstream: "origin/feature-diverged",
          ahead: 1,
          behind: 1,
        }),
      ],
      remoteBranches: [
        remoteBranchRow("origin/main", sha("root")),
        remoteBranchRow("origin/feature-behind", sha("fb-remote-2")),
        remoteBranchRow("origin/feature-diverged", sha("fd-remote")),
      ],
      tags: [],
    },
    status: {
      upstream,
      counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0 },
      isClean: true,
      dirtyPaths: [],
      dirtyTruncated: false,
      inProgress: null,
    },
  };
}

export const remoteOps: Scenario = buildScenario("remoteOps", "main", {
  name: "origin/main",
  ahead: 1,
  behind: 0,
});

export const remoteOpsPull: Scenario = buildScenario("remoteOpsPull", "feature-behind", {
  name: "origin/feature-behind",
  ahead: 0,
  behind: 2,
});

export const remoteOpsDiverged: Scenario = buildScenario("remoteOpsDiverged", "feature-diverged", {
  name: "origin/feature-diverged",
  ahead: 1,
  behind: 1,
});
