/**
 * `docs/plans/P11.md` W5: the one predicate every half of search — the loaded-row scan, the
 * streamed git tail, and the mock bridge's fixture-backed stand-in (W9) — runs, so there is
 * exactly one place §7.8's six-field-OR-plus-sha-prefix semantics is implemented and one place
 * W16's semantics table is asserted against.
 */
import type { CompiledQuery } from "./query.ts";
import type { CommitStore } from "../store/commitStore.ts";
import type { RefRecord } from "../model/ref.ts";

/** What a hit matched on — the dropdown labels a hit with this, and it is why body-only hits
 *  (hard part 1) are visible as something other than a mystery row. */
export type SearchField =
  | "subject"
  | "body"
  | "authorName"
  | "authorEmail"
  | "committerName"
  | "committerEmail"
  | "sha"
  | "refName"
  | "tagAnnotation";

/** Every field a commit can be searched on. `body` is `""` for a loaded row — the column store
 *  holds no commit body at all (hard part 1); only the streamed git tail (`ScanRecord`) ever
 *  supplies a real one. */
export interface CommitFields {
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly committerName: string;
  readonly committerEmail: string;
}

const NO_FIELDS: readonly SearchField[] = Object.freeze([]);

/**
 * A straight OR over seven tests — the AND-across-categories semantics `git log --grep --author`
 * would give is exactly what probe 1 rules out. Returns every field that matched, not a boolean:
 * a hit's `fields` is what the dropdown labels it with, and what the loaded/tail de-duplicator
 * (hard part 5) merges on. Allocation-light on the miss path (the common case): `NO_FIELDS`, not
 * a fresh `[]`, when nothing matches.
 */
export function matchCommitFields(
  fields: CommitFields,
  query: Extract<CompiledQuery, { kind: "ok" }>,
): readonly SearchField[] {
  const hits: SearchField[] = [];
  if (query.pattern.test(fields.subject)) hits.push("subject");
  if (fields.body.length > 0 && query.pattern.test(fields.body)) hits.push("body");
  if (query.pattern.test(fields.authorName)) hits.push("authorName");
  if (query.pattern.test(fields.authorEmail)) hits.push("authorEmail");
  if (query.pattern.test(fields.committerName)) hits.push("committerName");
  if (query.pattern.test(fields.committerEmail)) hits.push("committerEmail");
  if (query.shaPrefix !== null && fields.sha.toLowerCase().startsWith(query.shaPrefix)) {
    hits.push("sha");
  }
  return hits.length === 0 ? NO_FIELDS : hits;
}

export interface LoadedScanOptions {
  /** Hits collected before the scan stops adding to `hits` — `total` keeps counting past it. */
  readonly limit: number;
  /** §5.1's 120 ms client-side ceiling, checked every 1,024 rows (hard part 4). */
  readonly budgetMs: number;
}

export interface LoadedScanResult {
  readonly hits: readonly { readonly row: number; readonly fields: readonly SearchField[] }[];
  readonly total: number;
  readonly truncated: boolean;
  /** `false` ⇒ the time box fired before the scan reached `scannedRows === store.rowCount`. */
  readonly complete: boolean;
  readonly scannedRows: number;
}

/** Bytes-per-row of `prefixBytes`, plus the optional trailing half-nibble an odd-length hex
 *  prefix leaves over (probe: a 5-hex-digit prefix is two whole bytes plus the high nibble of a
 *  third). `null` when there is no sha-prefix arm to test at all. */
interface PrefixMatcher {
  readonly bytes: Uint8Array;
  readonly oddNibble: number | undefined;
}

function compilePrefixMatcher(shaPrefix: string | null): PrefixMatcher | null {
  if (shaPrefix === null) return null;
  const fullBytes = shaPrefix.length >> 1;
  const bytes = new Uint8Array(fullBytes);
  for (let i = 0; i < fullBytes; i++) {
    bytes[i] = Number.parseInt(shaPrefix.slice(i * 2, i * 2 + 2), 16);
  }
  const oddNibble =
    shaPrefix.length % 2 === 1
      ? Number.parseInt(shaPrefix[shaPrefix.length - 1] as string, 16)
      : undefined;
  return { bytes, oddNibble };
}

function matchesPrefix(matcher: PrefixMatcher, shas: Uint8Array, rowStart: number): boolean {
  const { bytes, oddNibble } = matcher;
  for (let i = 0; i < bytes.length; i++) {
    if (shas[rowStart + i] !== bytes[i]) return false;
  }
  if (oddNibble === undefined) return true;
  const nextByte = shas[rowStart + bytes.length] as number;
  return nextByte >> 4 === oddNibble;
}

const rowDecoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Cheapest-first per row: the four identity columns as integer `Set.has` checks (probe 9b's
 * once-per-query dictionary match turns a per-row string compare into this), then the sha prefix
 * (byte compares, only when the query has one), then the subject — the one per-row decode this
 * function performs. `body` is always `""` here (hard part 1: the store holds no bodies at all),
 * so a body-only match can only ever come from the streamed tail, never from this scan.
 */
function matchLoadedRow(
  row: number,
  matchedIds: ReadonlySet<number>,
  authorNameIds: Uint32Array,
  authorEmailIds: Uint32Array,
  committerNameIds: Uint32Array,
  committerEmailIds: Uint32Array,
  shas: Uint8Array,
  shaWidthBytes: number,
  prefixMatcher: PrefixMatcher | null,
  subjects: Uint8Array,
  offsets: Uint32Array,
  query: Extract<CompiledQuery, { kind: "ok" }>,
): readonly SearchField[] {
  const hits: SearchField[] = [];
  if (matchedIds.has(authorNameIds[row] as number)) hits.push("authorName");
  if (matchedIds.has(authorEmailIds[row] as number)) hits.push("authorEmail");
  if (matchedIds.has(committerNameIds[row] as number)) hits.push("committerName");
  if (matchedIds.has(committerEmailIds[row] as number)) hits.push("committerEmail");
  if (prefixMatcher !== null && matchesPrefix(prefixMatcher, shas, row * shaWidthBytes)) {
    hits.push("sha");
  }
  const start = offsets[row] as number;
  const end = offsets[row + 1] as number;
  if (query.pattern.test(rowDecoder.decode(subjects.subarray(start, end)))) hits.push("subject");
  return hits.length === 0 ? NO_FIELDS : hits;
}

/**
 * Probe 9b's strategy: a once-per-query dictionary pre-match into a `Set<number>` (single-digit
 * ms over ~40k distinct identity strings), then an integer scan of the four identity columns plus
 * a byte-compare sha-prefix test and one subject decode per row — 13-38 ms at 100k rows against
 * the 120 ms client-side budget. Every column view this reads is valid only until the store's
 * next `append*` call; this function acquires them once at the top and never awaits, so that
 * invariant always holds across one call.
 */
export function searchLoadedCommits(
  store: CommitStore,
  query: Extract<CompiledQuery, { kind: "ok" }>,
  opts: LoadedScanOptions,
): LoadedScanResult {
  const rows = store.rowCount;
  const dict = store.internedStrings();
  const matchedIds = new Set<number>();
  for (let id = 0; id < dict.length; id++) {
    if (query.pattern.test(dict[id] as string)) matchedIds.add(id);
  }
  const [authorNameIds, authorEmailIds, committerNameIds, committerEmailIds] =
    store.identityColumns();
  const shas = store.shaBytes();
  const shaWidthBytes = store.shaWidthBytes;
  const subjects = store.subjectBytes();
  const offsets = store.subjectOffsets();
  const prefixMatcher = compilePrefixMatcher(query.shaPrefix);
  const deadline = performance.now() + opts.budgetMs;
  const hits: { row: number; fields: readonly SearchField[] }[] = [];
  let total = 0;
  let row = 0;
  for (; row < rows; row++) {
    // Time box, checked on a power-of-two row boundary so the check itself is not the cost.
    if ((row & 1023) === 0 && performance.now() > deadline) break;
    const fields = matchLoadedRow(
      row,
      matchedIds,
      authorNameIds,
      authorEmailIds,
      committerNameIds,
      committerEmailIds,
      shas,
      shaWidthBytes,
      prefixMatcher,
      subjects,
      offsets,
      query,
    );
    if (fields.length === 0) continue;
    total++;
    if (hits.length < opts.limit) hits.push({ row, fields });
  }
  return {
    hits,
    total,
    truncated: total > hits.length,
    complete: row >= rows,
    scannedRows: row,
  };
}

/**
 * `shortName` first (the common case), then an annotated tag's own message — `subject` and
 * `body` — never a lightweight tag's borrowed commit subject (`ref.annotation` is already
 * `undefined` there; see `parse/refs.ts`). `pr` is P12's seam: the hook for matching a ref's
 * decoration against a pull request's number/title (§7.8's own paragraph on the boundary),
 * unused for the whole of this phase and never passed by any P11 caller.
 */
export function matchRef(
  ref: RefRecord,
  query: Extract<CompiledQuery, { kind: "ok" }>,
  pr?: { readonly number: number; readonly title: string },
): readonly SearchField[] {
  void pr;
  const hits: SearchField[] = [];
  if (query.pattern.test(ref.shortName)) hits.push("refName");
  const annotation = ref.annotation;
  if (
    annotation !== undefined &&
    (query.pattern.test(annotation.subject) ||
      (annotation.body.length > 0 && query.pattern.test(annotation.body)))
  ) {
    hits.push("tagAnnotation");
  }
  return hits.length === 0 ? NO_FIELDS : hits;
}
