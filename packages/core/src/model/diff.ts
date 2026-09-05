/**
 * P5's diff model (§4.4, §6.4, D14a) — the shapes that carry a unified diff across the wire and
 * the one genuinely algorithmic thing this phase does: mapping a diff-view cursor row onto a
 * line number in some revision (`mapDiffLineToRevision`), and re-mapping that line across a
 * second diff, commit → working tree (`mapLineAcrossDiff`, the drift re-map "Go to file" needs on
 * its live-file branch — see `docs/plans/P5.md`'s "The second map"). Both are pure, synchronous,
 * framework-free — `packages/core`'s standing rule — and are exhaustively unit tested rather than
 * left to integration tests, per `AGENTS.md`'s "cursor/page arithmetic with real boundary cases"
 * clause.
 */
import type { FileChange } from "./commit.ts";

export interface CommitTrailer {
  readonly token: string;
  readonly value: string;
}

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Without the leading marker character. */
  readonly text: string;
  readonly oldLine: number | undefined;
  readonly newLine: number | undefined;
  /** git's `\ No newline at end of file`, attached to the line it followed. */
  readonly noNewlineAtEof: boolean;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** Whatever git put after the closing `@@` — rendered in the hunk header row. */
  readonly heading: string;
  readonly lines: readonly DiffLine[];
}

export type FileDiffBody =
  | { readonly kind: "text"; readonly hunks: readonly DiffHunk[] }
  | {
      readonly kind: "binary";
      readonly oldBytes: number | undefined;
      readonly newBytes: number | undefined;
    }
  | { readonly kind: "lfsPointer"; readonly oid: string; readonly bytes: number }
  | { readonly kind: "tooLarge"; readonly bytes: number; readonly limitBytes: number }
  | { readonly kind: "empty"; readonly reason: "modeChangeOnly" | "identical" };

export interface FileDiff {
  readonly sha: string;
  /** Which parent `body` is diffed against — always 0 for a non-merge. */
  readonly parentIndex: number;
  /** The pre-image revision, or `null` for a root commit (diffed against the empty tree). */
  readonly baseSha: string | null;
  /** Echoed so a renderer has status, rename arrow and counts with no second lookup. */
  readonly change: FileChange;
  readonly body: FileDiffBody;
}

export type DiffSide = "old" | "new";

function otherSide(side: DiffSide): DiffSide {
  return side === "old" ? "new" : "old";
}

function clamp1(n: number): number {
  return n < 1 ? 1 : n;
}

/**
 * One flattened, renderable row of a parsed diff — a hunk header, or one of a hunk's content
 * lines. `DiffView.vue` (W9) renders from exactly this list, and `mapDiffLineToRevision`'s
 * `rowIndex` is an index into it — the two are never allowed to disagree about what "row 7"
 * means because both are built from the same function.
 */
export type DiffRow =
  | { readonly kind: "hunkHeader"; readonly hunkIndex: number }
  | { readonly kind: "line"; readonly hunkIndex: number; readonly lineIndex: number };

export function flattenDiffRows(hunks: readonly DiffHunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  hunks.forEach((hunk, hunkIndex) => {
    rows.push({ kind: "hunkHeader", hunkIndex });
    hunk.lines.forEach((_line, lineIndex) => {
      rows.push({ kind: "line", hunkIndex, lineIndex });
    });
  });
  return rows;
}

/**
 * Maps a diff row to a line number in `side`'s revision. `docs/plans/P5.md`'s "The line map"
 * spells out the table this implements — restated here only as code, not re-derived:
 *
 *   - a row that carries a number on `side` → that number (context always does; `add` on
 *     `"new"`; `del` on `"old"`);
 *   - a row with no number on `side` (`add` mapped to `"old"`, `del` mapped to `"new"`) → scan
 *     backwards within the same hunk for the nearest row that has one; answer is that number + 1,
 *     or `hunk.<side>Start` if the hunk has none before it;
 *   - a hunk-header row → `hunk.<side>Start`;
 *   - the file header, or a diff with no hunks → `1`.
 *
 * `rowIndex` indexes `flattenDiffRows(hunks)` — a row index that does not resolve to one (the
 * file header, or anything before the first hunk) is the last case above. Result is always
 * clamped to `≥ 1` (an added file's old-side mapping would otherwise land on `hunk.oldStart`,
 * which for `@@ -0,0 +1,N @@` is `0`).
 */
export function mapDiffLineToRevision(
  hunks: readonly DiffHunk[],
  rowIndex: number,
  side: DiffSide,
): number {
  if (hunks.length === 0) return 1;
  const rows = flattenDiffRows(hunks);
  const row = rows[rowIndex];
  if (row === undefined) return 1;

  const hunk = hunks[row.hunkIndex];
  if (hunk === undefined) return 1;
  const hunkStart = side === "old" ? hunk.oldStart : hunk.newStart;

  if (row.kind === "hunkHeader") return clamp1(hunkStart);

  const line = hunk.lines[row.lineIndex];
  if (line === undefined) return clamp1(hunkStart);
  const number = side === "old" ? line.oldLine : line.newLine;
  if (number !== undefined) return clamp1(number);

  for (let i = row.lineIndex - 1; i >= 0; i--) {
    const candidate = hunk.lines[i];
    const candidateNumber = candidate && (side === "old" ? candidate.oldLine : candidate.newLine);
    if (candidateNumber !== undefined) return clamp1(candidateNumber + 1);
  }
  return clamp1(hunkStart);
}

/**
 * The drift re-map (`docs/plans/P5.md`'s "The second map"): re-maps `line`, known on the `from`
 * side of `hunks`, to the corresponding line on the other side. A thin wrapper, not a second
 * algorithm — it either delegates to `mapDiffLineToRevision` (when some row actually carries
 * `line` on the `from` side) or falls back to the closed form `line + Δ`, where `Δ` is the
 * cumulative net insertion (new lines minus old lines) of every hunk ending at or before `line`
 * on the `from` side (`0` before the first hunk) — see "The line map"'s "general form" for why
 * this is the same arithmetic the per-row table already computes. `Δ` is signed old→new; mapping
 * new→old negates it, since the same per-hunk cumulative value describes both directions. `hunks`
 * empty → `line` unchanged. Result clamped to `≥ 1`.
 */
export function mapLineAcrossDiff(
  hunks: readonly DiffHunk[],
  line: number,
  from: DiffSide,
): number {
  if (hunks.length === 0) return line;

  const rows = flattenDiffRows(hunks);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (row === undefined || row.kind !== "line") continue;
    const hunk = hunks[row.hunkIndex];
    const diffLine = hunk?.lines[row.lineIndex];
    const number = diffLine && (from === "old" ? diffLine.oldLine : diffLine.newLine);
    if (number === line) return clamp1(mapDiffLineToRevision(hunks, rowIndex, otherSide(from)));
  }

  let delta = 0;
  for (const hunk of hunks) {
    const fromEnd = from === "old" ? hunk.oldStart + hunk.oldLines : hunk.newStart + hunk.newLines;
    if (fromEnd > line) break;
    const rawDelta = hunk.newStart + hunk.newLines - (hunk.oldStart + hunk.oldLines);
    // `rawDelta` is signed new-minus-old. Mapping old→new adds it; new→old subtracts it.
    delta = from === "old" ? rawDelta : -rawDelta;
  }
  return clamp1(line + delta);
}

const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*:/;
const FOLDED_CONTINUATION = /^\s/;

/**
 * Removes the trailer paragraph git's `%(trailers:...)` already parsed out of `body`'s own text
 * (probe P5, `docs/plans/P5.md`) — `%b` still contains it verbatim. The rule: take the final
 * blank-line-separated paragraph of `body`; drop it iff at least one trailer was returned *and*
 * every line of that paragraph either looks like a trailer (`^[A-Za-z][A-Za-z0-9-]*:`) or is a
 * folded continuation (starts with whitespace). No trailers → `body` is returned unchanged
 * without inspecting it at all — this is what leaves alone a last paragraph that merely contains
 * a colon (git already determined there is no real trailer block).
 */
export function splitTrailerBlock(body: string, trailers: readonly CommitTrailer[]): string {
  if (trailers.length === 0) return body;

  const lines = body.split("\n");
  let end = lines.length;
  while (end > 0 && (lines[end - 1]?.trim() ?? "") === "") end--;
  if (end === 0) return body;

  let start = end;
  while (start > 0 && (lines[start - 1]?.trim() ?? "") !== "") start--;

  const paragraph = lines.slice(start, end);
  const isTrailerShaped = (line: string): boolean =>
    TRAILER_LINE.test(line) || FOLDED_CONTINUATION.test(line);
  if (!paragraph.every(isTrailerShaped)) return body;

  const before = lines.slice(0, start);
  while (before.length > 0 && (before[before.length - 1]?.trim() ?? "") === "") before.pop();
  return before.join("\n");
}
