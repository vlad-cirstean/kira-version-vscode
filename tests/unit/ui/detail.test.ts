import { describe, expect, test } from "bun:test";
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
import { DetailState } from "../../../packages/ui/src/state/detail.ts";

/**
 * P5 W7's own "one in-flight request per kind" / "a response for a no-longer-selected sha is
 * dropped" rules — the two invariants that make the keyboard model (fast file-to-file arrow nav)
 * and the ≤80ms budget safe from races. `DeferredTransport` below deliberately never rejects a
 * request on its own `signal` firing — real transports *usually* do, but the whole point of the
 * "drop a stale response" rule is that `DetailState` must be correct even in the one case they
 * don't (an abort racing an already-in-flight resolution), so these tests exercise exactly that
 * harder case rather than the easier abort-always-rejects one.
 */
class DeferredTransport implements Transport {
  readonly detailCalls: ParamsOf<"commit.detail">[] = [];
  readonly fileDiffCalls: ParamsOf<"commit.fileDiff">[] = [];
  readonly #detailResolvers: Array<(v: ResultOf<"commit.detail">) => void> = [];
  readonly #fileDiffResolvers: Array<(v: ResultOf<"commit.fileDiff">) => void> = [];

  request<K extends RequestKey>(method: K, params: ParamsOf<K>): Promise<ResultOf<K>> {
    if (method === "commit.detail") {
      this.detailCalls.push(params as ParamsOf<"commit.detail">);
      return new Promise<ResultOf<K>>((resolve) => {
        this.#detailResolvers.push(resolve as (v: ResultOf<"commit.detail">) => void);
      });
    }
    if (method === "commit.fileDiff") {
      this.fileDiffCalls.push(params as ParamsOf<"commit.fileDiff">);
      return new Promise<ResultOf<K>>((resolve) => {
        this.#fileDiffResolvers.push(resolve as (v: ResultOf<"commit.fileDiff">) => void);
      });
    }
    throw new Error(`DeferredTransport: request('${method}') not handled by this fake`);
  }

  resolveDetail(index: number, result: ResultOf<"commit.detail">): void {
    const resolve = this.#detailResolvers[index];
    if (!resolve) throw new Error(`no commit.detail call at index ${index}`);
    resolve(result);
  }

  resolveFileDiff(index: number, result: ResultOf<"commit.fileDiff">): void {
    const resolve = this.#fileDiffResolvers[index];
    if (!resolve) throw new Error(`no commit.fileDiff call at index ${index}`);
    resolve(result);
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

  dispose(): void {}
}

function detail(
  sha: string,
  overrides: Partial<ResultOf<"commit.detail">> = {},
): ResultOf<"commit.detail"> {
  return {
    sha,
    parents: [],
    author: { name: "Ada", email: "ada@example.com", timestamp: 0 },
    committer: { name: "Ada", email: "ada@example.com", timestamp: 0 },
    subject: `subject of ${sha}`,
    body: "",
    trailers: [],
    signature: { status: "N", signer: "" },
    decoration: [],
    parentIndex: 0,
    files: [
      {
        kind: "modified",
        path: "a.ts",
        originalPath: undefined,
        similarity: undefined,
        additions: 1,
        deletions: 1,
        isBinary: false,
      },
      {
        kind: "modified",
        path: "b.ts",
        originalPath: undefined,
        similarity: undefined,
        additions: 2,
        deletions: 2,
        isBinary: false,
      },
    ],
    ...overrides,
  };
}

function fileDiff(sha: string, path: string): ResultOf<"commit.fileDiff"> {
  return {
    sha,
    parentIndex: 0,
    baseSha: "base",
    change: {
      kind: "modified",
      path,
      originalPath: undefined,
      similarity: undefined,
      additions: 1,
      deletions: 1,
      isBinary: false,
    },
    body: { kind: "text", hunks: [] },
  };
}

function setup(): { state: DetailState; transport: DeferredTransport } {
  const transport = new DeferredTransport();
  const bridge = new BridgeClient(transport);
  const state = new DetailState(bridge);
  state.setRepoId("/repos/x");
  return { state, transport };
}

describe("DetailState.select", () => {
  test("requests commit.detail for the selected commit at parentIndex 0", () => {
    const { state, transport } = setup();
    state.select("sha1");
    expect(transport.detailCalls).toEqual([{ repoId: "/repos/x", sha: "sha1", parentIndex: 0 }]);
  });

  test("a resolved response populates detail when it is still the current selection", async () => {
    const { state, transport } = setup();
    state.select("sha1");
    transport.resolveDetail(0, detail("sha1"));
    await Promise.resolve();
    expect(state.detail.value?.sha).toBe("sha1");
  });

  test("selecting a different commit resets parentIndex/mode/selectedFile/diff", async () => {
    const { state, transport } = setup();
    state.select("sha1");
    transport.resolveDetail(0, detail("sha1"));
    await Promise.resolve();
    state.selectFile(1);
    state.setParentIndex(0); // no-op (already 0) — sanity, does not add a call

    state.select("sha2");

    expect(state.parentIndex.value).toBe(0);
    expect(state.mode.value).toBe("detail");
    expect(state.selectedFile.value).toBe(-1);
    expect(state.diff.value).toBeUndefined();
    expect(state.detail.value).toBeUndefined();
  });

  test("a response for a commit that is no longer selected is dropped, not rendered", async () => {
    const { state, transport } = setup();
    state.select("sha1");
    state.select("sha2"); // supersedes the sha1 request before it resolves
    transport.resolveDetail(1, detail("sha2"));
    await Promise.resolve();
    // The stale sha1 response arrives *after* sha2's own — still must not overwrite it.
    transport.resolveDetail(0, detail("sha1"));
    await Promise.resolve();

    expect(state.detail.value?.sha).toBe("sha2");
  });
});

describe("DetailState.setParentIndex", () => {
  test("re-requests commit.detail for the new parent and resets file selection", async () => {
    const { state, transport } = setup();
    state.select("sha1");
    transport.resolveDetail(0, detail("sha1"));
    await Promise.resolve();
    state.selectFile(0);

    state.setParentIndex(1);

    expect(transport.detailCalls).toEqual([
      { repoId: "/repos/x", sha: "sha1", parentIndex: 0 },
      { repoId: "/repos/x", sha: "sha1", parentIndex: 1 },
    ]);
    expect(state.mode.value).toBe("detail");
    expect(state.selectedFile.value).toBe(-1);
    expect(state.diff.value).toBeUndefined();
  });

  test("a response for a parentIndex that is no longer selected is dropped", async () => {
    const { state, transport } = setup();
    state.select("sha1");
    transport.resolveDetail(0, detail("sha1"));
    await Promise.resolve();

    state.setParentIndex(1);
    state.setParentIndex(2); // supersedes the parentIndex-1 request

    transport.resolveDetail(2, detail("sha1", { parentIndex: 2 }));
    await Promise.resolve();
    transport.resolveDetail(1, detail("sha1", { parentIndex: 1 }));
    await Promise.resolve();

    expect(state.detail.value?.parentIndex).toBe(2);
  });
});

describe("DetailState.selectFile / showTree", () => {
  test("selecting a file requests its diff and switches mode to diff", async () => {
    const { state, transport } = setup();
    state.select("sha1");
    transport.resolveDetail(0, detail("sha1"));
    await Promise.resolve();

    state.selectFile(0);

    expect(state.mode.value).toBe("diff");
    expect(transport.fileDiffCalls).toEqual([
      { repoId: "/repos/x", sha: "sha1", path: "a.ts", parentIndex: 0 },
    ]);
  });

  test("a fileDiff response for a file no longer selected is dropped", async () => {
    const { state, transport } = setup();
    state.select("sha1");
    transport.resolveDetail(0, detail("sha1"));
    await Promise.resolve();

    state.selectFile(0);
    state.selectFile(1); // supersedes the a.ts request

    transport.resolveFileDiff(1, fileDiff("sha1", "b.ts"));
    await Promise.resolve();
    transport.resolveFileDiff(0, fileDiff("sha1", "a.ts"));
    await Promise.resolve();

    expect(state.diff.value?.change.path).toBe("b.ts");
  });

  test("showTree returns to detail mode without re-requesting the diff", async () => {
    const { state, transport } = setup();
    state.select("sha1");
    transport.resolveDetail(0, detail("sha1"));
    await Promise.resolve();
    state.selectFile(0);
    transport.resolveFileDiff(0, fileDiff("sha1", "a.ts"));
    await Promise.resolve();

    state.showTree();
    expect(state.mode.value).toBe("detail");

    state.selectFile(0); // same file already showing
    expect(transport.fileDiffCalls).toHaveLength(1);
  });

  test("selecting the same file again while already showing its diff is a no-op", async () => {
    const { state, transport } = setup();
    state.select("sha1");
    transport.resolveDetail(0, detail("sha1"));
    await Promise.resolve();
    state.selectFile(0);
    expect(transport.fileDiffCalls).toHaveLength(1);

    state.selectFile(0);
    expect(transport.fileDiffCalls).toHaveLength(1);
  });
});

describe("DetailState.select(null) / dispose", () => {
  test("select(null) clears every field and issues no request", () => {
    const { state, transport } = setup();
    state.select("sha1");
    state.select(null);
    expect(state.sha.value).toBeNull();
    expect(state.detail.value).toBeUndefined();
    expect(transport.detailCalls).toHaveLength(1);
  });
});
