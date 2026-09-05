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
  RefRecord as CoreRefRecord,
  TagAnnotation as CoreTagAnnotation,
} from "../../../packages/core/src/model/ref.ts";
import type { HeadState as CoreHeadState } from "../../../packages/core/src/model/repo.ts";
import type { StatusSummary as CoreStatusSummary } from "../../../packages/core/src/model/status.ts";
import type {
  CheckoutPreflight as CoreCheckoutPreflight,
  RevertPreflight as CoreRevertPreflight,
} from "../../../packages/core/src/preflight/types.ts";
import {
  type Settings as CoreSettings,
  defaultSettings,
} from "../../../packages/core/src/settings/schema.ts";
import type { GitErrorKind as CoreGitErrorKind } from "../../../packages/git/src/errors.ts";
import type {
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
  RefRow as WireRefRow,
  RevertPreflight as WireRevertPreflight,
  SettingsSnapshot as WireSettingsSnapshot,
  SignatureStatus as WireSignatureStatus,
  StatusSummary as WireStatusSummary,
  TagAnnotation as WireTagAnnotation,
  UndoSlotSnapshot as WireUndoSlotSnapshot,
} from "../../../packages/ipc/src/contract.ts";

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

  test("OpErrorKind is a structural copy of GitErrorKind minus nothing and plus nothing (W9)", () => {
    assertBothWays<WireOpErrorKind, CoreGitErrorKind>(
      (core) => core,
      (wire) => wire,
    );
    const kind: CoreGitErrorKind = "Conflict";
    const wire: WireOpErrorKind = kind;
    expect(wire).toBe(kind);
  });
});
