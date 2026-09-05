/**
 * The binding from W1's contract keys to W7's `RepoService` and W5's ports (§3.1, W8). One
 * function, `createRepoHandlers`, that both hosts (W10, W11) and the harness (W14) call to get
 * a `ServerHandlers` ready for `createRpcServer`. This is the first file in `packages/git` that
 * imports `@kira-version/ipc` — deferred by P1/P2 only because there was no contract worth
 * binding to until now (§3.1 already permits the dependency).
 *
 * No policy beyond mapping: `repo.open` calls `service.open` and translates the outcome;
 * `repo.pick` calls `dialogs.pickFolder` and never opens the result itself (the UI decides);
 * `graph.stream` forwards chunks and lets a thrown `GitError` cross the wire via `rpc.ts`'s own
 * `toWireError` (already turns `{name, kind, message}` into `{code, kind, message}` with no
 * stderr attached — nothing here needs to catch it).
 *
 * P5 W6 adds five more handlers, following the same rule. `commit.detail`/`commit.fileDiff`
 * forward straight to `RepoService` — both types are already wire-shaped (`wireConformance.
 * test.ts` is what keeps them that way), so no mapping function is needed. `editor.openDiff`,
 * `editor.goToFile` and `clipboard.write` are the two new ports' only callers.
 */
import { basename, join } from "node:path";
import type {
  Clipboard,
  Dialogs,
  EditorIntegration,
  HeadState,
  Logger,
  RepoIdentity,
  Settings,
  VirtualDocumentSource,
  WorkspaceRoots,
} from "@kira-version/core";
import { mapLineAcrossDiff } from "@kira-version/core";
import type {
  GoToFileOutcome,
  HostKind,
  RepoOpenResult,
  RepoSummary,
  RequestHandler,
  ServerHandlers,
  SettingsSnapshot,
  StreamHandler,
  GitStatus as WireGitStatus,
} from "@kira-version/ipc";
import { CONTRACT_VERSION } from "@kira-version/ipc";
import type { GitStatus, GraphChunkPayload, RepoOpenOutcome, RepoService } from "./repoService.ts";

/** The slice of `RepoService` this file actually calls — structural, not the concrete class,
 *  so W8's own tests (and W16's) can drive a fake through the real `createRpcServer` without
 *  standing up a real repo (`RepoService`'s `#`-private fields make the class itself nominal). */
export type RepoServicePort = Pick<
  RepoService,
  | "git"
  | "open"
  | "close"
  | "status"
  | "loadMore"
  | "streamGraph"
  | "refresh"
  | "detail"
  | "fileDiff"
  | "blob"
  | "worktreeDiff"
  | "pathExistsInCheckout"
>;

export interface RepoHandlersDeps {
  readonly service: RepoServicePort;
  readonly roots: WorkspaceRoots;
  readonly dialogs: Dialogs;
  readonly settings: () => Settings;
  readonly host: HostKind;
  readonly logger: Logger;
  readonly editor: EditorIntegration;
  readonly clipboard: Clipboard;
}

/**
 * The `VirtualDocumentSource` W5's `EditorIntegration.registerVirtualDocuments` needs, over
 * `service.blob`: the key encodes `<repoId>\0<rev>\0<path>` and resolving it is one `cat-file`
 * round trip on the session that is already open (W6). A key whose repo has since been closed
 * (or whose `rev:path` no longer resolves) answers `undefined` — VS Code shows an empty document
 * rather than the extension throwing, which is the honest outcome once the content genuinely is
 * no longer reachable.
 *
 * A free function rather than a method on `createRepoHandlers`'s return value: it is registered
 * once, at activation, by the host (`extension.ts`) — never per webview resolve, since VS Code
 * allows only one content provider per scheme and `resolveWebviewView` runs on every reveal.
 */
export function createVirtualDocumentSource(service: RepoServicePort): VirtualDocumentSource {
  return {
    async provide(key: string): Promise<string | undefined> {
      const parsed = parseVirtualKey(key);
      if (!parsed) return undefined;
      try {
        const blob = await service.blob(parsed.repoId, parsed.rev, parsed.path);
        return blob.kind === "found" ? blob.content : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** NUL: never legal inside a filesystem path, a git ref, or a git blob path, so — unlike any
 *  printable separator — it cannot collide with a real `repoId`/`rev`/`path` value. Matches
 *  `docs/plans/P5.md`'s own literal key format. Built via `fromCharCode` rather than a
 *  backslash escape in this file's own source, purely so the character stays visibly
 *  intentional here rather than an invisible byte a diff or an editor could mangle. */
const VIRTUAL_KEY_SEPARATOR = String.fromCharCode(0);

function virtualKey(repoId: string, rev: string, path: string): string {
  return [repoId, rev, path].join(VIRTUAL_KEY_SEPARATOR);
}

function parseVirtualKey(
  key: string,
): { readonly repoId: string; readonly rev: string; readonly path: string } | undefined {
  const parts = key.split(VIRTUAL_KEY_SEPARATOR);
  if (parts.length !== 3) return undefined;
  const [repoId, rev, path] = parts;
  if (repoId === undefined || rev === undefined || path === undefined) return undefined;
  return { repoId, rev, path };
}

/** The setting the UI should offer to edit when `git.kind === "tooOld"` — W1's own literal. */
const GIT_PATH_SETTING_ID = "kiraVersion.git.path";

function toSettingsSnapshot(settings: Settings): SettingsSnapshot {
  return {
    "kiraVersion.git.path": settings["kiraVersion.git.path"],
    "kiraVersion.graph.pageSize": settings["kiraVersion.graph.pageSize"],
    "kiraVersion.graph.scope": settings["kiraVersion.graph.scope"],
    "kiraVersion.log.level": settings["kiraVersion.log.level"],
  };
}

function toWireGitStatus(status: GitStatus): WireGitStatus {
  if (status.kind === "tooOld") {
    return { ...status, settingId: GIT_PATH_SETTING_ID };
  }
  return status;
}

function toHeadState(head: RepoIdentity["head"]): HeadState {
  return head;
}

function toRepoSummary(repoId: string, identity: RepoIdentity): RepoSummary {
  return {
    repoId,
    root: identity.root,
    gitDir: identity.gitDir,
    commonDir: identity.commonDir,
    isBare: identity.isBare,
    isLinkedWorktree: identity.isLinkedWorktree,
    head: toHeadState(identity.head),
  };
}

function toRepoOpenResult(outcome: RepoOpenOutcome): RepoOpenResult {
  switch (outcome.kind) {
    case "ok":
      return { kind: "ok", repo: toRepoSummary(outcome.repoId, outcome.identity) };
    case "notARepository":
      return { kind: "notARepository", path: outcome.path };
    case "gitUnavailable":
      return { kind: "gitUnavailable", git: toWireGitStatus(outcome.git) };
  }
}

export function createRepoHandlers(deps: RepoHandlersDeps): ServerHandlers {
  const logger = deps.logger.child("rpcHandlers");
  let activeRepoId: string | null = null;

  // biome-ignore lint/suspicious/noExplicitAny: a uniform wrapper over every handler shape.
  function logged<H extends (...args: any[]) => Promise<any>>(method: string, handler: H): H {
    return (async (...args: Parameters<H>) => {
      logger.log("debug", method);
      try {
        return await handler(...args);
      } catch (error) {
        logger.log("error", `${method} failed`, error);
        throw error;
      }
    }) as H;
  }

  const appInitImpl: RequestHandler<"app.init"> = async () => ({
    host: deps.host,
    contractVersion: CONTRACT_VERSION,
    settings: toSettingsSnapshot(deps.settings()),
    git: toWireGitStatus(deps.service.git),
    capabilities: {
      openInEditor: deps.editor.capabilities.openInEditor,
      goToFile: deps.editor.capabilities.goToFile,
      clipboard: true,
    },
  });

  const repoListImpl: RequestHandler<"repo.list"> = async () => ({
    candidates: await deps.roots.list(),
    activeRepoId,
  });

  const repoPickImpl: RequestHandler<"repo.pick"> = async () => ({
    path: await deps.dialogs.pickFolder({ title: "Open Repository" }),
  });

  const repoOpenImpl: RequestHandler<"repo.open"> = async ({ path }) => {
    const outcome = await deps.service.open(path);
    if (outcome.kind === "ok") activeRepoId = outcome.repoId;
    return toRepoOpenResult(outcome);
  };

  const repoCloseImpl: RequestHandler<"repo.close"> = async ({ repoId }) => {
    deps.service.close(repoId);
    if (activeRepoId === repoId) activeRepoId = null;
    return {};
  };

  const graphStatusImpl: RequestHandler<"graph.status"> = async ({ repoId }) =>
    deps.service.status(repoId);

  const graphLoadMoreImpl: RequestHandler<"graph.loadMore"> = async ({ repoId, pages }, ctx) => {
    if (deps.service.status(repoId).exhausted) return { started: false };
    await deps.service.loadMore(repoId, pages, ctx.signal);
    return { started: true };
  };

  const graphRefreshImpl: RequestHandler<"graph.refresh"> = async ({ repoId }) => ({
    restarted: deps.service.refresh(repoId),
  });

  const graphStreamImpl: StreamHandler<"graph.stream"> = async (
    { repoId, resumeThroughRow },
    ctx,
  ) => {
    await deps.service.streamGraph(repoId, {
      ...(resumeThroughRow !== undefined ? { resumeThroughRow } : {}),
      onChunk: (chunk: GraphChunkPayload) => ctx.emit(chunk),
      signal: ctx.signal,
    });
  };

  const commitDetailImpl: RequestHandler<"commit.detail"> = async (
    { repoId, sha, parentIndex },
    ctx,
  ) => deps.service.detail(repoId, sha, parentIndex, ctx.signal);

  const commitFileDiffImpl: RequestHandler<"commit.fileDiff"> = async (
    { repoId, sha, path, originalPath, parentIndex },
    ctx,
  ) => deps.service.fileDiff(repoId, sha, path, originalPath, parentIndex, ctx.signal);

  const editorOpenDiffImpl: RequestHandler<"editor.openDiff"> = async (
    { repoId, sha, path, originalPath, parentIndex },
    ctx,
  ) => {
    const { baseSha, change } = await deps.service.fileDiff(
      repoId,
      sha,
      path,
      originalPath,
      parentIndex,
      ctx.signal,
    );
    const leftPath = change.originalPath ?? path;
    const left =
      baseSha === null
        ? { kind: "empty" as const, label: basename(leftPath) }
        : {
            kind: "virtual" as const,
            key: virtualKey(repoId, baseSha, leftPath),
            label: basename(leftPath),
          };
    const right =
      change.kind === "deleted"
        ? { kind: "empty" as const, label: basename(path) }
        : { kind: "virtual" as const, key: virtualKey(repoId, sha, path), label: basename(path) };
    const shortSha = sha.slice(0, 7);
    await deps.editor.openDiff({
      left,
      right,
      title: `${basename(path)} (${shortSha}^ ↔ ${shortSha})`,
    });
    return {};
  };

  /** D14a's decision procedure, in this order and no other (`docs/plans/P5.md`'s "editor.goToFile"
   *  section): step 1a — a path present in the checkout re-maps the requested line across the
   *  commit→worktree drift before revealing the live file; everything else that could go wrong
   *  there (identical file, an untracked path, a patch over the cap, a failed spawn) arrives as
   *  `null` from `worktreeDiff` and falls back to the unmapped `line`, never an error. Step 2 —
   *  the path is not on disk at all, so the blob at `<rev>:<path>` is what can be shown instead. */
  const editorGoToFileImpl: RequestHandler<"editor.goToFile"> = async (
    { repoId, rev, path, line },
    ctx,
  ): Promise<GoToFileOutcome> => {
    if (deps.service.pathExistsInCheckout(repoId, path)) {
      const hunks = await deps.service.worktreeDiff(repoId, rev, path, ctx.signal);
      const finalLine = hunks === null ? line : mapLineAcrossDiff(hunks, line, "old");
      await deps.editor.reveal({ kind: "file", path: join(repoId, path) }, finalLine);
      return { kind: "liveFile", path, line: finalLine };
    }

    const blob = await deps.service.blob(repoId, rev, path);
    switch (blob.kind) {
      case "missing":
        return { kind: "unavailable", reason: "notInRevision" };
      case "binary":
        return { kind: "unavailable", reason: "binary" };
      case "tooLarge":
        return { kind: "unavailable", reason: "tooLarge" };
      case "found": {
        const key = virtualKey(repoId, rev, path);
        await deps.editor.reveal({ kind: "virtual", key, label: basename(path) }, line);
        return { kind: "virtualBlob", path, rev, line };
      }
    }
  };

  const clipboardWriteImpl: RequestHandler<"clipboard.write"> = async ({ text, label }) => {
    await deps.clipboard.writeText(text);
    logger.log("info", "clipboard write", { label });
    return {};
  };

  return {
    requests: {
      "app.init": logged("app.init", appInitImpl),
      "repo.list": logged("repo.list", repoListImpl),
      "repo.pick": logged("repo.pick", repoPickImpl),
      "repo.open": logged("repo.open", repoOpenImpl),
      "repo.close": logged("repo.close", repoCloseImpl),
      "graph.status": logged("graph.status", graphStatusImpl),
      "graph.loadMore": logged("graph.loadMore", graphLoadMoreImpl),
      "graph.refresh": logged("graph.refresh", graphRefreshImpl),
      "commit.detail": logged("commit.detail", commitDetailImpl),
      "commit.fileDiff": logged("commit.fileDiff", commitFileDiffImpl),
      "editor.openDiff": logged("editor.openDiff", editorOpenDiffImpl),
      "editor.goToFile": logged("editor.goToFile", editorGoToFileImpl),
      "clipboard.write": logged("clipboard.write", clipboardWriteImpl),
    },
    streams: {
      "graph.stream": logged("graph.stream", graphStreamImpl),
    },
  };
}
