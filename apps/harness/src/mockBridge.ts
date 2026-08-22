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
} from "@kira-version/ipc";
import { loadScenario } from "./scenarios/index.ts";

const SHA_BYTES = 20;

function shaBufferForCount(count: number): ArrayBuffer {
  const buffer = new ArrayBuffer(count * SHA_BYTES);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < view.length; i++) view[i] = i % 256;
  return buffer;
}

/**
 * Implements the ipc Transport against the active scenario's fixture data. P0 does not
 * parse real git output — that is packages/git's job from P1+ — so this returns plausible,
 * contract-shaped data. The stream mechanism chunks realistically so the UI's streaming
 * path is exercised rather than bypassed (§8.4).
 */
export function createMockBridge(scenarioName: string): Transport {
  const scenario = loadScenario(scenarioName);

  return {
    async request<K extends RequestKey>(method: K, _params: ParamsOf<K>): Promise<ResultOf<K>> {
      if (method === "repo.open") {
        return scenario.repoOpen as ResultOf<K>;
      }
      if (method === "graph.query") {
        return { totalCount: scenario.commitCount, hasMore: false } as ResultOf<K>;
      }
      throw new Error(`mock bridge: unhandled request '${method}'`);
    },

    on<K extends EventKey>(_method: K, _handler: (payload: EventPayload<K>) => void): () => void {
      // P0's placeholder shell never triggers repo.changed; registering the handler at all
      // proves the interface shape is implementable. Unsubscribe is a no-op.
      return () => {};
    },

    async stream<K extends StreamKey>(
      method: K,
      params: StreamParamsOf<K>,
      onChunk: (chunk: StreamChunkOf<K>) => void,
      signal?: AbortSignal,
    ): Promise<void> {
      if (method !== "graph.stream") {
        throw new Error(`mock bridge: unhandled stream '${method}'`);
      }
      const { pageSize } = params as StreamParamsOf<"graph.stream">;
      let offset = 0;
      while (offset < scenario.commitCount) {
        if (signal?.aborted) return;
        const count = Math.min(pageSize, scenario.commitCount - offset);
        const chunk = {
          repoId: scenario.repoOpen.repoId,
          rowOffset: offset,
          count,
          shaBuffer: shaBufferForCount(count),
        } satisfies StreamChunkOf<"graph.stream">;
        onChunk(chunk as StreamChunkOf<K>);
        offset += count;
        // Yield to the event loop between chunks so this behaves like a real paged stream
        // rather than a single synchronous burst.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },

    dispose(): void {},
  };
}
