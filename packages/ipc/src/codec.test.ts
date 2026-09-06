import { describe, expect, test } from "bun:test";
import { decode, dedupeTransferList, encode } from "./codec.ts";
import type {
  EventPayload,
  PackedCommitChunk,
  ParamsOf,
  ResultOf,
  StreamChunkOf,
} from "./contract.ts";
import {
  assertContractShape,
  CONTRACT_VERSION,
  ContractShapeError,
  unwrapVersioned,
  validateVersion,
  wrapVersioned,
} from "./validate.ts";

/**
 * Round-trips contract entries through the codec, over a real `MessageChannel` so the
 * ArrayBuffer case exercises actual structured-clone transfer semantics rather than an
 * in-process stand-in.
 */
async function roundTrip<T>(message: unknown, transfer: readonly ArrayBuffer[]): Promise<T> {
  const { port1, port2 } = new MessageChannel();
  const received = new Promise<T>((resolve) => {
    port2.onmessage = (event) => resolve(decode<T>(event.data));
  });
  port1.postMessage(message, transfer as ArrayBuffer[]);
  const result = await received;
  port1.close();
  port2.close();
  return result;
}

function emptyPackedChunk(): PackedCommitChunk {
  return {
    from: 0,
    to: 0,
    shaWidthBytes: 20,
    shas: new ArrayBuffer(0),
    parentOffsets: new ArrayBuffer(4),
    parentShas: new ArrayBuffer(0),
    identityIds: new ArrayBuffer(0),
    times: new ArrayBuffer(0),
    subjectBytes: new ArrayBuffer(0),
    subjectOffsets: new ArrayBuffer(4),
    dictionaryBase: 0,
    dictionary: [],
    decorations: [],
  };
}

describe("ipc codec", () => {
  test("round-trips app.init request/result", async () => {
    const params: ParamsOf<"app.init"> = {};
    const result: ResultOf<"app.init"> = {
      host: "harness",
      contractVersion: CONTRACT_VERSION,
      settings: {
        "kiraVersion.git.path": "",
        "kiraVersion.graph.pageSize": 5000,
        "kiraVersion.graph.scope": "all",
        "kiraVersion.log.level": "info",
        "kiraVersion.review.baseCandidates": ["main", "master"],
        "kiraVersion.fetch.autoInterval": 0,
        "kiraVersion.pull.strategy": "auto",
        "kiraVersion.protectedBranches": ["main", "master", "release/*"],
        "kiraVersion.stash.includeUntracked": false,
        "kiraVersion.stash.showInGraph": true,
      },
      git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
      capabilities: { openInEditor: true, goToFile: true, clipboard: true, resolveConflict: true },
    };
    const encodedParams = encode(params);
    const encodedResult = encode(result);
    expect(await roundTrip<typeof params>(encodedParams.payload, encodedParams.transfer)).toEqual(
      params,
    );
    expect(await roundTrip<typeof result>(encodedResult.payload, encodedResult.transfer)).toEqual(
      result,
    );
  });

  test("round-trips repo.open request/result", async () => {
    const params: ParamsOf<"repo.open"> = { path: "/repos/example" };
    const result: ResultOf<"repo.open"> = {
      kind: "ok",
      repo: {
        repoId: "r1",
        root: "/repos/example",
        gitDir: "/repos/example/.git",
        commonDir: "/repos/example/.git",
        isBare: false,
        isLinkedWorktree: false,
        head: { kind: "branch", name: "main" },
      },
    };
    const { payload, transfer } = encode(params);
    expect(transfer).toHaveLength(0);
    expect(await roundTrip<typeof params>(payload, transfer)).toEqual(params);
    const encodedResult = encode(result);
    expect(await roundTrip<typeof result>(encodedResult.payload, encodedResult.transfer)).toEqual(
      result,
    );
  });

  test("round-trips repo.changed event", async () => {
    const payload: EventPayload<"repo.changed"> = { repoId: "r1", kind: "refsChanged" };
    const encoded = encode(payload);
    expect(await roundTrip<typeof payload>(encoded.payload, encoded.transfer)).toEqual(payload);
  });

  test("round-trips graph.stream chunk and transfers every buffer rather than copying it", async () => {
    const packed = emptyPackedChunk();
    const shas = new ArrayBuffer(20 * 3);
    new Uint8Array(shas).fill(0xab);
    const chunk: StreamChunkOf<"graph.stream"> = {
      repoId: "r1",
      seq: 0,
      from: 0,
      to: 3,
      source: "git",
      remaining: 0,
      exhausted: true,
      commits: { ...packed, shas, to: 3 },
    };

    const { payload, transfer } = encode(chunk);
    // Every ArrayBuffer field of PackedCommitChunk is collected, including the empty ones.
    expect(transfer).toHaveLength(7);
    expect(transfer[0]).toBe(shas);
    expect(dedupeTransferList(transfer)).toBe(transfer);

    const result = await roundTrip<StreamChunkOf<"graph.stream">>(payload, transfer);

    // Transferred (not cloned): the original buffer is detached after postMessage.
    expect(shas.byteLength).toBe(0);
    expect(result.commits.shas.byteLength).toBe(60);
    expect(new Uint8Array(result.commits.shas).every((b) => b === 0xab)).toBe(true);
  });

  test("round-trips the four P9 stash requests/results", async () => {
    const stashListParams: ParamsOf<"stash.list"> = { repoId: "r1" };
    const stashListResult: ResultOf<"stash.list"> = {
      entries: [
        {
          index: 0,
          sha: "a".repeat(40),
          baseSha: "b".repeat(40),
          indexSha: "c".repeat(40),
          untrackedSha: undefined,
          message: "WIP on main: abc1234 subject",
          branch: "main",
          timestamp: 1700000000,
          fileCount: 2,
          includedUntracked: false,
        },
      ],
    };
    const { payload: p1, transfer: t1 } = encode(stashListParams);
    expect(await roundTrip<typeof stashListParams>(p1, t1)).toEqual(stashListParams);
    const { payload: r1, transfer: rt1 } = encode(stashListResult);
    expect(await roundTrip<typeof stashListResult>(r1, rt1)).toEqual(stashListResult);

    const stashShowParams: ParamsOf<"stash.show"> = { repoId: "r1", sha: "a".repeat(40) };
    const stashShowResult: ResultOf<"stash.show"> = {
      sha: "a".repeat(40),
      changes: [
        {
          kind: "modified",
          path: "a.txt",
          originalPath: undefined,
          similarity: undefined,
          additions: 1,
          deletions: 1,
          isBinary: false,
        },
      ],
    };
    const { payload: p2, transfer: t2 } = encode(stashShowParams);
    expect(await roundTrip<typeof stashShowParams>(p2, t2)).toEqual(stashShowParams);
    const { payload: r2, transfer: rt2 } = encode(stashShowResult);
    expect(await roundTrip<typeof stashShowResult>(r2, rt2)).toEqual(stashShowResult);

    const stashPopParams: ParamsOf<"preflight.stashPop"> = {
      repoId: "r1",
      sha: "a".repeat(40),
      index: 0,
    };
    const stashPopResult: ResultOf<"preflight.stashPop"> = {
      stashSha: "a".repeat(40),
      stashIndex: 0,
      targetSha: "b".repeat(40),
      prediction: { kind: "clean" },
      blockers: [],
      verdict: "clean",
    };
    const { payload: p3, transfer: t3 } = encode(stashPopParams);
    expect(await roundTrip<typeof stashPopParams>(p3, t3)).toEqual(stashPopParams);
    const { payload: r3, transfer: rt3 } = encode(stashPopResult);
    expect(await roundTrip<typeof stashPopResult>(r3, rt3)).toEqual(stashPopResult);

    const stashBranchParams: ParamsOf<"preflight.stashBranch"> = {
      repoId: "r1",
      sha: "a".repeat(40),
      branch: "recovered",
    };
    const stashBranchResult: ResultOf<"preflight.stashBranch"> = {
      name: { valid: true, error: undefined, exists: false },
      checkout: {
        target: { kind: "sha", name: "a".repeat(40) },
        detaches: false,
        createsTracking: undefined,
        carried: [],
        blockers: [],
        verdict: "clean",
        routes: [],
      },
      verdict: "clean",
    };
    const { payload: p4, transfer: t4 } = encode(stashBranchParams);
    expect(await roundTrip<typeof stashBranchParams>(p4, t4)).toEqual(stashBranchParams);
    const { payload: r4, transfer: rt4 } = encode(stashBranchResult);
    expect(await roundTrip<typeof stashBranchResult>(r4, rt4)).toEqual(stashBranchResult);
  });

  test("dedupeTransferList throws on a buffer listed twice", () => {
    const buffer = new ArrayBuffer(4);
    expect(() => dedupeTransferList([buffer, buffer])).toThrow(/appears twice/);
  });

  test('encode(m) defaults to the same shape as encode(m, "native")', () => {
    const packed = emptyPackedChunk();
    const shas = new ArrayBuffer(20);
    const defaulted = encode({ commits: packed, shas });
    const explicit = encode({ commits: packed, shas }, "native");
    expect(defaulted.payload).toEqual(explicit.payload);
    expect(defaulted.transfer).toEqual(explicit.transfer);
  });
});

describe("ipc codec — base64 encoding (W2)", () => {
  test("round-trips a zero-length ArrayBuffer", () => {
    const chunk = { ...emptyPackedChunk(), shas: new ArrayBuffer(0) };
    const { payload, transfer } = encode(chunk, "base64");
    expect(transfer).toHaveLength(0);
    const result = decode<PackedCommitChunk>(payload, "base64");
    expect(result.shas.byteLength).toBe(0);
    expect(result.shas).toBeInstanceOf(ArrayBuffer);
  });

  test("round-trips non-UTF8 subject bytes exactly (every byte value, including invalid UTF-8 sequences)", () => {
    const subjectBytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) subjectBytes[i] = i;
    // A couple of specifically invalid-UTF-8 stretches (lone continuation/leading bytes), placed
    // deliberately rather than left to chance among the 0..255 sweep above.
    subjectBytes.set([0xff, 0xfe, 0x80, 0x80, 0xc0], 10);
    const chunk = { ...emptyPackedChunk(), subjectBytes: subjectBytes.buffer };

    const { payload } = encode(chunk, "base64");
    const result = decode<PackedCommitChunk>(payload, "base64");

    expect(new Uint8Array(result.subjectBytes)).toEqual(subjectBytes);
  });

  test("round-trips the same ArrayBuffer referenced twice, independently", () => {
    const shas = new ArrayBuffer(20);
    new Uint8Array(shas).fill(0x42);
    const chunk = { ...emptyPackedChunk(), shas, parentShas: shas };

    const { payload, transfer } = encode(chunk, "base64");
    expect(transfer).toHaveLength(0); // nothing to transfer under base64
    const result = decode<PackedCommitChunk>(payload, "base64");

    expect(new Uint8Array(result.shas).every((b) => b === 0x42)).toBe(true);
    expect(new Uint8Array(result.parentShas).every((b) => b === 0x42)).toBe(true);
    // The two fields decode to distinct buffers (base64 has no shared-reference concept), unlike
    // native's structured clone, which would also duplicate them (never alias) across a
    // postMessage boundary — so this is not a regression, just worth pinning down.
    expect(result.shas).not.toBe(result.parentShas);
  });

  test("a typed-array view (not a bare ArrayBuffer) survives the round trip as the same kind", () => {
    const view = new Uint32Array([1, 2, 3, 0xdeadbeef]);
    const message = { view };

    const { payload } = encode(message, "base64");
    const result = decode<{ view: Uint32Array }>(payload, "base64");

    expect(result.view).toBeInstanceOf(Uint32Array);
    expect(Array.from(result.view)).toEqual(Array.from(view));
  });

  test('decode(encode(m, "base64").payload, "base64") reproduces every PackedCommitChunk column', () => {
    const packed: PackedCommitChunk = {
      ...emptyPackedChunk(),
      shas: new ArrayBuffer(20),
      parentOffsets: new ArrayBuffer(8),
      parentShas: new ArrayBuffer(20),
      identityIds: new ArrayBuffer(4),
      times: new ArrayBuffer(8),
      subjectBytes: new ArrayBuffer(16),
      subjectOffsets: new ArrayBuffer(8),
    };
    new Uint8Array(packed.shas).fill(0xaa);
    new Uint8Array(packed.parentShas).fill(0xbb);
    new Uint8Array(packed.subjectBytes).fill(0xcc);

    const { payload } = encode(packed, "base64");
    const result = decode<PackedCommitChunk>(payload, "base64");

    for (const key of [
      "shas",
      "parentOffsets",
      "parentShas",
      "identityIds",
      "times",
      "subjectBytes",
      "subjectOffsets",
    ] as const) {
      expect(new Uint8Array(result[key])).toEqual(new Uint8Array(packed[key]));
    }
  });
});

describe("ipc validate", () => {
  test("accepts a matching version", () => {
    expect(() => validateVersion(CONTRACT_VERSION)).not.toThrow();
  });

  test("throws loudly on a version mismatch", () => {
    expect(() => validateVersion(CONTRACT_VERSION + 1)).toThrow(/contract version mismatch/);
  });

  test("wrap/unwrap round-trips a body and validates its version", () => {
    const envelope = wrapVersioned({ hello: "world" });
    expect(unwrapVersioned(envelope)).toEqual({ hello: "world" });
    expect(() => unwrapVersioned({ version: CONTRACT_VERSION + 1, body: {} })).toThrow();
  });

  test("assertContractShape accepts a known request with an object payload", () => {
    expect(() => assertContractShape("request", "repo.open", { path: "/x" })).not.toThrow();
  });

  test("assertContractShape rejects an unknown method", () => {
    expect(() => assertContractShape("request", "repo.nonsense", {})).toThrow(ContractShapeError);
  });

  test("assertContractShape rejects a non-object payload", () => {
    expect(() => assertContractShape("event", "repo.changed", "nope")).toThrow(ContractShapeError);
  });

  test("assertContractShape rejects a non-string 'kind' discriminant", () => {
    expect(() => assertContractShape("request", "repo.open", { kind: 1 })).toThrow(
      ContractShapeError,
    );
  });

  test("assertContractShape accepts a valid stream method", () => {
    expect(() => assertContractShape("stream", "graph.stream", { repoId: "r1" })).not.toThrow();
  });
});
