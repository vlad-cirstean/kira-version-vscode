import type { CommitRecord, DecorationRef } from "@kira-version/core";
import { add, ctx, del, hunk } from "./diffFixtures.ts";
import { diffKey } from "./diffKey.ts";
import { topology } from "./topology.ts";
import type { CommitDetailFixture, Scenario } from "./types.ts";

/**
 * P5 W12's workhorse scenario: one commit with a body, two trailers, a signature and refs, whose
 * file tree carries one of every `FileChangeKind` plus every non-text `FileDiffBody` shape —
 * `docs/plans/P5.md`'s own list for this scenario, in this order: an add, a modify, a delete, a
 * rename-with-edits, a copy, a binary file, an LFS pointer, and a file whose diff is over the
 * size cap.
 *
 * A third commit, `manyFiles`, is layered on top of `tip` and carries the HEAD/`main` decoration
 * instead: `docs/plans/P5.md`'s W13 ("the 5,000-file scenario renders the cap plus its 'show
 * all' row") and W15 ("the `detail` scenario's 5,000-file commit is what makes the W8 render cap
 * meaningful") both name a 5,000-file commit within *this* scenario, distinct from the
 * eight-file-kind workhorse `tip` above — folding both into one commit would make it impossible
 * to assert the ordinary field-population case (`tip`) without every assertion also fighting the
 * render cap, and vice versa.
 */
const COMMIT_SPEC = ["root", "tip:root", "manyFiles:tip"];
const commits = topology(COMMIT_SPEC);

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  tip: [{ kind: "tag", name: "v1.0.0" }],
  manyFiles: [{ kind: "branch", name: "main", isHead: true }],
};

function decorate(records: readonly CommitRecord[]): CommitRecord[] {
  return records.map((record) => {
    const decoration = DECORATIONS[record.subject];
    return decoration ? { ...record, decoration } : record;
  });
}

const decorated = decorate(commits);
// `topology()`'s newest-first order puts "manyFiles" at index 0 and "tip" at index 1 — see this
// file's own `COMMIT_SPEC`.
const manyFilesCommit = decorated[0];
const tip = decorated[1];
if (!tip || !manyFilesCommit)
  throw new Error("detail scenario: topology() produced too few commits");
const tipSha = tip.sha;
const manyFilesSha = manyFilesCommit.sha;

const MANY_FILES_COUNT = 5000;
const MANY_FILES: CommitDetailFixture["files"] = Array.from(
  { length: MANY_FILES_COUNT },
  (_, i) => ({
    kind: "modified",
    path: `src/generated/file-${String(i).padStart(4, "0")}.ts`,
    originalPath: undefined,
    similarity: undefined,
    additions: 1,
    deletions: 1,
    isBinary: false,
  }),
);

const FILES: CommitDetailFixture["files"] = [
  {
    kind: "added",
    path: "src/added.ts",
    originalPath: undefined,
    similarity: undefined,
    additions: 12,
    deletions: 0,
    isBinary: false,
  },
  {
    kind: "modified",
    path: "src/modified.ts",
    originalPath: undefined,
    similarity: undefined,
    additions: 5,
    deletions: 3,
    isBinary: false,
  },
  {
    kind: "deleted",
    path: "src/deleted.ts",
    originalPath: undefined,
    similarity: undefined,
    additions: 0,
    deletions: 20,
    isBinary: false,
  },
  {
    kind: "renamed",
    path: "src/renamed-new.ts",
    originalPath: "src/renamed-old.ts",
    similarity: 85,
    additions: 4,
    deletions: 2,
    isBinary: false,
  },
  {
    kind: "copied",
    path: "src/copied-new.ts",
    originalPath: "src/copied-source.ts",
    similarity: 100,
    additions: 0,
    deletions: 0,
    isBinary: false,
  },
  {
    kind: "modified",
    path: "assets/image.png",
    originalPath: undefined,
    similarity: undefined,
    additions: undefined,
    deletions: undefined,
    isBinary: true,
  },
  {
    kind: "added",
    path: "assets/large-asset.bin",
    originalPath: undefined,
    similarity: undefined,
    additions: 3,
    deletions: 0,
    isBinary: false,
  },
  {
    kind: "modified",
    path: "logs/huge.log",
    originalPath: undefined,
    similarity: undefined,
    additions: 50_000,
    deletions: 1,
    isBinary: false,
  },
];

export const detail: Scenario = {
  name: "detail",
  git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
  repoOpen: {
    kind: "ok",
    repo: {
      repoId: "/repos/detail",
      root: "/repos/detail",
      gitDir: "/repos/detail/.git",
      commonDir: "/repos/detail/.git",
      isBare: false,
      isLinkedWorktree: false,
      head: { kind: "branch", name: "main" },
    },
  },
  commits: decorated,
  details: {
    [tipSha]: [
      {
        body:
          "Implements the commit-detail pane's fixture data.\n\n" +
          "Covers every file-change kind and diff body shape in one commit.",
        trailers: [
          { token: "Reviewed-by", value: "Ada Lovelace <ada@example.com>" },
          { token: "Fixes", value: "#42" },
        ],
        signature: { status: "G", signer: "Ada Lovelace <ada@example.com>" },
        files: FILES,
      },
    ],
    [manyFilesSha]: [
      {
        body: "Touches 5,000 files to exercise the file tree's render cap.",
        trailers: [],
        signature: { status: "N", signer: "" },
        files: MANY_FILES,
      },
    ],
  },
  diffs: {
    [diffKey(tipSha, "src/added.ts")]: {
      kind: "text",
      hunks: [
        hunk(0, 0, 1, 3, [
          add("export function added(): number {", 1),
          add("  return 1;", 2),
          add("}", 3),
        ]),
      ],
    },
    [diffKey(tipSha, "src/modified.ts")]: {
      kind: "text",
      hunks: [
        hunk(1, 6, 1, 8, [
          ctx("export function modified(): number {", 1, 1),
          del("  const a = 1;", 2),
          del("  const b = 2;", 3),
          add("  const a = 10;", 2),
          add("  const b = 20;", 3),
          add("  const c = 30;", 4),
          ctx("  return a + b;", 4, 5),
          ctx("}", 5, 6),
        ]),
      ],
    },
    [diffKey(tipSha, "src/deleted.ts")]: {
      kind: "text",
      hunks: [
        hunk(1, 3, 0, 0, [
          del("export function deleted(): void {}", 1),
          del("", 2),
          del("// eof", 3),
        ]),
      ],
    },
    [diffKey(tipSha, "src/renamed-new.ts")]: {
      kind: "text",
      hunks: [
        hunk(1, 3, 1, 4, [
          ctx("export function renamed(): number {", 1, 1),
          del("  return 1;", 2),
          add("  return 2;", 2),
          add("  // renamed and edited", 3),
          ctx("}", 3, 4),
        ]),
      ],
    },
    [diffKey(tipSha, "src/copied-new.ts")]: { kind: "empty", reason: "identical" },
    [diffKey(tipSha, "assets/image.png")]: { kind: "binary", oldBytes: 10_240, newBytes: 20_480 },
    [diffKey(tipSha, "assets/large-asset.bin")]: {
      kind: "lfsPointer",
      oid: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85",
      bytes: 104_857_600,
    },
    [diffKey(tipSha, "logs/huge.log")]: {
      kind: "tooLarge",
      bytes: 6_291_456,
      limitBytes: 5_242_880,
    },
  },
};
