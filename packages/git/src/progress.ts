/**
 * P8/W3 — a pure incremental decoder over one remote op's stderr byte stream, per
 * `docs/plans/P8.md`'s "The hard parts" §2. `createProgressParser` is meant to be handed
 * straight to `GitDriver.writeStreaming`'s `onStderr` tee: it never buffers the whole stream,
 * never allocates per byte, and holds only the current partial line across chunk boundaries — a
 * `\r`-delimited update from a real fetch/push can straddle an arbitrary chunk split, and a test
 * below replays exactly that at a pathological offset.
 *
 * Framing (probes 5/6): within one phase, updates are **CR-separated**; a phase ends with LF.
 * Fetch's server-side phases arrive `remote: `-prefixed; everything else does not. A trivially
 * small operation over a local transport can emit *no* progress lines at all — that is normal,
 * not a stall, and this module has no notion of "expected" progress to be silent about.
 *
 * Two recognised shapes, matched in order:
 *   - `NN% (n/N)` — a phase with a percentage: `/^(.+?):\s+(\d+)% \((\d+)\/(\d+)\)/`.
 *   - `N, done.` — a counted phase with no percentage: `/^(.+?):\s+(\d+), done\.$/`.
 * Anything else (a `Total …` summary, the `From …`/ref-update lines a fetch trails with, a plain
 * "done." with nothing before it) is **dropped from progress but not lost** — it is still part of
 * the same stderr byte stream `GitDriver`'s bounded buffer collects independently (this decoder
 * only taps a copy, per `ProcessRunner.SpawnRequest.onStderr`'s own contract) and so still lands
 * wherever `classifyGitError` looks on failure. An unrecognised line is not an error, just not
 * progress.
 */

export interface ParsedProgress {
  /** git's own phase label, verbatim and trimmed: "Counting objects", "Receiving objects", … */
  readonly phase: string;
  /** Absent for a counted-but-unbounded phase ("Enumerating objects: 91, done."). */
  readonly percent?: number;
  readonly done?: number;
  readonly total?: number;
  /** True for a `remote: `-prefixed phase — work happening on the server, not here (probe 6). */
  readonly remote: boolean;
}

const PERCENT_LINE = /^(.+?):\s+(\d+)% \((\d+)\/(\d+)\)/;
const DONE_LINE = /^(.+?):\s+(\d+), done\.$/;
const REMOTE_PREFIX = "remote: ";

function parseLine(rawLine: string): ParsedProgress | undefined {
  const remote = rawLine.startsWith(REMOTE_PREFIX);
  const line = remote ? rawLine.slice(REMOTE_PREFIX.length) : rawLine;

  const percentMatch = PERCENT_LINE.exec(line);
  if (percentMatch) {
    const [, phase, percent, done, total] = percentMatch as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    return {
      phase: phase.trim(),
      percent: Number(percent),
      done: Number(done),
      total: Number(total),
      remote,
    };
  }

  const doneMatch = DONE_LINE.exec(line);
  if (doneMatch) {
    const [, phase, done] = doneMatch as unknown as [string, string, string];
    return { phase: phase.trim(), done: Number(done), remote };
  }

  return undefined;
}

/**
 * Returns a chunk callback — hand it directly to `writeStreaming`'s `onStderr`. Holds a partial
 * line across calls: bytes accumulate in an internal buffer until a `\r` or `\n` completes a
 * line, at which point that line is parsed and, if recognised, `emit`ted. A trailing partial line
 * with no terminator yet (the tail of the byte stream while the process is still running) is
 * simply not processed until more bytes complete it — never a partial/garbled emission.
 */
export function createProgressParser(
  emit: (progress: ParsedProgress) => void,
): (chunk: Uint8Array) => void {
  let buffer = "";
  const decoder = new TextDecoder("utf-8", { fatal: false });

  return (chunk: Uint8Array): void => {
    buffer += decoder.decode(chunk, { stream: true });

    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer[i];
      if (c !== "\r" && c !== "\n") continue;
      const line = buffer.slice(start, i);
      start = i + 1;
      if (line.length === 0) continue;
      const parsed = parseLine(line);
      if (parsed) emit(parsed);
    }
    buffer = buffer.slice(start);
  };
}
