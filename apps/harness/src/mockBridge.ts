import type { DocumentRef, FileChange } from "@kira-version/core";
import { CommitStore, defaultSettings, mapLineAcrossDiff } from "@kira-version/core";
import type {
  MessageChannelLike,
  RequestHandler,
  ServerHandlers,
  SettingsSnapshot,
  StreamChunkOf,
  StreamHandler,
  Transport,
} from "@kira-version/ipc";
import { CONTRACT_VERSION, createRpcClient, createRpcServer } from "@kira-version/ipc";
import { diffKey } from "./scenarios/diffKey.ts";
import { loadScenario } from "./scenarios/index.ts";
import type { Scenario } from "./scenarios/types.ts";

/**
 * Wires a real `createRpcServer`/`createRpcClient` pair over an in-memory channel to a
 * hand-written `ServerHandlers` (P3 W14) — not `@kira-version/git`'s `createRepoHandlers`,
 * which `biome.json`'s `noRestrictedImports` override forbids `apps/harness/**` from
 * importing (grouped with `packages/ui`'s own "core + ipc only" restriction, B3, §3.1). The
 * handlers below are this file's own translation from a `Scenario`'s fixture data to the same
 * wire shapes `packages/git/src/rpcHandlers.ts` produces, mirroring `RepoService.streamGraph`'s
 * cache-then-fresh-page split conceptually rather than by shared code — there is a real repo
 * fixture (`Scenario.commits`) but no real git process behind it.
 */

/** How many rows one `graph.stream` chunk carries, whether replayed from the mock's own
 *  `CommitStore` (`source: "cache"`) or newly "read" out of `Scenario.commits`
 *  (`source: "git"`) — the same constant `RepoService.CHUNK_ROWS` uses, kept independent since
 *  the harness may not import `@kira-version/git`. */
const CHUNK_ROWS = 500;

/** How many commits one simulated "page" adds — `defaultSettings()`'s own
 *  `kiraVersion.graph.pageSize`, so `hugeRepo`'s `graph.loadMore` genuinely needs more than one
 *  call to reach exhaustion, matching what a real host would do with the same setting. */
const PAGE_SIZE = defaultSettings()["kiraVersion.graph.pageSize"];

/** Browser-safe `basename` — `node:path` is not an option here (`topology.ts`'s own doc comment
 *  on why Vite silently stubs `node:` built-ins to `{}` in a browser bundle applies just as much
 *  here as it does there). */
function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** One `editor.openDiff`/`editor.goToFile` call, as the mock recorded it — the harness's model of
 *  "what the host's editor did" (P5 W12's own wording: "the harness models an editor, and this is
 *  in character rather than a test hook"). Read by W13's Playwright suite off
 *  `window.__kiraHarness.lastEditorAction`; there is no real editor behind it to assert against
 *  instead. */
export type HarnessEditorAction =
  | {
      readonly kind: "openDiff";
      readonly left: DocumentRef;
      readonly right: DocumentRef;
      readonly title: string;
    }
  | { readonly kind: "reveal"; readonly ref: DocumentRef; readonly line: number };

/** Looks up the one `FileChange` a `commit.fileDiff`/`editor.openDiff` request needs, from
 *  `Scenario.details`'s fixture — thrown, not invented, when the fixture does not cover the
 *  request, matching `requireSession`'s own convention for "this is a fixture bug, not a real
 *  outcome to model". */
function requireFileChange(
  scenario: Scenario,
  sha: string,
  path: string,
  parentIndex: number,
): FileChange {
  const change = scenario.details?.[sha]?.[parentIndex]?.files.find((f) => f.path === path);
  if (!change) {
    throw new Error(
      `mock bridge: no FileChange fixture for sha '${sha}' path '${path}' parentIndex ${parentIndex}`,
    );
  }
  return change;
}

/** `service.blob`'s stand-in for D14a's "not in the checkout" branch: the harness has no real
 *  object database, so a path's blob is "found" at `rev` exactly when `Scenario.diffs` fixtures
 *  a `commit.fileDiff` body for `(rev, path)` — deliberately independent of whether that path
 *  also appears in some commit's `CommitDetailFixture.files`, so one scenario can list a path as
 *  "touched" (for the file tree) while still fixturing its blob as unresolvable (`goToFile`'s own
 *  fifth case, "blob missing entirely"). Binary/too-large blobs are not modelled: the real UI
 *  never calls `editor.goToFile` for one (W10 hides the action), so no scenario needs to
 *  exercise those two `GoToFileOutcome.reason` values through this path. */
function blobExistsAtRev(scenario: Scenario, rev: string, path: string): boolean {
  return scenario.diffs?.[diffKey(rev, path)] !== undefined;
}

function toSettingsSnapshot(): SettingsSnapshot {
  const settings = defaultSettings();
  return {
    "kiraVersion.git.path": settings["kiraVersion.git.path"],
    "kiraVersion.graph.pageSize": settings["kiraVersion.graph.pageSize"],
    "kiraVersion.graph.scope": settings["kiraVersion.graph.scope"],
    "kiraVersion.log.level": settings["kiraVersion.log.level"],
  };
}

/** A harness-local copy of `packages/ipc/src/rpc.test.ts`'s own `createInMemoryChannelPair` —
 *  a real in-memory pipe using `structuredClone` (with transfer support) so posting on one end
 *  synchronously invokes the other, mimicking real `postMessage`/transfer-detach semantics
 *  closely enough that `createRpcClient`/`createRpcServer` cannot tell this from a real host
 *  channel. */
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
  return [a, b];
}

/** Row 0 always packs from an empty dictionary — the one mark every session starts with, and
 *  the one `#resetSession`-equivalent below restores on a refresh (`packages/git/src/
 *  repoService.ts`'s own `initialDictionaryMarks`, mirrored here). */
function initialDictionaryMarks(): Map<number, number> {
  return new Map([[0, 0]]);
}

interface RepoSession {
  readonly repoId: string;
  readonly commits: Scenario["commits"];
  readonly store: CommitStore;
  /** `packSlice`'s dictionary base for each row this session has ever emitted a chunk up to,
   *  keyed by that row — never a single session-wide running cursor. A client that resets its
   *  own store (the repo picker's "open a different candidate", `App.vue`'s `handleRepoOpened`,
   *  W11) reopens `graph.stream` with `resumeThroughRow: 0` while this session's own `store`
   *  still holds every previously-cached row — replaying that cache with whatever dictionary
   *  cursor the *previous* stream had reached by then would pack row 0's chunk against a
   *  dictionary base the fresh client's interner (size 0) has never seen, tripping
   *  `CommitStore.appendPacked`'s ordering assert. Resolving the base from *this row's own* mark
   *  instead means a replay from row 0 always resolves to the row-0 mark (always 0), regardless
   *  of how far a previous stream over this same session had walked the dictionary forward —
   *  `packages/git/src/repoService.ts`'s own `streamGraph`/`#emitRange` already carry this exact
   *  fix (its doc comments call it out as "W2's fix"); this mock never had the equivalent until
   *  P4 W13's Playwright suite exercised a repo-picker reopen against an already-cached session
   *  for the first time and surfaced the gap. */
  dictionaryMarks: Map<number, number>;
  nextSeq: number;
}

function createSession(repoId: string, commits: Scenario["commits"]): RepoSession {
  return {
    repoId,
    commits,
    store: new CommitStore(),
    dictionaryMarks: initialDictionaryMarks(),
    nextSeq: 0,
  };
}

function requireSession(sessions: Map<string, RepoSession>, repoId: string): RepoSession {
  const session = sessions.get(repoId);
  if (!session) throw new Error(`mock bridge: no open repo '${repoId}'`);
  return session;
}

/** Appends exactly one page's worth of `session.commits` into `session.store`, or none if the
 *  scenario's fixture is already fully loaded — the mock's stand-in for `RepoService`'s
 *  "read one page from git into the store". */
function readPageIntoStore(session: RepoSession): void {
  const loaded = session.store.rowCount;
  const count = Math.min(PAGE_SIZE, session.commits.length - loaded);
  if (count <= 0) return;
  session.store.appendPage(session.commits.slice(loaded, loaded + count));
}

/** Packs and emits exactly one chunk, `[from, to)`, using the caller-supplied dictionary base
 *  for that specific row range, and records the resulting size as `to`'s mark — mirrors
 *  `RepoService#emitRange`'s own doc comment almost verbatim. Returns the next base so a caller
 *  walking forward through several ranges in one `graph.stream` call can thread it without a
 *  second map lookup. */
async function emitRange(
  session: RepoSession,
  from: number,
  to: number,
  dictionaryBase: number,
  source: "git" | "cache",
  emit: (chunk: StreamChunkOf<"graph.stream">) => Promise<void>,
): Promise<number> {
  const commits = session.store.packSlice(from, to, dictionaryBase);
  const nextBase = dictionaryBase + commits.dictionary.length;
  session.dictionaryMarks.set(to, nextBase);
  const remaining = session.commits.length - session.store.rowCount;
  await emit({
    repoId: session.repoId,
    seq: session.nextSeq++,
    from,
    to,
    source,
    remaining,
    exhausted: remaining === 0,
    commits,
  });
  return nextBase;
}

/** `createHandlers`'s own `ServerHandlers` plus a way to read its private `activeRepoId` closure
 *  variable from outside (P4 W12) — `createMockBridge`'s `triggerRefsChanged` hook needs to know
 *  which repo, if any, is open, without duplicating that tracking at its own level. */
interface MockHandlers {
  readonly serverHandlers: ServerHandlers;
  getActiveRepoId(): string | null;
  /** P5 W12's own hook — see `HarnessEditorAction`'s doc comment. */
  getLastEditorAction(): HarnessEditorAction | undefined;
}

function createHandlers(scenario: Scenario): MockHandlers {
  const sessions = new Map<string, RepoSession>();
  let activeRepoId: string | null = null;
  let lastEditorAction: HarnessEditorAction | undefined;

  const appInit: RequestHandler<"app.init"> = async () => ({
    host: "harness",
    contractVersion: CONTRACT_VERSION,
    settings: toSettingsSnapshot(),
    git: scenario.git,
    capabilities: scenario.capabilities ?? { openInEditor: true, goToFile: true, clipboard: true },
  });

  const repoList: RequestHandler<"repo.list"> = async () => ({
    candidates: scenario.candidates ?? [],
    activeRepoId,
  });

  const repoPick: RequestHandler<"repo.pick"> = async () => ({ path: null });

  // Ignores `path` deliberately: the mock has exactly one repo per scenario (`Scenario`'s own
  // doc comment), so there is nothing to branch on — every call returns the same fixed outcome.
  const repoOpen: RequestHandler<"repo.open"> = async () => {
    if (scenario.repoOpen.kind === "ok") {
      const { repoId } = scenario.repoOpen.repo;
      if (!sessions.has(repoId)) sessions.set(repoId, createSession(repoId, scenario.commits));
      activeRepoId = repoId;
    }
    return scenario.repoOpen;
  };

  const repoClose: RequestHandler<"repo.close"> = async ({ repoId }) => {
    sessions.delete(repoId);
    if (activeRepoId === repoId) activeRepoId = null;
    return {};
  };

  const graphStatus: RequestHandler<"graph.status"> = async ({ repoId }) => {
    const session = requireSession(sessions, repoId);
    const remaining = session.commits.length - session.store.rowCount;
    return { loaded: session.store.rowCount, remaining, exhausted: remaining === 0 };
  };

  const graphLoadMore: RequestHandler<"graph.loadMore"> = async ({ repoId, pages }) => {
    const session = requireSession(sessions, repoId);
    if (session.store.rowCount >= session.commits.length) return { started: false };
    for (let i = 0; i < (pages ?? 1); i++) readPageIntoStore(session);
    return { started: true };
  };

  // Mirrors `RepoService.refresh`'s observable effect (§6.2), simplified for a fixture-backed
  // session with no watcher and no lazy "next stream re-walks" staging: there is nothing to
  // re-query here (`Scenario.commits` is static), so the mock resets the store eagerly rather
  // than through a `staleReason` latch consumed on the next stream — the client sees the same
  // "next stream starts at `from: 0` with `source: git`" either way.
  const graphRefresh: RequestHandler<"graph.refresh"> = async ({ repoId }) => {
    const session = sessions.get(repoId);
    if (!session) return { restarted: false };
    session.store.clear();
    session.dictionaryMarks = initialDictionaryMarks();
    return { restarted: true };
  };

  // Mirrors `RepoService.streamGraph`'s cache-then-fresh-page split (see this file's own doc
  // comment): replay whatever this session's store already holds in `CHUNK_ROWS` chunks
  // (`source: "cache"`), then — only on this repo's very first stream, exactly as the real
  // service does — pull one page out of the scenario's fixture and stream the rows that adds.
  const graphStream: StreamHandler<"graph.stream"> = async ({ repoId, resumeThroughRow }, ctx) => {
    const session = requireSession(sessions, repoId);

    // Clamped, not trusted verbatim (`RepoService.streamGraph`'s own comment): a caller-supplied
    // `resumeThroughRow` from before a client-side reset would otherwise point past the (still
    // fully cached) store. The dictionary base for that row is resolved from `dictionaryMarks`,
    // not guessed — see this session field's own doc comment for why a running cursor is wrong
    // here specifically.
    const requestedRow = Math.min(resumeThroughRow ?? 0, session.store.rowCount);
    const mark = session.dictionaryMarks.get(requestedRow);
    let cursor = mark !== undefined ? requestedRow : 0;
    let dictionaryBase = mark ?? 0;
    const cachedThrough = session.store.rowCount;

    while (cursor < cachedThrough) {
      if (ctx.signal.aborted) return;
      const to = Math.min(cursor + CHUNK_ROWS, cachedThrough);
      dictionaryBase = await emitRange(session, cursor, to, dictionaryBase, "cache", ctx.emit);
      cursor = to;
    }
    if (ctx.signal.aborted) return;

    if (cachedThrough === 0 && session.store.rowCount < session.commits.length) {
      readPageIntoStore(session);
    }

    while (cursor < session.store.rowCount) {
      if (ctx.signal.aborted) return;
      const to = Math.min(cursor + CHUNK_ROWS, session.store.rowCount);
      dictionaryBase = await emitRange(session, cursor, to, dictionaryBase, "git", ctx.emit);
      cursor = to;
    }
  };

  const commitDetail: RequestHandler<"commit.detail"> = async ({ repoId, sha, parentIndex }) => {
    requireSession(sessions, repoId);
    const record = scenario.commits.find((c) => c.sha === sha);
    if (!record) throw new Error(`mock bridge: commit.detail: unknown sha '${sha}'`);
    const index = parentIndex ?? 0;
    // Unlike `requireFileChange`/`blobExistsAtRev` (whose whole point is a *specific* file's
    // content, which cannot be honestly guessed), a commit's own metadata already has a true
    // empty default: "this scenario doesn't model this commit's body/trailers/signature/files"
    // is not invented data, it's an accurate statement about scenarios (`clean`, `hugeRepo`,
    // `badges`, …) authored before P5 existed, for which every commit must still be selectable
    // without a hand-written `CommitDetailFixture` per sha — `hugeRepo`'s 20,000 commits chief
    // among them. Scenarios that exist to test detail content itself (`detail`, `merge`,
    // `goToFile`, `noCapabilities`) supply real fixtures and never hit this fallback.
    const fixture = scenario.details?.[sha]?.[index];
    return {
      sha: record.sha,
      parents: record.parents,
      author: record.author,
      committer: record.committer,
      subject: record.subject,
      decoration: record.decoration,
      body: fixture?.body ?? "",
      trailers: fixture?.trailers ?? [],
      signature: fixture?.signature ?? { status: "N", signer: "" },
      parentIndex: index,
      files: fixture?.files ?? [],
    };
  };

  const commitFileDiff: RequestHandler<"commit.fileDiff"> = async ({
    repoId,
    sha,
    path,
    parentIndex,
  }) => {
    requireSession(sessions, repoId);
    const record = scenario.commits.find((c) => c.sha === sha);
    if (!record) throw new Error(`mock bridge: commit.fileDiff: unknown sha '${sha}'`);
    const index = parentIndex ?? 0;
    const change = requireFileChange(scenario, sha, path, index);
    const baseSha = record.parents[index] ?? null;
    const body = scenario.diffs?.[diffKey(sha, path)];
    if (!body) {
      throw new Error(`mock bridge: no FileDiffBody fixture for sha '${sha}' path '${path}'`);
    }
    return { sha, parentIndex: index, baseSha, change, body };
  };

  // Mirrors `packages/git/src/rpcHandlers.ts`'s own `editorOpenDiffImpl` almost line for line —
  // this file's own doc comment on why: "the harness models an editor, and this is in character
  // rather than a test hook" (P5 W12).
  const editorOpenDiff: RequestHandler<"editor.openDiff"> = async ({
    repoId,
    sha,
    path,
    originalPath,
    parentIndex,
  }) => {
    requireSession(sessions, repoId);
    const record = scenario.commits.find((c) => c.sha === sha);
    if (!record) throw new Error(`mock bridge: editor.openDiff: unknown sha '${sha}'`);
    const index = parentIndex ?? 0;
    const change = requireFileChange(scenario, sha, path, index);
    const baseSha = record.parents[index] ?? null;
    const leftPath = change.originalPath ?? originalPath ?? path;
    const left: DocumentRef =
      baseSha === null
        ? { kind: "empty", label: basenameOf(leftPath) }
        : { kind: "virtual", key: diffKey(baseSha, leftPath), label: basenameOf(leftPath) };
    const right: DocumentRef =
      change.kind === "deleted"
        ? { kind: "empty", label: basenameOf(path) }
        : { kind: "virtual", key: diffKey(sha, path), label: basenameOf(path) };
    const shortSha = sha.slice(0, 7);
    lastEditorAction = {
      kind: "openDiff",
      left,
      right,
      title: `${basenameOf(path)} (${shortSha}^ ↔ ${shortSha})`,
    };
    return {};
  };

  // D14a's decision procedure, run in the *same order* as `packages/git/src/rpcHandlers.ts`'s
  // `editorGoToFileImpl` (that file's own doc comment points back here) — `checkoutPaths`
  // standing in for `fs.existsSync`, `worktreeDrift` for `worktreeDiff`, and `blobExistsAtRev`
  // for `service.blob`'s found/missing split (see that function's own doc comment for why the
  // harness does not model `binary`/`tooLarge`).
  const editorGoToFile: RequestHandler<"editor.goToFile"> = async ({ repoId, rev, path, line }) => {
    requireSession(sessions, repoId);

    if ((scenario.checkoutPaths ?? []).includes(path)) {
      const hunks = scenario.worktreeDrift?.[diffKey(rev, path)];
      const finalLine = hunks === undefined ? line : mapLineAcrossDiff(hunks, line, "old");
      lastEditorAction = {
        kind: "reveal",
        ref: { kind: "file", path: `${repoId}/${path}` },
        line: finalLine,
      };
      return { kind: "liveFile", path, line: finalLine };
    }

    if (!blobExistsAtRev(scenario, rev, path)) {
      return { kind: "unavailable", reason: "notInRevision" };
    }
    const key = diffKey(rev, path);
    lastEditorAction = {
      kind: "reveal",
      ref: { kind: "virtual", key, label: basenameOf(path) },
      line,
    };
    return { kind: "virtualBlob", path, rev, line };
  };

  const clipboardWrite: RequestHandler<"clipboard.write"> = async ({ text }) => {
    await navigator.clipboard.writeText(text);
    return {};
  };

  return {
    serverHandlers: {
      requests: {
        "app.init": appInit,
        "repo.list": repoList,
        "repo.pick": repoPick,
        "repo.open": repoOpen,
        "repo.close": repoClose,
        "graph.status": graphStatus,
        "graph.loadMore": graphLoadMore,
        "graph.refresh": graphRefresh,
        "commit.detail": commitDetail,
        "commit.fileDiff": commitFileDiff,
        "editor.openDiff": editorOpenDiff,
        "editor.goToFile": editorGoToFile,
        "clipboard.write": clipboardWrite,
      },
      streams: {
        "graph.stream": graphStream,
      },
    },
    getActiveRepoId: () => activeRepoId,
    getLastEditorAction: () => lastEditorAction,
  };
}

/** `Transport` plus one test-only hook (P4 W12) the harness's own `main.ts` wires to
 *  `window.__kiraHarness.triggerRefsChanged` — `W13`'s Playwright suite asserts the Refresh
 *  button's stale dot off this without waiting on (or building) a real filesystem watcher. */
export interface MockBridge extends Transport {
  /** Simulates the host noticing `.git/refs` changed underneath the currently open repo — a
   *  no-op with no repo open, matching `RepoState`'s own `repo.changed` handling, which ignores
   *  events for a repo that is not (or no longer) the active one. */
  triggerRefsChanged(): void;
  /** P5 W12: the most recent `editor.openDiff`/`editor.goToFile` action the mock recorded, or
   *  `undefined` if neither has fired yet this session — `main.ts` exposes this as
   *  `window.__kiraHarness.lastEditorAction` for W13's Playwright suite. */
  getLastEditorAction(): HarnessEditorAction | undefined;
}

export function createMockBridge(scenarioName: string): MockBridge {
  const scenario = loadScenario(scenarioName);
  const [serverChannel, clientChannel] = createInMemoryChannelPair();
  const { serverHandlers, getActiveRepoId, getLastEditorAction } = createHandlers(scenario);
  const server = createRpcServer(serverChannel, serverHandlers);
  const client = createRpcClient(clientChannel);

  return {
    ...client,
    dispose(): void {
      client.dispose();
      server.dispose();
    },
    triggerRefsChanged(): void {
      const repoId = getActiveRepoId();
      if (repoId === null) return;
      server.emit("repo.changed", { repoId, kind: "refsChanged" });
    },
    getLastEditorAction,
  };
}
