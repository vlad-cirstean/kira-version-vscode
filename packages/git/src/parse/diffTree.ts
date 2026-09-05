/**
 * `git diff-tree` (§4.4): two separate invocations, one for line counts (`--numstat`) and one
 * for change kind + rename/copy linkage (`--name-status`) — numstat has no letter code and
 * name-status has no counts, so both are needed and combining them is queries.ts's job
 * (`combineFileChanges`). Both run with `-M -C` (P5 fixes a P1 bug: numstat used to run without
 * them, so a rename showed up as an independent full delete of the old path plus a full add of
 * the new one — e.g. +10/-10 for a one-line edit that also renamed the file — rather than the
 * true, similarity-matched +1/-1 line delta git can actually compute once it knows the rename).
 *
 * A rename/copy record — in *either* invocation now — carries two NUL-separated paths in one
 * logical entry: the tab-delimited fields end with an empty path, and the real old/new paths
 * follow as two more NUL-terminated records. Same non-uniform-framing hazard as status.ts's `2`
 * record, and for the same reason: `-z` turns every field terminator into NUL, not just the
 * record terminator.
 */
import type { FileChangeKind } from "@kira-version/core";
import { assert } from "@kira-version/core";

// `--no-optional-locks` is not included here: driver.ts (W7) adds it structurally to every
// read, so a caller of this args builder does not need to remember it too.
function diffTreeArgs(mode: string[], from: string | undefined, to: string): string[] {
  const base = ["diff-tree", "-r", "--no-commit-id", ...mode, "-z"];
  return from === undefined ? [...base, "--root", to] : [...base, from, to];
}

export function numstatArgs(from: string | undefined, to: string): string[] {
  return diffTreeArgs(["--numstat", "-M", "-C"], from, to);
}

export function nameStatusArgs(from: string | undefined, to: string): string[] {
  return diffTreeArgs(["--name-status", "-M", "-C"], from, to);
}

export interface NumstatEntry {
  readonly path: string;
  /** Set for a rename/copy only — mirrors `NameStatusEntry.originalPath`, and is what lets
   *  `combineFileChanges` join the two invocations' records on `path` alone for every kind. */
  readonly originalPath: string | undefined;
  readonly additions: number | undefined;
  readonly deletions: number | undefined;
  readonly isBinary: boolean;
}

export interface NameStatusEntry {
  readonly kind: FileChangeKind;
  readonly path: string;
  readonly originalPath: string | undefined;
  readonly similarity: number | undefined;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

function splitTabLimited(text: string, count: number): string[] {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length && fields.length < count - 1; i++) {
    if (text[i] === "\t") {
      fields.push(text.slice(start, i));
      start = i + 1;
    }
  }
  fields.push(text.slice(start));
  return fields;
}

export function parseNumstatRecords(records: readonly Uint8Array[]): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  let i = 0;
  while (i < records.length) {
    const record = records[i];
    if (record === undefined || record.length === 0) {
      i++;
      continue;
    }
    const [addRaw, delRaw, path] = splitTabLimited(decoder.decode(record), 3);
    const isBinary = addRaw === "-" || delRaw === "-";
    const additions = isBinary ? undefined : Number(addRaw ?? 0);
    const deletions = isBinary ? undefined : Number(delRaw ?? 0);
    if (path === "") {
      // Rename/copy: git left the tab-delimited path field empty and instead appended the
      // old and new paths as two more `-z`-terminated records, same as name-status's R/C rows.
      const originalPathRecord = records[i + 1];
      const pathRecord = records[i + 2];
      assert(
        originalPathRecord !== undefined && pathRecord !== undefined,
        "diff-tree --numstat rename/copy record missing its path chunks",
      );
      entries.push({
        path: decoder.decode(pathRecord),
        originalPath: decoder.decode(originalPathRecord),
        additions,
        deletions,
        isBinary,
      });
      i += 3;
    } else {
      entries.push({
        path: path ?? "",
        originalPath: undefined,
        additions,
        deletions,
        isBinary,
      });
      i += 1;
    }
  }
  return entries;
}

function classifyLetter(letter: string): FileChangeKind {
  switch (letter) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "T":
      return "typeChanged";
    case "U":
      return "unmerged";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      assert(false, `unrecognised diff-tree --name-status letter: ${JSON.stringify(letter)}`);
  }
}

export function parseNameStatusRecords(records: readonly Uint8Array[]): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  let i = 0;
  while (i < records.length) {
    const record = records[i];
    if (record === undefined || record.length === 0) {
      i++;
      continue;
    }
    const statusToken = decoder.decode(record);
    const letter = statusToken[0] ?? "";
    if (letter === "R" || letter === "C") {
      const originalPathRecord = records[i + 1];
      const pathRecord = records[i + 2];
      assert(
        originalPathRecord !== undefined && pathRecord !== undefined,
        "diff-tree --name-status rename/copy record missing its path chunks",
      );
      entries.push({
        kind: classifyLetter(letter),
        originalPath: decoder.decode(originalPathRecord),
        path: decoder.decode(pathRecord),
        similarity: Number(statusToken.slice(1)),
      });
      i += 3;
    } else {
      const pathRecord = records[i + 1];
      assert(pathRecord !== undefined, "diff-tree --name-status record missing its path chunk");
      entries.push({
        kind: classifyLetter(letter),
        path: decoder.decode(pathRecord),
        originalPath: undefined,
        similarity: undefined,
      });
      i += 2;
    }
  }
  return entries;
}
