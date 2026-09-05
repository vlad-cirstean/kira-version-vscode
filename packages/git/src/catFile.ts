/**
 * A persistent `git cat-file --batch`/`--batch-check` per repo (§3.2, §4.3), avoiding a
 * process spawn per blob read. Two persistent processes, not one: `--batch-check` is probed
 * first for every read, and its response is metadata only — no blob content ever crosses the
 * pipe — so a multi-gigabyte blob costs nothing until `read()` has actually decided (via the
 * size gate) that it wants the bytes. Only then does the `--batch` process get asked.
 *
 * The wire protocol has no request ids: `<oid>\n` on stdin yields exactly one response, in
 * order. Requests are therefore serialized one at a time per process — pipelining would be
 * faster but adds nothing P1 needs and doubles the ways this state machine can be wrong.
 *
 * P5 W3 adds `check()`, exposing the already-open `--batch-check` process directly: turning a
 * binary diff's two blob oids into byte sizes (`RepoService.fileDiff`) needs only the size, and
 * routing that through `read()` would pay for a blob's content that is never displayed.
 */
import type { ProcessRunner, SpawnedProcess } from "@kira-version/core";
import type { ResolvedGit } from "./discovery.ts";
import type { CatFileResult, CatFileSession, Disposable } from "./driver.ts";
import { buildGitArgv, buildGitEnv } from "./driver.ts";

// Re-exported so existing importers of `CatFileResult` from this file (and `index.ts`'s own
// re-export) keep working — the type itself now lives in driver.ts, see that file's comment.
export type { CatFileResult } from "./driver.ts";

export interface CatFileSessionOptions {
  /** Above this size, `read()` returns `tooLarge` instead of allocating the blob — the
   *  "too large to display" copy itself is P5's, this is just the gate. */
  readonly maxBlobBytes?: number;
}

/** P5 W3's `blob()` uses this to report `limitBytes` on a `tooLarge` result without repeating
 *  the literal. */
export const DEFAULT_MAX_BLOB_BYTES = 10 * 1024 * 1024;
const MAX_CONSECUTIVE_FAILURES = 3;

// ---------------------------------------------------------------------------------------
// A minimal, purpose-built byte buffer: accumulate chunks, search for LF without copying
// until a header is actually complete, and hand out exact byte counts for blob content.
// ---------------------------------------------------------------------------------------

class ByteBuffer {
  #chunks: Uint8Array[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#length += chunk.length;
  }

  /** Byte offset of the first `target` byte, or -1 if not yet buffered. */
  indexOf(target: number): number {
    let offset = 0;
    for (const chunk of this.#chunks) {
      const idx = chunk.indexOf(target);
      if (idx !== -1) return offset + idx;
      offset += chunk.length;
    }
    return -1;
  }

  /** Consumes and returns exactly `n` bytes. Throws if fewer than `n` are buffered — callers
   *  must check `length` (or `indexOf`) first. */
  take(n: number): Uint8Array {
    if (n > this.#length)
      throw new RangeError(`ByteBuffer.take(${n}): only ${this.#length} buffered`);
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.#chunks[0];
      if (!chunk) throw new Error("unreachable: length accounting says bytes remain");
      const remaining = n - offset;
      if (chunk.length <= remaining) {
        out.set(chunk, offset);
        offset += chunk.length;
        this.#chunks.shift();
      } else {
        out.set(chunk.subarray(0, remaining), offset);
        this.#chunks[0] = chunk.subarray(remaining);
        offset += remaining;
      }
    }
    this.#length -= n;
    return out;
  }
}

// ---------------------------------------------------------------------------------------
// The state machine: header line, then (for --batch only) exactly `size` bytes plus a
// trailing LF. --batch-check never has a content phase — its response is the header alone.
// ---------------------------------------------------------------------------------------

const decoder = new TextDecoder("utf-8", { fatal: false });
const LF = 0x0a;

type ParseState =
  | { readonly mode: "header" }
  | {
      readonly mode: "content";
      readonly oid: string;
      readonly type: string;
      readonly size: number;
    };

class BatchStreamReader {
  readonly #buffer = new ByteBuffer();
  readonly #hasContentPhase: boolean;
  #state: ParseState = { mode: "header" };

  constructor(hasContentPhase: boolean) {
    this.#hasContentPhase = hasContentPhase;
  }

  push(chunk: Uint8Array): CatFileResult[] {
    this.#buffer.push(chunk);
    const out: CatFileResult[] = [];
    for (;;) {
      if (this.#state.mode === "header") {
        const parsed = this.#tryParseHeader();
        if (!parsed) break;
        if (parsed.kind === "missing") {
          out.push(parsed);
          continue;
        }
        if (!this.#hasContentPhase) {
          out.push({ ...parsed, content: new Uint8Array(0) });
          continue;
        }
        this.#state = { mode: "content", oid: parsed.oid, type: parsed.type, size: parsed.size };
        continue;
      }

      // mode === "content": exactly `size` bytes, then the protocol's trailing LF.
      const needed = this.#state.size + 1;
      if (this.#buffer.length < needed) break;
      const content = this.#buffer.take(this.#state.size);
      this.#buffer.take(1); // the trailing LF
      out.push({
        kind: "found",
        oid: this.#state.oid,
        type: this.#state.type,
        size: this.#state.size,
        content,
      });
      this.#state = { mode: "header" };
    }
    return out;
  }

  #tryParseHeader():
    | { kind: "missing"; oid: string }
    | { kind: "found"; oid: string; type: string; size: number }
    | undefined {
    const lfIndex = this.#buffer.indexOf(LF);
    if (lfIndex === -1) return undefined;
    const line = decoder.decode(this.#buffer.take(lfIndex));
    this.#buffer.take(1); // the header's own terminating LF
    // The `missing` reply echoes the *input string* verbatim, which for P5's `<rev>:<path>`
    // requests can itself contain spaces (`HEAD:my file.txt missing`) — splitting on space and
    // counting fields breaks on exactly that input. Recognise the reply by its fixed suffix
    // instead, and treat everything before it as the echoed request, however many spaces it has.
    const MISSING_SUFFIX = " missing";
    if (line.endsWith(MISSING_SUFFIX)) {
      const oid = line.slice(0, -MISSING_SUFFIX.length);
      if (oid) return { kind: "missing", oid };
    }
    // The found reply's first field is always a clean, resolved 40-hex oid — never the raw
    // request string — so splitting on space is safe here regardless of what `path` contained.
    const parts = line.split(" ");
    if (parts.length === 3 && parts[0] && parts[1]) {
      const size = Number(parts[2]);
      if (Number.isFinite(size)) return { kind: "found", oid: parts[0], type: parts[1], size };
    }
    throw new Error(`git cat-file --batch: unrecognised header line ${JSON.stringify(line)}`);
  }
}

// ---------------------------------------------------------------------------------------
// One persistent process (either flavour), with FIFO one-at-a-time request serialization
// and lazy, bounded-retry restart.
// ---------------------------------------------------------------------------------------

interface QueuedRequest {
  readonly oid: string;
  readonly resolve: (result: CatFileResult) => void;
  readonly reject: (err: unknown) => void;
}

class PersistentBatchProcess implements Disposable {
  readonly #runner: ProcessRunner;
  readonly #git: ResolvedGit;
  readonly #repoRoot: string;
  readonly #flag: "--batch" | "--batch-check";
  readonly #reader: BatchStreamReader;
  readonly #queue: QueuedRequest[] = [];

  #proc: SpawnedProcess | undefined;
  #inFlight: QueuedRequest | undefined;
  #consecutiveFailures = 0;
  #broken = false;
  #disposed = false;

  constructor(
    runner: ProcessRunner,
    git: ResolvedGit,
    repoRoot: string,
    flag: "--batch" | "--batch-check",
  ) {
    this.#runner = runner;
    this.#git = git;
    this.#repoRoot = repoRoot;
    this.#flag = flag;
    this.#reader = new BatchStreamReader(flag === "--batch");
  }

  request(oid: string): Promise<CatFileResult> {
    if (this.#disposed) return Promise.reject(new Error("cat-file session disposed"));
    if (this.#broken) {
      return Promise.reject(
        new Error(
          `git cat-file ${this.#flag} has failed to start ${MAX_CONSECUTIVE_FAILURES} times in a row`,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      this.#queue.push({ oid, resolve, reject });
      this.#pump();
    });
  }

  #ensureStarted(): void {
    if (this.#proc) return;
    const proc = this.#runner.spawn(this.#git.path, {
      argv: buildGitArgv(["cat-file", this.#flag], true),
      cwd: this.#repoRoot,
      env: buildGitEnv(),
    });
    this.#proc = proc;
    proc.exit.then(
      () => this.#handleExit(),
      () => this.#handleExit(),
    );
    this.#runReadLoop(proc);
  }

  async #runReadLoop(proc: SpawnedProcess): Promise<void> {
    try {
      for await (const chunk of proc.stdout) {
        this.#consecutiveFailures = 0;
        for (const result of this.#reader.push(chunk)) {
          const entry = this.#inFlight;
          this.#inFlight = undefined;
          entry?.resolve(result);
          this.#pump();
        }
      }
    } catch {
      // The exit handler (wired in #ensureStarted) fails whatever is left outstanding.
    }
  }

  #pump(): void {
    if (this.#inFlight || this.#disposed || this.#broken) return;
    const next = this.#queue.shift();
    if (!next) return;
    this.#inFlight = next;
    this.#ensureStarted();
    this.#proc?.write(new TextEncoder().encode(`${next.oid}\n`)).catch((err) => {
      const entry = this.#inFlight;
      this.#inFlight = undefined;
      entry?.reject(err);
    });
  }

  #handleExit(): void {
    this.#proc = undefined;
    this.#consecutiveFailures++;
    if (this.#consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) this.#broken = true;

    const stranded = this.#inFlight
      ? [this.#inFlight, ...this.#queue.splice(0)]
      : this.#queue.splice(0);
    this.#inFlight = undefined;
    for (const entry of stranded) {
      entry.reject(new Error(`git cat-file ${this.#flag} exited unexpectedly`));
    }
    // Deliberately no auto-respawn here — the next request() lazily restarts (via #pump ->
    // #ensureStarted), bounded by #consecutiveFailures so a permanently broken repo does not
    // spawn in a loop.
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#proc?.kill();
    this.#proc = undefined;
    const stranded = this.#inFlight
      ? [this.#inFlight, ...this.#queue.splice(0)]
      : this.#queue.splice(0);
    this.#inFlight = undefined;
    for (const entry of stranded) entry.reject(new Error("cat-file session disposed"));
  }
}

// ---------------------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------------------

export function openCatFileSession(
  git: ResolvedGit,
  runner: ProcessRunner,
  repoRoot: string,
  opts: CatFileSessionOptions = {},
): CatFileSession {
  const maxBlobBytes = opts.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  const checkProcess = new PersistentBatchProcess(runner, git, repoRoot, "--batch-check");
  const batchProcess = new PersistentBatchProcess(runner, git, repoRoot, "--batch");

  return {
    async read(oid: string): Promise<CatFileResult> {
      const checkResult = await checkProcess.request(oid);
      if (checkResult.kind !== "found") return checkResult;
      if (checkResult.size > maxBlobBytes) {
        return {
          kind: "tooLarge",
          oid: checkResult.oid,
          type: checkResult.type,
          size: checkResult.size,
        };
      }
      return batchProcess.request(oid);
    },
    check(oid: string): Promise<CatFileResult> {
      return checkProcess.request(oid);
    },
    dispose(): void {
      checkProcess.dispose();
      batchProcess.dispose();
    },
  };
}
