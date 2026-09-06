import { describe, expect, test } from "bun:test";
import type {
  CheckoutPreflight,
  EventKey,
  EventPayload,
  HeadState,
  OpResult,
  ParamsOf,
  PullPreflight,
  RemoteOpResult,
  RequestKey,
  ResultOf,
  RevertPreflight,
  StatusSummary,
  StreamChunkOf,
  StreamKey,
  StreamParamsOf,
  Transport,
} from "../../../packages/ipc/src/index.ts";
import { BridgeClient } from "../../../packages/ui/src/bridge/client.ts";
import { OpsState } from "../../../packages/ui/src/state/ops.ts";
import { RefsState } from "../../../packages/ui/src/state/refs.ts";

/** Scripted per-method, FIFO-per-method fake `Transport` — every P6 request this test drives is
 *  a plain request/response with no abort semantics of its own (that races are `DetailState`'s
 *  own concern, already covered there), so one small dispatcher plus a queue per method is
 *  enough. */
class ScriptedTransport implements Transport {
  readonly calls: Array<{ method: RequestKey; params: unknown }> = [];
  readonly #queues = new Map<RequestKey, unknown[]>();
  #changedHandlers = new Set<(payload: EventPayload<"repo.changed">) => void>();

  queue<K extends RequestKey>(method: K, result: ResultOf<K>): void {
    const list = this.#queues.get(method) ?? [];
    list.push(result);
    this.#queues.set(method, list);
  }

  emitChanged(payload: EventPayload<"repo.changed">): void {
    for (const handler of this.#changedHandlers) handler(payload);
  }

  request<K extends RequestKey>(method: K, params: ParamsOf<K>): Promise<ResultOf<K>> {
    this.calls.push({ method, params });
    const list = this.#queues.get(method);
    const next = list?.shift();
    if (next === undefined) throw new Error(`ScriptedTransport: no queued result for '${method}'`);
    return Promise.resolve(next as ResultOf<K>);
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

const BRANCH_HEAD: HeadState = { kind: "branch", name: "main" };
const DETACHED_HEAD: HeadState = { kind: "detached", sha: "c".repeat(40) };

function status(overrides: Partial<StatusSummary> = {}): StatusSummary {
  return {
    head: BRANCH_HEAD,
    upstream: undefined,
    counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0 },
    isClean: true,
    dirtyPaths: [],
    dirtyTruncated: false,
    inProgress: null,
    ...overrides,
  };
}

function checkoutPreflight(overrides: Partial<CheckoutPreflight> = {}): CheckoutPreflight {
  return {
    target: { kind: "branch", name: "side" },
    detaches: false,
    createsTracking: undefined,
    carried: [],
    blockers: [],
    verdict: "clean",
    routes: [],
    ...overrides,
  };
}

function revertPreflight(overrides: Partial<RevertPreflight> = {}): RevertPreflight {
  return {
    shas: ["a".repeat(40)],
    mainlineRequired: [],
    dirtyPaths: [],
    inProgress: null,
    prediction: { kind: "clean" },
    predictedFor: "a".repeat(40),
    detachedHead: false,
    verdict: "clean",
    blockers: [],
    ...overrides,
  };
}

function opResult(overrides: Partial<OpResult> = {}): OpResult {
  return {
    ok: true,
    error: undefined,
    undo: null,
    head: BRANCH_HEAD,
    inProgress: null,
    ...overrides,
  };
}

function remoteOpResult(overrides: Partial<RemoteOpResult> = {}): RemoteOpResult {
  return {
    ok: true,
    error: undefined,
    updates: [],
    head: BRANCH_HEAD,
    inProgress: null,
    ...overrides,
  };
}

function pullPreflight(overrides: Partial<PullPreflight> = {}): PullPreflight {
  return {
    strategy: "ff-only",
    source: "default",
    upstream: "origin/main",
    ahead: 0,
    behind: 2,
    dirty: false,
    routes: [],
    blockers: [],
    ...overrides,
  };
}

function setup(): { transport: ScriptedTransport; refs: RefsState; ops: OpsState } {
  const transport = new ScriptedTransport();
  const bridge = new BridgeClient(transport);
  const refs = new RefsState(bridge);
  const ops = new OpsState(bridge, refs);
  return { transport, refs, ops };
}

describe("OpsState", () => {
  test("setRepoId loads status and the undo slot", async () => {
    const { transport, ops } = setup();
    transport.queue("status.get", status());
    transport.queue("undo.peek", { slot: null });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();
    expect(ops.statusSummary.value).toEqual(status());
    expect(ops.undoSlot.value).toBeNull();
  });

  test("canRun mirrors core's canRunOp over the current inProgress", async () => {
    const { transport, ops } = setup();
    transport.queue(
      "status.get",
      status({
        inProgress: {
          kind: "revert",
          otherSha: "a".repeat(40),
          headName: undefined,
          conflictedPaths: ["a.txt"],
          canContinue: true,
          canAbort: true,
          isSequence: false,
          unmergedCount: 1,
        },
      }),
    );
    transport.queue("undo.peek", { slot: null });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();

    expect(ops.canRun("checkout")).toBe(false);
    expect(ops.canRun("revert")).toBe(false);
    expect(ops.canRun("branchCreate")).toBe(true);
    expect(ops.canRun("opAbort")).toBe(true);
  });

  test("runCheckout: clean verdict runs with no confirm step and announces", async () => {
    const { transport, refs, ops } = setup();
    transport.queue("status.get", status());
    transport.queue("undo.peek", { slot: null });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();

    transport.queue("preflight.checkout", checkoutPreflight());
    transport.queue("op.run", opResult({ head: { kind: "branch", name: "side" } }));
    await ops.runCheckout("side", "switch");

    expect(ops.pendingCheckout.value).toBeUndefined();
    expect(refs.head.value).toEqual({ kind: "branch", name: "side" });
    expect(ops.announcement.value).toBe("Checked out side");
    expect(ops.busy.value).toBe(false);
  });

  test("runCheckout: cleanCarry announces the carried count with no dialog", async () => {
    const { transport, ops } = setup();
    transport.queue("status.get", status());
    transport.queue("undo.peek", { slot: null });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();

    transport.queue(
      "preflight.checkout",
      checkoutPreflight({ verdict: "cleanCarry", carried: ["a.txt", "b.txt"] }),
    );
    transport.queue("op.run", opResult());
    await ops.runCheckout("side", "switch");

    expect(ops.pendingCheckout.value).toBeUndefined();
    expect(ops.announcement.value).toBe("Checked out side — 2 local changes carried over");
  });

  test("runCheckout: blocked verdict opens the dialog and awaits a route; Cancel runs nothing", async () => {
    const { transport, ops } = setup();
    transport.queue("status.get", status());
    transport.queue("undo.peek", { slot: null });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();

    const blocked = checkoutPreflight({
      verdict: "blocked",
      blockers: [{ kind: "blockedByTracked", paths: ["a.txt"] }],
      routes: ["discard"],
    });
    transport.queue("preflight.checkout", blocked);
    const promise = ops.runCheckout("side", "switch");
    await Promise.resolve();
    await Promise.resolve();

    expect(ops.pendingCheckout.value).toEqual(blocked);
    ops.resolveCheckoutDialog(null);
    await promise;

    expect(ops.pendingCheckout.value).toBeUndefined();
    expect(ops.announcement.value).toBe("Checkout cancelled.");
    expect(transport.calls.some((c) => c.method === "op.run")).toBe(false);
  });

  test("runCheckout: blocked verdict, Discard route runs op.run with discardLocalChanges", async () => {
    const { transport, ops } = setup();
    transport.queue("status.get", status());
    transport.queue("undo.peek", { slot: null });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();

    const blocked = checkoutPreflight({
      verdict: "blocked",
      blockers: [{ kind: "blockedByTracked", paths: ["a.txt"] }],
      routes: ["discard"],
    });
    transport.queue("preflight.checkout", blocked);
    transport.queue("op.run", opResult());
    const promise = ops.runCheckout("side", "switch");
    await Promise.resolve();
    await Promise.resolve();
    ops.resolveCheckoutDialog({ kind: "discard" });
    await promise;

    const opRunCall = transport.calls.find((c) => c.method === "op.run");
    expect(opRunCall?.params).toEqual({
      repoId: "r1",
      op: { kind: "checkout", target: "side", mode: "switch", discardLocalChanges: true },
    });
  });

  test("runCheckout: blocked verdict, stashAndCarry route pushes, switches, and pops clean", async () => {
    const { transport, ops } = setup();
    transport.queue("status.get", status());
    transport.queue("undo.peek", { slot: null });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();

    const blocked = checkoutPreflight({
      verdict: "blocked",
      blockers: [{ kind: "blockedByTracked", paths: ["a.txt"] }],
      routes: ["discard", "stashAndCarry"],
    });
    transport.queue("preflight.checkout", blocked);
    const promise = ops.runCheckout("side", "switch");
    await Promise.resolve();
    await Promise.resolve();

    expect(ops.pendingCheckout.value).toEqual(blocked);
    transport.queue("op.run", opResult()); // stashPush
    transport.queue("op.run", opResult({ head: { kind: "branch", name: "side" } })); // checkout
    transport.queue("stash.list", {
      entries: [
        {
          index: 0,
          sha: "s".repeat(40),
          baseSha: "b".repeat(40),
          baseSubject: "base commit",
          indexSha: "i".repeat(40),
          untrackedSha: undefined,
          includedUntracked: false,
          message: "WIP on main: base commit",
          branch: "main",
          timestamp: 1,
          fileCount: 1,
        },
      ],
    });
    transport.queue("preflight.stashPop", {
      stashSha: "s".repeat(40),
      stashIndex: 0,
      targetSha: "side".padEnd(40, "0"),
      prediction: { kind: "clean" },
      blockers: [],
      verdict: "clean",
    });
    transport.queue("op.run", opResult({ head: { kind: "branch", name: "side" } })); // stashPop
    ops.resolveCheckoutDialog({ kind: "stashAndCarry" });
    await promise;

    expect(ops.pendingCheckout.value).toBeUndefined();
    expect(ops.announcement.value).toBe("Checked out side");
    const opKinds = transport.calls
      .filter((c) => c.method === "op.run")
      .map((c) => (c.params as { op: { kind: string } }).op.kind);
    expect(opKinds).toEqual(["stashPush", "checkout", "stashPop"]);
  });

  test("runCheckout: op.run failure announces the error, never silently", async () => {
    const { transport, ops } = setup();
    transport.queue("status.get", status());
    transport.queue("undo.peek", { slot: null });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();

    transport.queue("preflight.checkout", checkoutPreflight());
    transport.queue(
      "op.run",
      opResult({ ok: false, error: { kind: "WorktreeConflict", message: "boom" } }),
    );
    await ops.runCheckout("side", "switch");

    expect(ops.announcement.value).toBe("Checkout failed — checked out in another worktree.");
  });

  test("runRevert: clean, single non-merge sha runs with no mainline picker", async () => {
    const { transport, ops } = setup();
    transport.queue("status.get", status());
    transport.queue("undo.peek", { slot: null });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();

    transport.queue("preflight.revert", revertPreflight());
    transport.queue("op.run", opResult());
    await ops.runRevert(["a".repeat(40)]);

    expect(ops.pendingRevert.value).toBeUndefined();
    const opRunCall = transport.calls.find((c) => c.method === "op.run");
    expect(opRunCall?.params).toEqual({
      repoId: "r1",
      op: { kind: "revert", shas: ["a".repeat(40)], mainline: undefined, noCommit: false },
    });
    expect(ops.announcement.value).toBe(`Reverted commit ${"a".repeat(7)}`);
  });

  test("runRevert: a merge commit requires a mainline pick before op.run runs", async () => {
    const { transport, ops } = setup();
    transport.queue("status.get", status());
    transport.queue("undo.peek", { slot: null });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();

    const mergeSha = "m".repeat(40);
    const withPicker = revertPreflight({
      shas: [mergeSha],
      predictedFor: null,
      mainlineRequired: [
        {
          sha: mergeSha,
          parents: [
            { parentNumber: 1, sha: "p1".padEnd(40, "0"), subject: "first parent" },
            { parentNumber: 2, sha: "p2".padEnd(40, "0"), subject: "second parent" },
          ],
        },
      ],
    });
    transport.queue("preflight.revert", withPicker);
    const promise = ops.runRevert([mergeSha]);
    await Promise.resolve();
    await Promise.resolve();

    expect(ops.pendingRevert.value).toEqual(withPicker);
    expect(transport.calls.some((c) => c.method === "op.run")).toBe(false);

    transport.queue("op.run", opResult());
    ops.resolveRevertDialog({ mainline: 1, noCommit: false });
    await promise;

    const opRunCall = transport.calls.find((c) => c.method === "op.run");
    expect(opRunCall?.params).toEqual({
      repoId: "r1",
      op: { kind: "revert", shas: [mergeSha], mainline: 1, noCommit: false },
    });
  });

  test("previewRevertMainline refreshes the pending preflight without resolving the dialog", async () => {
    const { transport, ops } = setup();
    transport.queue("status.get", status());
    transport.queue("undo.peek", { slot: null });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();

    const mergeSha = "m".repeat(40);
    transport.queue(
      "preflight.revert",
      revertPreflight({
        shas: [mergeSha],
        mainlineRequired: [
          { sha: mergeSha, parents: [{ parentNumber: 1, sha: "p", subject: "s" }] },
        ],
      }),
    );
    const promise = ops.runRevert([mergeSha]);
    await Promise.resolve();
    await Promise.resolve();

    transport.queue(
      "preflight.revert",
      revertPreflight({
        shas: [mergeSha],
        prediction: { kind: "conflicts", paths: ["a.txt"] },
        verdict: "willConflict",
      }),
    );
    await ops.previewRevertMainline(1);

    expect(ops.pendingRevert.value?.prediction).toEqual({ kind: "conflicts", paths: ["a.txt"] });
    // Still pending — previewing does not settle runRevert's own promise.
    ops.resolveRevertDialog(null);
    await promise;
  });

  test("branchDelete surfaces the returned undo slot", async () => {
    const { transport, ops } = setup();
    transport.queue("status.get", status());
    transport.queue("undo.peek", { slot: null });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();

    const slot = {
      id: "u1",
      label: "Undo delete of branch feature",
      recoverySha: "d".repeat(40),
      createdAt: 1,
    };
    transport.queue("op.run", opResult({ undo: slot }));
    const result = await ops.branchDelete("feature", false);

    expect(result.ok).toBe(true);
    expect(ops.undoSlot.value).toEqual(slot);
    expect(ops.announcement.value).toBe("Deleted branch feature");
  });

  test("undo() clears the slot and replays through undo.run", async () => {
    const { transport, ops } = setup();
    transport.queue("status.get", status());
    const slot = {
      id: "u1",
      label: "Undo delete of branch feature",
      recoverySha: "d".repeat(40),
      createdAt: 1,
    };
    transport.queue("undo.peek", { slot });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();
    expect(ops.undoSlot.value).toEqual(slot);

    transport.queue("undo.run", opResult({ undo: null }));
    const result = await ops.undo();

    expect(result?.ok).toBe(true);
    expect(ops.undoSlot.value).toBeNull();
    expect(ops.announcement.value).toBe(`Undone: ${slot.label}`);
    const undoRunCall = transport.calls.find((c) => c.method === "undo.run");
    expect(undoRunCall?.params).toEqual({ repoId: "r1", id: "u1" });
  });

  test("undo() is a no-op with an empty slot", async () => {
    const { transport, ops } = setup();
    transport.queue("status.get", status());
    transport.queue("undo.peek", { slot: null });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();

    const result = await ops.undo();
    expect(result).toBeUndefined();
    expect(transport.calls.some((c) => c.method === "undo.run")).toBe(false);
  });

  test("op.run applies head/inProgress/undo synchronously, before any repo.changed reload", async () => {
    const { transport, refs, ops } = setup();
    transport.queue("status.get", status());
    transport.queue("undo.peek", { slot: null });
    transport.queue("refs.list", {
      branches: [],
      remoteBranches: [],
      tags: [],
      head: BRANCH_HEAD,
    });
    ops.setRepoId("r1");
    refs.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    transport.queue("preflight.checkout", checkoutPreflight());
    transport.queue("op.run", opResult({ head: DETACHED_HEAD }));
    // No second refs.list queued for the reload the repo.changed event *would* trigger — proves
    // runCheckout's own synchronous apply is what updated refs.head, not a reload.
    await ops.runCheckout("deadbeef", "detach");

    expect(refs.head.value).toEqual(DETACHED_HEAD);
    expect(ops.statusSummary.value?.head).toEqual(DETACHED_HEAD);
  });

  test("a repo.changed event of either kind refreshes status", async () => {
    const { transport, ops } = setup();
    transport.queue("status.get", status());
    transport.queue("undo.peek", { slot: null });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();

    transport.queue("status.get", status({ isClean: false, dirtyPaths: ["a.txt"] }));
    transport.emitChanged({ repoId: "r1", kind: "worktreeChanged" });
    await Promise.resolve();
    await Promise.resolve();

    expect(ops.statusSummary.value?.isClean).toBe(false);
  });

  test("runPull: no blockers previews the strategy then runs remote.run directly", async () => {
    const { transport, ops } = setup();
    transport.queue("status.get", status());
    transport.queue("undo.peek", { slot: null });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();

    transport.queue("remote.pullPreflight", pullPreflight());
    transport.queue("remote.run", remoteOpResult());
    await ops.runPull("origin", "main");

    expect(ops.pendingPull.value).toBeUndefined();
    expect(ops.pullStrategy.value).toEqual({ strategy: "ff-only", source: "default" });
    expect(ops.announcement.value).toBe("Pulled origin/main (ff-only)");
    const runCall = transport.calls.find((c) => c.method === "remote.run");
    expect(runCall).toBeDefined();
  });

  test("runPull: dirtyNonFastForward blocker opens the dialog; Cancel runs nothing", async () => {
    const { transport, ops } = setup();
    transport.queue("status.get", status());
    transport.queue("undo.peek", { slot: null });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();

    const blocked = pullPreflight({
      strategy: "rebase",
      source: "branchConfig",
      dirty: true,
      routes: ["stashAndCarry"],
      blockers: ["dirtyNonFastForward"],
    });
    transport.queue("remote.pullPreflight", blocked);
    const promise = ops.runPull("origin", "main");
    await Promise.resolve();
    await Promise.resolve();

    expect(ops.pendingPull.value).toEqual(blocked);
    ops.resolvePullDialog(false);
    await promise;

    expect(ops.pendingPull.value).toBeUndefined();
    expect(ops.announcement.value).toBe("Pull cancelled.");
    expect(transport.calls.some((c) => c.method === "remote.run")).toBe(false);
  });

  test("runPull: dirtyNonFastForward blocker, confirmed stashAndCarry pushes, pulls, and pops clean", async () => {
    const { transport, ops } = setup();
    transport.queue("status.get", status());
    transport.queue("undo.peek", { slot: null });
    ops.setRepoId("r1");
    await Promise.resolve();
    await Promise.resolve();

    const blocked = pullPreflight({
      dirty: true,
      routes: ["stashAndCarry"],
      blockers: ["dirtyNonFastForward"],
    });
    transport.queue("remote.pullPreflight", blocked);
    const promise = ops.runPull("origin", "main");
    await Promise.resolve();
    await Promise.resolve();

    expect(ops.pendingPull.value).toEqual(blocked);
    transport.queue("op.run", opResult()); // stashPush
    transport.queue("remote.run", remoteOpResult()); // pull
    transport.queue("stash.list", {
      entries: [
        {
          index: 0,
          sha: "s".repeat(40),
          baseSha: "b".repeat(40),
          baseSubject: "base commit",
          indexSha: "i".repeat(40),
          untrackedSha: undefined,
          includedUntracked: false,
          message: "WIP on main: base commit",
          branch: "main",
          timestamp: 1,
          fileCount: 1,
        },
      ],
    });
    transport.queue("preflight.stashPop", {
      stashSha: "s".repeat(40),
      stashIndex: 0,
      targetSha: "a".repeat(40),
      prediction: { kind: "clean" },
      blockers: [],
      verdict: "clean",
    });
    transport.queue("op.run", opResult()); // stashPop
    ops.resolvePullDialog(true);
    await promise;

    expect(ops.pendingPull.value).toBeUndefined();
    expect(ops.announcement.value).toBe("Pulled origin/main (ff-only)");
    const opKinds = transport.calls
      .filter((c) => c.method === "op.run")
      .map((c) => (c.params as { op: { kind: string } }).op.kind);
    expect(opKinds).toEqual(["stashPush", "stashPop"]);
    expect(transport.calls.some((c) => c.method === "remote.run")).toBe(true);
  });
});
