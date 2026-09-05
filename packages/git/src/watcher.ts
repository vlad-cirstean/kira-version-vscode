/**
 * §4.5's coalescing: turns raw `FileWatcher` events on `.git`'s ref-ish and index files into
 * the two signals `RepoService` (W7) actually consumes, debounced so a burst of writes (a
 * rebase touching many refs, `git fetch --prune`) collapses into one `refsChanged`.
 *
 * Watched under `--git-common-dir` (D12 — a linked worktree's refs live in the common dir, not
 * its own git dir): `HEAD`, `refs/**`, `packed-refs`, `FETCH_HEAD`, `MERGE_HEAD`,
 * `rebase-merge/`, `rebase-apply/`. Watched under the git dir: `index`. Per
 * `nodeFileWatcher.ts`'s doc comment, individual files are never watched directly — `refs/` is
 * watched recursively, and the flat ref-ish files are caught by a non-recursive watch on their
 * parent directory instead, so an atomic rename replacing one of them still fires.
 */
import { basename, dirname, join, sep } from "node:path";
import type { Disposable, FileWatchEvent, FileWatcher, RepoIdentity } from "@kira-version/core";

export type WatchSignal = "refsChanged" | "worktreeChanged";

export interface RepoWatcher extends Disposable {
  onSignal(fn: (signal: WatchSignal) => void): Disposable;
  pause(): void;
  resume(): void;
}

export interface WatchRepoOptions {
  readonly debounceMs?: number;
  readonly now?: () => number;
}

const DEFAULT_DEBOUNCE_MS = 200;

// Flat files living directly in the common dir; anything under `refs/` is matched by path
// prefix instead (see #classify).
const REF_ISH_NAMES = new Set([
  "HEAD",
  "packed-refs",
  "FETCH_HEAD",
  "MERGE_HEAD",
  "rebase-merge",
  "rebase-apply",
]);

/** Git writes every one of these files atomically: `<name>.lock` is written, then renamed onto
 *  `<name>`. `fs.watch` reports a rename by the name that changed, which for the `MOVED_FROM`
 *  half of that pair is the `.lock` name, not the final one — so classification strips a
 *  trailing `.lock` before comparing, or every index/ref write would be silently missed. */
function stripLockSuffix(name: string): string {
  return name.endsWith(".lock") ? name.slice(0, -".lock".length) : name;
}

function classify(identity: RepoIdentity, path: string): WatchSignal | undefined {
  const refsDir = join(identity.commonDir, "refs");
  if (path === refsDir || path.startsWith(refsDir + sep)) return "refsChanged";

  const dir = dirname(path);
  const base = stripLockSuffix(basename(path));
  if (dir === identity.gitDir && base === "index") return "worktreeChanged";
  // An ambiguous coalesced event naming the watched directory itself, or a flat ref-ish file
  // directly inside it — both are common-dir concerns, so both read as refsChanged. Checked
  // after the index match above so a gitDir that equals commonDir (the non-worktree case)
  // still routes `index` to worktreeChanged rather than falling into this branch.
  if (path === identity.commonDir) return "refsChanged";
  if (dir === identity.commonDir && REF_ISH_NAMES.has(base)) return "refsChanged";
  return undefined;
}

export function watchRepo(
  fileWatcher: FileWatcher,
  identity: RepoIdentity,
  opts: WatchRepoOptions = {},
): RepoWatcher {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const now = opts.now ?? Date.now;

  const listeners = new Set<(signal: WatchSignal) => void>();
  let paused = false;
  let disposed = false;
  let windowStart: number | undefined;
  let pendingRefs = false;
  let pendingWorktree = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function cancelTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function flush(): void {
    windowStart = undefined;
    cancelTimer();
    const refs = pendingRefs;
    const worktree = pendingWorktree;
    pendingRefs = false;
    pendingWorktree = false;
    if (refs) for (const listener of listeners) listener("refsChanged");
    if (worktree) for (const listener of listeners) listener("worktreeChanged");
  }

  // Re-checks elapsed time (via the injectable `now`) rather than trusting a single
  // `setTimeout(debounceMs)` to have actually waited that long: a fake clock in tests can
  // report the window as already elapsed on the very first (near-immediate) check, so unit
  // tests never have to block on the real debounce window; production's real `Date.now` just
  // reschedules for the true remaining delay each time, which converges in one extra tick.
  function check(): void {
    timer = undefined;
    if (windowStart === undefined) return;
    const remaining = debounceMs - (now() - windowStart);
    if (remaining > 0) {
      timer = setTimeout(check, remaining);
    } else {
      flush();
    }
  }

  function noteSignal(signal: WatchSignal): void {
    if (paused || disposed) return;
    if (signal === "refsChanged") pendingRefs = true;
    else pendingWorktree = true;
    if (windowStart === undefined) {
      windowStart = now();
      timer = setTimeout(check, 0);
    }
  }

  function onFsEvent(event: FileWatchEvent): void {
    const signal = classify(identity, event.path);
    if (signal) noteSignal(signal);
  }

  const refsSubscription = fileWatcher.watch(
    [join(identity.commonDir, "refs")],
    { recursive: true },
    onFsEvent,
  );
  const flatDirs =
    identity.gitDir === identity.commonDir
      ? [identity.commonDir]
      : [identity.commonDir, identity.gitDir];
  // Also watch the shallow, known set of directories where refs actually live,
  // non-recursively, alongside the recursive `refs/` subscription above: on Linux, Node's
  // userland recursive watcher (nodeFileWatcher.ts's doc comment) can go stale on a given ref
  // file after its first rename-over, missing subsequent updates to the same path. A
  // non-recursive directory watch doesn't have that failure mode (it's the same mechanism
  // `flatDirs` already relies on for HEAD et al.), so this closes the gap. A duplicate event
  // costs nothing — this layer already debounces and coalesces by design (P4c W2).
  const flatRefDirs = ["heads", "tags", "remotes"].map((name) =>
    join(identity.commonDir, "refs", name),
  );
  const flatSubscription = fileWatcher.watch(
    [...flatDirs, ...flatRefDirs],
    { recursive: false },
    onFsEvent,
  );

  return {
    onSignal(fn: (signal: WatchSignal) => void): Disposable {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    pause(): void {
      paused = true;
      cancelTimer();
      windowStart = undefined;
      pendingRefs = false;
      pendingWorktree = false;
    },
    resume(): void {
      paused = false;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelTimer();
      windowStart = undefined;
      pendingRefs = false;
      pendingWorktree = false;
      listeners.clear();
      refsSubscription.dispose();
      flatSubscription.dispose();
    },
  };
}
