/**
 * P16 W5 — `toWire`/`fromWire` for `graph.stream`'s `PackedCommitChunk`, the one payload this
 * phase moves onto FlatBuffers (D45). Lives in its own file rather than inside `codec.ts`:
 * `codec.ts` owns *buffer encodings* (D34/D35), this owns *one payload's schema* — different
 * concerns, different reasons to change.
 *
 * The four compile-time/runtime drift guards this file carries (P16 plan, "What the drift check
 * actually protects today"):
 *  1. `toWire`'s exhaustive destructure + `Record<string, never>` guard — a field added to
 *     `PackedCommitChunk` and never written here fails `tsc`.
 *  2. `fromWire`'s annotated return type — a field never read back fails `tsc`.
 *  3. `ACCESSOR_BRIDGE` — every `keyof PackedCommitChunk` must also be an accessor on the
 *     generated table class; a contract field with no schema counterpart fails `tsc`.
 *  4. The `never`-defaulted `switch` on `DecorationRef.kind` in both directions.
 * What none of these can catch — a field written to the wrong slot — is `wireConformance.test.ts`'s
 * job (W9's no-defaults structural test).
 */
import * as flatbuffers from "flatbuffers";
import type { DecorationRef, PackedCommitChunk } from "./contract.ts";
import {
  DecorationRef as GeneratedDecorationRef,
  PackedCommitChunk as GeneratedPackedCommitChunk,
  RowDecorations as GeneratedRowDecorations,
} from "./generated/graphChunk.ts";

const FILE_IDENTIFIER = "KVGC";

// ---------------------------------------------------------------------------------------
// Drift guard 3 — every field PackedCommitChunk declares must have a same-named accessor on
// the generated table class (flatc camel-cases sha_width_bytes -> shaWidthBytes, so the names
// line up by construction). A field with no accessor makes its property's type `never` below,
// and assigning `true` to it fails `tsc`.
// ---------------------------------------------------------------------------------------

type AccessorBridge = {
  readonly [K in keyof PackedCommitChunk]: K extends keyof GeneratedPackedCommitChunk
    ? true
    : never;
};

const ACCESSOR_BRIDGE: AccessorBridge = {
  from: true,
  to: true,
  shaWidthBytes: true,
  shas: true,
  parentOffsets: true,
  parentShas: true,
  identityIds: true,
  times: true,
  subjectBytes: true,
  subjectOffsets: true,
  dictionaryBase: true,
  dictionary: true,
  decorations: true,
};
void ACCESSOR_BRIDGE;

// ---------------------------------------------------------------------------------------
// toWire
// ---------------------------------------------------------------------------------------

function addDecorationRef(builder: flatbuffers.Builder, ref: DecorationRef): number {
  const kindOffset = builder.createString(ref.kind);
  let nameOffset = 0;
  let isHead = false;
  switch (ref.kind) {
    case "branch":
      nameOffset = builder.createString(ref.name);
      isHead = ref.isHead;
      break;
    case "remoteBranch":
    case "tag":
      nameOffset = builder.createString(ref.name);
      break;
    case "head":
      break;
    // P9: no new wire field for `index` — the FlatBuffers schema has no numeric slot for a
    // stash decoration and adding one means a schema/codegen change this phase does not need;
    // the `name` string slot is otherwise unused for "stash" (and always was), so the index
    // travels there as its decimal string form instead.
    case "stash":
      nameOffset = builder.createString(String(ref.index));
      break;
    default: {
      const exhaustive: never = ref;
      throw new Error(
        `graphChunkCodec.toWire: unrecognised DecorationRef kind ${JSON.stringify(exhaustive)}`,
      );
    }
  }
  return GeneratedDecorationRef.createDecorationRef(builder, kindOffset, nameOffset, isHead);
}

/** Builds one `PackedCommitChunk` FlatBuffer, finished with the `"KVGC"` identifier, and returns
 *  exactly-sized bytes (`asUint8Array()`'s own buffer may be larger than the message it holds). */
export function toWire(chunk: PackedCommitChunk): ArrayBuffer {
  const {
    from,
    to,
    shaWidthBytes,
    shas,
    parentOffsets,
    parentShas,
    identityIds,
    times,
    subjectBytes,
    subjectOffsets,
    dictionaryBase,
    dictionary,
    decorations,
    ...rest
  } = chunk;
  // Drift guard 1: a field added to PackedCommitChunk and never destructured above lands here,
  // and assigning it to `Record<string, never>` fails `tsc`.
  const exhaustive: Record<string, never> = rest;
  void exhaustive;

  const builder = new flatbuffers.Builder(1024);

  // Nested tables are built leaf-first: each row's DecorationRefs, then that row's
  // RowDecorations, before the chunk-level `decorations` vector that references them all.
  const rowDecorationOffsets: number[] = [];
  for (const [row, refs] of decorations) {
    const refOffsets = refs.map((ref) => addDecorationRef(builder, ref));
    const refsVector = GeneratedRowDecorations.createRefsVector(builder, refOffsets);
    rowDecorationOffsets.push(
      GeneratedRowDecorations.createRowDecorations(builder, row, refsVector),
    );
  }
  const decorationsVector = GeneratedPackedCommitChunk.createDecorationsVector(
    builder,
    rowDecorationOffsets,
  );

  const dictionaryOffsets = dictionary.map((value) => builder.createString(value));
  const dictionaryVector = GeneratedPackedCommitChunk.createDictionaryVector(
    builder,
    dictionaryOffsets,
  );

  // Every column vector is created unconditionally, even at zero length, so a chunk's empty
  // columns (emptyPackedChunk(), a single root commit's empty parentShas) round-trip as
  // zero-length vectors rather than an absent field reading back as FlatBuffers' scalar/vector
  // default (rpc.test.ts's emptyPackedChunk() depends on this).
  //
  // These seven `[ubyte]` columns use `builder.createByteVector()` — the `flatbuffers` runtime's
  // own bulk method (one `TypedArray.set()` copy) — rather than the generated
  // `create<Field>Vector()` wrappers flatc emits for byte columns, which loop `addInt8()` once per
  // element. Both produce byte-identical wire output (a `[ubyte]` vector is just length + raw
  // bytes, regardless of which builder call wrote it); this is a sender-side perf fix only (P16
  // W11 follow-up), not a wire-format change. String/offset vectors (dictionary, decorations,
  // refs) still use their generated per-element builders below — `createByteVector` only applies
  // to raw byte vectors.
  const shasVector = builder.createByteVector(new Uint8Array(shas));
  const parentOffsetsVector = builder.createByteVector(new Uint8Array(parentOffsets));
  const parentShasVector = builder.createByteVector(new Uint8Array(parentShas));
  const identityIdsVector = builder.createByteVector(new Uint8Array(identityIds));
  const timesVector = builder.createByteVector(new Uint8Array(times));
  const subjectBytesVector = builder.createByteVector(new Uint8Array(subjectBytes));
  const subjectOffsetsVector = builder.createByteVector(new Uint8Array(subjectOffsets));

  GeneratedPackedCommitChunk.startPackedCommitChunk(builder);
  GeneratedPackedCommitChunk.addFrom(builder, from);
  GeneratedPackedCommitChunk.addTo(builder, to);
  GeneratedPackedCommitChunk.addShaWidthBytes(builder, shaWidthBytes);
  GeneratedPackedCommitChunk.addShas(builder, shasVector);
  GeneratedPackedCommitChunk.addParentOffsets(builder, parentOffsetsVector);
  GeneratedPackedCommitChunk.addParentShas(builder, parentShasVector);
  GeneratedPackedCommitChunk.addIdentityIds(builder, identityIdsVector);
  GeneratedPackedCommitChunk.addTimes(builder, timesVector);
  GeneratedPackedCommitChunk.addSubjectBytes(builder, subjectBytesVector);
  GeneratedPackedCommitChunk.addSubjectOffsets(builder, subjectOffsetsVector);
  GeneratedPackedCommitChunk.addDictionaryBase(builder, dictionaryBase);
  GeneratedPackedCommitChunk.addDictionary(builder, dictionaryVector);
  GeneratedPackedCommitChunk.addDecorations(builder, decorationsVector);
  const offset = GeneratedPackedCommitChunk.endPackedCommitChunk(builder);
  GeneratedPackedCommitChunk.finishPackedCommitChunkBuffer(builder, offset);

  const bytes = builder.asUint8Array();
  // A fresh, exactly-sized ArrayBuffer — `asUint8Array()`'s own backing buffer is the builder's
  // internal (over-allocated, growable) one, not sized to the finished message.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// ---------------------------------------------------------------------------------------
// fromWire
// ---------------------------------------------------------------------------------------

/** A fresh, exactly-sized `ArrayBuffer` copy of a column — never a view over the FlatBuffer
 *  itself. `appendPacked` does `new Uint32Array(chunk.parentOffsets)`, and a view over the
 *  FlatBuffer's own (larger) backing buffer would silently carry the wrong length; `codec.ts`'s
 *  `decodeBuffers` makes this exact `.slice()` for the same reason. `null` (an absent vector,
 *  never produced by `toWire` itself but a real possibility for a foreign buffer) normalizes to
 *  the same empty `ArrayBuffer` a zero-length vector produces. */
function copyColumn(view: Uint8Array | null): ArrayBuffer {
  if (view === null) return new ArrayBuffer(0);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function readDecorationRef(ref: GeneratedDecorationRef): DecorationRef {
  const kind = ref.kind();
  if (kind === null) {
    throw new Error("graphChunkCodec.fromWire: DecorationRef.kind is required but was absent");
  }
  switch (kind) {
    case "branch": {
      const name = ref.name();
      if (name === null) throw new Error("graphChunkCodec.fromWire: 'branch' ref has no name");
      return { kind: "branch", name, isHead: ref.isHead() };
    }
    case "remoteBranch": {
      const name = ref.name();
      if (name === null) {
        throw new Error("graphChunkCodec.fromWire: 'remoteBranch' ref has no name");
      }
      return { kind: "remoteBranch", name };
    }
    case "tag": {
      const name = ref.name();
      if (name === null) throw new Error("graphChunkCodec.fromWire: 'tag' ref has no name");
      return { kind: "tag", name };
    }
    case "head":
      return { kind: "head" };
    case "stash": {
      const name = ref.name();
      if (name === null) throw new Error("graphChunkCodec.fromWire: 'stash' ref has no index");
      return { kind: "stash", index: Number(name) };
    }
    default:
      throw new Error(`graphChunkCodec.fromWire: unrecognised DecorationRef kind '${kind}'`);
  }
}

/** Reads one `PackedCommitChunk` back out of a FlatBuffer built by `toWire`. Every property is
 *  written explicitly (drift guard 2): a field added to `PackedCommitChunk` and never read here
 *  is a missing-property `tsc` error on this function's return type. */
export function fromWire(buffer: ArrayBuffer): PackedCommitChunk {
  const byteBuffer = new flatbuffers.ByteBuffer(new Uint8Array(buffer));
  if (!GeneratedPackedCommitChunk.bufferHasIdentifier(byteBuffer)) {
    throw new Error(
      `graphChunkCodec.fromWire: buffer is missing the '${FILE_IDENTIFIER}' file identifier`,
    );
  }
  const table = GeneratedPackedCommitChunk.getRootAsPackedCommitChunk(byteBuffer);

  const decorations: Array<readonly [number, readonly DecorationRef[]]> = [];
  for (let i = 0; i < table.decorationsLength(); i++) {
    const rowDecorations = table.decorations(i);
    if (!rowDecorations) {
      throw new Error("unreachable: decorationsLength() disagreed with decorations(i)");
    }
    const refs: DecorationRef[] = [];
    for (let j = 0; j < rowDecorations.refsLength(); j++) {
      const ref = rowDecorations.refs(j);
      if (!ref) throw new Error("unreachable: refsLength() disagreed with refs(j)");
      refs.push(readDecorationRef(ref));
    }
    decorations.push([rowDecorations.row(), refs]);
  }

  const dictionary: string[] = [];
  for (let i = 0; i < table.dictionaryLength(); i++) dictionary.push(table.dictionary(i));

  return {
    from: table.from(),
    to: table.to(),
    shaWidthBytes: table.shaWidthBytes(),
    shas: copyColumn(table.shasArray()),
    parentOffsets: copyColumn(table.parentOffsetsArray()),
    parentShas: copyColumn(table.parentShasArray()),
    identityIds: copyColumn(table.identityIdsArray()),
    times: copyColumn(table.timesArray()),
    subjectBytes: copyColumn(table.subjectBytesArray()),
    subjectOffsets: copyColumn(table.subjectOffsetsArray()),
    dictionaryBase: table.dictionaryBase(),
    dictionary,
    decorations,
  };
}
