import { describe, expect, test } from "bun:test";
import type {
  EventKey,
  EventPayload,
  HeadState,
  ParamsOf,
  RefRow,
  RequestKey,
  ResultOf,
  StreamChunkOf,
  StreamKey,
  StreamParamsOf,
  Transport,
} from "../../../packages/ipc/src/index.ts";
import { BridgeClient } from "../../../packages/ui/src/bridge/client.ts";
import { RefsState } from "../../../packages/ui/src/state/refs.ts";

/** A scripted `Transport` serving `refs.list` from a queue and letting the test fire
 *  `repo.changed` directly — `DetailState`'s own test file's precedent, simplified: `RefsState`
 *  never races two in-flight requests against each other, so there is no need for a deferred
 *  resolver here, only a FIFO of canned results. */
class ScriptedTransport implements Transport {
  readonly refsListCalls: ParamsOf<"refs.list">[] = [];
  #queue: ResultOf<"refs.list">[] = [];
  #changedHandlers = new Set<(payload: EventPayload<"repo.changed">) => void>();

  queueRefs(result: ResultOf<"refs.list">): void {
    this.#queue.push(result);
  }

  emitChanged(payload: EventPayload<"repo.changed">): void {
    for (const handler of this.#changedHandlers) handler(payload);
  }

  request<K extends RequestKey>(method: K, params: ParamsOf<K>): Promise<ResultOf<K>> {
    if (method === "refs.list") {
      this.refsListCalls.push(params as ParamsOf<"refs.list">);
      const next = this.#queue.shift();
      if (!next) throw new Error("ScriptedTransport: no queued refs.list result");
      return Promise.resolve(next as ResultOf<K>);
    }
    throw new Error(`ScriptedTransport: request('${method}') not handled by this fake`);
  }

  on<K extends EventKey>(method: K, handler: (payload: EventPayload<K>) => void): () => void {
    if (method !== "repo.changed") return () => {};
    const cast = handler as (payload: EventPayload<"repo.changed">) => void;
    this.#changedHandlers.add(cast);
    return () => this.#changedHandlers.delete(cast);
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

function row(overrides: Partial<RefRow> = {}): RefRow {
  return {
    refname: "refs/heads/main",
    kind: "branch",
    shortName: "main",
    objectId: "a".repeat(40),
    peeledObjectId: undefined,
    upstream: undefined,
    track: undefined,
    committerDate: 0,
    isHead: true,
    checkedOutIn: undefined,
    annotation: undefined,
    ...overrides,
  };
}

function refsResult(overrides: Partial<ResultOf<"refs.list">> = {}): ResultOf<"refs.list"> {
  return {
    branches: [row()],
    remoteBranches: [],
    tags: [],
    head: { kind: "branch", name: "main" },
    ...overrides,
  };
}

describe("RefsState", () => {
  test("loads on setRepoId and exposes the three sections plus head", async () => {
    const transport = new ScriptedTransport();
    transport.queueRefs(refsResult());
    const bridge = new BridgeClient(transport);
    const refs = new RefsState(bridge);

    refs.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();

    expect(refs.branches.value).toHaveLength(1);
    expect(refs.head.value).toEqual({ kind: "branch", name: "main" });
    expect(refs.currentBranchName.value).toBe("main");
    expect(transport.refsListCalls).toEqual([{ repoId: "r1" }]);
  });

  test("reloads only on repo.changed with kind refsChanged, for the active repo", async () => {
    const transport = new ScriptedTransport();
    transport.queueRefs(refsResult());
    const bridge = new BridgeClient(transport);
    const refs = new RefsState(bridge);
    refs.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.refsListCalls).toHaveLength(1);

    // Wrong kind: ignored.
    transport.emitChanged({ repoId: "r1", kind: "worktreeChanged" });
    await Promise.resolve();
    expect(transport.refsListCalls).toHaveLength(1);

    // Wrong repo: ignored.
    transport.emitChanged({ repoId: "other", kind: "refsChanged" });
    await Promise.resolve();
    expect(transport.refsListCalls).toHaveLength(1);

    // Right repo, right kind: reloads.
    transport.queueRefs(
      refsResult({ branches: [row(), row({ shortName: "side", isHead: false })] }),
    );
    transport.emitChanged({ repoId: "r1", kind: "refsChanged" });
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.refsListCalls).toHaveLength(2);
    expect(refs.branches.value).toHaveLength(2);
  });

  test("clears all state when the repo closes", async () => {
    const transport = new ScriptedTransport();
    transport.queueRefs(refsResult());
    const bridge = new BridgeClient(transport);
    const refs = new RefsState(bridge);
    refs.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();
    expect(refs.branches.value).toHaveLength(1);

    refs.setRepoId(undefined);
    expect(refs.branches.value).toHaveLength(0);
    expect(refs.head.value).toBeUndefined();
  });

  test("badgesBySha maps a commit to every ref resolving to it, tags keyed by the peeled sha", () => {
    const transport = new ScriptedTransport();
    const bridge = new BridgeClient(transport);
    const refs = new RefsState(bridge);
    refs.branches.value = [row({ shortName: "main", objectId: "sha1" })];
    refs.tags.value = [
      row({
        kind: "tag",
        shortName: "v1",
        objectId: "tagobj1",
        peeledObjectId: "sha1",
        annotation: { tagger: "a", date: 0, subject: "v1" },
      }),
    ];

    const badges = refs.badgesBySha.value;
    expect(badges.get("sha1")?.map((r) => r.shortName)).toEqual(["main", "v1"]);
  });

  test("worktreeBranches is exactly the branches with checkedOutIn set", () => {
    const transport = new ScriptedTransport();
    const bridge = new BridgeClient(transport);
    const refs = new RefsState(bridge);
    refs.branches.value = [
      row({ shortName: "main" }),
      row({ shortName: "feature", checkedOutIn: "/repos/other-worktree" }),
    ];

    expect([...refs.worktreeBranches.value]).toEqual(["feature"]);
  });

  test("applyHead updates head synchronously without a reload (ops.ts's own step 4)", async () => {
    const transport = new ScriptedTransport();
    transport.queueRefs(refsResult());
    const bridge = new BridgeClient(transport);
    const refs = new RefsState(bridge);
    refs.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.refsListCalls).toHaveLength(1);

    const detached: HeadState = { kind: "detached", sha: "b".repeat(40) };
    refs.applyHead(detached);
    expect(refs.head.value).toEqual(detached);
    expect(refs.currentBranchName.value).toBeUndefined();
    // No extra refs.list call — applyHead is a pure local write.
    expect(transport.refsListCalls).toHaveLength(1);
  });
});
