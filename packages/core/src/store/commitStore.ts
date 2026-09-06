/**
 * §5.5's first memory rule: "commits are stored column-wise in typed arrays, not row-wise as
 * objects ... a commit 'object' is materialized on demand for the <=60 rows on screen and the
 * one selected commit, then discarded." This is the store that rule describes, built on
 * `ShaTable` (W3) and `StringInterner`/`SubjectBuffer` (W2).
 */
import type { LayoutInput } from "../graph/types.ts";
import type { CommitIdentity, CommitRecord, DecorationRef } from "../model/commit.ts";
import { assert, assertDefined } from "../util/assert.ts";
import { StringInterner, SubjectBuffer } from "./intern.ts";
import { bytesToHex, hexToBytes, ShaTable } from "./shaTable.ts";

const UINT32_MAX = 0xffffffff;
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/** Clamps a commit timestamp into `Uint32Array` range (1970 .. ~2106). Clock-skewed or
 *  imported histories do produce dates outside that range; clamping costs one comparison and
 *  keeps every timestamp column a `Uint32Array` instead of an 8-byte `Float64Array` for every
 *  repository to accommodate the rare one. `stats()` reports how many rows this touched. */
function clampTimestamp(value: number): { readonly clamped: number; readonly wasClamped: boolean } {
  if (!Number.isFinite(value) || value < 0) return { clamped: 0, wasClamped: value !== 0 };
  if (value > UINT32_MAX) return { clamped: UINT32_MAX, wasClamped: true };
  const floored = Math.floor(value);
  return { clamped: floored, wasClamped: floored !== value };
}

type TypedIntArray = Uint32Array | Int32Array;

/** A growable column backed by a typed array, doubling capacity on overflow like
 *  `intern.ts`'s buffers. Shared by every fixed-width column this store maintains. */
class GrowableColumn<T extends TypedIntArray> {
  #array: T;
  #length = 0;
  readonly #Ctor: new (
    length: number,
  ) => T;

  constructor(Ctor: new (length: number) => T, initialCapacity = 1024) {
    this.#Ctor = Ctor;
    this.#array = new Ctor(Math.max(1, initialCapacity));
  }

  push(value: number): number {
    if (this.#length >= this.#array.length) this.#grow();
    const index = this.#length;
    this.#array[index] = value;
    this.#length++;
    return index;
  }

  get(index: number): number {
    assert(index >= 0 && index < this.#length, `GrowableColumn.get(${index}): out of range`);
    return this.#array[index] as number;
  }

  set(index: number, value: number): void {
    assert(index >= 0 && index < this.#length, `GrowableColumn.set(${index}): out of range`);
    this.#array[index] = value;
  }

  get length(): number {
    return this.#length;
  }

  /** A view over exactly the appended entries — never a copy. */
  view(): T {
    return this.#array.subarray(0, this.#length) as T;
  }

  get byteLength(): number {
    return this.#array.byteLength;
  }

  clear(): void {
    this.#array = new this.#Ctor(1);
    this.#length = 0;
  }

  #grow(): void {
    const newCapacity = Math.max(1, this.#array.length * 2);
    const grown = new this.#Ctor(newCapacity);
    grown.set(this.#array);
    this.#array = grown;
  }
}

export interface AppendResult {
  readonly from: number;
  readonly to: number;
  /** Slots in the parent column that changed from unresolved to a real row because this batch
   *  supplied the parent — feeds the layout's incremental patch pass (W9). */
  readonly resolvedParentSlots: Uint32Array;
}

/**
 * The wire shape `packSlice`/`appendPacked` trade (P3 W3, §3's ipc→core boundary): every field
 * is a plain `ArrayBuffer` rather than a typed array so it survives a structural copy into
 * `packages/ipc`'s own declaration of the same shape (core and ipc may not import each other —
 * see `docs/plans/P3.md`'s "ipc → core boundary" section) without either side importing the
 * other's typed-array element type.
 *
 * Parents travel as shas (`parentShas`), not row indices — see the plan's W3 for why. The
 * dictionary is a delta: `dictionary` holds only the strings interned since `dictionaryBase`,
 * and `appendPacked` throws if the receiver's interner isn't at exactly that size, since a
 * mismatch means a chunk arrived out of order or was dropped.
 */
export interface PackedCommitChunk {
  readonly from: number;
  readonly to: number;
  readonly shaWidthBytes: number;
  readonly shas: ArrayBuffer;
  readonly parentOffsets: ArrayBuffer;
  readonly parentShas: ArrayBuffer;
  readonly identityIds: ArrayBuffer;
  readonly times: ArrayBuffer;
  readonly subjectBytes: ArrayBuffer;
  readonly subjectOffsets: ArrayBuffer;
  readonly dictionaryBase: number;
  readonly dictionary: readonly string[];
  readonly decorations: readonly (readonly [row: number, refs: readonly DecorationRef[]])[];
}

/** Every distinct `ArrayBuffer` backing `chunk`'s fields, exactly once — mirrors
 *  `graph/layout.ts`'s `layoutTransferList` and its reason: a buffer listed twice throws at
 *  `postMessage`, a buffer omitted is silently cloned. */
export function packedTransferList(chunk: PackedCommitChunk): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>([
    chunk.shas,
    chunk.parentOffsets,
    chunk.parentShas,
    chunk.identityIds,
    chunk.times,
    chunk.subjectBytes,
    chunk.subjectOffsets,
  ]);
  return [...buffers];
}

export interface CommitStoreStats {
  readonly rowCount: number;
  readonly shaTableBytes: number;
  /** The six identity/time columns plus the parent CSR pair. */
  readonly columnBytes: number;
  readonly subjectBufferBytes: number;
  readonly internedStringBytes: number;
  readonly decorationEntryCount: number;
  readonly pendingParentCount: number;
  readonly clampedTimestampCount: number;
  readonly totalBytes: number;
}

/** Not exported — parents unresolved at read time are surfaced as `-1` in `parentsOf()`'s
 *  `Int32Array`, per `core/graph/types.ts` (W5)'s `-1`-means-not-loaded convention there. */
const UNRESOLVED_PARENT_ROW = -1;

export class CommitStore {
  readonly #shas = new ShaTable();
  readonly #interner = new StringInterner();
  readonly #subjects = new SubjectBuffer();

  readonly #authorName = new GrowableColumn(Uint32Array);
  readonly #authorEmail = new GrowableColumn(Uint32Array);
  readonly #authorTime = new GrowableColumn(Uint32Array);
  readonly #committerName = new GrowableColumn(Uint32Array);
  readonly #committerEmail = new GrowableColumn(Uint32Array);
  readonly #committerTime = new GrowableColumn(Uint32Array);

  readonly #parentOffsets = new GrowableColumn(Uint32Array);
  readonly #parentRows = new GrowableColumn(Int32Array);

  readonly #decorations = new Map<number, readonly DecorationRef[]>();
  /** Parent slots not yet resolvable to a row, keyed by slot index, value the parent's hex sha
   *  — bounded by the walk's open frontier (typically well under a hundred), never by row
   *  count. Also what lets `commitAt()` reconstruct an unresolved parent's sha exactly, since
   *  `parentsOf()`'s `-1` alone would otherwise lose it. */
  readonly #pendingParents = new Map<number, string>();

  #rowCount = 0;
  #clampedTimestampCount = 0;
  /** Every parent slot resolved since the last `layoutInput()` call, regardless of whether it
   *  happened via `append()` or `appendPage()` — `layoutInput()` is normally called once per
   *  page, after many individual `append()` calls (the pipeline's per-record sink), so this
   *  accumulates across all of them rather than relying on a caller to thread each call's own
   *  `AppendResult.resolvedParentSlots` through by hand. */
  #resolvedSinceLastLayoutInput: number[] = [];

  constructor() {
    this.#parentOffsets.push(0);
  }

  get rowCount(): number {
    return this.#rowCount;
  }

  append(record: CommitRecord): number {
    return this.appendPage([record]).from;
  }

  appendPage(records: Iterable<CommitRecord>): AppendResult {
    const from = this.#rowCount;
    for (const record of records) this.#appendOne(record);
    const to = this.#rowCount;
    const resolvedParentSlots = Uint32Array.from(this.#resolvePendingParents());
    return { from, to, resolvedParentSlots };
  }

  #appendOne(record: CommitRecord): void {
    const row = this.#rowCount;
    const shaRow = this.#shas.append(record.sha);
    assert(
      shaRow === row,
      `CommitStore: sha table row ${shaRow} does not match store row ${row} — ` +
        `records must be appended in row order`,
    );

    this.#authorName.push(this.#interner.intern(record.author.name));
    this.#authorEmail.push(this.#interner.intern(record.author.email));
    this.#authorTime.push(this.#pushClamped(record.author.timestamp));
    this.#committerName.push(this.#interner.intern(record.committer.name));
    this.#committerEmail.push(this.#interner.intern(record.committer.email));
    this.#committerTime.push(this.#pushClamped(record.committer.timestamp));

    const subjectRow = this.#subjects.append(record.subject);
    assert(subjectRow === row, "unreachable: subjects appended in the same order as rows");

    if (record.decoration.length > 0) this.#decorations.set(row, record.decoration);

    for (const parentSha of record.parents) {
      const parentRow = this.#shas.rowOfHex(parentSha);
      const slot = this.#parentRows.push(parentRow === -1 ? UNRESOLVED_PARENT_ROW : parentRow);
      if (parentRow === -1) this.#pendingParents.set(slot, parentSha);
    }
    this.#parentOffsets.push(this.#parentRows.length);
    this.#rowCount++;
  }

  #pushClamped(timestamp: number): number {
    const { clamped, wasClamped } = clampTimestamp(timestamp);
    if (wasClamped) this.#clampedTimestampCount++;
    return clamped;
  }

  #resolvePendingParents(): number[] {
    if (this.#pendingParents.size === 0) return [];
    const resolved: number[] = [];
    for (const [slot, parentSha] of this.#pendingParents) {
      const parentRow = this.#shas.rowOfHex(parentSha);
      if (parentRow === -1) continue;
      this.#parentRows.set(slot, parentRow);
      resolved.push(slot);
    }
    for (const slot of resolved) this.#pendingParents.delete(slot);
    this.#resolvedSinceLastLayoutInput.push(...resolved);
    return resolved;
  }

  rowOfSha(hex: string): number {
    return this.#shas.rowOfHex(hex);
  }

  shaAt(row: number): string {
    return this.#shas.hexAt(row);
  }

  shortShaAt(row: number, chars = 7): string {
    return this.#shas.shortHexAt(row, chars);
  }

  subjectAt(row: number): string {
    return this.#subjects.at(row);
  }

  authorAt(row: number): CommitIdentity {
    return {
      name: this.#interner.get(this.#authorName.get(row)),
      email: this.#interner.get(this.#authorEmail.get(row)),
      timestamp: this.#authorTime.get(row),
    };
  }

  committerAt(row: number): CommitIdentity {
    return {
      name: this.#interner.get(this.#committerName.get(row)),
      email: this.#interner.get(this.#committerEmail.get(row)),
      timestamp: this.#committerTime.get(row),
    };
  }

  // -------------------------------------------------------------------------------------
  // Read-only column views — `docs/plans/P11.md` W2. Every one of these is a VIEW, not a copy,
  // and valid only until the next `append`/`appendPage`/`appendPacked` call grows the backing
  // array out from under it: `search/matcher.ts`'s `searchLoadedCommits` (the one caller) reads
  // them once at the top of a scan and never awaits inside it, which is the invariant to hold at
  // both ends rather than something this store enforces itself.
  // -------------------------------------------------------------------------------------

  /** The interner's own backing array, id-indexed — probe 9b's once-per-query dictionary match
   *  turns four per-row string comparisons into four integer `Set.has` checks. */
  internedStrings(): readonly string[] {
    return this.#interner.values();
  }

  /** The four identity columns, `[authorName, authorEmail, committerName, committerEmail]`, each
   *  a `Uint32Array` view of exactly `rowCount` interned-string ids. */
  identityColumns(): readonly [Uint32Array, Uint32Array, Uint32Array, Uint32Array] {
    return [
      this.#authorName.view(),
      this.#authorEmail.view(),
      this.#committerName.view(),
      this.#committerEmail.view(),
    ];
  }

  /** `rowCount * shaWidthBytes` bytes of binary shas, in row order. Empty (not a throw) for an
   *  empty store — `ShaTable.widthBytes` is undefined until the first append, which `rangeView`
   *  would otherwise assert on for a `(0, 0)` range. */
  shaBytes(): Uint8Array {
    return this.#rowCount === 0 ? new Uint8Array(0) : this.#shas.rangeView(0, this.#rowCount);
  }

  get shaWidthBytes(): number {
    return this.#rowCount > 0 ? this.#shas.widthBytes : 20;
  }

  /** The concatenated subject buffer — decode `subjectBytes().subarray(start, end)` per row
   *  rather than calling `subjectAt` (probe 9b: a per-row `TextDecoder` allocation is most of the
   *  naive matcher's cost). Pairs with `subjectOffsets()`. */
  subjectBytes(): Uint8Array {
    return this.#subjects.rangeBytes(0, this.#rowCount).bytes;
  }

  /** `offsets[i] .. offsets[i + 1]` bounds row `i`'s subject in `subjectBytes()`; one more entry
   *  than `rowCount`. */
  subjectOffsets(): Uint32Array {
    return this.#subjects.rangeBytes(0, this.#rowCount).offsets;
  }

  /** A view into the parent column: row indices, or -1 for a parent not (yet) loaded. */
  parentsOf(row: number): Int32Array {
    assert(row >= 0 && row < this.#rowCount, `CommitStore.parentsOf(${row}): out of range`);
    const offsets = this.#parentOffsets;
    const start = offsets.get(row);
    const end = offsets.get(row + 1);
    return this.#parentRows.view().subarray(start, end);
  }

  decorationAt(row: number): readonly DecorationRef[] {
    return this.#decorations.get(row) ?? [];
  }

  /** The <=60-rows-on-screen path (§5.5): allocates one object, retains nothing. */
  commitAt(row: number): CommitRecord {
    const parentRows = this.parentsOf(row);
    const offsets = this.#parentOffsets;
    const start = offsets.get(row);
    const parents = Array.from(parentRows, (parentRow, i) => {
      if (parentRow !== UNRESOLVED_PARENT_ROW) return this.shaAt(parentRow);
      const hex = this.#pendingParents.get(start + i);
      assert(hex !== undefined, "unreachable: unresolved parent slot missing from pending map");
      return hex;
    });
    return {
      sha: this.shaAt(row),
      parents,
      author: this.authorAt(row),
      committer: this.committerAt(row),
      subject: this.subjectAt(row),
      decoration: this.decorationAt(row),
    };
  }

  /**
   * The row range `[from, to)` plus the parent CSR the layout algorithm reads — the *whole*
   * store's `parentOffsets`/`parentRows` columns, not sliced, since a patch may need to reach
   * back to a row outside `[from, to)`. `resolvedParentSlots` is every parent slot resolved
   * since the last call to this method (see the field's own doc comment), then cleared —
   * calling this twice in a row without an intervening append yields an empty second result,
   * not a repeat of the first.
   */
  layoutInput(from: number, to: number): LayoutInput {
    assert(
      from >= 0 && to <= this.#rowCount && from <= to,
      `CommitStore.layoutInput(${from}, ${to}): out of range for ${this.#rowCount} rows`,
    );
    const resolvedParentSlots = Uint32Array.from(this.#resolvedSinceLastLayoutInput);
    this.#resolvedSinceLastLayoutInput = [];
    return {
      from,
      to,
      parentOffsets: this.#parentOffsets.view(),
      parentRows: this.#parentRows.view(),
      resolvedParentSlots,
    };
  }

  /**
   * Packs rows `[from, to)` into the wire format (P3 W3): the dictionary carries only strings
   * interned since `dictionaryBase`, so the caller (`RepoService`, W7) is responsible for
   * tracking what the receiver has already been sent and passing that boundary back in on the
   * next call.
   */
  packSlice(from: number, to: number, dictionaryBase: number): PackedCommitChunk {
    assert(
      from >= 0 && to <= this.#rowCount && from <= to,
      `CommitStore.packSlice(${from}, ${to}): out of range for ${this.#rowCount} rows`,
    );
    assert(
      dictionaryBase >= 0 && dictionaryBase <= this.#interner.size,
      `CommitStore.packSlice: dictionaryBase ${dictionaryBase} out of range for ` +
        `${this.#interner.size} interned strings`,
    );

    const count = to - from;
    const shaWidthBytes = this.#rowCount > 0 ? this.#shas.widthBytes : 20;

    const shas = new Uint8Array(count * shaWidthBytes);
    if (count > 0) shas.set(this.#shas.rangeView(from, to));

    const globalParentStart = this.#parentOffsets.get(from);
    const globalParentEnd = this.#parentOffsets.get(to);
    const parentOffsets = new Uint32Array(count + 1);
    for (let i = 0; i <= count; i++) {
      parentOffsets[i] = this.#parentOffsets.get(from + i) - globalParentStart;
    }

    const parentShas = new Uint8Array((globalParentEnd - globalParentStart) * shaWidthBytes);
    for (let slot = globalParentStart; slot < globalParentEnd; slot++) {
      const parentRow = this.#parentRows.get(slot);
      const bytes =
        parentRow === UNRESOLVED_PARENT_ROW
          ? hexToBytes(
              assertDefined(
                this.#pendingParents.get(slot),
                `unreachable: unresolved parent slot ${slot} missing from pending map`,
              ),
              shaWidthBytes,
            )
          : this.#shas.bytesAt(parentRow);
      parentShas.set(bytes, (slot - globalParentStart) * shaWidthBytes);
    }

    const identityIds = new Uint32Array(count * 4);
    const times = new Uint32Array(count * 2);
    const decorations: [number, readonly DecorationRef[]][] = [];
    for (let i = 0; i < count; i++) {
      const row = from + i;
      identityIds[i * 4 + 0] = this.#authorName.get(row);
      identityIds[i * 4 + 1] = this.#authorEmail.get(row);
      identityIds[i * 4 + 2] = this.#committerName.get(row);
      identityIds[i * 4 + 3] = this.#committerEmail.get(row);
      times[i * 2 + 0] = this.#authorTime.get(row);
      times[i * 2 + 1] = this.#committerTime.get(row);
      const refs = this.#decorations.get(row);
      if (refs !== undefined) decorations.push([i, refs]);
    }

    const subjectRange = this.#subjects.rangeBytes(from, to);
    const subjectBytes = new Uint8Array(subjectRange.bytes.length);
    subjectBytes.set(subjectRange.bytes);

    return {
      from,
      to,
      shaWidthBytes,
      shas: shas.buffer as ArrayBuffer,
      parentOffsets: parentOffsets.buffer as ArrayBuffer,
      parentShas: parentShas.buffer as ArrayBuffer,
      identityIds: identityIds.buffer as ArrayBuffer,
      times: times.buffer as ArrayBuffer,
      subjectBytes: subjectBytes.buffer as ArrayBuffer,
      subjectOffsets: subjectRange.offsets.buffer as ArrayBuffer,
      dictionaryBase,
      dictionary: this.#interner.valuesFrom(dictionaryBase),
      decorations,
    };
  }

  /**
   * Applies a wire chunk in place of the record-by-record `appendPage` path — the receiving
   * side of `packSlice`. Throws if the chunk doesn't start exactly where this store's rows end,
   * or if `dictionaryBase` doesn't match the interner's current size: both mean a chunk arrived
   * out of order or one was dropped, and applying it anyway would silently misattribute
   * dictionary ids to the wrong strings.
   */
  appendPacked(chunk: PackedCommitChunk): AppendResult {
    assert(
      chunk.from === this.#rowCount,
      `CommitStore.appendPacked: chunk starts at row ${chunk.from} but the store has ` +
        `${this.#rowCount} rows — chunks must be applied in order`,
    );
    assert(
      chunk.dictionaryBase === this.#interner.size,
      `CommitStore.appendPacked: chunk's dictionaryBase (${chunk.dictionaryBase}) does not ` +
        `match the store's interner size (${this.#interner.size}) — chunks arrived out of ` +
        "order or one was dropped",
    );

    for (const value of chunk.dictionary) this.#interner.intern(value);

    const from = this.#rowCount;
    const count = chunk.to - chunk.from;
    const shas = new Uint8Array(chunk.shas);
    const parentOffsets = new Uint32Array(chunk.parentOffsets);
    const parentShas = new Uint8Array(chunk.parentShas);
    const identityIds = new Uint32Array(chunk.identityIds);
    const times = new Uint32Array(chunk.times);
    const subjectBytes = new Uint8Array(chunk.subjectBytes);
    const subjectOffsets = new Uint32Array(chunk.subjectOffsets);
    const decorationByRow = new Map(chunk.decorations);

    for (let i = 0; i < count; i++) {
      const row = from + i;
      const shaSlice = shas.subarray(i * chunk.shaWidthBytes, (i + 1) * chunk.shaWidthBytes);
      const shaRow = this.#shas.appendBytes(shaSlice);
      assert(
        shaRow === row,
        `CommitStore.appendPacked: sha table row ${shaRow} does not match store row ${row}`,
      );

      this.#authorName.push(identityIds[i * 4 + 0] as number);
      this.#authorEmail.push(identityIds[i * 4 + 1] as number);
      this.#committerName.push(identityIds[i * 4 + 2] as number);
      this.#committerEmail.push(identityIds[i * 4 + 3] as number);
      this.#authorTime.push(times[i * 2 + 0] as number);
      this.#committerTime.push(times[i * 2 + 1] as number);

      const subjectStart = subjectOffsets[i] as number;
      const subjectEnd = subjectOffsets[i + 1] as number;
      const subjectRow = this.#subjects.append(
        textDecoder.decode(subjectBytes.subarray(subjectStart, subjectEnd)),
      );
      assert(subjectRow === row, "unreachable: subjects appended in the same order as rows");

      const decoration = decorationByRow.get(i);
      if (decoration !== undefined && decoration.length > 0) this.#decorations.set(row, decoration);

      const parentStart = parentOffsets[i] as number;
      const parentEnd = parentOffsets[i + 1] as number;
      for (let p = parentStart; p < parentEnd; p++) {
        const parentShaSlice = parentShas.subarray(
          p * chunk.shaWidthBytes,
          (p + 1) * chunk.shaWidthBytes,
        );
        const parentRow = this.#shas.rowOfBytes(parentShaSlice);
        const slot = this.#parentRows.push(parentRow === -1 ? UNRESOLVED_PARENT_ROW : parentRow);
        if (parentRow === -1) this.#pendingParents.set(slot, bytesToHex(parentShaSlice));
      }
      this.#parentOffsets.push(this.#parentRows.length);
      this.#rowCount++;
    }

    const to = this.#rowCount;
    const resolvedParentSlots = Uint32Array.from(this.#resolvePendingParents());
    return { from, to, resolvedParentSlots };
  }

  stats(): CommitStoreStats {
    const columnBytes =
      this.#authorName.byteLength +
      this.#authorEmail.byteLength +
      this.#authorTime.byteLength +
      this.#committerName.byteLength +
      this.#committerEmail.byteLength +
      this.#committerTime.byteLength +
      this.#parentOffsets.byteLength +
      this.#parentRows.byteLength;
    const shaTableBytes = this.#shas.byteLength;
    const subjectBufferBytes = this.#subjects.byteLength;
    const internedStringBytes = this.#interner.byteLength;
    return {
      rowCount: this.#rowCount,
      shaTableBytes,
      columnBytes,
      subjectBufferBytes,
      internedStringBytes,
      decorationEntryCount: this.#decorations.size,
      pendingParentCount: this.#pendingParents.size,
      clampedTimestampCount: this.#clampedTimestampCount,
      totalBytes: shaTableBytes + columnBytes + subjectBufferBytes + internedStringBytes,
    };
  }

  clear(): void {
    this.#shas.clear();
    this.#decorations.clear();
    this.#pendingParents.clear();
    this.#rowCount = 0;
    this.#clampedTimestampCount = 0;
    this.#resolvedSinceLastLayoutInput = [];
    this.#authorName.clear();
    this.#authorEmail.clear();
    this.#authorTime.clear();
    this.#committerName.clear();
    this.#committerEmail.clear();
    this.#committerTime.clear();
    this.#parentOffsets.clear();
    this.#parentRows.clear();
    this.#parentOffsets.push(0);
    this.#interner.clear();
    this.#subjects.clear();
  }
}
