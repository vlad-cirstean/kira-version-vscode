import type { CommitRecord, DecorationRef } from "@kira-version/core";
import type { RefRow } from "@kira-version/ipc";
import { topology } from "./topology.ts";
import type { Scenario } from "./types.ts";

/**
 * `docs/plans/P11.md` W15: the harness-side sibling of `tests/fixtures/generateRepo.ts`'s
 * `searchable(n)` — the same discriminating shapes in miniature, small enough for `search.spec.ts`
 * and friends (W20) to drive every §7.8 toggle and the tail-hit/ref-hit reveal paths against a
 * real (mock) bridge rather than a hand-rolled one. Subjects carry the case/whole-word/regex
 * discriminators the real fixture also carries (`WIDGETS` vs `widget` vs `subwidgetary`,
 * `(#123)`); per-commit authors (via `withAuthor` below — `topology()` itself gives every commit
 * the same identity) give the author-name/email fields something real to distinguish.
 * `TAIL_ONLY_TERM` lives only in a body via `Scenario.searchBodies` (W9), never in any subject —
 * `types.ts`'s own doc comment on that field names exactly this "loaded-store scan can't produce
 * it" case, and W20's tail-hit test is what exercises it.
 */
const TAIL_ONLY_TERM = "gizmocratic";

const AUTHORS: Readonly<Record<string, { name: string; email: string }>> = {
  root: { name: "Kira Fixture", email: "fixture@kira-version.test" },
  "add WIDGETS to the list": { name: "Priya Kapoor", email: "priya@example.com" },
  "Fix the widget cache": { name: "Marco Byte", email: "marco@example.com" },
  "subwidgetary refactor": { name: "Ada Lovelace", email: "ada@example.com" },
  "fix (#123) parsing bug": { name: "Grace Hopper", email: "grace@example.com" },
  "unrelated change to build config": { name: "Priya Kapoor", email: "priya@example.com" },
  "tail commit only body match": { name: "Marco Byte", email: "marco@example.com" },
  "release checkpoint": { name: "Ada Lovelace", email: "ada@example.com" },
  "main tip": { name: "Grace Hopper", email: "grace@example.com" },
};

const COMMIT_SPEC = [
  "root",
  "add WIDGETS to the list:root",
  "Fix the widget cache:add WIDGETS to the list",
  "subwidgetary refactor:Fix the widget cache",
  "fix (#123) parsing bug:subwidgetary refactor",
  "unrelated change to build config:fix (#123) parsing bug",
  "tail commit only body match:unrelated change to build config",
  "release checkpoint:tail commit only body match",
  "main tip:release checkpoint",
];

function withAuthor(record: CommitRecord): CommitRecord {
  const identity = AUTHORS[record.subject];
  if (!identity) throw new Error(`search scenario: no author named for '${record.subject}'`);
  const author = { ...identity, timestamp: record.author.timestamp };
  return { ...record, author, committer: author };
}

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  "release checkpoint": [
    { kind: "branch", name: "release", isHead: false },
    { kind: "tag", name: "release-preview" },
  ],
  "main tip": [
    { kind: "branch", name: "main", isHead: true },
    { kind: "tag", name: "v1.0.0" },
  ],
};

function decorate(records: readonly CommitRecord[]): CommitRecord[] {
  return records.map((record) => {
    const decoration = DECORATIONS[record.subject];
    return decoration ? { ...record, decoration } : record;
  });
}

const commits = decorate(topology(COMMIT_SPEC).map(withAuthor));

function shaOf(subject: string): string {
  const commit = commits.find((c) => c.subject === subject);
  if (!commit) throw new Error(`search scenario: no commit named '${subject}'`);
  return commit.sha;
}

const tailSha = shaOf("tail commit only body match");
const releaseSha = shaOf("release checkpoint");
const mainSha = shaOf("main tip");

export const search: Scenario = {
  name: "search",
  git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
  repoOpen: {
    kind: "ok",
    repo: {
      repoId: "/repos/search",
      root: "/repos/search",
      gitDir: "/repos/search/.git",
      commonDir: "/repos/search/.git",
      isBare: false,
      isLinkedWorktree: false,
      head: { kind: "branch", name: "main" },
    },
  },
  commits,
  // W9's `search.run` reads this for the one field `CommitRecord` never carries — see the
  // doc comment at the top of this file for why `tailSha`'s body-only term matters.
  searchBodies: {
    [tailSha]: `Nothing in the subject line hints at this.\n\nA ${TAIL_ONLY_TERM} widget assembly step, spelled out only here.`,
  },
  refs: {
    branches: [
      {
        refname: "refs/heads/main",
        kind: "branch",
        shortName: "main",
        objectId: mainSha,
        peeledObjectId: undefined,
        upstream: "origin/main",
        track: { ahead: 0, behind: 0 },
        committerDate: 1_700_028_800,
        isHead: true,
        checkedOutIn: undefined,
        annotation: undefined,
      },
      {
        refname: "refs/heads/release",
        kind: "branch",
        shortName: "release",
        objectId: releaseSha,
        peeledObjectId: undefined,
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_025_200,
        isHead: false,
        checkedOutIn: undefined,
        annotation: undefined,
      },
    ] satisfies RefRow[],
    remoteBranches: [
      {
        refname: "refs/remotes/origin/main",
        kind: "remoteBranch",
        shortName: "origin/main",
        objectId: mainSha,
        peeledObjectId: undefined,
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_028_800,
        isHead: false,
        checkedOutIn: undefined,
        annotation: undefined,
      },
    ] satisfies RefRow[],
    tags: [
      {
        refname: "refs/tags/v1.0.0",
        kind: "tag",
        shortName: "v1.0.0",
        // The tag object's own sha (probe P3) — not `mainSha`, which is the *pointed-at commit*;
        // `peeledObjectId` carries that instead, matching a real annotated tag's two objects.
        objectId: "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
        peeledObjectId: mainSha,
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_028_800,
        isHead: false,
        checkedOutIn: undefined,
        annotation: {
          tagger: "Grace Hopper <grace@example.com>",
          date: 1_700_028_800,
          subject: "Release 1.0.0",
          body: "First tagged release.\n\nIncludes the widget cache fix.",
        },
      },
      // Shares its "release" name prefix with `refs/heads/release` above — the fixture's own
      // `searchable()` (`tests/fixtures/generateRepo.ts`) carries the same pairing, and W16 row
      // 14 asserts that a query matching both a tag and a branch stays distinguishable by `kind`.
      {
        refname: "refs/tags/release-preview",
        kind: "tag",
        shortName: "release-preview",
        objectId: releaseSha,
        peeledObjectId: undefined,
        upstream: undefined,
        track: undefined,
        committerDate: 1_700_025_200,
        isHead: false,
        checkedOutIn: undefined,
        annotation: undefined,
      },
    ] satisfies RefRow[],
  },
  status: {
    upstream: { name: "origin/main", ahead: 0, behind: 0 },
    counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0 },
    isClean: true,
    dirtyPaths: [],
    dirtyTruncated: false,
    inProgress: null,
  },
};
