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
async function roundTrip<T>(message: T, transfer: readonly ArrayBuffer[]): Promise<T> {
  const { port1, port2 } = new MessageChannel();
  const received = new Promise<T>((resolve) => {
    port2.onmessage = (event) => resolve(decode(event.data as T));
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
      },
      git: { kind: "ok", path: "/usr/bin/git", version: "2.43.0" },
      capabilities: { openInEditor: true, goToFile: true, clipboard: true },
    };
    const encodedParams = encode(params);
    const encodedResult = encode(result);
    expect(await roundTrip(encodedParams.payload, encodedParams.transfer)).toEqual(params);
    expect(await roundTrip(encodedResult.payload, encodedResult.transfer)).toEqual(result);
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
    expect(await roundTrip(payload, transfer)).toEqual(params);
    const encodedResult = encode(result);
    expect(await roundTrip(encodedResult.payload, encodedResult.transfer)).toEqual(result);
  });

  test("round-trips repo.changed event", async () => {
    const payload: EventPayload<"repo.changed"> = { repoId: "r1", kind: "refsChanged" };
    const encoded = encode(payload);
    expect(await roundTrip(encoded.payload, encoded.transfer)).toEqual(payload);
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

    const result = await roundTrip(payload, transfer);

    // Transferred (not cloned): the original buffer is detached after postMessage.
    expect(shas.byteLength).toBe(0);
    expect(result.commits.shas.byteLength).toBe(60);
    expect(new Uint8Array(result.commits.shas).every((b) => b === 0xab)).toBe(true);
  });

  test("dedupeTransferList throws on a buffer listed twice", () => {
    const buffer = new ArrayBuffer(4);
    expect(() => dedupeTransferList([buffer, buffer])).toThrow(/appears twice/);
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
