/**
 * The one real `ProcessRunner` (packages/core/src/ports/processRunner.ts). Written once here,
 * not per host, because the extension host runs on Node — any future Node-based host reuses it
 * unchanged; `packages/host-*` wraps it with host-owned policy (which git path, which cwd,
 * logging) instead of reimplementing the spawn (§3.1, §3.3).
 */
import { type ChildProcessWithoutNullStreams, spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { ProcessExit, ProcessRunner, SpawnedProcess, SpawnRequest } from "@kira-version/core";

const SIGKILL_GRACE_MS = 2000;
const MAX_STDERR_BYTES = 1024 * 1024;
const TRUNCATION_MARKER = "\n…[stderr truncated]";

/** The child could not be started at all (e.g. ENOENT) — distinct from any git-reported failure. */
export class ProcessSpawnError extends Error {
  override readonly cause: unknown;

  constructor(executable: string, cause: unknown) {
    super(
      `failed to spawn '${executable}': ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "ProcessSpawnError";
    this.cause = cause;
  }
}

async function* iterateStream(stream: Readable): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of stream) {
      yield chunk as Uint8Array;
    }
  } catch (err) {
    // The pipe tearing down early — because the process was killed or never started — is
    // expected; `exit` (rejected on spawn failure, or carrying a kill signal) is the
    // canonical place callers learn that, not an exception out of stdout iteration.
    if ((err as NodeJS.ErrnoException)?.code !== "ERR_STREAM_PREMATURE_CLOSE") throw err;
  }
}

async function pumpStdin(
  stdin: NodeJS.WritableStream,
  source: Uint8Array | AsyncIterable<Uint8Array>,
): Promise<void> {
  if (source instanceof Uint8Array) {
    await writeChunk(stdin, source);
  } else {
    for await (const chunk of source) {
      await writeChunk(stdin, chunk);
    }
  }
  stdin.end();
}

function writeChunk(stdin: NodeJS.WritableStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stdin.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

class NodeSpawnedProcess implements SpawnedProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: Promise<Uint8Array>;
  readonly exit: Promise<ProcessExit>;
  #killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    child: ChildProcessWithoutNullStreams,
    signal: AbortSignal | undefined,
    onStderr: ((chunk: Uint8Array) => void) | undefined,
  ) {
    this.#child = child;
    this.stdout = iterateStream(child.stdout);
    this.stderr = collectStderr(child.stderr, onStderr);
    this.exit = waitForExit(child);

    // Once settled (however it settles), there is nothing left to escalate.
    this.exit
      .catch(() => {})
      .finally(() => {
        if (this.#killTimer) clearTimeout(this.#killTimer);
      });

    if (signal) {
      if (signal.aborted) this.kill();
      else signal.addEventListener("abort", () => this.kill(), { once: true });
    }
  }

  write(chunk: Uint8Array): Promise<void> {
    return writeChunk(this.#child.stdin, chunk);
  }

  kill(signal?: NodeJS.Signals): void {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    if (signal) {
      killGroup(this.#child, signal);
      return;
    }
    killGroup(this.#child, "SIGTERM");
    this.#killTimer = setTimeout(() => {
      if (this.#child.exitCode === null && this.#child.signalCode === null) {
        killGroup(this.#child, "SIGKILL");
      }
    }, SIGKILL_GRACE_MS);
  }
}

/**
 * Signals the whole process group, not just the immediate child. `git` itself never forks a
 * subprocess that outlives it, but a shell-scripted stand-in (fakeGit.ts, used to test
 * discovery.ts's timeout handling) does: `#!/bin/sh` running `sleep N` as its last statement
 * is a *grandchild*, and killing only the shell can leave that grandchild running with the
 * stdout pipe still open — which then never emits EOF, hanging any reader forever. Spawning
 * with `detached: true` makes the child its own process-group leader, so `kill(-pid)` reaches
 * the whole tree.
 */
function killGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (typeof child.pid !== "number") return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH (already dead) or a platform without process groups — fall back to the direct child.
    child.kill(signal);
  }
}

function collectStderr(
  stream: Readable,
  onStderr: ((chunk: Uint8Array) => void) | undefined,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  stream.on("data", (chunk: Buffer) => {
    // The tee sees every chunk, ahead of truncation — a progress parser cares about the byte
    // stream as it actually arrived, not the bounded buffer `stderr` resolves with.
    if (onStderr) {
      try {
        onStderr(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      } catch {
        // A caller's parser throwing must never take down the spawn — `stderr`/`exit` are the
        // only channels this port promises, and both must still resolve normally.
      }
    }
    if (truncated) return;
    if (total + chunk.length > MAX_STDERR_BYTES) {
      chunks.push(chunk.subarray(0, MAX_STDERR_BYTES - total));
      truncated = true;
      return;
    }
    chunks.push(chunk);
    total += chunk.length;
  });
  return new Promise((resolve) => {
    stream.on("end", () => {
      const marker = truncated ? Buffer.from(TRUNCATION_MARKER, "utf8") : Buffer.alloc(0);
      resolve(new Uint8Array(Buffer.concat([...chunks, marker])));
    });
    stream.on("error", () => resolve(new Uint8Array(Buffer.concat(chunks))));
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<ProcessExit> {
  return new Promise((resolve, reject) => {
    let spawnFailed = false;
    let settled = false;

    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (spawnFailed || settled) return;
      settled = true;
      resolve({ code, signal });
    };

    child.on("error", (err) => {
      if (child.exitCode === null && child.signalCode === null) {
        spawnFailed = true;
        settled = true;
        reject(new ProcessSpawnError(child.spawnfile, err));
      }
    });
    // 'exit' and 'close' both, not just 'close': under this sandbox's Bun runtime, one has
    // been observed to occasionally never fire for a child that has genuinely already exited
    // (confirmed absent under real Node, 150+ clean runs — production never runs Bun, §8.1,
    // so this is a test-environment concern, not a correctness bug this code can fix). A
    // watchdog polling `exitCode`/`signalCode` was tried and does not help: those fields go
    // unset in the same failure, meaning the underlying process is a genuine unreaped zombie
    // at the OS level — not a JS-observable race this process can detect or recover from.
    child.on("exit", (code, sig) => settle(code, sig));
    child.on("close", (code, sig) => settle(code, sig));
  });
}

export class NodeProcessRunner implements ProcessRunner {
  spawn(executable: string, request: SpawnRequest): SpawnedProcess {
    const child = nodeSpawn(executable, [...request.argv], {
      cwd: request.cwd,
      env: { ...request.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      // Own process group, so kill() (killGroup, below) can reach a child's own descendants.
      detached: true,
    });

    const process_ = new NodeSpawnedProcess(child, request.signal, request.onStderr);

    if (request.stdin !== undefined) {
      pumpStdin(child.stdin, request.stdin).catch(() => {
        // A write failure here means the process died or closed stdin early; `exit`/`stderr`
        // carry the actual failure signal, so this is not a second error path.
      });
    }

    return process_;
  }
}
