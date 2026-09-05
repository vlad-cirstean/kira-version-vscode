import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RecordSplitter } from "@kira-version/core";
import { parseNameStatusRecords, parseNumstatRecords } from "./diffTree.ts";

const FIXTURES = join(import.meta.dir, "../../../../tests/fixtures/porcelain/diffTree");
const HAND_AUTHORED = join(import.meta.dir, "../../../../tests/fixtures/porcelain/handAuthored");

function loadRecords(dir: string, name: string): Uint8Array[] {
  const bytes = readFileSync(join(dir, `${name}.bin`));
  const splitter = new RecordSplitter();
  const records = splitter.push(bytes);
  const tail = splitter.finish();
  return tail !== undefined ? [...records, tail] : records;
}

describe("parseNumstatRecords", () => {
  test("plain additions/deletions, no rename involved", () => {
    const entries = parseNumstatRecords(loadRecords(FIXTURES, "numstat-simple"));
    const a = entries.find((e) => e.path === "a.txt");
    const b = entries.find((e) => e.path === "b.txt");
    expect(a).toEqual({
      path: "a.txt",
      originalPath: undefined,
      additions: 1,
      deletions: 0,
      isBinary: false,
    });
    expect(b).toEqual({
      path: "b.txt",
      originalPath: undefined,
      additions: 1,
      deletions: 0,
      isBinary: false,
    });
  });

  test("a binary file reports '-'/'-' as undefined additions/deletions", () => {
    const [entry] = parseNumstatRecords(loadRecords(FIXTURES, "numstat-binary"));
    expect(entry).toEqual({
      path: "blob.bin",
      originalPath: undefined,
      additions: undefined,
      deletions: undefined,
      isBinary: true,
    });
  });

  test("a root commit diffs against the empty tree", () => {
    const [entry] = parseNumstatRecords(loadRecords(FIXTURES, "root-numstat"));
    expect(entry).toEqual({
      path: "file.txt",
      originalPath: undefined,
      additions: 1,
      deletions: 0,
      isBinary: false,
    });
  });

  test("a pure rename (-M -C) consumes two path chunks and reports the true 0/0 delta", () => {
    const [entry] = parseNumstatRecords(loadRecords(FIXTURES, "numstat-rename"));
    expect(entry).toEqual({
      path: "new.txt",
      originalPath: "old.txt",
      additions: 0,
      deletions: 0,
      isBinary: false,
    });
  });

  test("a rename with an edit (P1 fix): true +1/-0 delta, not an independent delete+add", () => {
    const [entry] = parseNumstatRecords(loadRecords(FIXTURES, "numstat-renameWithEdit"));
    expect(entry).toEqual({
      path: "new.txt",
      originalPath: "old.txt",
      additions: 1,
      deletions: 0,
      isBinary: false,
    });
  });
});

describe("parseNameStatusRecords", () => {
  test("ordinary M/A entries each consume exactly one path chunk", () => {
    const entries = parseNameStatusRecords(loadRecords(FIXTURES, "nameStatus-ordinary"));
    expect(entries).toEqual([
      { kind: "modified", path: "a.txt", originalPath: undefined, similarity: undefined },
      { kind: "added", path: "b.txt", originalPath: undefined, similarity: undefined },
    ]);
  });

  test("a rename consumes two path chunks (originalPath, then path)", () => {
    const entries = parseNameStatusRecords(loadRecords(FIXTURES, "nameStatus-rename"));
    expect(entries).toEqual([
      { kind: "renamed", path: "new.txt", originalPath: "old.txt", similarity: 100 },
    ]);
  });

  test("a rename with an edit in the same commit still reports rename linkage", () => {
    const entries = parseNameStatusRecords(loadRecords(FIXTURES, "nameStatus-renameWithEdit"));
    expect(entries).toEqual([
      { kind: "renamed", path: "new.txt", originalPath: "old.txt", similarity: 83 },
    ]);
  });

  test("a copy is distinct from a rename and the original is retained", () => {
    const entries = parseNameStatusRecords(loadRecords(FIXTURES, "nameStatus-copy"));
    const copy = entries.find((e) => e.kind === "copied");
    expect(copy).toEqual({
      kind: "copied",
      path: "copy.txt",
      originalPath: "orig.txt",
      similarity: 100,
    });
    const modified = entries.find((e) => e.kind === "modified");
    expect(modified?.path).toBe("orig.txt");
  });

  test("a root commit's added file", () => {
    const entries = parseNameStatusRecords(loadRecords(FIXTURES, "root-nameStatus"));
    expect(entries).toEqual([
      { kind: "added", path: "file.txt", originalPath: undefined, similarity: undefined },
    ]);
  });

  test("a merge commit's diff against each parent independently", () => {
    const parent1 = parseNameStatusRecords(loadRecords(FIXTURES, "mergeParent1-nameStatus"));
    const parent2 = parseNameStatusRecords(loadRecords(FIXTURES, "mergeParent2-nameStatus"));
    expect(parent1.length).toBeGreaterThan(0);
    expect(parent2.length).toBeGreaterThan(0);
  });

  test("a path containing a raw newline is framed correctly by NUL, not corrupted", () => {
    const entries = parseNameStatusRecords(
      loadRecords(HAND_AUTHORED, "pathWithNewline-nameStatus"),
    );
    expect(entries).toEqual([
      { kind: "added", path: "line\nbreak.txt", originalPath: undefined, similarity: undefined },
    ]);
  });

  test("a non-UTF-8 path decodes without throwing (lossy, not corrupt-the-parser)", () => {
    const entries = parseNameStatusRecords(loadRecords(HAND_AUTHORED, "nonUtf8Path-nameStatus"));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("added");
    expect(entries[0]?.path.startsWith("bad")).toBe(true);
    expect(entries[0]?.path.endsWith(".txt")).toBe(true);
  });
});
