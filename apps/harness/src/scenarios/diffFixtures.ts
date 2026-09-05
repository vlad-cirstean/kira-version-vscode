/**
 * Tiny builders for hand-written `DiffHunk`/`DiffLine` fixtures (P5 W12) — every `diffs`/
 * `worktreeDrift` entry a scenario needs is a handful of lines, and writing out the full
 * `DiffLine` shape (five fields, most of them `undefined`) at each call site is the kind of
 * repetition that hides the one field that actually varies. Not exported from `@kira-version/
 * core`: this is fixture-authoring sugar, not part of the wire model those types describe.
 */
import type { DiffHunk, DiffLine } from "@kira-version/core";

/** A context line: present, unchanged, on both sides. */
export function ctx(text: string, oldLine: number, newLine: number): DiffLine {
  return { kind: "context", text, oldLine, newLine, noNewlineAtEof: false };
}

/** An added line: `new`-side only. */
export function add(text: string, newLine: number): DiffLine {
  return { kind: "add", text, oldLine: undefined, newLine, noNewlineAtEof: false };
}

/** A deleted line: `old`-side only. */
export function del(text: string, oldLine: number): DiffLine {
  return { kind: "del", text, oldLine, newLine: undefined, noNewlineAtEof: false };
}

export function hunk(
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
  lines: readonly DiffLine[],
  heading = "",
): DiffHunk {
  return { oldStart, oldLines, newStart, newLines, heading, lines };
}
