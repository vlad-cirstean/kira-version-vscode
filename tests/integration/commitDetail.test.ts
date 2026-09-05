import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProcessExit,
  ProcessRunner,
  SpawnedProcess,
  SpawnRequest,
} from "../../packages/core/src/index.ts";
import { defaultSettings } from "../../packages/core/src/index.ts";
import {
  FakeClipboard,
  FakeDialogs,
  FakeEditorIntegration,
  FakeLogger,
  FakeWorkspaceRoots,
} from "../../packages/core/src/ports/testFakes.ts";
import { GitCancelled } from "../../packages/git/src/errors.ts";
import { NodeFileWatcher } from "../../packages/git/src/nodeFileWatcher.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { MAX_PATCH_BYTES, RepoService } from "../../packages/git/src/repoService.ts";
import { createRepoHandlers } from "../../packages/git/src/rpcHandlers.ts";
import type { MessageChannelLike } from "../../packages/ipc/src/index.ts";
import { createRpcClient, createRpcServer } from "../../packages/ipc/src/index.ts";
import { baseEnv, branchy, detailWorkload, octopus } from "../fixtures/generateRepo.ts";

/**
 * W16: "the tier where the things the harness models are checked against the thing itself" —
 * every fact below is already covered at the unit level against recorded porcelain fixtures or a
 * fake `RepoService` (`packages/git/src/queries.test.ts`, `tests/unit/git/rpcHandlers.test.ts`);
 * this file re-verifies the same facts against a real `git` binary and real, generated
 * repositories, so a fixture or a fake that quietly drifted from git's actual behaviour would be
 * caught here and nowhere else.
 *
 * The small hand-rolled fixture helpers below (`commitFile`/`deleteFile`/`renameAndEdit`/
 * `initRepo`) are the same convention `repoService.test.ts`'s own binary-file test already uses
 * when a scenario needs something `tests/fixtures/generateRepo.ts`'s named shapes don't build (a
 * rename, a specific binary/LFS/oversized blob, an unmerged branch, mid-test working-tree drift)
 * — every commit still gets a fixed, reproducible author/committer identity and an advancing
 * date, matching that file's own determinism discipline.
 */

let commitDateIndex = 0;

function commitEnv(): NodeJS.ProcessEnv {
  const date = `${1_700_000_000 + commitDateIndex++ * 3600} +0000`;
  return {
    GIT_AUTHOR_NAME: "Kira Fixture",
    GIT_AUTHOR_EMAIL: "fixture@kira-version.test",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "Kira Fixture",
    GIT_COMMITTER_EMAIL: "fixture@kira-version.test",
    GIT_COMMITTER_DATE: date,
  };
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, env: baseEnv(dir), encoding: "utf8" });
}

function commitStaged(dir: string, message: string): string {
  execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "-m", message], {
    cwd: dir,
    env: { ...baseEnv(dir), ...commitEnv() },
  });
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

function initRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kira-commitDetail-${prefix}-`));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: dir,
    env: baseEnv(dir),
  });
  return dir;
}

/** Writes `relPath` and commits it (add + commit) — for an ordinary add/modify. */
function commitFile(
  dir: string,
  relPath: string,
  content: string | Buffer,
  message: string,
): string {
  writeFileSync(join(dir, relPath), content);
  execFileSync("git", ["add", "--", relPath], { cwd: dir, env: baseEnv(dir) });
  return commitStaged(dir, message);
}

/** `git rm`s `relPath` (from the index; still removed from disk) and commits the deletion. */
function deleteFile(dir: string, relPath: string, message: string): string {
  execFileSync("git", ["rm", "--quiet", "--", relPath], { cwd: dir, env: baseEnv(dir) });
  return commitStaged(dir, message);
}

/** `git mv`s `fromPath` to `toPath`, rewrites its content, and commits both as one change —
 *  the rename-plus-edit shape probe P1/P2 exists for. */
function renameAndEdit(
  dir: string,
  fromPath: string,
  toPath: string,
  newContent: string,
  message: string,
): string {
  execFileSync("git", ["mv", fromPath, toPath], { cwd: dir, env: baseEnv(dir) });
  writeFileSync(join(dir, toPath), newContent);
  execFileSync("git", ["add", "--", toPath], { cwd: dir, env: baseEnv(dir) });
  return commitStaged(dir, message);
}

async function openService(dir: string, runner: ProcessRunner = new NodeProcessRunner()) {
  const service = await RepoService.create({
    runner,
    fileWatcher: new NodeFileWatcher(),
    logger: new FakeLogger(),
    settings: defaultSettings(),
    configuredGitCandidates: [],
  });
  const opened = await service.open(dir);
  if (opened.kind !== "ok") throw new Error(`unreachable: ${JSON.stringify(opened)}`);
  return { service, repoId: opened.repoId };
}

// ---------------------------------------------------------------------------------------
// Rename + edit: the true delta, and a rename rendering, not a whole-file add (probe P1/P2).
// ---------------------------------------------------------------------------------------

describe("commit detail — rename plus an edit (P5 W16)", () => {
  test("the tree reports the true +1/-1, the per-file diff renders as a rename, and similarity matches git's own", async () => {
    const dir = initRepo("rename-edit");
    const original = `${Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n")}\n`;
    commitFile(dir, "old.txt", original, "add old.txt");

    const edited = original.replace("line 2", "line 2 EDITED");
    const sha = renameAndEdit(dir, "old.txt", "new.txt", edited, "rename and edit");

    // git's own answer, gathered independently of the code under test.
    const numstatFields = git(dir, ["diff-tree", "-r", "--numstat", "-M", "-C", `${sha}~1`, sha])
      .trim()
      .split("\t");
    const expectedAdditions = Number(numstatFields[0]);
    const expectedDeletions = Number(numstatFields[1]);
    const nameStatusLine = git(dir, [
      "diff-tree",
      "-r",
      "--name-status",
      "-M",
      "-C",
      `${sha}~1`,
      sha,
    ]).trim();
    const expectedSimilarity = Number(nameStatusLine.split("\t")[0]?.match(/\d+/)?.[0] ?? "0");

    const { service, repoId } = await openService(dir);
    try {
      const detail = await service.detail(repoId, sha);
      expect(detail.files).toHaveLength(1);
      const file = detail.files[0];
      if (!file) throw new Error("unreachable");
      expect(file.kind).toBe("renamed");
      expect(file.path).toBe("new.txt");
      expect(file.originalPath).toBe("old.txt");
      // The P1 fix: the true +1/-1 for the one edited line, not the whole file re-counted as
      // an unrelated add+delete pair (which would report +5/-5).
      expect(file.additions).toBe(1);
      expect(file.deletions).toBe(1);
      expect(file.additions).toBe(expectedAdditions);
      expect(file.deletions).toBe(expectedDeletions);
      expect(file.similarity).toBe(expectedSimilarity);

      const diff = await service.fileDiff(repoId, sha, "new.txt", "old.txt");
      expect(diff.body.kind).toBe("text");
      if (diff.body.kind !== "text") throw new Error("unreachable");
      // Probe P2's trap: naming only `path` (not both paths) in the pathspec renders a rename
      // as a whole-file add. Renders correctly here — one small hunk, not five lines of pure
      // additions.
      expect(diff.body.hunks).toHaveLength(1);
      const changedLines = diff.body.hunks[0]?.lines.filter((l) => l.kind !== "context") ?? [];
      expect(changedLines).toHaveLength(2); // one del, one add
    } finally {
      service.dispose();
    }
  });
});

// ---------------------------------------------------------------------------------------
// Merge / octopus / root — parentIndex selects a genuinely different file list.
// ---------------------------------------------------------------------------------------

describe("commit detail — merge, octopus and root commits (P5 W16)", () => {
  test("a merge's parentIndex 0 and 1 produce different file lists", async () => {
    const repo = branchy({ mainCommits: 2, featureCommits: 2, mergeBack: true });
    const mergeSha = repo.commits[repo.commits.length - 1];
    if (!mergeSha) throw new Error("unreachable");

    const { service, repoId } = await openService(repo.dir);
    try {
      const detail = await service.detail(repoId, mergeSha, 0);
      expect(detail.parents).toHaveLength(2);

      const viaMain = await service.detail(repoId, mergeSha, 0);
      const viaFeature = await service.detail(repoId, mergeSha, 1);
      const mainPaths = viaMain.files.map((f) => f.path).sort();
      const featurePaths = viaFeature.files.map((f) => f.path).sort();
      expect(mainPaths).not.toEqual(featurePaths);
      // Diffing against the main parent surfaces what the feature branch alone contributed.
      expect(mainPaths).toContain("feature.txt");
      // Diffing against the feature parent surfaces what main alone contributed while the
      // branch was open.
      expect(featurePaths).toContain("main.txt");
    } finally {
      service.dispose();
    }
  });

  test("an octopus merge exposes all of its parents, each a valid diff base", async () => {
    const repo = octopus();
    const mergeSha = repo.commits[repo.commits.length - 1];
    if (!mergeSha) throw new Error("unreachable");

    const { service, repoId } = await openService(repo.dir);
    try {
      const detail = await service.detail(repoId, mergeSha, 0);
      // main's own tip (unchanged since the base commit) is parent 0; topic/a, topic/b and
      // topic/c are parents 1-3 — four parents total for a three-way octopus.
      expect(detail.parents).toHaveLength(4);

      for (let parentIndex = 0; parentIndex < 4; parentIndex++) {
        const perParent = await service.detail(repoId, mergeSha, parentIndex);
        expect(perParent.parentIndex).toBe(parentIndex);
        // Each of the other two topic branches' files shows up as introduced-by-the-merge
        // relative to *this* parent alone.
        expect(perParent.files.length).toBeGreaterThan(0);
      }
    } finally {
      service.dispose();
    }
  });

  test("a root commit's detail against the empty tree is a real diff, not an error", async () => {
    const dir = initRepo("root");
    const sha = commitFile(dir, "file.txt", "hello\n", "root commit");

    const { service, repoId } = await openService(dir);
    try {
      const detail = await service.detail(repoId, sha);
      expect(detail.parents).toEqual([]);
      expect(detail.files).toEqual([
        {
          kind: "added",
          path: "file.txt",
          originalPath: undefined,
          similarity: undefined,
          additions: 1,
          deletions: 0,
          isBinary: false,
        },
      ]);
      const diff = await service.fileDiff(repoId, sha, "file.txt", undefined);
      expect(diff.baseSha).toBeNull();
      expect(diff.body.kind).toBe("text");
    } finally {
      service.dispose();
    }
  });
});

// ---------------------------------------------------------------------------------------
// Binary, LFS-pointer and over-cap classification.
// ---------------------------------------------------------------------------------------

describe("commit detail — binary, LFS-pointer and tooLarge classification (P5 W16)", () => {
  test("a binary file's per-file diff classifies as binary with real blob sizes", async () => {
    const dir = initRepo("binary");
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x10, 0x20]);
    const sha = commitFile(dir, "image.bin", bytes, "add a binary file");

    const { service, repoId } = await openService(dir);
    try {
      const diff = await service.fileDiff(repoId, sha, "image.bin", undefined);
      expect(diff.body.kind).toBe("binary");
      if (diff.body.kind !== "binary") throw new Error("unreachable");
      expect(diff.body.oldBytes).toBeUndefined(); // added: nothing on the old side
      expect(diff.body.newBytes).toBe(bytes.length);
    } finally {
      service.dispose();
    }
  });

  test("an LFS pointer file's per-file diff classifies as lfsPointer with its declared oid and size", async () => {
    const dir = initRepo("lfs");
    const oid = "a".repeat(64);
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 123456\n`;
    const sha = commitFile(dir, "asset.psd", pointer, "add an LFS pointer");

    const { service, repoId } = await openService(dir);
    try {
      const diff = await service.fileDiff(repoId, sha, "asset.psd", undefined);
      expect(diff.body).toEqual({ kind: "lfsPointer", oid, bytes: 123456 });
    } finally {
      service.dispose();
    }
  });

  test("a patch over the shared byte cap reports tooLarge instead of materializing hunks", async () => {
    const dir = initRepo("toolarge");
    // Each added line is counted in the patch; comfortably over MAX_PATCH_BYTES (1 MiB) for an
    // added file, whose whole content becomes "+" lines.
    const line = "x".repeat(120);
    const content = `${Array.from({ length: 20_000 }, () => line).join("\n")}\n`;
    const sha = commitFile(dir, "huge.txt", content, "add a huge file");

    const { service, repoId } = await openService(dir);
    try {
      const diff = await service.fileDiff(repoId, sha, "huge.txt", undefined);
      expect(diff.body.kind).toBe("tooLarge");
      if (diff.body.kind !== "tooLarge") throw new Error("unreachable");
      expect(diff.body.bytes).toBeGreaterThan(MAX_PATCH_BYTES);
      expect(diff.body.limitBytes).toBe(MAX_PATCH_BYTES);
    } finally {
      service.dispose();
    }
  });
});

// ---------------------------------------------------------------------------------------
// editor.goToFile's three branches against a real checkout, and the drift re-map — through the
// actual RPC layer (createRepoHandlers/createRpcServer/createRpcClient), a real `RepoService`,
// and a `FakeEditorIntegration` standing in only for the editor UI itself (no real VS Code editor
// exists in a test environment; the decision logic under test lives entirely in rpcHandlers.ts
// and RepoService, not in the editor).
// ---------------------------------------------------------------------------------------

function createInMemoryChannelPair(): readonly [MessageChannelLike, MessageChannelLike] {
  let handlerA: ((message: unknown) => void) | undefined;
  let handlerB: ((message: unknown) => void) | undefined;
  const a: MessageChannelLike = {
    bufferEncoding: "native",
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
    bufferEncoding: "native",
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

function wireRpc(service: RepoService) {
  const editor = new FakeEditorIntegration();
  const handlers = createRepoHandlers({
    service,
    roots: new FakeWorkspaceRoots(),
    dialogs: new FakeDialogs(),
    settings: () => defaultSettings(),
    host: "harness",
    logger: new FakeLogger(),
    editor,
    clipboard: new FakeClipboard(),
  });
  const [a, b] = createInMemoryChannelPair();
  const server = createRpcServer(a, handlers);
  const client = createRpcClient(b);
  return { editor, server, client };
}

describe("editor.goToFile — three branches against a real checkout (P5 W16, D14a)", () => {
  test("liveFile, virtualBlob (deleted since), virtualBlob (branch not an ancestor of HEAD), and unavailable are each reached by a different repository state", async () => {
    const dir = initRepo("goToFile");
    const c0 = commitFile(dir, "file.txt", "hello\n", "add file.txt");
    const c1 = commitFile(dir, "doomed.txt", "doomed\n", "add doomed.txt");
    deleteFile(dir, "doomed.txt", "remove doomed.txt");

    // A branch off the current tip that is never merged back into main: ghost.txt exists only
    // there. HEAD (main) stays at the deletion commit throughout.
    execFileSync("git", ["switch", "--quiet", "-c", "feature/ghost"], {
      cwd: dir,
      env: baseEnv(dir),
    });
    const ghostSha = commitFile(dir, "ghost.txt", "ghost\n", "add ghost.txt on an unmerged branch");
    execFileSync("git", ["switch", "--quiet", "main"], { cwd: dir, env: baseEnv(dir) });

    const { service, repoId } = await openService(dir);
    try {
      const { client, server } = wireRpc(service);
      try {
        // liveFile: file.txt exists on disk, unchanged since c0.
        const live = await client.request("editor.goToFile", {
          repoId,
          rev: c0,
          path: "file.txt",
          line: 1,
        });
        expect(live).toEqual({ kind: "liveFile", path: "file.txt", line: 1 });

        // virtualBlob: doomed.txt existed at c1 but was deleted afterward — gone from disk now.
        const deletedSince = await client.request("editor.goToFile", {
          repoId,
          rev: c1,
          path: "doomed.txt",
          line: 1,
        });
        expect(deletedSince).toEqual({ kind: "virtualBlob", path: "doomed.txt", rev: c1, line: 1 });

        // virtualBlob: ghost.txt exists at ghostSha, on a branch that is not an ancestor of the
        // current HEAD — D14a's own reason this branch exists at all.
        const onUnmergedBranch = await client.request("editor.goToFile", {
          repoId,
          rev: ghostSha,
          path: "ghost.txt",
          line: 1,
        });
        expect(onUnmergedBranch).toEqual({
          kind: "virtualBlob",
          path: "ghost.txt",
          rev: ghostSha,
          line: 1,
        });

        // unavailable: doomed.txt did not exist yet at c0 — missing from that revision entirely,
        // not merely absent from the current checkout.
        const missing = await client.request("editor.goToFile", {
          repoId,
          rev: c0,
          path: "doomed.txt",
          line: 1,
        });
        expect(missing).toEqual({ kind: "unavailable", reason: "notInRevision" });
      } finally {
        client.dispose();
        server.dispose();
      }
    } finally {
      service.dispose();
    }
  });
});

describe("editor.goToFile — the drift re-map against a real working tree (P5 W16, D14a)", () => {
  test("re-maps across a later commit's insert, then across an uncommitted edit, then declines once the path is untracked", async () => {
    const dir = initRepo("drift");
    const baseline = `${Array.from({ length: 10 }, (_, i) => `L${i}`).join("\n")}\n`;
    const commitA = commitFile(dir, "notes.txt", baseline, "baseline");
    const knownLine = 6; // "L5" — the line this test tracks across every step below.

    // A later commit inserts N=3 lines above the known line.
    const afterInsert = `${["L0", "L1", "L2", "L3", "L4", "NEW0", "NEW1", "NEW2", "L5", "L6", "L7", "L8", "L9"].join("\n")}\n`;
    commitFile(dir, "notes.txt", afterInsert, "insert 3 lines above L5");

    const { service, repoId } = await openService(dir);
    try {
      const { client, server } = wireRpc(service);
      try {
        const afterCommit = await client.request("editor.goToFile", {
          repoId,
          rev: commitA,
          path: "notes.txt",
          line: knownLine,
        });
        expect(afterCommit).toEqual({ kind: "liveFile", path: "notes.txt", line: knownLine + 3 });

        // Without committing, 2 more lines land on disk above the same point.
        const afterUncommittedEdit = `${[
          "L0",
          "L1",
          "L2",
          "L3",
          "L4",
          "NEW0",
          "NEW1",
          "NEW2",
          "MORE0",
          "MORE1",
          "L5",
          "L6",
          "L7",
          "L8",
          "L9",
        ].join("\n")}\n`;
        writeFileSync(join(dir, "notes.txt"), afterUncommittedEdit);

        const afterDiskEdit = await client.request("editor.goToFile", {
          repoId,
          rev: commitA,
          path: "notes.txt",
          line: knownLine,
        });
        // Pins "working tree, not HEAD": a `<rev>..HEAD`-based implementation would still report
        // `knownLine + 3` here, since nothing was committed.
        expect(afterDiskEdit).toEqual({
          kind: "liveFile",
          path: "notes.txt",
          line: knownLine + 3 + 2,
        });

        // Untrack the path — removed from the index, left on disk.
        execFileSync("git", ["rm", "--quiet", "--cached", "notes.txt"], {
          cwd: dir,
          env: baseEnv(dir),
        });

        const afterUntracked = await client.request("editor.goToFile", {
          repoId,
          rev: commitA,
          path: "notes.txt",
          line: knownLine,
        });
        // worktreeDiff can no longer see the path at all (git reports it as deleted, from the
        // index's point of view) — the outcome stays liveFile, with the unmapped historical line.
        expect(afterUntracked).toEqual({ kind: "liveFile", path: "notes.txt", line: knownLine });
      } finally {
        client.dispose();
        server.dispose();
      }
    } finally {
      service.dispose();
    }
  });
});

// ---------------------------------------------------------------------------------------
// Blob-by-path through cat-file --batch: a spaced path (both directions, the W2 fix), and a
// newline path taking the one-shot `git show` fallback.
// ---------------------------------------------------------------------------------------

describe("blob() — cat-file --batch with a spaced path, and the newline one-shot fallback (P5 W2/W16)", () => {
  test("a path with a space resolves in both the found and missing directions", async () => {
    const dir = initRepo("spaced");
    const sha = commitFile(dir, "my file.txt", "hello from a spaced path\n", "add a spaced path");

    const { service, repoId } = await openService(dir);
    try {
      const found = await service.blob(repoId, sha, "my file.txt");
      expect(found).toEqual({ kind: "found", content: "hello from a spaced path\n" });

      const missing = await service.blob(repoId, sha, "no such file.txt");
      expect(missing).toEqual({ kind: "missing" });
    } finally {
      service.dispose();
    }
  });

  test("a path containing a newline reads through the one-shot fallback, found and missing", async () => {
    const dir = initRepo("newline");
    const newlinePath = "weird\nname.txt";
    writeFileSync(join(dir, newlinePath), "content behind a newline path\n");
    execFileSync("git", ["add", "--", newlinePath], { cwd: dir, env: baseEnv(dir) });
    const sha = commitStaged(dir, "add a newline path");

    const { service, repoId } = await openService(dir);
    try {
      const found = await service.blob(repoId, sha, newlinePath);
      expect(found).toEqual({ kind: "found", content: "content behind a newline path\n" });

      const missing = await service.blob(repoId, sha, "does\nnot\nexist.txt");
      expect(missing).toEqual({ kind: "missing" });
    } finally {
      service.dispose();
    }
  });
});

// ---------------------------------------------------------------------------------------
// Cancellation: a superseded commit.detail kills its underlying process, not merely discards
// the result — asserted by inspecting the real child process's own exit signal, the strongest
// form of the spawn-counting technique `repoService.test.ts` already uses for `loadMore`.
// ---------------------------------------------------------------------------------------

class SpawnRecordingRunner implements ProcessRunner {
  readonly #inner = new NodeProcessRunner();
  readonly records: Array<{
    readonly argv: readonly string[];
    readonly exit: Promise<ProcessExit>;
  }> = [];
  #armedController: AbortController | undefined;

  /** The *next* spawn aborts `controller` synchronously, before returning — early enough to
   *  preempt even a fast git process, since the whole abort-to-kill chain runs in this same
   *  synchronous turn, well before any I/O event for the just-spawned child can be observed. */
  armNextSpawn(controller: AbortController): void {
    this.#armedController = controller;
  }

  spawn(executable: string, request: SpawnRequest): SpawnedProcess {
    const proc = this.#inner.spawn(executable, request);
    this.records.push({ argv: request.argv, exit: proc.exit });
    const controller = this.#armedController;
    if (controller) {
      this.#armedController = undefined;
      controller.abort();
    }
    return proc;
  }
}

describe("commit.detail — cancellation kills its process (P5 W16)", () => {
  test("a superseded detail() request's process is actually killed by signal, not merely discarded; a later request still succeeds", async () => {
    const repo = detailWorkload();
    // Built in a fixed order (tests/fixtures/generateRepo.ts's detailWorkload): index 4 is
    // always the many-generated-files commit — real enough work for git that a synchronous
    // abort issued the instant its process spawns reliably preempts a fast, natural exit.
    const manyFilesSha = repo.commits[4];
    if (!manyFilesSha) throw new Error("unreachable");

    const runner = new SpawnRecordingRunner();
    const { service, repoId } = await openService(repo.dir, runner);
    try {
      const controller = new AbortController();
      const recordedBefore = runner.records.length;
      runner.armNextSpawn(controller);

      await expect(
        service.detail(repoId, manyFilesSha, 0, controller.signal),
      ).rejects.toBeInstanceOf(GitCancelled);

      const spawnedForThisCall = runner.records.slice(recordedBefore);
      expect(spawnedForThisCall.length).toBeGreaterThan(0);
      const exits = await Promise.all(spawnedForThisCall.map((r) => r.exit));
      // A process that exited naturally would report signal: null; one actually killed reports
      // the signal it was killed with (SIGTERM — nodeProcessRunner.ts's own default).
      expect(exits.some((exit) => exit.signal !== null)).toBe(true);

      // The superseded request must not have poisoned the cache or left the session unusable.
      const detail = await service.detail(repoId, manyFilesSha, 0);
      expect(detail.sha).toBe(manyFilesSha);
      expect(detail.files.length).toBeGreaterThanOrEqual(500);
    } finally {
      service.dispose();
    }
  }, 10_000);
});
