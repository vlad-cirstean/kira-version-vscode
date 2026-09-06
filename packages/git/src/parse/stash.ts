/**
 * `git stash list` (§4.4/§7.6), reusing `git log`'s `-z`/`%x1f` machinery — a stash entry is a
 * commit, so the same NUL/field framing applies, with one extra wrinkle: `--numstat` interleaves
 * each entry's own NUL-terminated numstat lines right after its header record (P9 probe 12), so
 * one spawn lists every entry's shape, counts included.
 *
 * `stash show` reuses `diff-tree`'s existing `parseNumstatRecords`/`parseNameStatusRecords`
 * unchanged — probe 12 confirmed byte-identical framing — so no stash-specific diff parser
 * exists here; only the args builders for it live in this file, beside the list parser they
 * share a framing discriminator with.
 */
import type { StashEntry } from "@kira-version/core";
import { splitLimitedFields } from "@kira-version/core";

const FIELD_DELIMITER = 0x1f;
const FIELD_COUNT = 5;

/** `%gs`, not `%s`: `git stash list` itself displays the REFLOG subject, and `git stash store -m`
 *  (P9's drop-undo, §7.12) sets only that. The two are identical until a stash is restored by
 *  `store`, at which point `%s` still shows the pre-drop label while `%gs` shows the restored one
 *  (P9 probe 9) — a real bug in the P1-era format string, fixed here. */
export const STASH_FORMAT = "%H%x1f%P%x1f%gd%x1f%at%x1f%gs";

// `--no-optional-locks` is not included here: driver.ts adds it structurally to every read, so a
// caller of this args builder does not need to remember it too.
/** ONE spawn for the whole stash stack, per-entry tracked file counts included. `--numstat`
 *  makes git interleave each entry's NUL-terminated numstat lines right after its header record
 *  (P9 probe 12) — `parseStashList` below is the framing discriminator that un-interleaves them.
 *  `-u` is deliberately absent: in `stash list` (unlike `stash show`) `-u` means `--patch`, not
 *  `--include-untracked` — it does not add untracked files to the count, it switches the whole
 *  command to patch mode. There is no way to see untracked counts here; `includedUntracked` only
 *  flags their possible presence and `stash.show` gives the real list on demand. */
export function stashListArgs(): string[] {
  return ["stash", "list", "-z", "--numstat", "-M", "-C", `--format=${STASH_FORMAT}`];
}

/** Tracked AND untracked in one invocation (`-u` on a stash with no third parent is a harmless
 *  no-op, rc=0 — probe 12), in exactly `diff-tree`'s own `-z` framing, so
 *  `parseNumstatRecords`/`parseNameStatusRecords` consume the output unchanged. */
export function stashShowNumstatArgs(sha: string): string[] {
  return ["stash", "show", "--numstat", "-z", "-u", "-M", "-C", sha];
}
export function stashShowNameStatusArgs(sha: string): string[] {
  return ["stash", "show", "--name-status", "-z", "-u", "-M", "-C", sha];
}

/** TRACKED HALF ONLY — deliberately no `-u` — for `classifyStashPop`'s `stashPaths`
 *  (§7.6: `stashPaths ∩ {d.path | d.tracked}` is the `localChangesWouldBeOverwritten` blocker).
 *  Untracked collisions are a wholly separate question, answered by `stashUntrackedPathsArgs`
 *  below against the stash's own third parent, never by this. */
export function stashShowNameOnlyArgs(sha: string): string[] {
  return ["stash", "show", "--name-only", "-z", "-M", "-C", sha];
}

/** The `-u` set, for the untracked-collision blocker (§7.6's `classifyStashPop`). Empty when
 *  `-u` was passed to `stash push` with nothing untracked to save — an empty third parent tree
 *  (P9 probe 1), not a missing one. */
export function stashUntrackedPathsArgs(untrackedSha: string): string[] {
  return ["ls-tree", "-r", "--name-only", "-z", untrackedSha];
}

const decoder = new TextDecoder("utf-8", { fatal: false });

const STASH_INDEX = /^stash@\{(\d+)\}$/;
const BRANCH_PREFIX = /^(?:WIP on|On) ([^:]*):/;

function parseBranch(message: string): string | null {
  const match = BRANCH_PREFIX.exec(message);
  const name = match?.[1];
  if (name === undefined || name === "(no branch)") return null;
  return name;
}

function parseHeader(record: Uint8Array): {
  readonly sha: string;
  readonly baseSha: string;
  readonly indexSha: string;
  readonly untrackedSha: string | undefined;
  readonly index: number;
  readonly timestamp: number;
  readonly message: string;
} {
  const [sha, parentsRaw, gd, at, gs] = splitLimitedFields(
    record,
    FIELD_DELIMITER,
    FIELD_COUNT,
  ).map((field) => decoder.decode(field));
  const parents = parentsRaw ? parentsRaw.split(" ").filter((p) => p.length > 0) : [];
  const indexMatch = STASH_INDEX.exec(gd ?? "");
  const message = gs ?? "";
  return {
    sha: sha ?? "",
    baseSha: parents[0] ?? "",
    indexSha: parents[1] ?? "",
    untrackedSha: parents[2],
    index: indexMatch?.[1] !== undefined ? Number(indexMatch[1]) : 0,
    timestamp: Number(at ?? 0),
    message,
  };
}

/**
 * Un-interleaves `stashListArgs()`'s output: a header record always contains `\x1f` (the format
 * string's field delimiter); a numstat line never does — that presence test is the framing
 * discriminator (P9 probe 12), not record position, so a stash whose message happens to be empty
 * still parses correctly. git inserts a bare `\n` between a commit's formatted header and its
 * diff output (ordinary `log --numstat` behaviour, unaffected by `-z`); with `-z` that newline
 * lands as a leading byte on the FIRST numstat record of each entry rather than as a trailing
 * byte on the header — confirmed against a live git 2.43.0 by inspecting the raw bytes — so it is
 * stripped there, not from the header.
 *
 * Returns entries oldest-parsed-first in whatever order git emitted them (`stash@{0}` first, per
 * `stash list`'s own ordering) — callers that need index order can rely on `%gd` alone; array
 * position is never used for `index` (a future filtered read must not silently desynchronise it).
 */
export function parseStashList(records: readonly Uint8Array[]): StashEntry[] {
  const entries: StashEntry[] = [];
  let current: ReturnType<typeof parseHeader> | undefined;
  let fileCount = 0;

  const flush = (): void => {
    if (current === undefined) return;
    entries.push({
      index: current.index,
      sha: current.sha,
      baseSha: current.baseSha,
      indexSha: current.indexSha,
      untrackedSha: current.untrackedSha,
      message: current.message,
      branch: parseBranch(current.message),
      timestamp: current.timestamp,
      fileCount,
      includedUntracked: current.untrackedSha !== undefined,
    });
  };

  for (const record of records) {
    if (record.includes(FIELD_DELIMITER)) {
      flush();
      current = parseHeader(record);
      fileCount = 0;
      continue;
    }
    // A numstat line (possibly with git's leading `\n` before an entry's first one) or an empty
    // trailing fragment — either way, not a header, so it counts toward the open entry only if
    // there is a real line in it.
    const text = decoder.decode(record);
    const trimmed = text.startsWith("\n") ? text.slice(1) : text;
    if (trimmed.length === 0) continue;
    fileCount++;
  }
  flush();

  return entries;
}
