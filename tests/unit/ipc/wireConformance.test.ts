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
import type { HeadState as CoreHeadState } from "../../../packages/core/src/model/repo.ts";
import {
  type Settings as CoreSettings,
  defaultSettings,
} from "../../../packages/core/src/settings/schema.ts";
import type {
  CommitIdentity as WireCommitIdentity,
  CommitTrailer as WireCommitTrailer,
  DecorationRef as WireDecorationRef,
  DiffHunk as WireDiffHunk,
  DiffLine as WireDiffLine,
  FileChange as WireFileChange,
  FileDiffBody as WireFileDiffBody,
  HeadState as WireHeadState,
  SettingsSnapshot as WireSettingsSnapshot,
  SignatureStatus as WireSignatureStatus,
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
});
