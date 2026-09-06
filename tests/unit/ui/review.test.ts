import { describe, expect, test } from "bun:test";
import { CommitStore } from "../../../packages/core/src/index.ts";
import type {
  BaseResolution,
  EventKey,
  EventPayload,
  PackedCommitChunk,
  ParamsOf,
  RequestKey,
  ResultOf,
  StreamChunkOf,
  StreamKey,
  StreamParamsOf,
  Transport,
} from "../../../packages/ipc/src/index.ts";
import { BridgeClient } from "../../../packages/ui/src/bridge/client.ts";
import { ReviewSessionState } from "../../../packages/ui/src/state/review.ts";
import { topology } from "../../fixtures/topology.ts";

/**
 * P7 W10's own "Done when": `setTarget` walks resolving -> one of ask/unrelated/empty/listing;
 * `setBase` re-resolves and re-opens in place; `loadMore` is the same two-round-trip shape
 * `GraphViewState` uses; a mid-review `refsChanged` never silently re-walks and never silently
 * does nothing (D39); expansions are created once and kept for the session.
 */

function readyResolution(base: string, branch: string, commitCount: number): BaseResolution {
  return {
    branch,
    base,
    reason: "defaultBranch",
    range: { kind: "ready", commitCount },
    candidates: [{ ref: base, kind: "branch", reason: "defaultBranch" }],
  };
}

function packedChunk(spec: readonly string[]): PackedCommitChunk {
  const store = new CommitStore();
  store.appendPage(topology(spec));
  return store.packSlice(0, store.rowCount, 0);
}

function streamChunk(
  repoId: string,
  commits: PackedCommitChunk,
  remaining = 0,
): StreamChunkOf<"graph.stream"> {
  return {
    repoId,
    seq: 0,
    from: commits.from,
    to: commits.to,
    source: "git",
    remaining,
    exhausted: remaining === 0,
    commits,
  };
}

function fakeDetailResult(sha: string): ResultOf<"commit.detail"> {
  return {
    sha,
    parents: [],
    author: { name: "a", email: "a@x", timestamp: 1_700_000_000 },
    committer: { name: "a", email: "a@x", timestamp: 1_700_000_000 },
    subject: sha,
    body: "",
    trailers: [],
    signature: { status: "N", signer: "" },
    decoration: [],
    parentIndex: 0,
    files: [],
  };
}

class FakeTransport implements Transport {
  resolveBaseQueue: (BaseResolution | Error)[] = [];
  streamScripts: StreamChunkOf<"graph.stream">[][] = [];
  readonly resolveBaseCalls: ParamsOf<"review.resolveBase">[] = [];
  readonly loadMoreCalls: ParamsOf<"graph.loadMore">[] = [];
  readonly detailCalls: ParamsOf<"commit.detail">[] = [];
  detailResult: ResultOf<"commit.detail"> | undefined;
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();

  request<K extends RequestKey>(method: K, params: ParamsOf<K>): Promise<ResultOf<K>> {
    if (method === "review.resolveBase") {
      this.resolveBaseCalls.push(params as ParamsOf<"review.resolveBase">);
      const next = this.resolveBaseQueue.shift();
      if (next === undefined) throw new Error("FakeTransport: no resolveBase result queued");
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next as ResultOf<K>);
    }
    if (method === "graph.loadMore") {
      this.loadMoreCalls.push(params as ParamsOf<"graph.loadMore">);
      return Promise.resolve({ started: true } as ResultOf<K>);
    }
    if (method === "commit.detail") {
      this.detailCalls.push(params as ParamsOf<"commit.detail">);
      if (!this.detailResult) throw new Error("FakeTransport: detailResult not set");
      return Promise.resolve(this.detailResult as ResultOf<K>);
    }
    if (method === "clipboard.write") return Promise.resolve({} as ResultOf<K>);
    throw new Error(`FakeTransport: request('${method}') not scripted by this test`);
  }

  on<K extends EventKey>(method: K, handler: (payload: EventPayload<K>) => void): () => void {
    const set = this.#listeners.get(method) ?? new Set();
    set.add(handler as (payload: unknown) => void);
    this.#listeners.set(method, set);
    return () => set.delete(handler as (payload: unknown) => void);
  }

  emit<K extends EventKey>(method: K, payload: EventPayload<K>): void {
    for (const handler of this.#listeners.get(method) ?? []) handler(payload);
  }

  async stream<K extends StreamKey>(
    method: K,
    params: StreamParamsOf<K>,
    onChunk: (chunk: StreamChunkOf<K>) => void | Promise<void>,
  ): Promise<void> {
    if (method !== "graph.stream") throw new Error(`unhandled stream '${method}'`);
    void params;
    const script = this.streamScripts.shift();
    if (!script) throw new Error("FakeTransport: stream() called with no script queued");
    for (const chunk of script) await onChunk(chunk as StreamChunkOf<K>);
  }

  dispose(): void {}
}

const CAPABILITIES = {
  openInEditor: true,
  goToFile: true,
  clipboard: true,
  resolveConflict: false,
};

function makeReview(transport: FakeTransport): ReviewSessionState {
  return new ReviewSessionState(new BridgeClient(transport), CAPABILITIES);
}

describe("ReviewSessionState", () => {
  test("setTarget resolves, then opens the stream on a ready outcome", async () => {
    const transport = new FakeTransport();
    transport.resolveBaseQueue = [readyResolution("main", "feature-x", 2)];
    transport.streamScripts = [[streamChunk("r1", packedChunk(["c0", "c1:c0"]))]];

    const review = makeReview(transport);
    await review.setTarget("r1", "feature-x");

    expect(transport.resolveBaseCalls).toEqual([{ repoId: "r1", branch: "feature-x" }]);
    expect(review.phase.value).toBe("listing");
    expect(review.resolution.value?.range).toEqual({ kind: "ready", commitCount: 2 });
    expect(review.loadedRows.value).toBe(2);
    expect(review.exhausted.value).toBe(true);
  });

  test("an ask/unrelated/empty outcome renders its own phase and opens no stream", async () => {
    for (const range of [
      { kind: "ask" as const },
      { kind: "unrelated" as const },
      { kind: "empty" as const },
    ]) {
      const transport = new FakeTransport();
      transport.resolveBaseQueue = [
        {
          branch: "feature-x",
          base: range.kind === "ask" ? null : "main",
          reason: range.kind === "ask" ? "none" : "defaultBranch",
          range,
          candidates: [],
        },
      ];
      const review = makeReview(transport);
      await review.setTarget("r1", "feature-x");
      expect(review.phase.value).toBe(range.kind);
      expect(transport.streamScripts).toHaveLength(0); // never consumed — no stream was opened
    }
  });

  test("setBase re-resolves with an explicit base and re-opens in place", async () => {
    const transport = new FakeTransport();
    transport.resolveBaseQueue = [
      { branch: "feature-x", base: null, reason: "none", range: { kind: "ask" }, candidates: [] },
    ];
    const review = makeReview(transport);
    await review.setTarget("r1", "feature-x");
    expect(review.phase.value).toBe("ask");

    transport.resolveBaseQueue = [readyResolution("develop", "feature-x", 1)];
    transport.streamScripts = [[streamChunk("r1", packedChunk(["c0"]))]];
    await review.setBase("develop");

    expect(transport.resolveBaseCalls[1]).toEqual({
      repoId: "r1",
      branch: "feature-x",
      base: "develop",
    });
    expect(review.phase.value).toBe("listing");
    expect(review.resolution.value?.reason).toBe("defaultBranch"); // echoed verbatim from the fake
    expect(review.loadedRows.value).toBe(1);
  });

  test("loadMore pages the review walk then re-opens the stream, mirroring GraphViewState", async () => {
    const transport = new FakeTransport();
    transport.resolveBaseQueue = [readyResolution("main", "feature-x", 3)];
    transport.streamScripts = [[streamChunk("r1", packedChunk(["c0", "c1:c0"]), 1)]];
    const review = makeReview(transport);
    await review.setTarget("r1", "feature-x");
    expect(review.loadedRows.value).toBe(2);
    expect(review.remaining.value).toBe(1);

    transport.streamScripts = [[streamChunk("r1", packedChunk(["c0", "c1:c0", "c2:c1"]), 0)]];
    await review.loadMore();

    expect(transport.loadMoreCalls).toEqual([
      { repoId: "r1", pages: 1, range: { base: "main", branch: "feature-x" } },
    ]);
    expect(review.loadedRows.value).toBe(3);
    expect(review.exhausted.value).toBe(true);
    expect(review.isLoadingMore.value).toBe(false);
  });

  test("expand fetches commit.detail once; collapsing and re-expanding does not re-fetch", async () => {
    const transport = new FakeTransport();
    transport.resolveBaseQueue = [readyResolution("main", "feature-x", 1)];
    transport.streamScripts = [[streamChunk("r1", packedChunk(["c0"]))]];
    transport.detailResult = fakeDetailResult("sha-c0");
    const review = makeReview(transport);
    await review.setTarget("r1", "feature-x");

    const sha = review.store.shaAt(0);
    review.expand(sha);
    expect(review.expandedShas.value.has(sha)).toBe(true);
    await Promise.resolve(); // let detail's own request resolve
    expect(transport.detailCalls).toHaveLength(1);
    expect(review.expansionFor(sha)?.detail.detail.value?.sha).toBe("sha-c0");

    review.collapse(sha);
    expect(review.expandedShas.value.has(sha)).toBe(false);
    review.expand(sha);
    expect(transport.detailCalls).toHaveLength(1); // no second fetch — the DetailState was kept
  });

  test("a mid-review refsChanged never re-walks silently: it sets staleReview, and only acknowledgeStaleReview applies it", async () => {
    const transport = new FakeTransport();
    transport.resolveBaseQueue = [readyResolution("main", "feature-x", 1)];
    transport.streamScripts = [[streamChunk("r1", packedChunk(["c0"]))]];
    const review = makeReview(transport);
    await review.setTarget("r1", "feature-x");
    expect(review.staleReview.value).toBe(false);

    // The background check finds a changed commit count.
    transport.resolveBaseQueue = [readyResolution("main", "feature-x", 2)];
    transport.emit("repo.changed", { repoId: "r1", kind: "refsChanged" });
    await Promise.resolve();
    await Promise.resolve();

    expect(review.staleReview.value).toBe(true);
    expect(review.resolution.value?.range).toEqual({ kind: "ready", commitCount: 1 }); // unchanged until acknowledged
    expect(review.loadedRows.value).toBe(1); // unchanged until acknowledged

    transport.streamScripts = [[streamChunk("r1", packedChunk(["c0", "c1:c0"]))]];
    await review.acknowledgeStaleReview();

    expect(review.staleReview.value).toBe(false);
    expect(review.resolution.value?.range).toEqual({ kind: "ready", commitCount: 2 });
    expect(review.loadedRows.value).toBe(2);
  });

  test("a refsChanged that resolves to the same outcome never sets staleReview", async () => {
    const transport = new FakeTransport();
    transport.resolveBaseQueue = [readyResolution("main", "feature-x", 1)];
    transport.streamScripts = [[streamChunk("r1", packedChunk(["c0"]))]];
    const review = makeReview(transport);
    await review.setTarget("r1", "feature-x");

    transport.resolveBaseQueue = [readyResolution("main", "feature-x", 1)];
    transport.emit("repo.changed", { repoId: "r1", kind: "refsChanged" });
    await Promise.resolve();
    await Promise.resolve();

    expect(review.staleReview.value).toBe(false);
  });

  test("a refsChanged for a different repo is ignored", async () => {
    const transport = new FakeTransport();
    transport.resolveBaseQueue = [readyResolution("main", "feature-x", 1)];
    transport.streamScripts = [[streamChunk("r1", packedChunk(["c0"]))]];
    const review = makeReview(transport);
    await review.setTarget("r1", "feature-x");

    transport.emit("repo.changed", { repoId: "r2", kind: "refsChanged" });
    await Promise.resolve();
    expect(transport.resolveBaseCalls).toHaveLength(1); // no second call at all
    expect(review.staleReview.value).toBe(false);
  });

  test("a genuine review.resolveBase failure lands in an explicit error phase, not a blank one", async () => {
    const transport = new FakeTransport();
    transport.resolveBaseQueue = [new Error("git merge-base: fatal error")];
    const review = makeReview(transport);
    await review.setTarget("r1", "feature-x");

    expect(review.phase.value).toBe("error");
    expect(review.resolveError.value).toContain("merge-base");
  });

  test("setTarget on a second branch discards the first branch's expansions", async () => {
    const transport = new FakeTransport();
    transport.resolveBaseQueue = [readyResolution("main", "feature-x", 1)];
    transport.streamScripts = [[streamChunk("r1", packedChunk(["c0"]))]];
    transport.detailResult = fakeDetailResult("sha-c0");
    const review = makeReview(transport);
    await review.setTarget("r1", "feature-x");
    const sha = review.store.shaAt(0);
    review.expand(sha);
    await Promise.resolve();
    expect(review.expandedShas.value.size).toBe(1);

    transport.resolveBaseQueue = [readyResolution("main", "other-branch", 1)];
    transport.streamScripts = [[streamChunk("r1", packedChunk(["c9"]))]];
    await review.setTarget("r1", "other-branch");

    expect(review.expandedShas.value.size).toBe(0);
    expect(review.expansionFor(sha)).toBeUndefined();
  });
});
