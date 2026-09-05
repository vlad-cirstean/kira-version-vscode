import { describe, expect, test } from "bun:test";
import {
  type DiffHunk,
  type DiffLine,
  flattenDiffRows,
  mapDiffLineToRevision,
  mapLineAcrossDiff,
  splitTrailerBlock,
} from "./diff.ts";

function line(partial: Partial<DiffLine> & { kind: DiffLine["kind"] }): DiffLine {
  return {
    text: "",
    oldLine: undefined,
    newLine: undefined,
    noNewlineAtEof: false,
    ...partial,
  };
}

function hunk(partial: Partial<DiffHunk> & Pick<DiffHunk, "lines">): DiffHunk {
  return {
    oldStart: 1,
    oldLines: partial.lines.length,
    newStart: 1,
    newLines: partial.lines.length,
    heading: "",
    ...partial,
  };
}

describe("mapDiffLineToRevision", () => {
  // A single hunk: context(10/10), del(11/-), del(12/-), add(-/11), add(-/12), add(-/13), add(-/14).
  const hunkA: DiffHunk = {
    oldStart: 10,
    oldLines: 3,
    newStart: 10,
    newLines: 5,
    heading: "",
    lines: [
      line({ kind: "context", oldLine: 10, newLine: 10 }),
      line({ kind: "del", oldLine: 11 }),
      line({ kind: "del", oldLine: 12 }),
      line({ kind: "add", newLine: 11 }),
      line({ kind: "add", newLine: 12 }),
      line({ kind: "add", newLine: 13 }),
      line({ kind: "add", newLine: 14 }),
    ],
  };
  const rowsA = flattenDiffRows([hunkA]);
  const rowIndexOf = (lineIndex: number) =>
    rowsA.findIndex((r) => r.kind === "line" && r.hunkIndex === 0 && r.lineIndex === lineIndex);

  test("context row resolves on both sides", () => {
    const row = rowIndexOf(0);
    expect(mapDiffLineToRevision([hunkA], row, "old")).toBe(10);
    expect(mapDiffLineToRevision([hunkA], row, "new")).toBe(10);
  });

  test("add row: exact on new, backwards-scan on old", () => {
    const row = rowIndexOf(3); // first add, newLine=11
    expect(mapDiffLineToRevision([hunkA], row, "new")).toBe(11);
    // nearest preceding old-numbered row is del(12) -> 12 + 1 = 13
    expect(mapDiffLineToRevision([hunkA], row, "old")).toBe(13);
  });

  test("del row: exact on old, backwards-scan on new", () => {
    const row = rowIndexOf(1); // first del, oldLine=11
    expect(mapDiffLineToRevision([hunkA], row, "old")).toBe(11);
    // nearest preceding new-numbered row is context(10) -> 10 + 1 = 11
    expect(mapDiffLineToRevision([hunkA], row, "new")).toBe(11);
  });

  test("first row of hunk with no preceding number falls back to hunk.<side>Start", () => {
    const pureInsertion = hunk({
      oldStart: 5,
      oldLines: 0,
      newStart: 10,
      newLines: 2,
      lines: [line({ kind: "add", newLine: 10 }), line({ kind: "add", newLine: 11 })],
    });
    const rows = flattenDiffRows([pureInsertion]);
    const firstLineRow = rows.findIndex((r) => r.kind === "line" && r.lineIndex === 0);
    expect(mapDiffLineToRevision([pureInsertion], firstLineRow, "old")).toBe(5);
  });

  test("hunk-header row resolves to hunk.<side>Start", () => {
    const headerRow = rowsA.findIndex((r) => r.kind === "hunkHeader");
    expect(mapDiffLineToRevision([hunkA], headerRow, "old")).toBe(10);
    expect(mapDiffLineToRevision([hunkA], headerRow, "new")).toBe(10);
  });

  test("file header / no hunks / out-of-range row maps to 1", () => {
    expect(mapDiffLineToRevision([], 0, "old")).toBe(1);
    expect(mapDiffLineToRevision([hunkA], -1, "old")).toBe(1);
    expect(mapDiffLineToRevision([hunkA], 9999, "old")).toBe(1);
  });

  test("second hunk's numbers come from its own header, not a running counter", () => {
    const hunkC = hunk({
      oldStart: 100,
      oldLines: 1,
      newStart: 100,
      newLines: 1,
      lines: [line({ kind: "context", oldLine: 100, newLine: 100 })],
    });
    const rows = flattenDiffRows([hunkA, hunkC]);
    const headerRow = rows.findIndex(
      (r, i) => r.kind === "hunkHeader" && r.hunkIndex === 1 && i > 0,
    );
    expect(mapDiffLineToRevision([hunkA, hunkC], headerRow, "old")).toBe(100);
    expect(mapDiffLineToRevision([hunkA, hunkC], headerRow, "new")).toBe(100);
  });

  test("added file hunk header (@@ -0,0 +1,N @@) clamps old side to 1", () => {
    const addedFile = hunk({
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 2,
      lines: [line({ kind: "add", newLine: 1 }), line({ kind: "add", newLine: 2 })],
    });
    const rows = flattenDiffRows([addedFile]);
    const headerRow = rows.findIndex((r) => r.kind === "hunkHeader");
    expect(mapDiffLineToRevision([addedFile], headerRow, "old")).toBe(1);
  });

  test("deleted file hunk header (@@ -1,N +0,0 @@) clamps new side to 1", () => {
    const deletedFile = hunk({
      oldStart: 1,
      oldLines: 2,
      newStart: 0,
      newLines: 0,
      lines: [line({ kind: "del", oldLine: 1 }), line({ kind: "del", oldLine: 2 })],
    });
    const rows = flattenDiffRows([deletedFile]);
    const headerRow = rows.findIndex((r) => r.kind === "hunkHeader");
    expect(mapDiffLineToRevision([deletedFile], headerRow, "new")).toBe(1);
  });

  test("a trailing noNewlineAtEof marker is an attribute, not a phantom row", () => {
    const h = hunk({
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [line({ kind: "context", oldLine: 1, newLine: 1, noNewlineAtEof: true })],
    });
    const rows = flattenDiffRows([h]);
    // header + exactly one line row, never an extra row for the marker.
    expect(rows.length).toBe(2);
    const lastRow = rows.length - 1;
    expect(mapDiffLineToRevision([h], lastRow, "old")).toBe(1);
    expect(mapDiffLineToRevision([h], lastRow, "new")).toBe(1);
  });
});

describe("mapLineAcrossDiff", () => {
  // Net +2 insertion (old 10-12, new 10-14).
  const hunkF: DiffHunk = {
    oldStart: 10,
    oldLines: 3,
    newStart: 10,
    newLines: 5,
    heading: "",
    lines: [
      line({ kind: "context", oldLine: 10, newLine: 10 }),
      line({ kind: "del", oldLine: 11 }),
      line({ kind: "del", oldLine: 12 }),
      line({ kind: "add", newLine: 11 }),
      line({ kind: "add", newLine: 12 }),
      line({ kind: "add", newLine: 13 }),
      line({ kind: "add", newLine: 14 }),
    ],
  };
  // Net -1 of its own across old 30-34 -> new 32-35, on top of hunkF's cumulative +2 => final
  // cumulative delta after both hunks is +1 (not hunkF's +2, and not a summed +1).
  const hunkG = hunk({
    oldStart: 30,
    oldLines: 5,
    newStart: 32,
    newLines: 4,
    lines: [
      line({ kind: "del", oldLine: 30 }),
      line({ kind: "del", oldLine: 31 }),
      line({ kind: "del", oldLine: 32 }),
      line({ kind: "context", oldLine: 33, newLine: 32 }),
      line({ kind: "context", oldLine: 34, newLine: 33 }),
      line({ kind: "add", newLine: 34 }),
      line({ kind: "add", newLine: 35 }),
    ],
  });

  test("hunks empty -> identity", () => {
    expect(mapLineAcrossDiff([], 5, "old")).toBe(5);
    expect(mapLineAcrossDiff([], 5, "new")).toBe(5);
  });

  test("line above the first hunk: delta 0, unchanged", () => {
    expect(mapLineAcrossDiff([hunkF, hunkG], 5, "old")).toBe(5);
  });

  test("line below the last hunk: delta from that hunk's own cumulative value", () => {
    // final cumulative delta after both hunks is +1, not +2 (hunkF alone) nor +2+(-1) summed twice.
    expect(mapLineAcrossDiff([hunkF, hunkG], 100, "old")).toBe(101);
  });

  test("line between two hunks: delta from the nearer preceding hunk", () => {
    // 20 sits after hunkF (old extent ends at 13) and before hunkG (old extent starts at 30).
    expect(mapLineAcrossDiff([hunkF, hunkG], 20, "old")).toBe(22);
  });

  test("line deleted on the from side arrives via delegation to mapDiffLineToRevision", () => {
    // old line 12 is del'd in hunkF; the per-row backwards-scan finds context(10/10) and answers
    // 10 + 1 = 11, the same value a direct mapDiffLineToRevision call on that row would give.
    expect(mapLineAcrossDiff([hunkF, hunkG], 12, "old")).toBe(11);
  });

  test("pure-insertion and pure-deletion hunks: delta sign flips with direction", () => {
    const insertion = hunk({
      oldStart: 5,
      oldLines: 0,
      newStart: 5,
      newLines: 3,
      lines: [
        line({ kind: "add", newLine: 5 }),
        line({ kind: "add", newLine: 6 }),
        line({ kind: "add", newLine: 7 }),
      ],
    });
    expect(mapLineAcrossDiff([insertion], 10, "old")).toBe(13);
    expect(mapLineAcrossDiff([insertion], 10, "new")).toBe(7);

    const deletion = hunk({
      oldStart: 5,
      oldLines: 3,
      newStart: 5,
      newLines: 0,
      lines: [
        line({ kind: "del", oldLine: 5 }),
        line({ kind: "del", oldLine: 6 }),
        line({ kind: "del", oldLine: 7 }),
      ],
    });
    expect(mapLineAcrossDiff([deletion], 10, "old")).toBe(7);
    expect(mapLineAcrossDiff([deletion], 10, "new")).toBe(13);
  });

  test("line far beyond the end of file: still line + delta", () => {
    const insertion = hunk({
      oldStart: 5,
      oldLines: 0,
      newStart: 5,
      newLines: 3,
      lines: [
        line({ kind: "add", newLine: 5 }),
        line({ kind: "add", newLine: 6 }),
        line({ kind: "add", newLine: 7 }),
      ],
    });
    expect(mapLineAcrossDiff([insertion], 1000, "old")).toBe(1003);
  });
});

describe("splitTrailerBlock", () => {
  test("empty body, trailers present: returned unchanged", () => {
    expect(splitTrailerBlock("", [{ token: "Signed-off-by", value: "A <a@example.com>" }])).toBe(
      "",
    );
  });

  test("body that is only trailers: empty result", () => {
    const body = "Signed-off-by: A <a@example.com>";
    expect(splitTrailerBlock(body, [{ token: "Signed-off-by", value: "A <a@example.com>" }])).toBe(
      "",
    );
  });

  test("no trailers returned by git: body returned unchanged, even with a colon-prefixed line", () => {
    const body = "Subject detail.\n\nNote: this looks like a trailer but git says it is not.";
    expect(splitTrailerBlock(body, [])).toBe(body);
  });

  test("folded trailer continuation line is part of the dropped paragraph", () => {
    const body =
      "Explanation paragraph.\n\nSigned-off-by: A <a@example.com>\n    continuation of a folded value";
    expect(
      splitTrailerBlock(body, [
        { token: "Signed-off-by", value: "A <a@example.com> continuation" },
      ]),
    ).toBe("Explanation paragraph.");
  });

  test("trailing blank lines after the trailer paragraph are also dropped", () => {
    const body = "Body text.\n\nSigned-off-by: A <a@example.com>\n\n\n";
    expect(splitTrailerBlock(body, [{ token: "Signed-off-by", value: "A <a@example.com>" }])).toBe(
      "Body text.",
    );
  });
});
