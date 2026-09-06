/**
 * The §4.4 read surface: the thin façade binding `driver.ts` + each `parse/*.ts` file's argv
 * and parser into the typed API the rest of the app calls. No formats live here (those live
 * with their parsers, W4) and no spawn policy lives here (that lives in the driver, W7) —
 * what this file owns is which query is a stream and which is a one-shot, and how a query's
 * exit-code semantics map onto a result.
 *
 * `identity()` is not re-implemented here — discovery.ts's `resolveRepoIdentity` already is
 * the one-shot rev-parse + HEAD resolution query and is used directly.
 */
import type {
  CommitDetail,
  CommitRecord,
  CommitTrailer,
  FileChange,
  MergePrediction,
  RefRecord,
  RevertParentChoice,
  SignatureStatus,
  StashEntry,
  StatusResult,
} from "@kira-version/core";
import { splitLimitedFields, splitTrailerBlock } from "@kira-version/core";
import type { GitDriver, GitRead } from "./driver.ts";
import { GitError } from "./errors.ts";
import type { NameStatusEntry, NumstatEntry } from "./parse/diffTree.ts";
import {
  nameStatusArgs,
  numstatArgs,
  parseNameStatusRecords,
  parseNumstatRecords,
} from "./parse/diffTree.ts";
import { logArgs, parseLogRecord, revSetArgs, showMetadataArgs } from "./parse/log.ts";
import { mergeTreeArgs, parseMergeTreeOutput } from "./parse/mergeTree.ts";
import { parseRefRecord, REFS_RECORD_DELIMITER, refsArgs } from "./parse/refs.ts";
import {
  parseStashList,
  stashListArgs,
  stashShowNameStatusArgs,
  stashShowNumstatArgs,
} from "./parse/stash.ts";
import { parseStatus, statusArgs } from "./parse/status.ts";

const decoder = new TextDecoder("utf-8", { fatal: false });

async function collectBytes(bytes: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of bytes) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Collects a one-shot read to completion, propagating a failed exit (`read.done`) as a
 *  thrown error — the shared shape almost every query below follows. */
async function collectOneShot(read: GitRead): Promise<Uint8Array> {
  const bytes = await collectBytes(read.bytes);
  await read.done;
  return bytes;
}

/** Strips a single trailing `-z` record terminator, for an invocation that emits exactly one
 *  NUL-terminated record (`show -s -z ...`) and is parsed as fixed fields rather than split
 *  into multiple records via `splitZ` below — without this, the record's last field (the
 *  commit subject, or the diff body) silently gains a trailing NUL byte, which prints as
 *  invisible whitespace and fails an exact string comparison. Never applied to `numstatBytes`/
 *  `nameStatusBytes` above: those go through `splitZ`, which only emits a record on actually
 *  encountering a NUL and would instead *lose* the final record if this ran first. */
function stripTrailingNul(bytes: Uint8Array): Uint8Array {
  const last = bytes.length - 1;
  return last >= 0 && bytes[last] === 0x00 ? bytes.subarray(0, last) : bytes;
}

// ---------------------------------------------------------------------------------------
// log — the only streaming query. §5.1.1's long-lived paged session (P2) replaces the
// paging mechanics; the record-yielding shape it exposes is this one.
// ---------------------------------------------------------------------------------------

export interface LogQueryOptions {
  readonly scope: "all" | "head";
  readonly pageSize: number;
  readonly signal?: AbortSignal;
}

export function log(driver: GitDriver, opts: LogQueryOptions): AsyncIterable<CommitRecord> {
  const read = driver.read(
    logArgs({ scope: opts.scope, maxCount: opts.pageSize }),
    opts.signal ? { signal: opts.signal } : {},
  );
  return mapRecords(read, 0x00, parseLogRecord);
}

async function* mapRecords<T>(
  read: GitRead,
  delimiter: number,
  parse: (record: Uint8Array) => T,
): AsyncGenerator<T> {
  for await (const record of read.records(delimiter)) {
    yield parse(record);
  }
  // Iteration alone never surfaces a failed exit — `bytes`/`records` just stop when the
  // process's stdout ends, whatever the exit code was. `done` is where that shows up.
  await read.done;
}

// ---------------------------------------------------------------------------------------
// refs, status, stash, countCommits — one-shot queries.
// ---------------------------------------------------------------------------------------

export async function refs(driver: GitDriver): Promise<RefRecord[]> {
  const read = driver.read(refsArgs());
  const records: Uint8Array[] = [];
  for await (const record of read.records(REFS_RECORD_DELIMITER)) records.push(record);
  await read.done;
  return records.filter((r) => r.length > 0).map((r) => parseRefRecord(r));
}

export async function status(
  driver: GitDriver,
  opts: { ignored?: boolean } = {},
): Promise<StatusResult> {
  const read = driver.read(statusArgs(opts));
  const records: Uint8Array[] = [];
  for await (const record of read.records(0x00)) records.push(record);
  await read.done;
  return parseStatus(records);
}

// ---------------------------------------------------------------------------------------
// refsSnapshot — P6/W8's two-spawn scoped fetch behind `refs.list`: heads+remotes sorted by
// `-committerdate`, tags sorted by `-v:refname`, split by `kind` here rather than by a third
// spawn (`for-each-ref` cannot filter `refs/heads` from `refs/remotes` within one `--format`
// pass, but both are already discriminated per-record by `parseRefRecord`'s `kind`, so the
// split is a free `Array.filter`, not another round-trip). Distinct from the plain `refs()`
// above, which P1's own integration tests still call with `scope: "all"` — this is additive,
// not a replacement.
// ---------------------------------------------------------------------------------------

export interface RefsSnapshot {
  readonly branches: RefRecord[];
  readonly remoteBranches: RefRecord[];
  readonly tags: RefRecord[];
}

async function collectRefRecords(
  driver: GitDriver,
  argv: string[],
  withSubject: boolean,
): Promise<RefRecord[]> {
  const read = driver.read(argv);
  const records: Uint8Array[] = [];
  for await (const record of read.records(REFS_RECORD_DELIMITER)) records.push(record);
  await read.done;
  return records.filter((r) => r.length > 0).map((r) => parseRefRecord(r, withSubject));
}

export async function refsSnapshot(driver: GitDriver): Promise<RefsSnapshot> {
  const [headsAndRemotes, tags] = await Promise.all([
    collectRefRecords(driver, refsArgs("heads"), false),
    collectRefRecords(driver, refsArgs("tags"), true),
  ]);
  return {
    branches: headsAndRemotes.filter((r) => r.kind === "branch"),
    remoteBranches: headsAndRemotes.filter((r) => r.kind === "remoteBranch"),
    tags,
  };
}

/** §7.6/§4.4: one spawn for the whole stack, per-entry tracked file counts included (P9 probe
 *  12) — `parseStashList` un-interleaves the header/numstat framing itself, so nothing is
 *  filtered here beyond a genuinely empty trailing record. */
export async function stashList(driver: GitDriver): Promise<StashEntry[]> {
  const read = driver.read(stashListArgs());
  const records: Uint8Array[] = [];
  for await (const record of read.records(0x00)) records.push(record);
  await read.done;
  return parseStashList(records);
}

/** The stash's own file list for the detail pane (§4.4/§7.6): two `stash show` invocations
 *  (tracked + `-u` untracked, one for numstat, one for name-status), joined by the same
 *  `combineFileChanges` `commitDetail` uses below — probe 12 confirmed `stash show` emits
 *  `diff-tree`'s own `-z` framing byte-for-byte, so no stash-specific diff parser exists. */
export async function stashShow(
  driver: GitDriver,
  sha: string,
): Promise<{ readonly sha: string; readonly changes: readonly FileChange[] }> {
  const [numstatBytes, nameStatusBytes] = await Promise.all([
    collectOneShot(driver.read(stashShowNumstatArgs(sha))),
    collectOneShot(driver.read(stashShowNameStatusArgs(sha))),
  ]);
  const changes = combineFileChanges(
    parseNumstatRecords(splitZ(numstatBytes)),
    parseNameStatusRecords(splitZ(nameStatusBytes)),
  );
  return { sha, changes };
}

/** Shared by `countCommits` and `countRange` (P7 W2) — `rev-list --count`'s only possible
 *  successful output is one line, one integer. */
function parseCount(bytes: Uint8Array): number {
  return Number(decoder.decode(bytes).trim());
}

export async function countCommits(driver: GitDriver, scope: "all" | "head"): Promise<number> {
  // `rev-list`, unlike `log`, requires an explicit revision — "head" scope names HEAD directly
  // rather than relying on git's argument-less default the way `logArgs`'s "head" scope does.
  const argv = ["rev-list", "--count", ...(scope === "all" ? revSetArgs("all") : ["HEAD"])];
  const bytes = await collectOneShot(driver.read(argv));
  return parseCount(bytes);
}

/** `docs/plans/P7.md` W2/§6.8: `rev-list --count <base>..<branch>` — the range-count half of
 *  base resolution's `ready`/`empty` distinction. A bad `base`/`branch` throws (a real `GitError`,
 *  never silently `0`) — `resolveReviewBase` (W4) is what decides that is a genuine failure
 *  rather than "unrelated" or "empty" (V6). */
export async function countRange(driver: GitDriver, base: string, branch: string): Promise<number> {
  const bytes = await collectOneShot(driver.read(["rev-list", "--count", `${base}..${branch}`]));
  return parseCount(bytes);
}

/** `docs/plans/P7.md` W2/§6.8: `git merge-base <a> <b>`, returning the sha or `null` when the two
 *  share no common ancestor — `merge-base` exits 1 with no output in that case (V4), which is
 *  cleanly distinguishable from a bad-ref error (exit 128, real stderr): only exit 1 is caught
 *  here, everything else rethrows as a genuine `GitError`. */
export async function mergeBase(driver: GitDriver, a: string, b: string): Promise<string | null> {
  const read = driver.read(["merge-base", a, b]);
  const bytes = await collectBytes(read.bytes);
  try {
    await read.done;
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) return null;
    throw err;
  }
  return decoder.decode(bytes).trim();
}

/** `docs/plans/P7.md` W2/§6.8 step 2: `git symbolic-ref --short refs/remotes/origin/HEAD`,
 *  returning its short name or `undefined` when unset — no remote at all, `origin/HEAD`
 *  explicitly unset, or (V1) a dangling target all throw a `GitError` here and are folded into
 *  "not detected" rather than surfaced as an error the UI would otherwise have to render. A
 *  successful-but-nonexistent answer (`origin/HEAD` points at a branch since deleted) is *not*
 *  this function's problem to catch — `resolveBase` (core, W1) checks existence against the ref
 *  snapshot and falls through on its own when this returns a name nothing matches. */
export async function detectDefaultBranch(driver: GitDriver): Promise<string | undefined> {
  try {
    const bytes = await collectOneShot(
      driver.read(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
    );
    const value = decoder.decode(bytes).trim();
    return value.length > 0 ? value : undefined;
  } catch (err) {
    if (err instanceof GitError) return undefined;
    throw err;
  }
}

// ---------------------------------------------------------------------------------------
// predictMerge — merge-tree's exit code is part of its result, not a failure signal.
// Exit 1 (conflicts) is a real, expected outcome; only >1 is an actual error. driver.read()
// classifies any non-zero exit as a GitError, so exit 1 is caught here and reinterpreted —
// its exitCode still tells parseMergeTreeOutput which shape to expect.
// ---------------------------------------------------------------------------------------

export async function predictMerge(
  driver: GitDriver,
  base: string,
  other: string,
  opts?: { readonly mergeBase?: string },
): Promise<MergePrediction> {
  const read = driver.read(mergeTreeArgs(base, other, opts));
  const bytes = await collectBytes(read.bytes);
  let exitCode = 0;
  try {
    await read.done;
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) {
      exitCode = 1;
    } else {
      throw err;
    }
  }
  return parseMergeTreeOutput(decoder.decode(bytes), exitCode);
}

// ---------------------------------------------------------------------------------------
// commitDetail — metadata (reusing log.ts's format/parser via `show`), body + signature (a
// second minimal `show`, kept separate so a stray 0x1f in the message can only corrupt the
// body — the very last field — never the metadata already parsed from the first call), and
// two diff-tree runs merged into one per-file change list.
// ---------------------------------------------------------------------------------------

// `%GS` (signer) and `%(trailers:only=true,unfold=true)` (structured trailers — git's own
// trailer-detection rules, not worth reimplementing, per probe P5) are inserted ahead of `%b`,
// which stays the *last* field: a stray 0x1f inside a commit message can then only ever corrupt
// the body, never a field parsed before it.
const BODY_AND_SIGNATURE_FORMAT = "%G?%x1f%GS%x1f%(trailers:only=true,unfold=true)%x1f%b";

function showBodyAndSignatureArgs(sha: string): string[] {
  return ["show", "-s", "-z", `--format=${BODY_AND_SIGNATURE_FORMAT}`, sha];
}

/** `%(trailers:...)`'s own text, one already-unfolded trailer per line, `Token: Value` — a
 *  trailing blank line only appears when this placeholder is the last thing `--format` prints,
 *  which it never is here, so no trailing-blank-line handling is needed. */
function parseTrailerBlock(raw: string): CommitTrailer[] {
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const sep = line.indexOf(": ");
      return sep === -1
        ? { token: line, value: "" }
        : { token: line.slice(0, sep), value: line.slice(sep + 2) };
    });
}

async function fetchBodyAndSignature(
  driver: GitDriver,
  sha: string,
  signal: AbortSignal | undefined,
): Promise<{
  signature: { status: SignatureStatus; signer: string };
  trailers: CommitTrailer[];
  body: string;
}> {
  const bytes = stripTrailingNul(
    await collectOneShot(driver.read(showBodyAndSignatureArgs(sha), signal ? { signal } : {})),
  );
  const [statusRaw, signerRaw, trailersRaw, bodyRaw] = splitLimitedFields(bytes, 0x1f, 4).map(
    (field) => decoder.decode(field),
  );
  const trailers = parseTrailerBlock(trailersRaw ?? "");
  const body = splitTrailerBlock(bodyRaw ?? "", trailers);
  return {
    signature: {
      status: (statusRaw as SignatureStatus | undefined) ?? "N",
      signer: signerRaw ?? "",
    },
    trailers,
    body,
  };
}

/**
 * Joins the two `diff-tree` invocations' records on `path` alone — both now run with `-M -C`
 * (P5 fixed a P1 bug: numstat used to run without them, so a rename's true line delta had to be
 * approximated from two unrelated full delete/add records). With both invocations agreeing on
 * `-M -C`, a rename's `path` is the same join key in each, and its numstat record already
 * carries the correct post-rename delta — no rename-specific branch is needed here.
 */
export function combineFileChanges(
  numstat: readonly NumstatEntry[],
  nameStatus: readonly NameStatusEntry[],
): FileChange[] {
  const byPath = new Map(numstat.map((entry) => [entry.path, entry]));
  return nameStatus.map((entry) => {
    const stat = byPath.get(entry.path);
    return {
      kind: entry.kind,
      path: entry.path,
      originalPath: entry.originalPath,
      similarity: entry.similarity,
      additions: stat?.additions,
      deletions: stat?.deletions,
      isBinary: stat?.isBinary ?? false,
    };
  });
}

export interface CommitDetailOptions {
  /** Which parent to diff against, for a merge commit — default: first parent (§4.4). */
  readonly parentIndex?: number;
  /** Threaded to every `driver.read` this makes (W3) — a superseded request's processes must
   *  actually die, not merely have their result discarded, so a fast keyboard run never queues
   *  behind a request nobody wants any more. */
  readonly signal?: AbortSignal;
}

export async function commitDetail(
  driver: GitDriver,
  sha: string,
  opts: CommitDetailOptions = {},
): Promise<CommitDetail> {
  const parentIndex = opts.parentIndex ?? 0;
  const { signal } = opts;
  const readOpts = signal ? { signal } : {};
  const metadataBytes = await collectOneShot(driver.read(showMetadataArgs(sha), readOpts));
  const metadata = parseLogRecord(stripTrailingNul(metadataBytes));

  const parentSha = metadata.parents[parentIndex];
  const from = parentSha; // undefined for a root commit — triggers --root below

  const [numstatBytes, nameStatusBytes, { signature, trailers, body }] = await Promise.all([
    collectOneShot(driver.read(numstatArgs(from, sha), readOpts)),
    collectOneShot(driver.read(nameStatusArgs(from, sha), readOpts)),
    fetchBodyAndSignature(driver, sha, signal),
  ]);

  const numstatRecords = splitZ(numstatBytes);
  const nameStatusRecords = splitZ(nameStatusBytes);
  const files = combineFileChanges(
    parseNumstatRecords(numstatRecords),
    parseNameStatusRecords(nameStatusRecords),
  );

  return { ...metadata, body, trailers, signature, parentIndex, files };
}

// ---------------------------------------------------------------------------------------
// revertMergeParents — §7.10's mainline picker data. `preflight.revert`'s wire request carries
// only `shas` (plus an optional already-chosen `mainline`), never the parent lists themselves —
// those are looked up here, one `show -s` per requested sha to learn its parent count and shas,
// then one more per DISTINCT parent sha across every merge found (deduplicated: an octopus base
// shared by two requested shas costs one spawn, not two) to learn that parent's subject for the
// picker's label. Bounded by how many commits a user selects for revert at once — never a hot
// path the way `log`'s walk is.
// ---------------------------------------------------------------------------------------

export async function revertMergeParents(
  driver: GitDriver,
  shas: readonly string[],
): Promise<Map<string, RevertParentChoice[]>> {
  const metas = await Promise.all(
    shas.map(async (sha) => {
      const bytes = stripTrailingNul(await collectOneShot(driver.read(showMetadataArgs(sha))));
      return { sha, record: parseLogRecord(bytes) };
    }),
  );
  const merges = metas.filter((m) => m.record.parents.length > 1);

  const parentShas = [...new Set(merges.flatMap((m) => m.record.parents))];
  const subjectEntries = await Promise.all(
    parentShas.map(async (parentSha) => {
      const bytes = stripTrailingNul(
        await collectOneShot(driver.read(showMetadataArgs(parentSha))),
      );
      return [parentSha, parseLogRecord(bytes).subject] as const;
    }),
  );
  const parentSubjects = new Map(subjectEntries);

  const result = new Map<string, RevertParentChoice[]>();
  for (const m of merges) {
    result.set(
      m.sha,
      m.record.parents.map((parentSha, i) => ({
        parentNumber: i + 1,
        sha: parentSha,
        subject: parentSubjects.get(parentSha) ?? "",
      })),
    );
  }
  return result;
}

/** Splits a fully-collected `-z` invocation's output into its NUL-delimited records — used
 *  by the two diff-tree calls above, which are small (one commit's worth of files) and do
 *  not need `log`'s streaming treatment. */
function splitZ(bytes: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x00) {
      records.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  return records;
}
