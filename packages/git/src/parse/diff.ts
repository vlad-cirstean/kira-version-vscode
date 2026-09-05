/**
 * The unified-diff parser for a single file's patch (§4.4, P5 W2, probe P4). Input is the raw
 * bytes of one `diff --git a/… b/…` section — W3's `fileDiff`/`worktreeDiff` build the argv and
 * hand this file exactly one file's worth of output; parsing multiple files is not this
 * function's job. Output is the structural half of `FileDiffBody` (core's model) — the "binary"
 * shape here carries the two blob oids from the `index` line rather than byte sizes, because
 * turning an oid into a size is an async `cat-file --batch-check` round trip and this parser, like
 * every other file under `parse/`, is pure and synchronous. `repoService.fileDiff` (W3) does that
 * round trip and assembles the final `FileDiffBody`.
 *
 * Handles every shape probe P4 observed: the `diff --git` header, `similarity index` /
 * `rename from` / `rename to` (and their `copy` counterparts), `new file mode` /
 * `deleted file mode`, `old mode` / `new mode`, `index <old>..<new> <mode>` (oids are whatever
 * length git chose to abbreviate them to — `cat-file` resolves an abbreviated oid itself),
 * `--- a/x` / `+++ b/y` (including `/dev/null`), `@@` headers with and without a heading and with
 * omitted counts, all three line markers, `\ No newline at end of file` (which can appear twice
 * in one hunk — once for each side — when both the old and new last lines lack a trailing
 * newline), and `Binary files a/… and b/… differ`.
 *
 * Bytes, not strings, until the last moment: decoded with the same non-fatal `TextDecoder` every
 * other parser in `parse/` uses, so an invalid-UTF-8 file renders replacement characters rather
 * than throwing. Line content is kept byte-for-byte as git emits it — no CRLF normalization here
 * (`core.autocrlf` is the user's business, §4.1).
 */
import type { DiffHunk, DiffLine } from "@kira-version/core";

const decoder = new TextDecoder("utf-8", { fatal: false });

export type ParsedFileDiffBody =
  | { readonly kind: "text"; readonly hunks: readonly DiffHunk[] }
  | {
      readonly kind: "binary";
      readonly oldOid: string | undefined;
      readonly newOid: string | undefined;
    }
  | { readonly kind: "lfsPointer"; readonly oid: string; readonly bytes: number }
  | { readonly kind: "empty"; readonly reason: "modeChangeOnly" | "identical" };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const INDEX_LINE = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: \S+)?$/;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";
const LFS_VERSION_LINE = "version https://git-lfs.github.com/spec/v1";
const LFS_OID_LINE = /^oid sha256:([0-9a-f]{64})$/;
const LFS_SIZE_LINE = /^size (\d+)$/;

function isZeroOid(oid: string): boolean {
  return /^0+$/.test(oid);
}

/** D22: "a pointer file is recognisable from its first line" — sniffed in the patch itself
 *  rather than by re-reading the blob, which works for both sides of the diff at once. Prefers
 *  the first hunk's post-image (add/context) lines, since those are the file's current content;
 *  falls back to its del lines for a pointer file that was deleted outright. */
function sniffLfsPointer(hunks: readonly DiffHunk[]): { oid: string; bytes: number } | undefined {
  const first = hunks[0];
  if (!first) return undefined;
  const postImage = first.lines.filter((l) => l.kind === "add" || l.kind === "context");
  const lines = (postImage.length > 0 ? postImage : first.lines).map((l) => l.text);
  if (lines.length < 3) return undefined;
  if (lines[0] !== LFS_VERSION_LINE) return undefined;
  const oidMatch = lines[1] !== undefined ? LFS_OID_LINE.exec(lines[1]) : null;
  const sizeMatch = lines[2] !== undefined ? LFS_SIZE_LINE.exec(lines[2]) : null;
  if (!oidMatch || !sizeMatch || oidMatch[1] === undefined || sizeMatch[1] === undefined) {
    return undefined;
  }
  return { oid: oidMatch[1], bytes: Number(sizeMatch[1]) };
}

function parseHunks(lines: readonly string[], startIndex: number): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const headerLine = lines[i];
    if (headerLine === undefined || headerLine.length === 0) {
      i++;
      continue;
    }
    if (!headerLine.startsWith("@@")) {
      i++;
      continue;
    }
    const m = HUNK_HEADER.exec(headerLine);
    if (!m) {
      throw new Error(`git diff: unrecognised hunk header ${JSON.stringify(headerLine)}`);
    }
    const oldStart = Number(m[1]);
    const oldLines = m[2] !== undefined ? Number(m[2]) : 1;
    const newStart = Number(m[3]);
    const newLines = m[4] !== undefined ? Number(m[4]) : 1;
    const heading = m[5] ?? "";
    i++;

    const contentLines: DiffLine[] = [];
    let oldCounter = oldStart;
    let newCounter = newStart;
    let consumedOld = 0;
    let consumedNew = 0;

    const attachNoNewline = (): void => {
      const lastIndex = contentLines.length - 1;
      const last = contentLines[lastIndex];
      if (last) contentLines[lastIndex] = { ...last, noNewlineAtEof: true };
    };

    while (i < lines.length && (consumedOld < oldLines || consumedNew < newLines)) {
      const raw = lines[i];
      if (raw === undefined) break;
      if (raw.startsWith(NO_NEWLINE_MARKER)) {
        attachNoNewline();
        i++;
        continue;
      }
      const marker = raw[0];
      const text = raw.slice(1);
      if (marker === " ") {
        contentLines.push({
          kind: "context",
          text,
          oldLine: oldCounter,
          newLine: newCounter,
          noNewlineAtEof: false,
        });
        oldCounter++;
        newCounter++;
        consumedOld++;
        consumedNew++;
      } else if (marker === "-") {
        contentLines.push({
          kind: "del",
          text,
          oldLine: oldCounter,
          newLine: undefined,
          noNewlineAtEof: false,
        });
        oldCounter++;
        consumedOld++;
      } else if (marker === "+") {
        contentLines.push({
          kind: "add",
          text,
          oldLine: undefined,
          newLine: newCounter,
          noNewlineAtEof: false,
        });
        newCounter++;
        consumedNew++;
      } else {
        // Not a content line and not the no-newline marker — the hunk's declared counts were not
        // satisfied by what actually followed. Falls through to the mismatch check below rather
        // than looping forever.
        break;
      }
      i++;
    }
    // The marker can also follow the very last content line once the hunk's counts are already
    // satisfied (the common case: one file, one "no newline" side).
    if (lines[i]?.startsWith(NO_NEWLINE_MARKER) ?? false) {
      attachNoNewline();
      i++;
    }

    if (consumedOld !== oldLines || consumedNew !== newLines) {
      throw new Error(
        `git diff: hunk line counts disagree with its header ` +
          `(@@ -${oldStart},${oldLines} +${newStart},${newLines} @@ reported ` +
          `${consumedOld} old / ${consumedNew} new lines actually present)`,
      );
    }
    hunks.push({ oldStart, oldLines, newStart, newLines, heading, lines: contentLines });
  }
  return hunks;
}

export function parseFileDiffBody(bytes: Uint8Array): ParsedFileDiffBody {
  const text = decoder.decode(bytes);
  if (text.length === 0) return { kind: "empty", reason: "identical" };

  const lines = text.split("\n");
  let i = 0;
  if (!(lines[i]?.startsWith("diff --git ") ?? false)) {
    // No recognisable header at all — never crash the pane over an unexpected invocation; the
    // honest fallback is "nothing to show".
    return { kind: "empty", reason: "identical" };
  }
  i++;

  let modeChanged = false;
  let oldOid: string | undefined;
  let newOid: string | undefined;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    if (line.startsWith("old mode ") || line.startsWith("new mode ")) {
      modeChanged = true;
      continue;
    }
    if (
      line.startsWith("deleted file mode ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("dissimilarity index ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ") ||
      line.startsWith("copy from ") ||
      line.startsWith("copy to ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      continue;
    }
    const indexMatch = INDEX_LINE.exec(line);
    if (indexMatch) {
      const [, rawOld, rawNew] = indexMatch;
      oldOid = rawOld !== undefined && !isZeroOid(rawOld) ? rawOld : undefined;
      newOid = rawNew !== undefined && !isZeroOid(rawNew) ? rawNew : undefined;
      continue;
    }
    if (line.startsWith("Binary files ")) {
      return { kind: "binary", oldOid, newOid };
    }
    if (line.startsWith("@@")) {
      const hunks = parseHunks(lines, i);
      const lfs = sniffLfsPointer(hunks);
      return lfs !== undefined
        ? { kind: "lfsPointer", oid: lfs.oid, bytes: lfs.bytes }
        : { kind: "text", hunks };
    }
    // An unrecognised header line between `diff --git` and the first hunk/binary marker — skip
    // it rather than fail the whole pane over one line this parser does not yet know about.
  }

  return { kind: "empty", reason: modeChanged ? "modeChangeOnly" : "identical" };
}
