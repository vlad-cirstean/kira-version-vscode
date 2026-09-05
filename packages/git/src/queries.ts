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
import { parseStashRecord, stashListArgs } from "./parse/stash.ts";
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
  return records.filter((r) => r.length > 0).map(parseRefRecord);
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

export async function stashList(driver: GitDriver): Promise<StashEntry[]> {
  const read = driver.read(stashListArgs());
  const records: Uint8Array[] = [];
  for await (const record of read.records(0x00)) records.push(record);
  await read.done;
  return records.filter((r) => r.length > 0).map(parseStashRecord);
}

export async function countCommits(driver: GitDriver, scope: "all" | "head"): Promise<number> {
  // `rev-list`, unlike `log`, requires an explicit revision — "head" scope names HEAD directly
  // rather than relying on git's argument-less default the way `logArgs`'s "head" scope does.
  const argv = ["rev-list", "--count", ...(scope === "all" ? revSetArgs("all") : ["HEAD"])];
  const bytes = await collectOneShot(driver.read(argv));
  return Number(decoder.decode(bytes).trim());
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
): Promise<MergePrediction> {
  const read = driver.read(mergeTreeArgs(base, other));
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
