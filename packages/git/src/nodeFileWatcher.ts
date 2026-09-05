/**
 * The one real `FileWatcher` (packages/core/src/ports/fileWatcher.ts), `node:fs.watch` based,
 * written once for the same reason `nodeProcessRunner.ts` is: the extension host runs on Node,
 * and any future Node-based host reuses this unchanged rather than reimplementing it.
 *
 * `fs.watch({ recursive: true })` on macOS is FSEvents-backed and coalesces events aggressively,
 * so a caller must re-read state rather than trust an event's `kind` to be precise — `watcher.ts`
 * treats every event on a relevant path as "something changed here", never as a definitive
 * created/changed/deleted fact. A watch on a file git replaces atomically (e.g. `refs/heads/x`
 * via rename) can silently stop firing once the original inode is gone, so `watcher.ts` watches
 * directories, not individual ref files.
 *
 * **Linux (P4c, dev-infra only — D27 keeps v1 macOS-only).** libuv/inotify has no recursive
 * primitive, so `recursive: true` on Linux is routed by Node itself to a **userland**
 * implementation (`internal/fs/recursive_watch`, landed in the v20 line): it `readdir`s the tree
 * once at start and places a separate, individual `fs.watch` on every entry — files as well as
 * directories — adding a watch for each new entry as it appears. Two consequences, both verified
 * directly against this runtime rather than assumed:
 * - The `filename` contract is unchanged: every emit is still `path.relative(rootPath, file)`,
 *   so this file's `join(path, filename)` and `watcher.ts`'s absolute-path `classify()` need no
 *   Linux-specific branch. (This was the failure mode most worth checking, and it does not
 *   occur — worth recording, because "the filename is already absolute" is exactly the bug a
 *   future reader would otherwise suspect.)
 * - The per-file watch this userland layer places on an existing ref file goes stale after that
 *   file's *first* atomic rename-over: a manual probe (`git branch -f <ref> <sha>` run twice
 *   against an already-watched branch ref, docs/plans/P4c-linux-test-infra.md's Findings) showed
 *   the first update fires and the second is silently missed — the watch never rebinds to the
 *   new inode. `watcher.ts` closes this by also watching `refs/heads`, `refs/tags` and
 *   `refs/remotes` non-recursively, the same directory-watch mechanism it already relies on for
 *   `HEAD`; a duplicate event costs nothing since this layer debounces and coalesces by design.
 * - One inotify watch per file under `.git/refs`, since every entry gets its own. Fine against
 *   this container's `fs.inotify.max_user_watches`; a repository with an unusually large
 *   loose-ref set could exhaust it, at which point `#watchOne`'s `catch` below logs a
 *   `FileWatchError` and that one watch is silently skipped. Not fixed here — Linux is not a
 *   shipped platform (D27) — but written down so it isn't mistaken for an oversight.
 */
import { existsSync, type FSWatcher, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import type {
  Disposable,
  FileWatchEvent,
  FileWatcher,
  FileWatchOptions,
  Logger,
} from "@kira-version/core";

/** A `node:fs.watch` failure on one watched path (EMFILE, the path disappearing, ...). Logged
 *  and that one watch is torn down; it never reaches a caller as an unhandled `error` event or
 *  an exception out of `watch()`. */
export class FileWatchError extends Error {
  readonly path: string;
  override readonly cause: unknown;

  constructor(path: string, cause: unknown) {
    super(`watching '${path}' failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "FileWatchError";
    this.path = path;
    this.cause = cause;
  }
}

export class NodeFileWatcher implements FileWatcher {
  readonly #logger: Logger | undefined;

  constructor(logger?: Logger) {
    this.#logger = logger;
  }

  watch(
    paths: readonly string[],
    opts: FileWatchOptions,
    onEvent: (event: FileWatchEvent) => void,
  ): Disposable {
    const watchers: FSWatcher[] = [];

    for (const path of paths) {
      const watcher = this.#watchOne(path, opts, onEvent);
      if (watcher) watchers.push(watcher);
    }

    return {
      dispose: () => {
        for (const watcher of watchers) watcher.close();
      },
    };
  }

  #watchOne(
    path: string,
    opts: FileWatchOptions,
    onEvent: (event: FileWatchEvent) => void,
  ): FSWatcher | undefined {
    let watcher: FSWatcher;
    try {
      watcher = fsWatch(path, { recursive: opts.recursive ?? false }, (eventType, filename) => {
        const fullPath = filename ? join(path, filename.toString()) : path;
        const kind =
          eventType === "change" ? "changed" : existsSync(fullPath) ? "created" : "deleted";
        onEvent({ path: fullPath, kind });
      });
    } catch (err) {
      this.#logger?.log("error", "watch setup failed", new FileWatchError(path, err));
      return undefined;
    }
    watcher.on("error", (err) => {
      this.#logger?.log("error", "watch failed", new FileWatchError(path, err));
      watcher.close();
    });
    return watcher;
  }
}
