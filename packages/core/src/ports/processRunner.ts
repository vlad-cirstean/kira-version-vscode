/**
 * The narrow interface `packages/git`'s driver spawns every git invocation through. Byte
 * streams, not strings or Node's `child_process` types — this port is implemented once, in
 * `packages/git/src/nodeProcessRunner.ts` (both hosts are Node, so there is exactly one real
 * implementation), and stood in for by a fake in unit tests that assert on exact argv/env
 * without spawning anything.
 *
 * Bytes rather than strings is deliberate: paths and blob content are frequently not valid
 * UTF-8, and decoding here — before any parser sees the data — would corrupt it irreversibly.
 * Decoding happens once per field, in the parser that knows what the field means.
 *
 * P8/W1: the port has exactly one streaming affordance, `onStderr` below — not a second read
 * path. `stderr` still resolves with the complete bounded buffer every existing caller
 * (`classifyGitError`) depends on; `onStderr` is a tee on the same bytes, for progress
 * reporting's benefit, called before each chunk is appended to that buffer.
 */
export interface SpawnRequest {
  /** git's own argv, without the executable path. */
  readonly argv: readonly string[];
  readonly cwd: string;
  /** The complete child environment. Replaces the runner's own env; never merged with it. */
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array | AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
  /** Called with each stderr chunk as it arrives, before it is appended to the buffer that
   *  `stderr` resolves with. Progress reporting (§7.1's `--progress` framing) needs to see
   *  chunks before exit; `classifyGitError` still needs the whole buffer at exit. Both, from
   *  one read — not two read paths that can disagree. Never called after `exit` resolves.
   *  Exceptions thrown by the callback are logged and swallowed: a progress-rendering bug must
   *  not fail a push. */
  readonly onStderr?: (chunk: Uint8Array) => void;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SpawnedProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  /** Always collected, bounded, and available whether or not the process is still running. */
  readonly stderr: Promise<Uint8Array>;
  readonly exit: Promise<ProcessExit>;
  /** For a long-lived process fed on stdin (`cat-file --batch`); rejects if stdin is closed. */
  write(chunk: Uint8Array): Promise<void>;
  kill(signal?: NodeJS.Signals): void;
}

export interface ProcessRunner {
  spawn(executable: string, request: SpawnRequest): SpawnedProcess;
}
