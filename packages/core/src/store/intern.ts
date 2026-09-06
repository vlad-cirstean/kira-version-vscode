/**
 * §5.5's third memory rule, both halves of it: string interning (author names, emails, ref
 * names repeat — a repo with 20 authors should retain 20 strings, not 100k) and the subject
 * buffer (commit subjects are the one genuinely large, genuinely non-repeating set, so they go
 * into one concatenated `Uint8Array` with an offset index rather than 100k separate string
 * objects).
 */
import { assert } from "../util/assert.ts";

/** Rough per-string retained-heap estimate: a UTF-16 char is 2 bytes in V8, plus a fixed
 *  string-object overhead. Not exact — exactness would need engine internals no public API
 *  exposes — but stable enough to catch a regression in `stats()` (W4/W15). */
const STRING_OVERHEAD_BYTES = 24;

function estimateStringBytes(value: string): number {
  return STRING_OVERHEAD_BYTES + value.length * 2;
}

/**
 * A `Map<string, number>` plus a `string[]` — the easy half of §5.5's third rule. `intern` is
 * idempotent: interning the same value twice returns the same id, in first-seen order.
 */
export class StringInterner {
  readonly #idOf = new Map<string, number>();
  readonly #values: string[] = [];
  #byteLength = 0;

  intern(value: string): number {
    const existing = this.#idOf.get(value);
    if (existing !== undefined) return existing;
    const id = this.#values.length;
    this.#idOf.set(value, id);
    this.#values.push(value);
    this.#byteLength += estimateStringBytes(value);
    return id;
  }

  get(id: number): string {
    const value = this.#values[id];
    assert(value !== undefined, `StringInterner.get(${id}): no such id`);
    return value;
  }

  /** The backing array itself, index === id — a view, not a copy: valid only until the next
   *  `intern()` call adds to it. `search/matcher.ts`'s once-per-query dictionary pre-match
   *  (`docs/plans/P11.md` probe 9b) is the one caller; it never awaits while holding this. */
  values(): readonly string[] {
    return this.#values;
  }

  get size(): number {
    return this.#values.length;
  }

  /** Estimated retained bytes across every distinct interned string. */
  get byteLength(): number {
    return this.#byteLength;
  }

  /** Every string interned since id `base`, in id order — the wire format's dictionary delta
   *  (W3): a packed chunk carries only the strings the receiver doesn't already have. */
  valuesFrom(base: number): readonly string[] {
    assert(
      base >= 0 && base <= this.#values.length,
      `StringInterner.valuesFrom(${base}): out of range for ${this.#values.length} strings`,
    );
    return this.#values.slice(base);
  }

  clear(): void {
    this.#idOf.clear();
    this.#values.length = 0;
    this.#byteLength = 0;
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

function growBuffer(current: Uint8Array<ArrayBuffer>, minLength: number): Uint8Array<ArrayBuffer> {
  let capacity = current.length === 0 ? 1024 : current.length;
  while (capacity < minLength) capacity *= 2;
  const grown = new Uint8Array(capacity);
  grown.set(current);
  return grown;
}

function growOffsets(
  current: Uint32Array<ArrayBuffer>,
  minLength: number,
): Uint32Array<ArrayBuffer> {
  let capacity = current.length === 0 ? 256 : current.length;
  while (capacity < minLength) capacity *= 2;
  const grown = new Uint32Array(capacity);
  grown.set(current);
  return grown;
}

/**
 * A single growing `Uint8Array` of UTF-8 bytes plus a `Uint32Array` of start offsets: subject
 * `i` is `bytes[offsets[i] .. offsets[i+1])`. `append` always assigns the next sequential
 * index — there is no way to insert or overwrite out of order — so keeping subjects in row
 * order is a contract enforced by the caller: `CommitStore` (W4) asserts the index `append`
 * returns against its own row counter, which is what turns a caller that fell out of sync into
 * a loud failure instead of a subject silently misattributed to the wrong row.
 */
export class SubjectBuffer {
  #bytes = new Uint8Array(0);
  #byteLength = 0;
  // offsets[i] = start of subject i; offsets[count] = current end (one more entry than count).
  #offsets = new Uint32Array(1);
  #count = 0;

  append(subject: string): number {
    const index = this.#count;
    const encoded = textEncoder.encode(subject);
    const start = this.#byteLength;
    const end = start + encoded.length;

    if (end > this.#bytes.length) this.#bytes = growBuffer(this.#bytes, end);
    this.#bytes.set(encoded, start);
    this.#byteLength = end;

    if (this.#count + 1 >= this.#offsets.length) {
      this.#offsets = growOffsets(this.#offsets, this.#count + 2);
    }
    this.#offsets[this.#count + 1] = end;
    this.#count++;
    return index;
  }

  at(index: number): string {
    assert(
      index >= 0 && index < this.#count,
      `SubjectBuffer.at(${index}): only ${this.#count} subjects appended`,
    );
    const start = this.#offsets[index];
    const end = this.#offsets[index + 1];
    assert(start !== undefined && end !== undefined, "unreachable: offsets sized to count + 1");
    return textDecoder.decode(this.#bytes.subarray(start, end));
  }

  get count(): number {
    return this.#count;
  }

  /** Actual allocated bytes: the encoded-subject buffer plus the offset index. */
  get byteLength(): number {
    return this.#bytes.byteLength + this.#offsets.byteLength;
  }

  /** Bytes and chunk-relative offsets for rows `[from, to)` — the wire format's per-chunk
   *  subject columns (W3). Subjects are appended contiguously in row order, so this is one
   *  contiguous slice rather than `to - from` individual re-encodes; `bytes` is a view into the
   *  live buffer, not a copy, and the offsets are rebased to start at 0 for the slice. */
  rangeBytes(
    from: number,
    to: number,
  ): { readonly bytes: Uint8Array; readonly offsets: Uint32Array } {
    assert(
      from >= 0 && to <= this.#count && from <= to,
      `SubjectBuffer.rangeBytes(${from}, ${to}): out of range (${this.#count} entries)`,
    );
    const start = this.#offsets[from] as number;
    const end = this.#offsets[to] as number;
    const offsets = new Uint32Array(to - from + 1);
    for (let i = 0; i <= to - from; i++) {
      offsets[i] = (this.#offsets[from + i] as number) - start;
    }
    return { bytes: this.#bytes.subarray(start, end), offsets };
  }

  clear(): void {
    this.#bytes = new Uint8Array(0);
    this.#byteLength = 0;
    this.#offsets = new Uint32Array(1);
    this.#count = 0;
  }
}
