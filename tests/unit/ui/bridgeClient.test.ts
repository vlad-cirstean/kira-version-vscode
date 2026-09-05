import { describe, expect, test } from "bun:test";
import { defaultSettings } from "../../../packages/core/src/index.ts";
import type {
  EventKey,
  EventPayload,
  ParamsOf,
  RequestKey,
  ResultOf,
  StreamChunkOf,
  StreamKey,
  StreamParamsOf,
  Transport,
} from "../../../packages/ipc/src/index.ts";
import { BridgeClient } from "../../../packages/ui/src/bridge/client.ts";

/**
 * `BridgeClient.init()` is the one piece of logic this file adds on top of forwarding straight
 * to `Transport` (request/on/stream are pure pass-throughs, not worth a test of their own): it
 * must run the `app.init` handshake exactly once no matter how many callers await it, and it
 * must reflect the outcome in `connectionState`.
 */

const INIT_RESULT: ResultOf<"app.init"> = {
  host: "harness",
  contractVersion: 2,
  settings: defaultSettings(),
  git: { kind: "ok", path: "/usr/bin/git", version: "2.40.0" },
  capabilities: { openInEditor: true, goToFile: true, clipboard: true, resolveConflict: true },
};

class FakeTransport implements Transport {
  requestCalls = 0;
  /** Set to reject the next (and only the next) `app.init` call. */
  nextError: unknown;
  disposed = false;

  request<K extends RequestKey>(method: K, _params: ParamsOf<K>): Promise<ResultOf<K>> {
    if (method !== "app.init") throw new Error(`unhandled request '${method}'`);
    this.requestCalls++;
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = undefined;
      return Promise.reject(error);
    }
    return Promise.resolve(INIT_RESULT as ResultOf<K>);
  }

  on<K extends EventKey>(_method: K, _handler: (payload: EventPayload<K>) => void): () => void {
    return () => {};
  }

  stream<K extends StreamKey>(
    _method: K,
    _params: StreamParamsOf<K>,
    _onChunk: (chunk: StreamChunkOf<K>) => void,
  ): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
  }
}

describe("BridgeClient", () => {
  test("starts in connecting state", () => {
    const client = new BridgeClient(new FakeTransport());
    expect(client.connectionState.value).toBe("connecting");
  });

  test("init() resolves with the app.init result and moves to connected", async () => {
    const transport = new FakeTransport();
    const client = new BridgeClient(transport);

    const result = await client.init();

    expect(result).toEqual(INIT_RESULT);
    expect(client.connectionState.value).toBe("connected");
  });

  test("init() performs the handshake exactly once for concurrent and later callers", async () => {
    const transport = new FakeTransport();
    const client = new BridgeClient(transport);

    const [first, second] = await Promise.all([client.init(), client.init()]);
    const third = await client.init();

    expect(transport.requestCalls).toBe(1);
    expect(first).toEqual(INIT_RESULT);
    expect(second).toEqual(INIT_RESULT);
    expect(third).toEqual(INIT_RESULT);
  });

  test("a rejected app.init moves connectionState to error and rejects every caller", async () => {
    const transport = new FakeTransport();
    transport.nextError = new Error("channel closed");
    const client = new BridgeClient(transport);

    await expect(client.init()).rejects.toThrow("channel closed");
    expect(client.connectionState.value).toBe("error");
    // The failed handshake is cached too — init() does not silently retry on every call.
    await expect(client.init()).rejects.toThrow("channel closed");
    expect(transport.requestCalls).toBe(1);
  });

  test("dispose() resets connectionState and disposes the transport", async () => {
    const transport = new FakeTransport();
    const client = new BridgeClient(transport);
    await client.init();

    client.dispose();

    expect(client.connectionState.value).toBe("connecting");
    expect(transport.disposed).toBe(true);
  });
});
