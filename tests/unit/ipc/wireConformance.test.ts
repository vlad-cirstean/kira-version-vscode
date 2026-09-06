/**
 * `packages/ipc` may not import `@kira-version/core` (§3.1, B3), so `contract.ts` declares its
 * own structural copies of core's wire-relevant types instead of importing them. This file is
 * the check that closes the drift that resolution risks (`docs/plans/P3.md`'s "The `ipc` →
 * `core` boundary" section): every assignment below is compile-time-only — `tsc --build`
 * (`bun run check`) fails if a field is added to one side and not the other, in either
 * direction, which is exactly what an import would have caught for free.
 *
 * Lives under `tests/unit/` rather than colocated in either package for the same `rootDir`
 * reason P2 discovered (`docs/SPEC.md` §3.1): a test that imports both `packages/core` and
 * `packages/ipc` cannot live inside either package's own `src/`.
 */
import { describe, expect, test } from "bun:test";
import type {
  CommitRecord,
  CommitIdentity as CoreCommitIdentity,
  DecorationRef as CoreDecorationRef,
  FileChange as CoreFileChange,
  SignatureStatus as CoreSignatureStatus,
} from "../../../packages/core/src/model/commit.ts";
import type {
  CommitTrailer as CoreCommitTrailer,
  DiffHunk as CoreDiffHunk,
  DiffLine as CoreDiffLine,
  FileDiffBody as CoreFileDiffBody,
} from "../../../packages/core/src/model/diff.ts";
import type {
  InProgressOperation as CoreInProgressOperation,
  OpRequest as CoreOpRequest,
  OpResult as CoreOpResult,
  UndoSlotSnapshot as CoreUndoSlotSnapshot,
} from "../../../packages/core/src/model/operation.ts";
import type {
  RefKind as CoreRefKind,
  RefRecord as CoreRefRecord,
  TagAnnotation as CoreTagAnnotation,
} from "../../../packages/core/src/model/ref.ts";
import type {
  PullStrategy as CorePullStrategy,
  PullStrategySource as CorePullStrategySource,
  RefUpdate as CoreRefUpdate,
  RemoteOpKind as CoreRemoteOpKind,
  RemoteOpRequest as CoreRemoteOpRequest,
  RemoteOpResult as CoreRemoteOpResult,
} from "../../../packages/core/src/model/remote.ts";
import type { HeadState as CoreHeadState } from "../../../packages/core/src/model/repo.ts";
import type {
  BaseCandidate as CoreBaseCandidate,
  BaseResolutionReason as CoreBaseResolutionReason,
} from "../../../packages/core/src/model/review.ts";
import type { StatusSummary as CoreStatusSummary } from "../../../packages/core/src/model/status.ts";
import type {
  CheckoutPreflight as CoreCheckoutPreflight,
  PullPreflight as CorePullPreflight,
  PushPreflight as CorePushPreflight,
  RevertPreflight as CoreRevertPreflight,
} from "../../../packages/core/src/preflight/types.ts";
import {
  type Settings as CoreSettings,
  defaultSettings,
} from "../../../packages/core/src/settings/schema.ts";
import { CommitStore } from "../../../packages/core/src/store/commitStore.ts";
import type { GitErrorKind as CoreGitErrorKind } from "../../../packages/git/src/errors.ts";
import type { BufferEncoding } from "../../../packages/ipc/src/codec.ts";
import {
  decode,
  decodeStreamPayload,
  encode,
  encodeStreamPayload,
} from "../../../packages/ipc/src/codec.ts";
import type {
  PackedCommitChunk,
  StreamChunkOf,
  BaseCandidate as WireBaseCandidate,
  BaseResolutionReason as WireBaseResolutionReason,
  CheckoutPreflight as WireCheckoutPreflight,
  CommitIdentity as WireCommitIdentity,
  CommitTrailer as WireCommitTrailer,
  DecorationRef as WireDecorationRef,
  DiffHunk as WireDiffHunk,
  DiffLine as WireDiffLine,
  FileChange as WireFileChange,
  FileDiffBody as WireFileDiffBody,
  HeadState as WireHeadState,
  InProgressOperation as WireInProgressOperation,
  OpErrorKind as WireOpErrorKind,
  OpRequest as WireOpRequest,
  OpResult as WireOpResult,
  PullPreflight as WirePullPreflight,
  PullStrategy as WirePullStrategy,
  PullStrategySource as WirePullStrategySource,
  PushPreflight as WirePushPreflight,
  RefRow as WireRefRow,
  RefUpdate as WireRefUpdate,
  RemoteOpKind as WireRemoteOpKind,
  RemoteOpParams as WireRemoteOpParams,
  RemoteOpResult as WireRemoteOpResult,
  RevertPreflight as WireRevertPreflight,
  SettingsSnapshot as WireSettingsSnapshot,
  SignatureStatus as WireSignatureStatus,
  StatusSummary as WireStatusSummary,
  TagAnnotation as WireTagAnnotation,
  UndoSlotSnapshot as WireUndoSlotSnapshot,
} from "../../../packages/ipc/src/contract.ts";
import {
  fromWire as graphChunkFromWire,
  toWire as graphChunkToWire,
} from "../../../packages/ipc/src/graphChunkCodec.ts";
import { topology } from "../../fixtures/topology.ts";

/** Never called — its only job is to make the assignments inside it part of the compiled
 *  program, so a type mismatch is a `tsc` error rather than dead code eliminated before it
 *  can be checked. */
function assertBothWays<Wire, Core>(
  _toWire: (core: Core) => Wire,
  _toCore: (wire: Wire) => Core,
): void {
  // intentionally empty
}

describe("ipc wire conformance", () => {
  test("HeadState: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireHeadState, CoreHeadState>(
      (core) => core,
      (wire) => wire,
    );
    // A real value, so this test is not vacuous under `bun test` (which does not itself
    // typecheck) — it also exercises the shape at runtime.
    const branch: CoreHeadState = { kind: "branch", name: "main" };
    const wire: WireHeadState = branch;
    expect(wire).toEqual(branch);
  });

  test("DecorationRef: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireDecorationRef, CoreDecorationRef>(
      (core) => core,
      (wire) => wire,
    );
    const tag: CoreDecorationRef = { kind: "tag", name: "v1" };
    const wire: WireDecorationRef = tag;
    expect(wire).toEqual(tag);
  });

  test("SettingsSnapshot: core's generated Settings and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireSettingsSnapshot, CoreSettings>(
      (core) => core,
      (wire) => wire,
    );
    const settings: CoreSettings = defaultSettings();
    const wire: WireSettingsSnapshot = settings;
    expect(wire).toEqual(settings);
  });

  // ---- P5 W4: the diff model's wire copies ---------------------------------------------

  test("CommitIdentity: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireCommitIdentity, CoreCommitIdentity>(
      (core) => core,
      (wire) => wire,
    );
    const identity: CoreCommitIdentity = { name: "T", email: "t@t.com", timestamp: 0 };
    const wire: WireCommitIdentity = identity;
    expect(wire).toEqual(identity);
  });

  test("FileChange: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireFileChange, CoreFileChange>(
      (core) => core,
      (wire) => wire,
    );
    const change: CoreFileChange = {
      kind: "modified",
      path: "a.txt",
      originalPath: undefined,
      similarity: undefined,
      additions: 1,
      deletions: 1,
      isBinary: false,
    };
    const wire: WireFileChange = change;
    expect(wire).toEqual(change);
  });

  test("SignatureStatus: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireSignatureStatus, CoreSignatureStatus>(
      (core) => core,
      (wire) => wire,
    );
    const status: CoreSignatureStatus = "G";
    const wire: WireSignatureStatus = status;
    expect(wire).toBe(status);
  });

  test("CommitTrailer: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireCommitTrailer, CoreCommitTrailer>(
      (core) => core,
      (wire) => wire,
    );
    const trailer: CoreCommitTrailer = { token: "Signed-off-by", value: "T <t@t.com>" };
    const wire: WireCommitTrailer = trailer;
    expect(wire).toEqual(trailer);
  });

  test("DiffLine: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireDiffLine, CoreDiffLine>(
      (core) => core,
      (wire) => wire,
    );
    const line: CoreDiffLine = {
      kind: "add",
      text: "hello",
      oldLine: undefined,
      newLine: 1,
      noNewlineAtEof: false,
    };
    const wire: WireDiffLine = line;
    expect(wire).toEqual(line);
  });

  test("DiffHunk: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireDiffHunk, CoreDiffHunk>(
      (core) => core,
      (wire) => wire,
    );
    const hunk: CoreDiffHunk = {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      heading: "",
      lines: [],
    };
    const wire: WireDiffHunk = hunk;
    expect(wire).toEqual(hunk);
  });

  test("FileDiffBody: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireFileDiffBody, CoreFileDiffBody>(
      (core) => core,
      (wire) => wire,
    );
    const body: CoreFileDiffBody = { kind: "tooLarge", bytes: 2_000_000, limitBytes: 1_000_000 };
    const wire: WireFileDiffBody = body;
    expect(wire).toEqual(body);
  });

  // ---- P6 W9: refs, status, pre-flight, operations --------------------------------------

  test("RefRow: assignable both ways against core's RefRecord, minus the wire-irrelevant objectType", () => {
    // `RefRecord.objectType` (`"commit" | "tag" | "tree" | "blob"`) is never sent across the
    // wire — a tag's annotated-ness is already carried by `annotation`'s presence — so this
    // compares against `RefRecord` with that one field omitted, deliberately, rather than the
    // whole type: every OTHER field drifting on either side still fails `tsc`.
    assertBothWays<WireRefRow, Omit<CoreRefRecord, "objectType">>(
      (core) => core,
      (wire) => wire,
    );
    const record: CoreRefRecord = {
      refname: "refs/heads/main",
      kind: "branch",
      shortName: "main",
      objectId: "abc1234abc1234abc1234abc1234abc1234abc1",
      objectType: "commit",
      peeledObjectId: undefined,
      upstream: undefined,
      track: undefined,
      committerDate: 0,
      isHead: true,
      checkedOutIn: undefined,
      annotation: undefined,
    };
    const { objectType: _objectType, ...wire } = record;
    const asWire: WireRefRow = wire;
    expect(asWire).toEqual(wire);
  });

  test("TagAnnotation: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireTagAnnotation, CoreTagAnnotation>(
      (core) => core,
      (wire) => wire,
    );
    const annotation: CoreTagAnnotation = { tagger: "T <t@t.com>", date: 0, subject: "release" };
    const wire: WireTagAnnotation = annotation;
    expect(wire).toEqual(annotation);
  });

  test("StatusSummary: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireStatusSummary, CoreStatusSummary>(
      (core) => core,
      (wire) => wire,
    );
    const summary: CoreStatusSummary = {
      head: { kind: "branch", name: "main" },
      upstream: undefined,
      counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0 },
      isClean: true,
      dirtyPaths: [],
      dirtyTruncated: false,
      inProgress: null,
    };
    const wire: WireStatusSummary = summary;
    expect(wire).toEqual(summary);
  });

  test("InProgressOperation: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireInProgressOperation, CoreInProgressOperation>(
      (core) => core,
      (wire) => wire,
    );
    const op: CoreInProgressOperation = {
      kind: "revert",
      otherSha: "abc1234",
      headName: undefined,
      conflictedPaths: ["a.txt"],
      canContinue: true,
      canAbort: true,
      isSequence: false,
      unmergedCount: 1,
    };
    const wire: WireInProgressOperation = op;
    expect(wire).toEqual(op);
  });

  test("CheckoutPreflight: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireCheckoutPreflight, CoreCheckoutPreflight>(
      (core) => core,
      (wire) => wire,
    );
    const preflight: CoreCheckoutPreflight = {
      target: { kind: "branch", name: "topic" },
      detaches: false,
      createsTracking: undefined,
      carried: [],
      blockers: [],
      verdict: "clean",
      routes: [],
    };
    const wire: WireCheckoutPreflight = preflight;
    expect(wire).toEqual(preflight);
  });

  test("RevertPreflight: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireRevertPreflight, CoreRevertPreflight>(
      (core) => core,
      (wire) => wire,
    );
    const preflight: CoreRevertPreflight = {
      shas: ["abc1234"],
      mainlineRequired: [],
      dirtyPaths: [],
      inProgress: null,
      prediction: { kind: "clean" },
      predictedFor: "abc1234",
      detachedHead: false,
      verdict: "clean",
      blockers: [],
    };
    const wire: WireRevertPreflight = preflight;
    expect(wire).toEqual(preflight);
  });

  // ---- P8 W4: remote-op vocabulary and pull/push pre-flight -----------------------------

  test("PullStrategy: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WirePullStrategy, CorePullStrategy>(
      (core) => core,
      (wire) => wire,
    );
    const strategy: CorePullStrategy = "rebase";
    const wire: WirePullStrategy = strategy;
    expect(wire).toBe(strategy);
  });

  test("PullStrategySource: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WirePullStrategySource, CorePullStrategySource>(
      (core) => core,
      (wire) => wire,
    );
    const source: CorePullStrategySource = "branchConfig";
    const wire: WirePullStrategySource = source;
    expect(wire).toBe(source);
  });

  test("RemoteOpKind: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireRemoteOpKind, CoreRemoteOpKind>(
      (core) => core,
      (wire) => wire,
    );
    const kind: CoreRemoteOpKind = "forcePush";
    const wire: WireRemoteOpKind = kind;
    expect(wire).toBe(kind);
  });

  test("RefUpdate: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireRefUpdate, CoreRefUpdate>(
      (core) => core,
      (wire) => wire,
    );
    const update: CoreRefUpdate = {
      ref: "origin/main",
      from: "abc1234",
      to: "def5678",
      forced: false,
    };
    const wire: WireRefUpdate = update;
    expect(wire).toEqual(update);
  });

  test("PullPreflight: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WirePullPreflight, CorePullPreflight>(
      (core) => core,
      (wire) => wire,
    );
    const preflight: CorePullPreflight = {
      strategy: "ff-only",
      source: "default",
      upstream: "origin/main",
      ahead: 0,
      behind: 2,
      dirty: false,
      routes: [],
      blockers: [],
    };
    const wire: WirePullPreflight = preflight;
    expect(wire).toEqual(preflight);
  });

  test("PushPreflight: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WirePushPreflight, CorePushPreflight>(
      (core) => core,
      (wire) => wire,
    );
    const preflight: CorePushPreflight = {
      upstream: "origin/main",
      wouldSetUpstream: false,
      ahead: 1,
      behind: 0,
      remoteTip: "abc1234",
      protectedBy: null,
      fastForward: true,
    };
    const wire: WirePushPreflight = preflight;
    expect(wire).toEqual(preflight);
  });

  test("RemoteOpRequest: assignable both ways against RemoteOpParams minus the wire-only repoId", () => {
    // Same "minus one wire-only field" shape as RefRow vs RefRecord above: `RemoteOpParams`
    // bundles `repoId` alongside the request fields flatly (no nested `op:`, unlike `op.run` —
    // `docs/plans/P8.md`'s D51), and `RemoteOpRequest` is exactly that params shape minus it.
    assertBothWays<Omit<WireRemoteOpParams, "repoId">, CoreRemoteOpRequest>(
      (core) => core,
      (wire) => wire,
    );
    const request: CoreRemoteOpRequest = {
      kind: "fetch",
      remote: "origin",
      branch: undefined,
      setUpstream: false,
      prune: true,
      pruneTags: false,
      strategy: undefined,
      expectedRemoteTip: null,
      plainForce: undefined,
      confirmToken: undefined,
    };
    const wire: Omit<WireRemoteOpParams, "repoId"> = request;
    expect(wire).toEqual(request);
  });

  test("RemoteOpResult: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireRemoteOpResult, CoreRemoteOpResult>(
      (core) => core,
      (wire) => wire,
    );
    const result: CoreRemoteOpResult = {
      ok: true,
      error: undefined,
      updates: [{ ref: "origin/main", from: "abc1234", to: "def5678", forced: false }],
      head: { kind: "branch", name: "main" },
      inProgress: null,
    };
    const wire: WireRemoteOpResult = result;
    expect(wire).toEqual(result);

    // The error's own remoteMessage field (HookRejected only) — a second literal so the
    // assignability check above is not only ever exercised against `error: undefined`.
    const rejected: CoreRemoteOpResult = {
      ok: false,
      error: { kind: "HookRejected", message: "hook declined", remoteMessage: "no force-pushes" },
      updates: [],
      head: { kind: "branch", name: "main" },
      inProgress: null,
    };
    const rejectedWire: WireRemoteOpResult = rejected;
    expect(rejectedWire).toEqual(rejected);
  });

  test("OpRequest: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireOpRequest, CoreOpRequest>(
      (core) => core,
      (wire) => wire,
    );
    const op: CoreOpRequest = { kind: "opContinue" };
    const wire: WireOpRequest = op;
    expect(wire).toEqual(op);
  });

  test("OpResult: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireOpResult, CoreOpResult>(
      (core) => core,
      (wire) => wire,
    );
    const result: CoreOpResult = {
      ok: true,
      error: undefined,
      undo: null,
      head: { kind: "branch", name: "main" },
      inProgress: null,
    };
    const wire: WireOpResult = result;
    expect(wire).toEqual(result);
  });

  test("UndoSlotSnapshot: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireUndoSlotSnapshot, CoreUndoSlotSnapshot>(
      (core) => core,
      (wire) => wire,
    );
    const slot: CoreUndoSlotSnapshot = {
      id: "1",
      label: "Deleted branch feature",
      recoverySha: "abc1234",
      createdAt: 0,
    };
    const wire: WireUndoSlotSnapshot = slot;
    expect(wire).toEqual(slot);
  });

  test("every GitErrorKind is a valid OpErrorKind (W9; one-directional as of P8)", () => {
    // Through P7 these two were kept in exact lockstep ("minus nothing and plus nothing").
    // P8 deliberately breaks that symmetry: `OpErrorKind` gains `ProtectedBranch` and
    // `Cancelled`, neither of which `classifyGitError` (`packages/git/src/errors.ts`) can ever
    // produce — a protected-branch refusal and a mid-flight cancellation are both op-level
    // facts, decided before/around the git spawn rather than read off its exit. So only the
    // git-classification direction still holds: every `GitErrorKind` git can actually classify
    // must still be a member of `OpErrorKind`, but not the reverse.
    function onlyGitKindsAreOpKinds(core: CoreGitErrorKind): WireOpErrorKind {
      return core;
    }
    void onlyGitKindsAreOpKinds;
    const kind: CoreGitErrorKind = "Conflict";
    const wire: WireOpErrorKind = kind;
    expect(wire).toBe(kind);
  });

  // ---- P7 W5: branch review's wire copies -----------------------------------------------
  //
  // `CommitRange`/`ReviewRangeState`/`BaseResolution` have no `core` counterpart to check
  // against here: `core/src/model/review.ts`'s pure classifier answers only "which ref" (its
  // own `BaseResolutionCore`), never the range's walkability — that is computed host-side in
  // `packages/git/src/repoService.ts`, which may import both `core` and `ipc` and so is checked
  // by the type-checker directly at every real call site, not by a structural copy here (B3
  // only restricts `ipc` <-> `core`). `BaseResolutionReason` and `BaseCandidate` are the two
  // pieces `core` and `ipc` really do both declare, so those are what this file mirrors.

  test("BaseResolutionReason: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireBaseResolutionReason, CoreBaseResolutionReason>(
      (core) => core,
      (wire) => wire,
    );
    const reason: CoreBaseResolutionReason = "upstream";
    const wire: WireBaseResolutionReason = reason;
    expect(wire).toBe(reason);
  });

  test("BaseCandidate: core and ipc's wire copy are assignable both ways", () => {
    assertBothWays<WireBaseCandidate, CoreBaseCandidate>(
      (core) => core,
      (wire) => wire,
    );
    const kind: CoreRefKind = "branch";
    const candidate: CoreBaseCandidate = { ref: "main", kind, reason: "defaultBranch" };
    const wire: WireBaseCandidate = candidate;
    expect(wire).toEqual(candidate);
  });
});

// ---------------------------------------------------------------------------------------
// P15 W7 — a *runtime* round trip over the real transport boundary, per D37. Everything above
// this line is compile-time only (`assertBothWays` bodies that never run, catching core/ipc
// *shape* drift via `tsc`); this section catches drift in what actually crosses the wire —
// encode -> the real boundary a channel of each `BufferEncoding` actually puts a message
// through ("base64": `JSON.stringify`/`JSON.parse`; "native": `structuredClone`) -> decode ->
// `appendPacked`. Built from a real `CommitStore`, not a hand-written literal, since a literal
// could drift from what `packSlice` actually produces without anyone noticing.
// ---------------------------------------------------------------------------------------

const PACKED_COLUMNS = [
  "shas",
  "parentOffsets",
  "parentShas",
  "identityIds",
  "times",
  "subjectBytes",
  "subjectOffsets",
] as const;

/** What a channel declaring `encoding` actually does to a message between `post` and the other
 *  side's `onMessage` — mirrors `rpc.ts`'s `post`/`receive` exactly, so this is the same boundary
 *  a real transport puts a `PackedCommitChunk` through, not an in-process stand-in for it. */
function crossRealBoundary<T>(message: T, encoding: BufferEncoding): T {
  const { payload, transfer } = encode(message, encoding);
  const wire =
    encoding === "native"
      ? structuredClone(payload, { transfer: transfer as ArrayBuffer[] })
      : JSON.parse(JSON.stringify(payload));
  return decode<T>(wire, encoding);
}

/** P16 W9's "the seam, end to end": routes a `PackedCommitChunk` through the actual production
 *  path — `encodeStreamPayload` (FlatBuffers `toWire` on `commits`, D45) -> `crossRealBoundary`
 *  (the base64/native boundary, D34-D36, unchanged) -> `decodeStreamPayload` (FlatBuffers
 *  `fromWire`) — rather than `crossRealBoundary` alone, which after P16 tests only the layer
 *  `PackedCommitChunk` no longer crosses directly. Wraps `commits` in a plausible
 *  `graph.stream` envelope (the other seven scalars this dispatch leaves untouched, plan
 *  judgment call 2) and unwraps it again, so callers still deal only in `PackedCommitChunk`. */
function crossGraphStreamBoundary(
  commits: PackedCommitChunk,
  encoding: BufferEncoding,
): PackedCommitChunk {
  const envelope: StreamChunkOf<"graph.stream"> = {
    repoId: "r1",
    seq: 0,
    from: commits.from,
    to: commits.to,
    source: "git",
    remaining: 0,
    exhausted: true,
    commits,
  };
  const encoded = encodeStreamPayload("graph.stream", envelope);
  const crossed = crossRealBoundary(encoded, encoding);
  const decoded = decodeStreamPayload("graph.stream", crossed) as StreamChunkOf<"graph.stream">;
  return decoded.commits;
}

/** A plain-number-array copy of every column — taken *before* a "native" round trip, since that
 *  transfers (and so detaches) the chunk's own buffers; comparing against this snapshot rather
 *  than against the original chunk after the fact is what makes the "native" case testable at
 *  all here. */
function snapshotColumns(
  chunk: PackedCommitChunk,
): Readonly<Record<(typeof PACKED_COLUMNS)[number], number[]>> {
  const snapshot = {} as Record<(typeof PACKED_COLUMNS)[number], number[]>;
  for (const column of PACKED_COLUMNS) snapshot[column] = Array.from(new Uint8Array(chunk[column]));
  return snapshot;
}

function expectColumnsMatchSnapshot(
  snapshot: Readonly<Record<(typeof PACKED_COLUMNS)[number], number[]>>,
  chunk: PackedCommitChunk,
): void {
  for (const column of PACKED_COLUMNS) {
    expect(Array.from(new Uint8Array(chunk[column]))).toEqual(snapshot[column]);
  }
}

describe("ipc wire conformance — runtime round trip over the real boundary (P15 W7)", () => {
  const records: readonly CommitRecord[] = topology([
    "root",
    "left:root",
    "right:root",
    "merge:left,right",
  ]).map((record, i) => ({
    ...record,
    // Non-ASCII subject bytes (W2's edge case), a couple of scripts plus an emoji so the UTF-8
    // encoding genuinely spans one, two, three and four-byte sequences.
    subject: `${record.subject} — 日本語 émoji 🎉 (#${i})`,
  }));

  for (const encoding of ["native", "base64"] as const) {
    test(`a real PackedCommitChunk survives '${encoding}' byte-identically and appendPacked accepts it`, () => {
      const source = new CommitStore();
      source.appendPage(records);
      const chunk = source.packSlice(0, source.rowCount, 0);
      const snapshot = snapshotColumns(chunk);

      const result = crossGraphStreamBoundary(chunk, encoding);
      expectColumnsMatchSnapshot(snapshot, result);

      const receiver = new CommitStore();
      const appended = receiver.appendPacked(result);
      expect(appended.to).toBe(source.rowCount);
      for (let row = 0; row < source.rowCount; row++) {
        expect(receiver.shaAt(row)).toBe(source.shaAt(row));
        expect(receiver.subjectAt(row)).toBe(source.subjectAt(row));
        expect(Array.from(receiver.parentsOf(row))).toEqual(Array.from(source.parentsOf(row)));
      }
      // The non-ASCII subject specifically, not just "some subject" — this is the byte
      // comparison that would fail if base64's UTF-8 handling silently mangled it.
      expect(receiver.subjectAt(0)).toBe(source.subjectAt(0));
      expect(receiver.subjectAt(0)).toContain("日本語 émoji 🎉");
    });
  }

  test("a single root commit's empty parentShas survives both encodings", () => {
    const source = new CommitStore();
    source.appendPage(topology(["only-root"]));

    for (const encoding of ["native", "base64"] as const) {
      // A fresh packSlice per iteration: "native" transfers (and so detaches) its input, and a
      // detached buffer cannot be encoded again on the next iteration.
      const chunk = source.packSlice(0, source.rowCount, 0);
      expect(chunk.parentShas.byteLength).toBe(0);

      const result = crossGraphStreamBoundary(chunk, encoding);
      expect(result.parentShas.byteLength).toBe(0);
      const receiver = new CommitStore();
      receiver.appendPacked(result);
      expect(Array.from(receiver.parentsOf(0))).toEqual([]);
    }
  });

  test('a chunk where the same buffer appears twice still round-trips under "base64" (native already throws, codec.test.ts)', () => {
    // Deliberately still on the generic codec (crossRealBoundary), not crossGraphStreamBoundary:
    // this exercises D36's buffer-aliasing/dedup behaviour in codec.ts's own traversal, which
    // graph.stream's production path no longer exhibits once P16 lands — toWire always emits
    // exactly one ArrayBuffer, so two contract fields aliasing the same JS ArrayBuffer object is
    // no longer observable at the wire. The scenario this test protects is real for any other
    // (non-FlatBuffers) payload the contract might carry, so it stays.
    const source = new CommitStore();
    source.appendPage(records);
    const chunk = source.packSlice(0, source.rowCount, 0);
    // Not a shape `packSlice` itself ever produces (every field is freshly allocated) — a
    // synthetic alias, forcing the exact case `dedupeTransferList` exists to catch under
    // "native" and that "base64" has no concept of (its transfer list is always empty).
    const aliased: PackedCommitChunk = { ...chunk, parentShas: chunk.shas };

    const result = crossRealBoundary(aliased, "base64");
    expect(new Uint8Array(result.shas)).toEqual(new Uint8Array(chunk.shas));
    expect(new Uint8Array(result.parentShas)).toEqual(new Uint8Array(chunk.shas));
  });

  test('a Uint8Array (not a bare ArrayBuffer) survives the "base64" boundary as itself — the assumption toWireSafe used to carry, discharged rather than inherited', () => {
    const view = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const result = crossRealBoundary({ view }, "base64");
    expect(result.view).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.view)).toEqual(Array.from(view));
  });

  // ---- P16 W9: the no-defaults structural test -------------------------------------------
  //
  // A fixture with a field at its FlatBuffers scalar/vector default does not actually test that
  // field: FlatBuffers omits defaults on write and reads them back as the default regardless of
  // whether a write happened at all. This test asserts every one of PackedCommitChunk's 13
  // fields is genuinely away from its default *before* trusting the round trip that follows, and
  // pins the exact 13-name key set so a field added to the contract and forgotten here is a
  // failing literal, not a tautology against `Object.keys` of the very value being checked.

  const PACKED_COMMIT_CHUNK_KEYS = [
    "decorations",
    "dictionary",
    "dictionaryBase",
    "from",
    "identityIds",
    "parentOffsets",
    "parentShas",
    "shaWidthBytes",
    "shas",
    "subjectBytes",
    "subjectOffsets",
    "times",
    "to",
  ].sort();

  test("no field of a packSlice(from>0, dictionaryBase>0) chunk with decorations is at a FlatBuffers default, and the round trip preserves exactly the 13-field contract shape", () => {
    const records: CommitRecord[] = topology(["root", "a:root", "b:root", "merge:a,b"]).map(
      (record, i): CommitRecord =>
        i === 2
          ? { ...record, decoration: [{ kind: "branch", name: "feature/x", isHead: false }] }
          : record,
    );
    const source = new CommitStore();
    source.appendPage(records);

    // dictionaryBase=0 always returns the store's *entire* dictionary (packSlice's dictionary
    // field is store-wide and independent of the row range, `commitStore.ts`'s own packSlice),
    // so its length is exactly the interner's total size — from which any value strictly between
    // 0 and that total is a valid, non-default dictionaryBase for the slice below.
    const totalDictionarySize = source.packSlice(0, source.rowCount, 0).dictionary.length;
    expect(totalDictionarySize).toBeGreaterThan(1);
    const dictionaryBase = totalDictionarySize - 1;

    const chunk = source.packSlice(2, 4, dictionaryBase);

    expect(chunk.from).not.toBe(0);
    expect(chunk.to).not.toBe(0);
    expect(chunk.shaWidthBytes).not.toBe(0);
    expect(chunk.shas.byteLength).toBeGreaterThan(0);
    expect(chunk.parentOffsets.byteLength).toBeGreaterThan(0);
    expect(chunk.parentShas.byteLength).toBeGreaterThan(0);
    expect(chunk.identityIds.byteLength).toBeGreaterThan(0);
    expect(chunk.times.byteLength).toBeGreaterThan(0);
    expect(chunk.subjectBytes.byteLength).toBeGreaterThan(0);
    expect(chunk.subjectOffsets.byteLength).toBeGreaterThan(0);
    expect(chunk.dictionaryBase).not.toBe(0);
    expect(chunk.dictionary.length).toBeGreaterThan(0);
    expect(chunk.decorations.length).toBeGreaterThan(0);

    expect(Object.keys(chunk).sort()).toEqual(PACKED_COMMIT_CHUNK_KEYS);

    for (const encoding of ["native", "base64"] as const) {
      // A fresh packSlice per iteration: "native" transfers (and so detaches) its input.
      const fresh = source.packSlice(2, 4, dictionaryBase);
      const result = crossGraphStreamBoundary(fresh, encoding);

      expect(Object.keys(result).sort()).toEqual(PACKED_COMMIT_CHUNK_KEYS);
      for (const key of PACKED_COMMIT_CHUNK_KEYS) {
        const expected = fresh[key as keyof PackedCommitChunk];
        const actual = result[key as keyof PackedCommitChunk];
        if (expected instanceof ArrayBuffer) {
          expect(Array.from(new Uint8Array(actual as ArrayBuffer))).toEqual(
            Array.from(new Uint8Array(expected)),
          );
        } else {
          expect(actual).toEqual(expected);
        }
      }
    }
  });

  // ---- P16 W9: all five DecorationRef variants, through the FlatBuffers seam -------------

  test("all five DecorationRef variants round-trip through the FlatBuffers seam exactly, including exactOptionalPropertyTypes' no-'name'-on-'head' distinction", () => {
    const variants: readonly CoreDecorationRef[] = [
      { kind: "branch", name: "feature/x", isHead: false },
      { kind: "remoteBranch", name: "origin/main" },
      { kind: "tag", name: "v2.0.0" },
      { kind: "head" },
      { kind: "stash", index: 0 },
    ];
    const records: CommitRecord[] = topology(["c0", "c1:c0", "c2:c1", "c3:c2", "c4:c3"]).map(
      (record, i): CommitRecord => {
        const variant = variants[i];
        if (!variant) throw new Error("unreachable: fewer DecorationRef variants than records");
        return { ...record, decoration: [variant] };
      },
    );
    const source = new CommitStore();
    source.appendPage(records);
    const chunk = source.packSlice(0, source.rowCount, 0);
    expect(chunk.decorations.length).toBe(5);

    const result = crossGraphStreamBoundary(chunk, "native");
    expect(result.decorations.length).toBe(5);

    const byRow = new Map(result.decorations);
    for (const [row, variant] of variants.entries()) {
      expect(byRow.get(row)).toEqual([variant]);
    }

    const headRow = variants.findIndex((v) => v.kind === "head");
    const headRef = byRow.get(headRow)?.[0];
    expect(headRef).toBeDefined();
    // exactOptionalPropertyTypes makes this a real distinction: 'head' must come back with no
    // 'name' property at all, not `name: undefined`.
    expect(Object.keys(headRef as object)).toEqual(["kind"]);

    const stashRow = variants.findIndex((v) => v.kind === "stash");
    const stashRef = byRow.get(stashRow)?.[0];
    // Unlike 'head', 'stash' carries a real payload (P9's `index`) — round-tripped through the
    // unused `name` wire slot as a decimal string (graphChunkCodec.ts's own doc comment on why),
    // never a bare `{kind}`.
    expect(stashRef).toEqual({ kind: "stash", index: 0 });
  });

  // ---- P16 W12: corruption is loud, not silent -------------------------------------------
  //
  // W12's "done when" is stated in terms of the VS Code e2e tier ("forcing `toWire` to emit a
  // buffer with the wrong `file_identifier` fails these specs loudly rather than rendering an
  // empty list"), but that tier needs a real downloaded VS Code build this sandbox cannot reach
  // (`bun run test:e2e:vscode`'s own attempt here aborts mid-download). These three tests are
  // the unit-level substitute: they exercise the exact three ways a `graph.stream` chunk can
  // arrive corrupted or foreign — a `commits` payload with no `$fb` tag at all, one tagged with
  // a version this build does not recognise, and a buffer that is tagged as FlatBuffers but was
  // never actually built by `toWire` (wrong `file_identifier`) — and confirm every one of them
  // throws instead of silently decoding into nonsense or an empty chunk.

  test("decodeStreamPayload throws when 'graph.stream' arrives with no '$fb' tag on commits", () => {
    const envelope = {
      repoId: "r1",
      seq: 0,
      from: 0,
      to: 0,
      source: "git",
      remaining: 0,
      exhausted: true,
      commits: { notFlatBuffers: true },
    };
    expect(() => decodeStreamPayload("graph.stream", envelope)).toThrow(/\$fb/);
  });

  test("decodeStreamPayload throws on an unrecognised '$fb' tag", () => {
    const envelope = {
      repoId: "r1",
      seq: 0,
      from: 0,
      to: 0,
      source: "git",
      remaining: 0,
      exhausted: true,
      commits: { $fb: "graphChunk/99", d: new ArrayBuffer(0) },
    };
    expect(() => decodeStreamPayload("graph.stream", envelope)).toThrow(/graphChunk\/99/);
  });

  test("graphChunkCodec.fromWire throws on a buffer with the wrong file_identifier", () => {
    const source = new CommitStore();
    source.appendPage(topology(["root"]));
    const chunk = source.packSlice(0, source.rowCount, 0);
    const good = graphChunkToWire(chunk);

    // FlatBuffers' file identifier is a fixed 4-byte ASCII tag at a fixed offset (bytes 4-7 of
    // the buffer, right after the root table's own 4-byte offset) — corrupting just those bytes
    // simulates "tagged as FlatBuffers but not this schema" without needing a second, unrelated
    // schema compiled just to produce one.
    const corrupted = good.slice(0);
    new Uint8Array(corrupted, 4, 4).set([0x58, 0x58, 0x58, 0x58]); // "XXXX", not "KVGC"

    expect(() => graphChunkFromWire(corrupted)).toThrow(/file identifier/);
    // The good buffer alongside it proves the corruption, not some unrelated fromWire bug, is
    // what throws.
    expect(() => graphChunkFromWire(good)).not.toThrow();
  });
});
