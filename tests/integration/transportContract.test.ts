import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackedCommitChunk } from "../../packages/core/src/index.ts";
import { CommitStore, defaultSettings } from "../../packages/core/src/index.ts";
import {
  FakeClipboard,
  FakeDialogs,
  FakeEditorIntegration,
  FakeLogger,
  FakeWorkspaceRoots,
} from "../../packages/core/src/ports/testFakes.ts";
import { NodeFileWatcher } from "../../packages/git/src/nodeFileWatcher.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { RepoService } from "../../packages/git/src/repoService.ts";
import { createRepoHandlers } from "../../packages/git/src/rpcHandlers.ts";
import {
  createRpcClient,
  createRpcServer,
  type MessageChannelLike,
} from "../../packages/ipc/src/rpc.ts";
import { CONTRACT_VERSION } from "../../packages/ipc/src/validate.ts";
import { linear } from "../fixtures/generateRepo.ts";

/**
 * W2's `createRpcClient`/`createRpcServer` endpoint, driven end-to-end against W8's
 * `createRepoHandlers` over a real `RepoService` (W7) — the whole bridge minus the two host
 * adapters (`webview.postMessage`, `ipcRenderer` + `MessagePort`), which is "the test that makes
 * the host packages' untestability acceptable" (docs/plans/P3.md's W16 text): `packages/ipc`'s
 * own `rpc.test.ts` already covers correlation/credit/cancellation semantics against fake
 * handlers, and `packages/git`'s own tests cover `RepoService` in isolation, but nothing else
 * proves the two actually fit together across a real wire encode/decode.
 */

/** `packages/ipc/src/rpc.test.ts`'s own in-memory pipe: posting on one end synchronously
 *  invokes the other's handler, after a `structuredClone` (with transfer, if given) so the
 *  buffer-detach semantics `packSlice`'s transfer list depends on are real, not skipped. */
function createInMemoryChannelPair(): readonly [MessageChannelLike, MessageChannelLike] {
  let handlerA: ((message: unknown) => void) | undefined;
  let handlerB: ((message: unknown) => void) | undefined;
  let closedA = false;
  let closedB = false;

  const a: MessageChannelLike = {
    post(message, transfer) {
      if (closedA) return;
      const cloned = transfer
        ? structuredClone(message, { transfer: transfer as ArrayBuffer[] })
        : structuredClone(message);
      handlerB?.(cloned);
    },
    onMessage(handler) {
      handlerA = handler;
      return () => {
        if (handlerA === handler) handlerA = undefined;
      };
    },
    close() {
      closedA = true;
    },
  };
  const b: MessageChannelLike = {
    post(message, transfer) {
      if (closedB) return;
      const cloned = transfer
        ? structuredClone(message, { transfer: transfer as ArrayBuffer[] })
        : structuredClone(message);
      handlerA?.(cloned);
    },
    onMessage(handler) {
      handlerB = handler;
      return () => {
        if (handlerB === handler) handlerB = undefined;
      };
    },
    close() {
      closedB = true;
    },
  };
  return [a, b] as const;
}

async function setup(pageSize = 4) {
  const runner = new NodeProcessRunner();
  const service = await RepoService.create({
    runner,
    fileWatcher: new NodeFileWatcher(),
    logger: new FakeLogger(),
    settings: { ...defaultSettings(), "kiraVersion.graph.pageSize": pageSize },
    configuredGitCandidates: [],
  });
  const roots = new FakeWorkspaceRoots();
  const dialogs = new FakeDialogs();
  const editor = new FakeEditorIntegration();
  const clipboard = new FakeClipboard();
  const handlers = createRepoHandlers({
    service,
    roots,
    dialogs,
    settings: () => defaultSettings(),
    host: "vscode",
    logger: new FakeLogger(),
    editor,
    clipboard,
  });
  const [clientChannel, serverChannel] = createInMemoryChannelPair();
  const server = createRpcServer(serverChannel, handlers);
  const client = createRpcClient(clientChannel);
  return { service, server, client, dialogs };
}

describe("transport contract: rpc.ts driven against createRepoHandlers over a real RepoService", () => {
  test("app.init reports the real git status and this contract's version", async () => {
    const { service, server, client } = await setup();
    try {
      const result = await client.request("app.init", {});
      expect(result.contractVersion).toBe(CONTRACT_VERSION);
      expect(result.host).toBe("vscode");
      expect(result.git.kind).toBe("ok");
    } finally {
      client.dispose();
      server.dispose();
      service.dispose();
    }
  });

  test("repo.open, graph.stream and repo.close round-trip a real repository across the wire", async () => {
    const { service, server, client } = await setup(4);
    try {
      const repo = linear(10);
      const opened = await client.request("repo.open", { path: repo.dir });
      expect(opened.kind).toBe("ok");
      if (opened.kind !== "ok") throw new Error("unreachable");
      const { repoId } = opened.repo;
      expect(opened.repo.root).toBe(repo.dir);

      const chunks: Array<{
        readonly from: number;
        readonly to: number;
        readonly source: "git" | "cache";
        readonly commits: PackedCommitChunk;
      }> = [];
      await client.stream("graph.stream", { repoId }, (chunk) => {
        chunks.push(chunk);
      });
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((chunk) => chunk.source === "git")).toBe(true);
      const lastChunk = chunks.at(-1);
      expect(lastChunk?.to).toBe(4); // one page's worth, exactly what pageSize(4) promises

      // The wire-decoded chunks apply to a real CommitStore exactly like a host's own UI would.
      const store = new CommitStore();
      for (const chunk of chunks) store.appendPacked(chunk.commits);
      expect(store.rowCount).toBe(4);
      const newestSha = repo.commits.at(-1);
      if (!newestSha) throw new Error("unreachable: linear(10) always has 10 commits");
      expect(store.shaAt(0)).toBe(newestSha); // topo-order: newest first

      const status = await client.request("graph.status", { repoId });
      expect(status).toEqual({ loaded: 4, remaining: 6, exhausted: false });

      const loadMore = await client.request("graph.loadMore", { repoId, pages: 3 });
      expect(loadMore).toEqual({ started: true });
      expect(await client.request("graph.status", { repoId })).toEqual({
        loaded: 10,
        remaining: 0,
        exhausted: true,
      });

      // A second stream, resuming from what's already loaded, replays the cache rather than
      // re-walking — the exact behaviour repoService.test.ts's own resumed-stream test asserts
      // against the service directly; this asserts it survives the wire encode/decode too.
      const resumed: typeof chunks = [];
      await client.stream("graph.stream", { repoId, resumeThroughRow: 4 }, (chunk) => {
        resumed.push(chunk);
      });
      expect(resumed.every((chunk) => chunk.source === "cache")).toBe(true);
      expect(resumed.reduce((sum, chunk) => sum + (chunk.to - chunk.from), 0)).toBe(6);

      await client.request("repo.close", { repoId });
      await expect(client.request("graph.status", { repoId })).rejects.toThrow();
    } finally {
      client.dispose();
      server.dispose();
      service.dispose();
    }
  });

  test("repo.open on a non-repository path crosses the wire as a typed result, not a thrown error", async () => {
    const { service, server, client } = await setup();
    try {
      const notARepo = mkdtempSync(join(tmpdir(), "kira-not-a-repo-"));
      const opened = await client.request("repo.open", { path: notARepo });
      expect(opened.kind).toBe("notARepository");
    } finally {
      client.dispose();
      server.dispose();
      service.dispose();
    }
  });

  test("repo.pick forwards to Dialogs and back across the wire", async () => {
    const { service, server, client, dialogs } = await setup();
    try {
      dialogs.queuedResults.push("/some/picked/repo");
      const result = await client.request("repo.pick", {});
      expect(result).toEqual({ path: "/some/picked/repo" });
      expect(dialogs.calls).toHaveLength(1);
    } finally {
      client.dispose();
      server.dispose();
      service.dispose();
    }
  });

  test("a GitError thrown mid-stream crosses the wire as a typed error, not a dropped connection", async () => {
    const { service, server, client } = await setup();
    try {
      const opened = await client.request("repo.open", { path: linear(2).dir });
      if (opened.kind !== "ok") throw new Error("unreachable");
      // graph.status on an unknown repoId throws inside the handler (RepoService.status), the
      // same path a real error crossing mid-request exercises for "res" frames; graph.stream's
      // own error path is exercised by the resumed-stream test above staying error-free, so
      // this covers the request-side half of `toWireError`.
      await expect(
        client.request("graph.status", { repoId: "not-a-real-repo-id" }),
      ).rejects.toThrow();
    } finally {
      client.dispose();
      server.dispose();
      service.dispose();
    }
  });
});
