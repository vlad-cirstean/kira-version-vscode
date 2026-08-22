/**
 * The type map every transport (real or mock) and the UI client are checked against.
 * Seeded with exactly four entries — enough to exercise all three RPC mechanisms.
 * P3 grows this; P0 only proves the shape.
 */
export type Contract = {
  requests: {
    "repo.open": {
      params: { path: string };
      result: { repoId: string; toplevel: string; gitDir: string; isBare: boolean };
    };
    "graph.query": {
      params: { repoId: string; scope: "all" | "head"; pageSize: number; skip: number };
      result: { totalCount: number; hasMore: boolean };
    };
  };
  events: {
    "repo.changed": { repoId: string; kind: "refsChanged" | "worktreeChanged" };
  };
  streams: {
    "graph.stream": {
      params: { repoId: string; pageSize: number };
      chunk: { repoId: string; rowOffset: number; count: number; shaBuffer: ArrayBuffer };
    };
  };
};

export type RequestKey = keyof Contract["requests"];
export type EventKey = keyof Contract["events"];
export type StreamKey = keyof Contract["streams"];

export type ParamsOf<K extends RequestKey> = Contract["requests"][K]["params"];
export type ResultOf<K extends RequestKey> = Contract["requests"][K]["result"];
export type EventPayload<K extends EventKey> = Contract["events"][K];
export type StreamParamsOf<K extends StreamKey> = Contract["streams"][K]["params"];
export type StreamChunkOf<K extends StreamKey> = Contract["streams"][K]["chunk"];
