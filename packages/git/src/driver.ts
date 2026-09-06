/**
 * The single spawn path (§4.3). Every git invocation this product ever makes goes through
 * `openGitDriver()`'s `read()`/`write()` — the discipline (env hygiene, the four `-c`
 * overrides, `--no-optional-locks` on reads, streaming rather than buffering, cancellation,
 * the write queue) is built into that one path rather than remembered at each call site.
 * If a bare `run(argv)` were reachable without it, some call site would eventually skip some
 * of it, and those bugs (a translated-locale stderr that misclassifies, a `color.ui=always`
 * user whose porcelain arrives with ANSI escapes) are the kind that reproduce on one machine
 * in ten.
 */
import type { ProcessExit, ProcessRunner, SpawnedProcess } from "@kira-version/core";
import { splitRecords } from "@kira-version/core";
import type { ResolvedGit } from "./discovery.ts";
import { classifyGitError, GitCancelled, GitSpawnFailed } from "./errors.ts";
import { ProcessSpawnError } from "./nodeProcessRunner.ts";

// ---------------------------------------------------------------------------------------
// Env and flags — the structural part of §4.3's discipline.
// ---------------------------------------------------------------------------------------

/**
 * Narrow, enumerated `-c` overrides, each because it corrupts a machine-readable format —
 * never the user's config wholesale. `core.quotepath=false` (§4.3) so non-ASCII paths come
 * back as UTF-8 bytes; `color.ui=false` so a user's `color.ui=always` cannot inject ANSI
 * escapes into porcelain output; `log.showSignature=false` so a user's
 * `log.showSignature=true` cannot inject signature blocks into `git log`'s record framing;
 * `i18n.logOutputEncoding=UTF-8` so `%s`-formatted text comes back in a known encoding
 * regardless of the repo's own config.
 */
const CONFIG_OVERRIDES = [
  "-c",
  "core.quotepath=false",
  "-c",
  "color.ui=false",
  "-c",
  "log.showSignature=false",
  "-c",
  "i18n.logOutputEncoding=UTF-8",
];

/**
 * Replaces the child's environment; never merges an ad hoc override into `process.env` at a
 * call site. `GIT_ASKPASS`/`SSH_ASKPASS` are deliberately left as inherited by default — P8's
 * askpass broker (`askpass.ts`) overrides them itself, per remote op, via `writeStreaming`'s
 * `env` option, and leaves them alone entirely when the user has their own `core.askPass` or
 * `GIT_ASKPASS` configured (§4.1's config-fidelity rule). Two of the four no-hang guarantees
 * live here regardless: `GIT_TERMINAL_PROMPT=0` below, so git fails fast rather than prompting,
 * and `detached: true` at the spawn site (`nodeProcessRunner.ts`), which makes the child its own
 * session leader (`setsid()`) with no controlling terminal to prompt on even if the first
 * guarantee were somehow bypassed. The other two (the broker's own bounded timeout, and
 * op-level cancel) are askpass.ts's and the driver's own `writeStreaming`, respectively.
 */
export function buildGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  // P6/W6: a driver that can block on an interactive editor is a driver that can hang. Probe
  // P6: with no GIT_EDITOR, `git merge --continue` (no TTY) fails rc=1 with "There was a
  // problem with the editor 'editor'" and — worse — leaves MERGE_HEAD in place, so the
  // operation is never actually finished. `GIT_EDITOR=true` makes the same continue commit
  // cleanly, rc=0, using git's own default commit message. Any op that can reach a
  // commit-message editor (merge/cherry-pick/revert's `--continue`, `tag -a` without `-m`)
  // gets this, not a per-call flag — a hang here is a driver bug regardless of which
  // subcommand triggers it.
  env.GIT_EDITOR = "true";
  // Error classification (errors.ts) pattern-matches stderr; a translated git otherwise gets
  // every error classified Unknown. Porcelain/plumbing formats are untranslated by contract
  // (verified for real in W13's V1), so this should not perturb parsed output.
  env.LC_ALL = "C";
  return env;
}

/** The complete argv for one invocation, including the structural flags. `forRead` adds
 *  `--no-optional-locks` (§4.3); writes need normal locking to avoid corrupting a concurrent
 *  operation, so they do not get it. */
export function buildGitArgv(argv: readonly string[], forRead: boolean): string[] {
  const flags = [...CONFIG_OVERRIDES, "--no-pager"];
  if (forRead) flags.push("--no-optional-locks");
  return [...flags, ...argv];
}

// ---------------------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------------------

export interface ReadOptions {
  readonly signal?: AbortSignal;
}

export interface WriteOptions {
  /** Honored only while the write is queued; a write that has already started is never
   *  killed (§4.3) — an aborted `git commit` mid-flight is how a user ends up explaining a
   *  stale `index.lock` to themselves). */
  readonly signal?: AbortSignal;
}

/**
 * P8/W2: a write that reports progress and, when `killable`, may be cancelled after it has
 * started. §4.3's "a write that has already started is never killed" is right for every local
 * write — killing one can strand `index.lock`, a half-written ref, or a partial sequencer state.
 * A network fetch has none of those hazards: it writes loose objects or a packfile a later `gc`
 * collects, and moves no ref the user can see until it completes — so it, and only it, is ever
 * passed `killable: true` (D50; see the cancellability table in "The hard parts" §3). `push`,
 * `forcePush`, `deleteRemoteBranch`, and pull's merge/rebase phase all use `killable: false`
 * here — same queue, same progress reporting, no kill.
 */
export interface StreamingWriteOptions {
  /** Teed to every chunk of stderr as it arrives — see `ProcessRunner.SpawnRequest.onStderr`. */
  readonly onStderr?: (chunk: Uint8Array) => void;
  readonly killable: boolean;
  /** While queued: removes the entry and rejects with `GitCancelled`, exactly like `write()`.
   *  After the process has started: a no-op unless `killable`, in which case it kills the child
   *  (SIGTERM, then SIGKILL after `nodeProcessRunner.ts`'s ~2s grace) and the promise still
   *  rejects with `GitCancelled` — never resolves as if nothing happened. */
  readonly signal?: AbortSignal;
  /** The askpass broker's per-op additions (`GIT_ASKPASS`, the socket path, the op token) —
   *  merged over `buildGitEnv()`'s own, never replacing it. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface GitWriteResult {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface GitRead {
  readonly bytes: AsyncIterable<Uint8Array>;
  /** The same bytes, pre-split on `delimiter` via `splitRecords` (core's incremental
   *  splitter) — the form every §4.4 parser actually consumes. */
  records(delimiter: number): AsyncIterable<Uint8Array>;
  /** Resolves on a clean exit; rejects with a `GitError` (via errors.ts) or `GitCancelled`. */
  readonly done: Promise<void>;
  cancel(): void;
}

export interface Disposable {
  dispose(): void;
}

/** `catFile.ts`'s per-request result (P5 W3 widens this from a bare marker type). Declared
 *  here, alongside `CatFileSession`, for the same reason that interface is declared here and
 *  not in catFile.ts — see its own comment. */
export type CatFileResult =
  | {
      readonly kind: "found";
      readonly oid: string;
      readonly type: string;
      readonly size: number;
      readonly content: Uint8Array;
    }
  | { readonly kind: "missing"; readonly oid: string }
  | {
      readonly kind: "tooLarge";
      readonly oid: string;
      readonly type: string;
      readonly size: number;
    };

/**
 * The contract `catFile.ts` (W9) implements. Declared here, not there, so `GitDriver` can
 * carry a `catFile` property without driver.ts importing catFile.ts — W9 depends on W7, not
 * the reverse, and importing it here would make that circular. A real `GitDriver` is
 * assembled by a caller that already has both: `openGitDriver(git, runner, repoRoot,
 * openCatFileSession(git, runner, repoRoot))`.
 */
export interface CatFileSession extends Disposable {
  /** The size-gated full read (P5 W3): `--batch-check` first, then `--batch` for content when
   *  under the gate. Used to materialize a virtual document's actual bytes
   *  (`RepoService.blob`). */
  read(oid: string): Promise<CatFileResult>;
  /** `--batch-check` only — no blob content ever crosses the pipe. Used to turn a binary
   *  diff's two blob oids into byte sizes (`RepoService.fileDiff`) without paying for content
   *  that is never displayed. */
  check(oid: string): Promise<CatFileResult>;
}

export interface GitDriver {
  read(argv: readonly string[], opts?: ReadOptions): GitRead;
  write(argv: readonly string[], opts?: WriteOptions): Promise<GitWriteResult>;
  /** P8/W2: same write queue as `write()` — a remote op serializes against local writes exactly
   *  as before, which is what makes §7.1's auto-fetch guardrail ("never while another op holds
   *  the write queue") expressible at all. See `StreamingWriteOptions`'s own doc comment for the
   *  kill semantics. `onInvalidated` fires on success as always, and — deliberately — also for a
   *  killed *killable* write: a partial fetch may have moved remote-tracking refs the graph must
   *  not go on showing as stale. */
  writeStreaming(argv: readonly string[], opts: StreamingWriteOptions): Promise<GitWriteResult>;
  readonly catFile: CatFileSession;
  /** Bumped once per completed write; see `onInvalidated`. */
  readonly generation: number;
  /** True while the write queue is non-empty or a write is in flight. P8/W15's auto-fetch
   *  scheduler reads this — §7.1's "never while another operation is running" guardrail. */
  readonly busy: boolean;
  /** Fires once a completed write bumps `generation` (§4.3: "a mutating op invalidates the
   *  graph cache on completion"). In-flight reads started at an older generation are not
   *  cancelled by this — see `GitRead.done`'s callers, who decide whether to discard a
   *  now-stale result themselves; throwing away a nearly-complete 100k-commit walk because a
   *  tag was created is worse than serving it and re-querying. */
  onInvalidated(fn: () => void): Disposable;
  dispose(): void;
}

export interface OpenGitDriverOptions {
  /** Bound on concurrent reads. Enough to overlap a status, a refs query and a detail fetch
   *  without thrashing a laptop's disk during a graph walk. */
  readonly readConcurrency?: number;
}

const DEFAULT_READ_CONCURRENCY = 4;

export function openGitDriver(
  git: ResolvedGit,
  runner: ProcessRunner,
  repoRoot: string,
  catFile: CatFileSession,
  opts: OpenGitDriverOptions = {},
): GitDriver {
  return new GitDriverImpl(
    git,
    runner,
    repoRoot,
    catFile,
    opts.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
  );
}

// ---------------------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------------------

async function collectAll(bytes: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of bytes) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** A counting semaphore for the bounded read pool. */
class Pool {
  #capacity: number;
  #inUse = 0;
  #waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  get inUse(): number {
    return this.#inUse;
  }

  async acquire(): Promise<() => void> {
    if (this.#inUse >= this.#capacity) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    this.#inUse++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inUse--;
      const next = this.#waiters.shift();
      if (next) next();
    };
  }
}

interface QueuedWrite {
  readonly kind: "plain";
  readonly argv: readonly string[];
  readonly signal: AbortSignal | undefined;
  readonly resolve: (result: GitWriteResult) => void;
  readonly reject: (err: unknown) => void;
}

interface QueuedStreamingWrite {
  readonly kind: "streaming";
  readonly argv: readonly string[];
  readonly signal: AbortSignal | undefined;
  readonly killable: boolean;
  readonly onStderr: ((chunk: Uint8Array) => void) | undefined;
  readonly env: Readonly<Record<string, string>> | undefined;
  readonly resolve: (result: GitWriteResult) => void;
  readonly reject: (err: unknown) => void;
  /** Flips once `#runStreamingWrite` actually spawns — after that, `signal`'s own abort
   *  listener switches from "remove from queue" to "kill `proc`, if killable" (or a no-op). */
  started: boolean;
  proc: SpawnedProcess | undefined;
}

type WriteQueueEntry = QueuedWrite | QueuedStreamingWrite;

class GitDriverImpl implements GitDriver {
  readonly catFile: CatFileSession;
  #generation = 0;
  readonly #invalidationListeners = new Set<() => void>();
  readonly #readPool: Pool;
  readonly #writeQueue: WriteQueueEntry[] = [];
  #writeInFlight = false;
  #disposed = false;

  constructor(
    private readonly git: ResolvedGit,
    private readonly runner: ProcessRunner,
    private readonly repoRoot: string,
    catFile: CatFileSession,
    readConcurrency: number,
  ) {
    this.catFile = catFile;
    this.#readPool = new Pool(readConcurrency);
  }

  get generation(): number {
    return this.#generation;
  }

  get busy(): boolean {
    return this.#writeInFlight || this.#writeQueue.length > 0;
  }

  onInvalidated(fn: () => void): Disposable {
    this.#invalidationListeners.add(fn);
    return {
      dispose: () => {
        this.#invalidationListeners.delete(fn);
      },
    };
  }

  read(argv: readonly string[], opts: ReadOptions = {}): GitRead {
    const fullArgv = buildGitArgv(argv, true);
    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const acquireAndSpawn = this.#readPool.acquire().then((release) => {
      if (controller.signal.aborted) {
        release();
        return undefined;
      }
      const proc: SpawnedProcess = this.runner.spawn(this.git.path, {
        argv: fullArgv,
        cwd: this.repoRoot,
        env: buildGitEnv(),
        signal: controller.signal,
      });
      const cleanup = () => release();
      proc.exit.then(cleanup, cleanup);
      return proc;
    });

    // `bytes` captures the exit outcome itself, in a `finally` after its own `yield*`
    // completes, and signals `exitCaptured` — `done` below only ever *waits* on that signal,
    // it never iterates `bytes` itself. That matters: `bytes` is a single generator, and a
    // second independent consumer pulling from it concurrently with the caller's own
    // `for await` would split chunks between the two unpredictably. It also avoids a
    // different, harder bug — an independent consumer awaiting `spawned.exit` concurrently
    // with stdout consumption reproducibly hangs under this sandbox's Bun runtime (confirmed
    // absent under real Node; production never runs Bun, §8.1). Net effect: `done` only
    // settles once `bytes` has actually been driven to completion by someone — in practice
    // always the caller, since every query in queries.ts consumes a read's `bytes`/`records`
    // before awaiting `done`. A caller that awaits `done` without ever touching `bytes` will
    // hang; that is a real, deliberate constraint of this API, not an oversight.
    let exitOutcome: { readonly exit: ProcessExit } | { readonly error: unknown } | undefined;
    let signalExitCaptured!: () => void;
    const exitCaptured = new Promise<void>((resolve) => {
      signalExitCaptured = resolve;
    });

    const bytes = (async function* (): AsyncGenerator<Uint8Array> {
      const spawned = await acquireAndSpawn;
      if (!spawned) {
        signalExitCaptured();
        return;
      }
      try {
        yield* spawned.stdout;
      } finally {
        try {
          exitOutcome = { exit: await spawned.exit };
        } catch (err) {
          exitOutcome = { error: err };
        }
        signalExitCaptured();
      }
    })();

    const done = (async () => {
      await exitCaptured;
      const spawned = await acquireAndSpawn;
      if (!spawned) throw new GitCancelled(fullArgv);
      if (!exitOutcome)
        throw new Error("unreachable: exitCaptured resolved without recording an outcome");
      if ("error" in exitOutcome) {
        throw exitOutcome.error instanceof ProcessSpawnError
          ? new GitSpawnFailed(this.git.path, exitOutcome.error)
          : exitOutcome.error;
      }
      // Checked *after* exit, not before: a signal that fires the instant exit resolves
      // must still be treated as a cancellation, not a same-tick race that slips through.
      if (controller.signal.aborted) throw new GitCancelled(fullArgv);
      if (exitOutcome.exit.code !== 0) {
        const stderr = new TextDecoder("utf-8", { fatal: false }).decode(await spawned.stderr);
        throw classifyGitError(fullArgv, exitOutcome.exit.code, stderr);
      }
    })();
    // A read's failure is a caller concern (they await `done` or iterate `bytes`); an
    // unhandled rejection here would otherwise surface as a process-level warning the moment
    // this promise settles, even for a caller that only ever reads `bytes`.
    done.catch(() => {});

    return {
      bytes,
      records: (delimiter: number) => splitRecords(bytes, { delimiter }),
      done,
      cancel: () => controller.abort(),
    };
  }

  async write(argv: readonly string[], opts: WriteOptions = {}): Promise<GitWriteResult> {
    if (opts.signal?.aborted) throw new GitCancelled(argv);
    return new Promise<GitWriteResult>((resolve, reject) => {
      const entry: QueuedWrite = { kind: "plain", argv, signal: opts.signal, resolve, reject };
      if (opts.signal) {
        opts.signal.addEventListener(
          "abort",
          () => {
            const index = this.#writeQueue.indexOf(entry);
            if (index !== -1) {
              this.#writeQueue.splice(index, 1);
              reject(new GitCancelled(argv));
            }
            // Already started: per WriteOptions' contract, abort is a no-op from here on.
          },
          { once: true },
        );
      }
      this.#writeQueue.push(entry);
      this.#pumpWriteQueue();
    });
  }

  async writeStreaming(
    argv: readonly string[],
    opts: StreamingWriteOptions,
  ): Promise<GitWriteResult> {
    if (opts.signal?.aborted) throw new GitCancelled(argv);
    return new Promise<GitWriteResult>((resolve, reject) => {
      const entry: QueuedStreamingWrite = {
        kind: "streaming",
        argv,
        signal: opts.signal,
        killable: opts.killable,
        onStderr: opts.onStderr,
        env: opts.env,
        resolve,
        reject,
        started: false,
        proc: undefined,
      };
      if (opts.signal) {
        opts.signal.addEventListener(
          "abort",
          () => {
            if (!entry.started) {
              const index = this.#writeQueue.indexOf(entry);
              if (index !== -1) {
                this.#writeQueue.splice(index, 1);
                reject(new GitCancelled(argv));
              }
              return;
            }
            // Already started: killable is the one case D50 relaxes §4.3's "never killed" rule
            // for — everything else is a no-op from here on, same as write()'s own contract.
            if (entry.killable) entry.proc?.kill();
          },
          { once: true },
        );
      }
      this.#writeQueue.push(entry);
      this.#pumpWriteQueue();
    });
  }

  #pumpWriteQueue(): void {
    if (this.#writeInFlight) return;
    const entry = this.#writeQueue.shift();
    if (!entry) return;
    this.#writeInFlight = true;
    const run = entry.kind === "plain" ? this.#runWrite(entry) : this.#runStreamingWrite(entry);
    run.finally(() => {
      this.#writeInFlight = false;
      this.#pumpWriteQueue();
    });
  }

  async #runStreamingWrite(entry: QueuedStreamingWrite): Promise<void> {
    const fullArgv = buildGitArgv(entry.argv, false);
    entry.started = true;
    try {
      const proc = this.runner.spawn(this.git.path, {
        argv: fullArgv,
        cwd: this.repoRoot,
        env: { ...buildGitEnv(), ...entry.env },
        // `exactOptionalPropertyTypes`: the key must be entirely absent when there is no
        // callback, not present with value `undefined`.
        ...(entry.onStderr ? { onStderr: entry.onStderr } : {}),
      });
      entry.proc = proc;
      const [stdout, stderr] = await Promise.all([collectAll(proc.stdout), proc.stderr]);
      const exit = await proc.exit;
      if (exit.signal !== null) {
        // Killed (only ever reachable when entry.killable — writeStreaming's own abort
        // listener is the only thing that ever calls proc.kill()). A partial fetch may have
        // already written loose objects or moved remote-tracking refs, so this still counts as
        // an invalidating write even though it settles GitCancelled rather than a result.
        this.#generation++;
        for (const listener of this.#invalidationListeners) listener();
        entry.reject(new GitCancelled(fullArgv));
        return;
      }
      if (exit.code !== 0) {
        entry.reject(
          classifyGitError(
            fullArgv,
            exit.code,
            new TextDecoder("utf-8", { fatal: false }).decode(stderr),
          ),
        );
        return;
      }
      this.#generation++;
      for (const listener of this.#invalidationListeners) listener();
      entry.resolve({ stdout, stderr });
    } catch (err) {
      entry.reject(err instanceof ProcessSpawnError ? new GitSpawnFailed(this.git.path, err) : err);
    }
  }

  async #runWrite(entry: QueuedWrite): Promise<void> {
    const fullArgv = buildGitArgv(entry.argv, false);
    try {
      const proc = this.runner.spawn(this.git.path, {
        argv: fullArgv,
        cwd: this.repoRoot,
        env: buildGitEnv(),
      });
      const [stdout, stderr] = await Promise.all([collectAll(proc.stdout), proc.stderr]);
      const exit = await proc.exit;
      if (exit.code !== 0) {
        entry.reject(
          classifyGitError(
            fullArgv,
            exit.code,
            new TextDecoder("utf-8", { fatal: false }).decode(stderr),
          ),
        );
        return;
      }
      this.#generation++;
      for (const listener of this.#invalidationListeners) listener();
      entry.resolve({ stdout, stderr });
    } catch (err) {
      entry.reject(err instanceof ProcessSpawnError ? new GitSpawnFailed(this.git.path, err) : err);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const entry of this.#writeQueue.splice(0)) {
      entry.reject(new GitCancelled(entry.argv));
    }
    this.catFile.dispose();
  }
}
