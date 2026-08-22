import { describe, expect, test } from "bun:test";
import type { EventPayload, ParamsOf, ResultOf, StreamChunkOf } from "./contract.ts";
import { decode, encode } from "./codec.ts";
import { CONTRACT_VERSION, unwrapVersioned, validateVersion, wrapVersioned } from "./validate.ts";

/**
 * Round-trips each of the four seeded contract entries through the codec, over a real
 * `MessageChannel` so the ArrayBuffer case exercises actual structured-clone transfer
 * semantics rather than an in-process stand-in.
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

describe("ipc codec", () => {
  test("round-trips repo.open request", async () => {
    const params: ParamsOf<"repo.open"> = { path: "/repos/example" };
    const { payload, transfer } = encode(params);
    expect(transfer).toHaveLength(0);
    const result = await roundTrip(payload, transfer);
    expect(result).toEqual(params);
  });

  test("round-trips graph.query request/result", async () => {
    const params: ParamsOf<"graph.query"> = { repoId: "r1", scope: "all", pageSize: 5000, skip: 0 };
    const result: ResultOf<"graph.query"> = { totalCount: 127_400, hasMore: true };
    const encodedParams = encode(params);
    const encodedResult = encode(result);
    expect(await roundTrip(encodedParams.payload, encodedParams.transfer)).toEqual(params);
    expect(await roundTrip(encodedResult.payload, encodedResult.transfer)).toEqual(result);
  });

  test("round-trips repo.changed event", async () => {
    const payload: EventPayload<"repo.changed"> = { repoId: "r1", kind: "refsChanged" };
    const encoded = encode(payload);
    expect(await roundTrip(encoded.payload, encoded.transfer)).toEqual(payload);
  });

  test("round-trips graph.stream chunk and transfers the ArrayBuffer rather than copying it", async () => {
    const shaBuffer = new ArrayBuffer(20 * 3); // 3 shas, 20 bytes each
    new Uint8Array(shaBuffer).fill(0xab);
    const chunk: StreamChunkOf<"graph.stream"> = {
      repoId: "r1",
      rowOffset: 0,
      count: 3,
      shaBuffer,
    };

    const { payload, transfer } = encode(chunk);
    expect(transfer).toEqual([shaBuffer]);
    expect(shaBuffer.byteLength).toBe(60);

    const result = await roundTrip(payload, transfer);

    // Transferred (not cloned): the original buffer is detached after postMessage.
    expect(shaBuffer.byteLength).toBe(0);
    // The received buffer carries the original bytes.
    expect(result.shaBuffer.byteLength).toBe(60);
    expect(new Uint8Array(result.shaBuffer).every((b) => b === 0xab)).toBe(true);
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
});
