/**
 * A controllable `ProcessRunner` double for unit tests that need to assert exact argv/env
 * without spawning anything, and need precise control over when a "process" produces output
 * or exits — the read-pool-bound and write-queue-serialization tests need exactly that
 * timing control, which a real spawned process cannot offer deterministically. Not exported
 * from index.ts: this is test scaffolding, not product surface.
 */
import type {
  Disposable,
  FileWatchEvent,
  FileWatcher,
  FileWatchOptions,
  ProcessExit,
  ProcessRunner,
  SpawnedProcess,
  SpawnRequest,
} from "@kira-version/core";
import { locateGit, type ResolvedGit } from "./discovery.ts";
import type { CatFileSession } from "./driver.ts";

export class FakeProcess implements SpawnedProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: Promise<Uint8Array>;
  readonly exit: Promise<ProcessExit>;
  readonly writes: Uint8Array[] = [];
  killedWith: NodeJS.Signals[] = [];

  #stdoutChunks: Uint8Array[] = [];
  #stdoutEnded = false;
  #stdoutWaiters: Array<() => void> = [];
  #resolveStderr!: (bytes: Uint8Array) => void;
  #resolveExit!: (exit: ProcessExit) => void;
  #rejectExit!: (err: unknown) => void;
  #settled = false;

  get settled(): boolean {
    return this.#settled;
  }

  constructor() {
    this.stderr = new Promise((resolve) => {
      this.#resolveStderr = resolve;
    });
    this.exit = new Promise((resolve, reject) => {
      this.#resolveExit = resolve;
      this.#rejectExit = reject;
    });
    this.stdout = this.#iterateStdout();
  }

  async *#iterateStdout(): AsyncGenerator<Uint8Array> {
    let index = 0;
    for (;;) {
      if (index < this.#stdoutChunks.length) {
        yield this.#stdoutChunks[index] as Uint8Array;
        index++;
        continue;
      }
      if (this.#stdoutEnded) return;
      await new Promise<void>((resolve) => this.#stdoutWaiters.push(resolve));
    }
  }

  emitStdout(chunk: Uint8Array): void {
    this.#stdoutChunks.push(chunk);
    this.#drainWaiters();
  }

  endStdout(): void {
    this.#stdoutEnded = true;
    this.#drainWaiters();
  }

  #drainWaiters(): void {
    const waiters = this.#stdoutWaiters;
    this.#stdoutWaiters = [];
    for (const waiter of waiters) waiter();
  }

  finish(code: number, stderrText = ""): void {
    if (this.#settled) return;
    this.#settled = true;
    this.endStdout();
    this.#resolveStderr(new TextEncoder().encode(stderrText));
    this.#resolveExit({ code, signal: null });
  }

  failSpawn(err: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    this.endStdout();
    this.#resolveStderr(new Uint8Array());
    this.#rejectExit(err);
  }

  write(chunk: Uint8Array): Promise<void> {
    this.writes.push(chunk);
    return Promise.resolve();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.killedWith.push(signal);
    if (!this.#settled) {
      this.#settled = true;
      this.endStdout();
      this.#resolveStderr(new Uint8Array());
      this.#resolveExit({ code: null, signal });
    }
  }
}

export class FakeProcessRunner implements ProcessRunner {
  readonly calls: Array<{ executable: string; request: SpawnRequest }> = [];
  readonly processes: FakeProcess[] = [];

  spawn(executable: string, request: SpawnRequest): SpawnedProcess {
    this.calls.push({ executable, request });
    const proc = new FakeProcess();
    this.processes.push(proc);
    // Mirrors NodeProcessRunner's contract: a ProcessRunner honors request.signal itself.
    if (request.signal) {
      if (request.signal.aborted) proc.kill("SIGTERM");
      else request.signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
    }
    return proc;
  }
}

/**
 * A controllable `FileWatcher` double for `watcher.ts`'s unit tests: records every `watch()`
 * call (paths + options) and lets a test fire a synthetic event to every still-subscribed
 * listener via `emit`, without touching a real filesystem.
 */
export class FakeFileWatcher implements FileWatcher {
  readonly calls: Array<{ readonly paths: readonly string[]; readonly opts: FileWatchOptions }> =
    [];
  readonly #listeners = new Set<(event: FileWatchEvent) => void>();

  watch(
    paths: readonly string[],
    opts: FileWatchOptions,
    onEvent: (event: FileWatchEvent) => void,
  ): Disposable {
    this.calls.push({ paths, opts });
    this.#listeners.add(onEvent);
    return { dispose: () => this.#listeners.delete(onEvent) };
  }

  /** Fires `event` to every still-subscribed listener — the test's stand-in for a real fs
   *  change. */
  emit(event: FileWatchEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}

/**
 * Resolves a real `ResolvedGit` through the legitimate path (discovery.ts's opaque
 * constructor), against a fake version probe, rather than poking a hole in its opacity. Uses
 * its own throwaway runner — a `ResolvedGit` carries no reference to the runner that produced
 * it, and reusing a caller's own runner here would pollute its `processes`/`calls` with the
 * version probe's spawn, off by one from whatever that caller wants to assert on.
 */
export async function fakeResolvedGit(version = "2.45.0"): Promise<ResolvedGit> {
  const probeRunner = new FakeProcessRunner();
  const resultPromise = locateGit({ runner: probeRunner, configuredCandidates: ["/fake/git"] });
  await Promise.resolve();
  const proc = probeRunner.processes.at(-1);
  if (!proc) throw new Error("expected the version probe to have spawned");
  proc.emitStdout(new TextEncoder().encode(`git version ${version}\n`));
  proc.finish(0);
  const resolution = await resultPromise;
  if (resolution.kind !== "ok") throw new Error(`unexpected resolution: ${resolution.kind}`);
  return resolution.git;
}

/** A `CatFileSession` that answers every request `missing` and spawns nothing — for a test
 *  whose `GitDriver` needs *a* `catFile` to construct but never actually reads a blob through
 *  it (P5 W3 widened the interface from a bare `Disposable`). */
export function noopCatFileSession(): CatFileSession {
  return {
    dispose(): void {},
    async read(oid: string) {
      return { kind: "missing", oid } as const;
    },
    async check(oid: string) {
      return { kind: "missing", oid } as const;
    },
  };
}

/**
 * Ticks the microtask queue until `predicate` holds — robust against exactly how many promise
 * hops a driver's internals happen to take, which is an implementation detail tests should
 * not hard-code against. Throws if `predicate` never becomes true within `maxTicks`, rather
 * than silently returning — a wrong assumption about what a test is waiting for should fail
 * fast and close to the mistake, not surface as an unrelated assertion or a full test timeout.
 */
export async function flushUntil(predicate: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  if (!predicate()) {
    throw new Error(`flushUntil: predicate still false after ${maxTicks} microtask ticks`);
  }
}
