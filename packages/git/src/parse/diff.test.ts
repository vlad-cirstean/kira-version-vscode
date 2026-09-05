import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFileDiffBody } from "./diff.ts";

const FIXTURES = join(import.meta.dir, "../../../../tests/fixtures/porcelain/diffBody");

function load(name: string): Uint8Array {
  return readFileSync(join(FIXTURES, `${name}.bin`));
}

const encoder = new TextEncoder();

describe("parseFileDiffBody — text", () => {
  test("a single hunk, ordinary modification", () => {
    const body = parseFileDiffBody(load("text-simple"));
    expect(body.kind).toBe("text");
    if (body.kind !== "text") return;
    expect(body.hunks).toHaveLength(1);
    const hunk = body.hunks[0];
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, heading: "" });
    expect(hunk?.lines.map((l) => [l.kind, l.text])).toEqual([
      ["context", "line1"],
      ["context", "line2"],
      ["add", "line3"],
    ]);
    expect(hunk?.lines.map((l) => l.oldLine)).toEqual([1, 2, undefined]);
    expect(hunk?.lines.map((l) => l.newLine)).toEqual([1, 2, 3]);
    expect(hunk?.lines.every((l) => !l.noNewlineAtEof)).toBe(true);
  });

  test("a multi-hunk patch: each hunk's numbers and heading come from its own header", () => {
    const body = parseFileDiffBody(load("text-multiHunk"));
    expect(body.kind).toBe("text");
    if (body.kind !== "text") return;
    expect(body.hunks).toHaveLength(2);
    expect(body.hunks[0]).toMatchObject({
      oldStart: 2,
      oldLines: 1,
      newStart: 2,
      newLines: 1,
      heading: "function foo() {",
    });
    expect(body.hunks[1]).toMatchObject({
      oldStart: 6,
      oldLines: 1,
      newStart: 6,
      newLines: 1,
      heading: "function bar() {",
    });
    expect(body.hunks[0]?.lines.map((l) => l.text)).toEqual(["  return 1;", "  return 100;"]);
    expect(body.hunks[1]?.lines.map((l) => l.text)).toEqual(["  return 2;", "  return 200;"]);
  });

  test("\\ No newline at end of file attached to the removed line, not the added one", () => {
    const body = parseFileDiffBody(load("text-noNewlineOnDel"));
    expect(body.kind).toBe("text");
    if (body.kind !== "text") return;
    const [del, add] = body.hunks[0]?.lines ?? [];
    expect(del?.kind).toBe("del");
    expect(del?.noNewlineAtEof).toBe(true);
    expect(add?.kind).toBe("add");
    expect(add?.noNewlineAtEof).toBe(false);
  });

  test("\\ No newline at end of file attached to the added line, not the removed one", () => {
    const body = parseFileDiffBody(load("text-noNewlineOnAdd"));
    expect(body.kind).toBe("text");
    if (body.kind !== "text") return;
    const [del, add] = body.hunks[0]?.lines ?? [];
    expect(del?.kind).toBe("del");
    expect(del?.noNewlineAtEof).toBe(false);
    expect(add?.kind).toBe("add");
    expect(add?.noNewlineAtEof).toBe(true);
  });
});

describe("parseFileDiffBody — binary", () => {
  test("an added binary file: no old oid, a new oid", () => {
    const body = parseFileDiffBody(load("binary-add"));
    expect(body.kind).toBe("binary");
    if (body.kind !== "binary") return;
    expect(body.oldOid).toBeUndefined();
    expect(body.newOid).toMatch(/^[0-9a-f]+$/);
  });

  test("a modified binary file: both oids present", () => {
    const body = parseFileDiffBody(load("binary-modify"));
    expect(body.kind).toBe("binary");
    if (body.kind !== "binary") return;
    expect(body.oldOid).toBeDefined();
    expect(body.newOid).toBeDefined();
    expect(body.oldOid).not.toBe(body.newOid);
  });

  test("a deleted binary file: an old oid, no new oid", () => {
    const body = parseFileDiffBody(load("binary-delete"));
    expect(body.kind).toBe("binary");
    if (body.kind !== "binary") return;
    expect(body.oldOid).toBeDefined();
    expect(body.newOid).toBeUndefined();
  });
});

describe("parseFileDiffBody — lfsPointer", () => {
  test("an added LFS pointer file is recognised from its first hunk's content", () => {
    const body = parseFileDiffBody(load("lfsPointer-add"));
    expect(body).toEqual({ kind: "lfsPointer", oid: "a".repeat(64), bytes: 123456 });
  });
});

describe("parseFileDiffBody — empty", () => {
  test("a mode change with no content change", () => {
    const body = parseFileDiffBody(load("empty-modeChangeOnly"));
    expect(body).toEqual({ kind: "empty", reason: "modeChangeOnly" });
  });

  test("a pure (100% similarity) rename: identical content, nothing to render", () => {
    const body = parseFileDiffBody(load("empty-identicalPureRename"));
    expect(body).toEqual({ kind: "empty", reason: "identical" });
  });

  test("zero bytes of input: identical, not a crash", () => {
    expect(parseFileDiffBody(new Uint8Array(0))).toEqual({ kind: "empty", reason: "identical" });
  });
});

describe("parseFileDiffBody — malformed input", () => {
  test("a hunk whose line counts disagree with its header throws, never renders silently", () => {
    const honest = encoder.encode(
      "diff --git a/a.txt b/a.txt\n" +
        "index aaaaaaa..bbbbbbb 100644\n" +
        "--- a/a.txt\n" +
        "+++ b/a.txt\n" +
        "@@ -1,2 +1,2 @@\n" +
        " line one\n" +
        "-line two\n" +
        "+line two changed\n",
    );
    // Same body, but the header now claims 5 old/new lines instead of the 2 actually present.
    const corrupted = encoder.encode(
      "diff --git a/a.txt b/a.txt\n" +
        "index aaaaaaa..bbbbbbb 100644\n" +
        "--- a/a.txt\n" +
        "+++ b/a.txt\n" +
        "@@ -1,5 +1,5 @@\n" +
        " line one\n" +
        "-line two\n" +
        "+line two changed\n",
    );
    expect(() => parseFileDiffBody(honest)).not.toThrow();
    expect(() => parseFileDiffBody(corrupted)).toThrow(/hunk line counts disagree/);
  });
});
