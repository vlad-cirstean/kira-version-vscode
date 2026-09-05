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
 */
const COMMIT_SPEC = ["root", "tip:root"];
const commits = topology(COMMIT_SPEC);

const DECORATIONS: Readonly<Record<string, readonly DecorationRef[]>> = {
  tip: [
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

const decorated = decorate(commits);
// `topology()`'s newest-first order puts "tip" at index 0 — see this file's own `COMMIT_SPEC`.
const tip = decorated[0];
if (!tip) throw new Error("detail scenario: topology() produced no commits");
const tipSha = tip.sha;

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
