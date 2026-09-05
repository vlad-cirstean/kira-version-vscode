import { describe, expect, test } from "bun:test";
import type {
  CommitDetail,
  DiffHunk,
  FileDiff,
  Settings,
} from "../../../packages/core/src/index.ts";
import { defaultSettings } from "../../../packages/core/src/index.ts";
import {
  FakeClipboard,
  FakeDialogs,
  FakeEditorIntegration,
  FakeLogger,
  FakeWorkspaceRoots,
} from "../../../packages/core/src/ports/testFakes.ts";
import { GitError } from "../../../packages/git/src/errors.ts";
import type { BlobResult, GitStatus } from "../../../packages/git/src/repoService.ts";
import type { RepoServicePort } from "../../../packages/git/src/rpcHandlers.ts";
import { createRepoHandlers } from "../../../packages/git/src/rpcHandlers.ts";
import type {
  MessageChannelLike,
  RequestKey,
  ServerHandlers,
  StreamChunkOf,
} from "../../../packages/ipc/src/index.ts";
import { createRpcClient, createRpcServer } from "../../../packages/ipc/src/index.ts";

/**
 * W8's own "Done when": every contract key has a handler, and a fake `RepoService` drives a
 * full client-to-handler round trip over an in-memory channel — including a thrown `GitError`
 * arriving client-side as `{ code, kind }` with no stderr attached.
 */

function createInMemoryChannelPair(): readonly [MessageChannelLike, MessageChannelLike] {
  let handlerA: ((message: unknown) => void) | undefined;
  let handlerB: ((message: unknown) => void) | undefined;

  const a: MessageChannelLike = {
    post(message, transfer) {
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
    close() {},
  };
  const b: MessageChannelLike = {
    post(message, transfer) {
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
    close() {},
  };
  return [a, b] as const;
}

class FakeRepoService implements RepoServicePort {
  git: GitStatus;
  openResult: Awaited<ReturnType<RepoServicePort["open"]>> = {
    kind: "notARepository",
    path: "",
  };
  statusResult: ReturnType<RepoServicePort["status"]> = {
    loaded: 0,
    remaining: 0,
    exhausted: false,
  };
  readonly closedRepoIds: string[] = [];
  readonly loadMoreCalls: Array<{
    repoId: string;
    pages: number | undefined;
    signal: AbortSignal | undefined;
  }> = [];
  readonly refreshCalls: string[] = [];
  refreshResult = true;
  streamError: unknown;
  streamChunks: readonly StreamChunkOf<"graph.stream">[] = [];

  detailResult: CommitDetail | undefined;
  readonly detailCalls: Array<{
    repoId: string;
    sha: string;
    parentIndex: number | undefined;
    signal: AbortSignal | undefined;
  }> = [];
  fileDiffResult: FileDiff | undefined;
  readonly fileDiffCalls: Array<{
    repoId: string;
    sha: string;
    path: string;
    originalPath: string | undefined;
    parentIndex: number | undefined;
    signal: AbortSignal | undefined;
  }> = [];
  blobResult: BlobResult = { kind: "missing" };
  worktreeDiffResult: readonly DiffHunk[] | null = null;
  checkoutPaths = new Set<string>();

  constructor(git: GitStatus) {
    this.git = git;
  }

  async detail(
    repoId: string,
    sha: string,
    parentIndex?: number,
    signal?: AbortSignal,
  ): Promise<CommitDetail> {
    this.detailCalls.push({ repoId, sha, parentIndex, signal });
    if (!this.detailResult) throw new Error("FakeRepoService.detailResult not set");
    return this.detailResult;
  }

  async fileDiff(
    repoId: string,
    sha: string,
    path: string,
    originalPath: string | undefined,
    parentIndex?: number,
    signal?: AbortSignal,
  ): Promise<FileDiff> {
    this.fileDiffCalls.push({ repoId, sha, path, originalPath, parentIndex, signal });
    if (!this.fileDiffResult) throw new Error("FakeRepoService.fileDiffResult not set");
    return this.fileDiffResult;
  }

  async blob(_repoId: string, _rev: string, _path: string): Promise<BlobResult> {
    return this.blobResult;
  }

  async worktreeDiff(
    _repoId: string,
    _rev: string,
    _path: string,
    _signal?: AbortSignal,
  ): Promise<readonly DiffHunk[] | null> {
    return this.worktreeDiffResult;
  }

  pathExistsInCheckout(_repoId: string, path: string): boolean {
    return this.checkoutPaths.has(path);
  }

  open(_path: string): ReturnType<RepoServicePort["open"]> {
    return Promise.resolve(this.openResult);
  }

  close(repoId: string): void {
    this.closedRepoIds.push(repoId);
  }

  status(_repoId: string): ReturnType<RepoServicePort["status"]> {
    return this.statusResult;
  }

  async loadMore(repoId: string, pages?: number, signal?: AbortSignal): Promise<void> {
    this.loadMoreCalls.push({ repoId, pages, signal });
  }

  refresh(repoId: string): boolean {
    this.refreshCalls.push(repoId);
    return this.refreshResult;
  }

  async streamGraph(
    _repoId: string,
    opts: Parameters<RepoServicePort["streamGraph"]>[1],
  ): Promise<void> {
    for (const chunk of this.streamChunks) {
      await opts.onChunk(chunk);
    }
    if (this.streamError) throw this.streamError;
  }
}

function settingsFn(overrides: Partial<Settings> = {}): () => Settings {
  const settings = { ...defaultSettings(), ...overrides };
  return () => settings;
}

function setup(service: FakeRepoService) {
  const roots = new FakeWorkspaceRoots([{ path: "/repos/a", label: "a" }]);
  const dialogs = new FakeDialogs();
  const logger = new FakeLogger();
  const editor = new FakeEditorIntegration();
  const clipboard = new FakeClipboard();
  const handlers: ServerHandlers = createRepoHandlers({
    service,
    roots,
    dialogs,
    settings: settingsFn(),
    host: "harness",
    logger,
    editor,
    clipboard,
  });
  const [a, b] = createInMemoryChannelPair();
  const server = createRpcServer(a, handlers);
  const client = createRpcClient(b);
  return { roots, dialogs, logger, editor, clipboard, server, client };
}

describe("createRepoHandlers", () => {
  test("every contract request and stream key has a handler", () => {
    const service = new FakeRepoService({ kind: "ok", path: "/usr/bin/git", version: "2.40.0" });
    const roots = new FakeWorkspaceRoots();
    const dialogs = new FakeDialogs();
    const handlers = createRepoHandlers({
      service,
      roots,
      dialogs,
      settings: settingsFn(),
      host: "harness",
      logger: new FakeLogger(),
      editor: new FakeEditorIntegration(),
      clipboard: new FakeClipboard(),
    });
    const expectedRequests: RequestKey[] = [
      "app.init",
      "repo.list",
      "repo.pick",
      "repo.open",
      "repo.close",
      "graph.status",
      "graph.loadMore",
      "graph.refresh",
      "commit.detail",
      "commit.fileDiff",
      "editor.openDiff",
      "editor.goToFile",
      "clipboard.write",
    ];
    for (const key of expectedRequests) expect(typeof handlers.requests[key]).toBe("function");
    expect(typeof handlers.streams["graph.stream"]).toBe("function");
  });

  test("app.init reports host, contract version, settings and git status", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "/usr/bin/git", version: "2.40.0" });
    const { client, server } = setup(service);
    try {
      const result = await client.request("app.init", {});
      expect(result.host).toBe("harness");
      expect(result.contractVersion).toBe(4);
      expect(result.settings).toEqual(defaultSettings());
      expect(result.git).toEqual({ kind: "ok", path: "/usr/bin/git", version: "2.40.0" });
      expect(result.capabilities).toEqual({
        openInEditor: true,
        goToFile: true,
        clipboard: true,
      });
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("app.init's tooOld git status gains the settingId the UI needs to render", async () => {
    const service = new FakeRepoService({
      kind: "tooOld",
      path: "/usr/bin/git",
      detected: "2.10.0",
      required: "2.38.0",
    });
    const { client, server } = setup(service);
    try {
      const result = await client.request("app.init", {});
      expect(result.git).toEqual({
        kind: "tooOld",
        path: "/usr/bin/git",
        detected: "2.10.0",
        required: "2.38.0",
        settingId: "kiraVersion.git.path",
      });
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("repo.list forwards WorkspaceRoots' candidates with no active repo before any open", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    const { client, server, roots } = setup(service);
    try {
      const result = await client.request("repo.list", {});
      expect(result.candidates).toEqual(await roots.list());
      expect(result.activeRepoId).toBeNull();
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("repo.pick calls Dialogs.pickFolder and never opens the result itself", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    const { client, server, dialogs } = setup(service);
    dialogs.queuedResults = ["/repos/picked"];
    try {
      const result = await client.request("repo.pick", {});
      expect(result).toEqual({ path: "/repos/picked" });
      expect(service.closedRepoIds).toEqual([]); // never touched RepoService
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("repo.open translates an ok outcome into a RepoSummary and becomes the active repo", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    service.openResult = {
      kind: "ok",
      repoId: "/repos/a",
      identity: {
        root: "/repos/a",
        gitDir: "/repos/a/.git",
        commonDir: "/repos/a/.git",
        isBare: false,
        isLinkedWorktree: false,
        head: { kind: "branch", name: "main" },
      },
    };
    const { client, server } = setup(service);
    try {
      const opened = await client.request("repo.open", { path: "/repos/a" });
      expect(opened).toEqual({
        kind: "ok",
        repo: {
          repoId: "/repos/a",
          root: "/repos/a",
          gitDir: "/repos/a/.git",
          commonDir: "/repos/a/.git",
          isBare: false,
          isLinkedWorktree: false,
          head: { kind: "branch", name: "main" },
        },
      });

      const list = await client.request("repo.list", {});
      expect(list.activeRepoId).toBe("/repos/a");
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("repo.open translates notARepository and gitUnavailable outcomes verbatim", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    const { client, server } = setup(service);
    try {
      service.openResult = { kind: "notARepository", path: "/not/a/repo" };
      expect(await client.request("repo.open", { path: "/not/a/repo" })).toEqual({
        kind: "notARepository",
        path: "/not/a/repo",
      });

      service.openResult = {
        kind: "gitUnavailable",
        git: { kind: "notFound", probed: ["/usr/bin/git"] },
      };
      expect(await client.request("repo.open", { path: "/anything" })).toEqual({
        kind: "gitUnavailable",
        git: { kind: "notFound", probed: ["/usr/bin/git"] },
      });
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("repo.close closes the RepoService session and clears the active repo", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    service.openResult = {
      kind: "ok",
      repoId: "/repos/a",
      identity: {
        root: "/repos/a",
        gitDir: "/repos/a/.git",
        commonDir: "/repos/a/.git",
        isBare: false,
        isLinkedWorktree: false,
        head: { kind: "branch", name: "main" },
      },
    };
    const { client, server } = setup(service);
    try {
      await client.request("repo.open", { path: "/repos/a" });
      expect(await client.request("repo.close", { repoId: "/repos/a" })).toEqual({});
      expect(service.closedRepoIds).toEqual(["/repos/a"]);
      expect((await client.request("repo.list", {})).activeRepoId).toBeNull();
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("graph.status passes RepoService's status through unchanged", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    service.statusResult = { loaded: 12, remaining: 3, exhausted: false };
    const { client, server } = setup(service);
    try {
      expect(await client.request("graph.status", { repoId: "r1" })).toEqual({
        loaded: 12,
        remaining: 3,
        exhausted: false,
      });
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("graph.loadMore reports started:false without calling loadMore when already exhausted", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    service.statusResult = { loaded: 10, remaining: 0, exhausted: true };
    const { client, server } = setup(service);
    try {
      expect(await client.request("graph.loadMore", { repoId: "r1" })).toEqual({
        started: false,
      });
      expect(service.loadMoreCalls).toEqual([]);
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("graph.loadMore calls RepoService.loadMore and reports started:true when not exhausted", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    service.statusResult = { loaded: 3, remaining: 7, exhausted: false };
    const { client, server } = setup(service);
    try {
      expect(await client.request("graph.loadMore", { repoId: "r1", pages: 2 })).toEqual({
        started: true,
      });
      expect(service.loadMoreCalls).toHaveLength(1);
      expect(service.loadMoreCalls[0]?.repoId).toBe("r1");
      expect(service.loadMoreCalls[0]?.pages).toBe(2);
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("graph.loadMore forwards the request's own AbortSignal to RepoService.loadMore", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    service.statusResult = { loaded: 3, remaining: 7, exhausted: false };
    const { client, server } = setup(service);
    try {
      await client.request("graph.loadMore", { repoId: "r1" });
      expect(service.loadMoreCalls[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(service.loadMoreCalls[0]?.signal?.aborted).toBe(false);
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("graph.refresh calls RepoService.refresh and reports its restarted result", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    const { client, server } = setup(service);
    try {
      service.refreshResult = true;
      expect(await client.request("graph.refresh", { repoId: "r1" })).toEqual({
        restarted: true,
      });
      expect(service.refreshCalls).toEqual(["r1"]);

      service.refreshResult = false;
      expect(await client.request("graph.refresh", { repoId: "r2" })).toEqual({
        restarted: false,
      });
      expect(service.refreshCalls).toEqual(["r1", "r2"]);
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("graph.stream forwards chunks from RepoService.streamGraph verbatim", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    service.streamChunks = [
      {
        repoId: "r1",
        seq: 0,
        from: 0,
        to: 2,
        source: "git",
        remaining: 0,
        exhausted: true,
        commits: {
          from: 0,
          to: 2,
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
        },
      },
    ];
    const { client, server } = setup(service);
    try {
      const received: StreamChunkOf<"graph.stream">[] = [];
      await client.stream("graph.stream", { repoId: "r1" }, (chunk) => {
        received.push(chunk);
      });
      expect(received).toHaveLength(1);
      expect(received[0]?.repoId).toBe("r1");
      expect(received[0]?.exhausted).toBe(true);
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("a thrown GitError crosses the wire as { code, kind } with no stderr attached", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    service.streamError = new GitError("LockHeld", ["log"], 128, "fatal: Unable to create lock");
    const { client, server } = setup(service);
    try {
      await expect(client.stream("graph.stream", { repoId: "r1" }, () => {})).rejects.toMatchObject(
        {
          name: "RpcError",
          code: "GitError",
          kind: "LockHeld",
        },
      );
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  // ---------------------------------------------------------------------------------------
  // P5 W6: commit.detail, commit.fileDiff, editor.openDiff, editor.goToFile, clipboard.write.
  // ---------------------------------------------------------------------------------------

  function fileChange(overrides: Partial<FileDiff["change"]> = {}): FileDiff["change"] {
    return {
      kind: "modified",
      path: "src/a.ts",
      originalPath: undefined,
      similarity: undefined,
      additions: 1,
      deletions: 1,
      isBinary: false,
      ...overrides,
    };
  }

  function detailFixture(overrides: Partial<CommitDetail> = {}): CommitDetail {
    return {
      sha: "a".repeat(40),
      parents: ["b".repeat(40)],
      author: { name: "T", email: "t@t.com", timestamp: 0 },
      committer: { name: "T", email: "t@t.com", timestamp: 0 },
      subject: "a commit",
      body: "",
      trailers: [],
      signature: { status: "N", signer: "" },
      decoration: [],
      parentIndex: 0,
      files: [fileChange()],
      ...overrides,
    };
  }

  test("app.init reports the editor port's own capabilities, not a hard-coded true", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    const roots = new FakeWorkspaceRoots();
    const dialogs = new FakeDialogs();
    const editor = new FakeEditorIntegration({ openInEditor: false, goToFile: false });
    const handlers = createRepoHandlers({
      service,
      roots,
      dialogs,
      settings: settingsFn(),
      host: "harness",
      logger: new FakeLogger(),
      editor,
      clipboard: new FakeClipboard(),
    });
    const [a, b] = createInMemoryChannelPair();
    const server = createRpcServer(a, handlers);
    const client = createRpcClient(b);
    try {
      const result = await client.request("app.init", {});
      expect(result.capabilities).toEqual({
        openInEditor: false,
        goToFile: false,
        clipboard: true,
      });
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("commit.detail forwards to RepoService.detail with the request's AbortSignal", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    service.detailResult = detailFixture();
    const { client, server } = setup(service);
    try {
      const result = await client.request("commit.detail", { repoId: "r1", sha: "abc" });
      expect(result).toEqual(service.detailResult);
      expect(service.detailCalls).toHaveLength(1);
      expect(service.detailCalls[0]?.repoId).toBe("r1");
      expect(service.detailCalls[0]?.sha).toBe("abc");
      expect(service.detailCalls[0]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("commit.fileDiff forwards to RepoService.fileDiff, including originalPath and parentIndex", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    service.fileDiffResult = {
      sha: "abc",
      parentIndex: 1,
      baseSha: "def",
      change: fileChange({ kind: "renamed", originalPath: "old.ts" }),
      body: { kind: "text", hunks: [] },
    };
    const { client, server } = setup(service);
    try {
      const result = await client.request("commit.fileDiff", {
        repoId: "r1",
        sha: "abc",
        path: "src/a.ts",
        originalPath: "old.ts",
        parentIndex: 1,
      });
      expect(result).toEqual(service.fileDiffResult);
      expect(service.fileDiffCalls).toEqual([
        {
          repoId: "r1",
          sha: "abc",
          path: "src/a.ts",
          originalPath: "old.ts",
          parentIndex: 1,
          signal: service.fileDiffCalls[0]?.signal,
        },
      ]);
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("editor.openDiff resolves both sides through the port, labelling a rename's left side with originalPath", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    service.fileDiffResult = {
      sha: "abc1234",
      parentIndex: 0,
      baseSha: "def5678",
      change: fileChange({ kind: "renamed", path: "new.ts", originalPath: "old.ts" }),
      body: { kind: "text", hunks: [] },
    };
    const { client, server, editor } = setup(service);
    try {
      await client.request("editor.openDiff", {
        repoId: "r1",
        sha: "abc1234",
        path: "new.ts",
        originalPath: "old.ts",
      });
      expect(editor.actions).toHaveLength(1);
      const action = editor.actions[0];
      expect(action?.kind).toBe("openDiff");
      expect(action?.left).toEqual({
        kind: "virtual",
        key: expect.stringContaining("old.ts") as unknown as string,
        label: "old.ts",
      });
      expect(action?.right).toEqual({
        kind: "virtual",
        key: expect.stringContaining("new.ts") as unknown as string,
        label: "new.ts",
      });
      expect(action?.title).toBe("new.ts (abc1234^ ↔ abc1234)");
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("editor.openDiff uses the empty side for an added file (no baseSha) and a deleted file", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    service.fileDiffResult = {
      sha: "abc1234",
      parentIndex: 0,
      baseSha: null,
      change: fileChange({ kind: "added" }),
      body: { kind: "text", hunks: [] },
    };
    const { client, server, editor } = setup(service);
    try {
      await client.request("editor.openDiff", { repoId: "r1", sha: "abc1234", path: "src/a.ts" });
      expect(editor.actions[0]?.left).toEqual({ kind: "empty", label: "a.ts" });

      service.fileDiffResult = {
        sha: "abc1234",
        parentIndex: 0,
        baseSha: "def5678",
        change: fileChange({ kind: "deleted" }),
        body: { kind: "text", hunks: [] },
      };
      await client.request("editor.openDiff", { repoId: "r1", sha: "abc1234", path: "src/a.ts" });
      expect(editor.actions[1]?.right).toEqual({ kind: "empty", label: "a.ts" });
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("editor.goToFile: a path in the checkout re-maps the line across worktreeDiff and reveals a file", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    service.checkoutPaths.add("src/a.ts");
    service.worktreeDiffResult = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 3,
        heading: "",
        lines: [
          { kind: "context", text: "x", oldLine: 1, newLine: 1, noNewlineAtEof: false },
          { kind: "add", text: "y", oldLine: undefined, newLine: 2, noNewlineAtEof: false },
          { kind: "add", text: "z", oldLine: undefined, newLine: 3, noNewlineAtEof: false },
        ],
      },
    ];
    const { client, server, editor } = setup(service);
    try {
      const result = await client.request("editor.goToFile", {
        repoId: "/repos/a",
        rev: "abc",
        path: "src/a.ts",
        line: 1,
      });
      // Two lines inserted after line 1 on the "old" side push a later old-line-1 reference
      // forward — the drift re-map, not the unmapped historical line.
      expect(result).toEqual({ kind: "liveFile", path: "src/a.ts", line: 1 });
      expect(editor.actions).toEqual([
        { kind: "reveal", ref: { kind: "file", path: "/repos/a/src/a.ts" }, line: 1 },
      ]);
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("editor.goToFile: worktreeDiff returning null falls back to the unmapped line unchanged", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    service.checkoutPaths.add("src/a.ts");
    service.worktreeDiffResult = null;
    const { client, server } = setup(service);
    try {
      const result = await client.request("editor.goToFile", {
        repoId: "/repos/a",
        rev: "abc",
        path: "src/a.ts",
        line: 42,
      });
      expect(result).toEqual({ kind: "liveFile", path: "src/a.ts", line: 42 });
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("editor.goToFile: a path missing from the checkout falls through to service.blob's three outcomes", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    const { client, server, editor } = setup(service);
    try {
      service.blobResult = { kind: "missing" };
      expect(
        await client.request("editor.goToFile", {
          repoId: "/repos/a",
          rev: "abc",
          path: "gone.ts",
          line: 1,
        }),
      ).toEqual({ kind: "unavailable", reason: "notInRevision" });

      service.blobResult = { kind: "binary" };
      expect(
        await client.request("editor.goToFile", {
          repoId: "/repos/a",
          rev: "abc",
          path: "gone.ts",
          line: 1,
        }),
      ).toEqual({ kind: "unavailable", reason: "binary" });

      service.blobResult = { kind: "tooLarge", bytes: 2_000_000, limitBytes: 1_000_000 };
      expect(
        await client.request("editor.goToFile", {
          repoId: "/repos/a",
          rev: "abc",
          path: "gone.ts",
          line: 1,
        }),
      ).toEqual({ kind: "unavailable", reason: "tooLarge" });

      service.blobResult = { kind: "found", content: "hello\n" };
      const result = await client.request("editor.goToFile", {
        repoId: "/repos/a",
        rev: "abc",
        path: "gone.ts",
        line: 3,
      });
      expect(result).toEqual({ kind: "virtualBlob", path: "gone.ts", rev: "abc", line: 3 });
      const lastAction = editor.actions.at(-1);
      expect(lastAction?.kind).toBe("reveal");
      expect(lastAction?.ref).toEqual({
        kind: "virtual",
        key: expect.stringContaining("gone.ts") as unknown as string,
        label: "gone.ts",
      });
      expect(lastAction?.line).toBe(3);
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("clipboard.write calls Clipboard.writeText and logs only the label, never the text", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    const { client, server, clipboard, logger } = setup(service);
    try {
      const result = await client.request("clipboard.write", {
        text: "a very secret commit message",
        label: "full message",
      });
      expect(result).toEqual({});
      expect(clipboard.writes).toEqual(["a very secret commit message"]);
      const loggedText = logger.entries.some((entry) =>
        JSON.stringify(entry).includes("a very secret commit message"),
      );
      expect(loggedText).toBe(false);
      const loggedLabel = logger.entries.some((entry) =>
        JSON.stringify(entry.data ?? {}).includes("full message"),
      );
      expect(loggedLabel).toBe(true);
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  test("clipboard.write propagates a rejected write rather than swallowing it into a boolean", async () => {
    const service = new FakeRepoService({ kind: "ok", path: "git", version: "2.40.0" });
    const { client, server, clipboard } = setup(service);
    clipboard.rejectWith = new Error("clipboard unavailable");
    try {
      await expect(client.request("clipboard.write", { text: "x", label: "y" })).rejects.toThrow();
    } finally {
      client.dispose();
      server.dispose();
    }
  });
});
