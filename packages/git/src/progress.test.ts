import { describe, expect, test } from "bun:test";
import { createProgressParser, type ParsedProgress } from "./progress.ts";

function feed(transcript: string, chunkSize?: number): ParsedProgress[] {
  const emitted: ParsedProgress[] = [];
  const onChunk = createProgressParser((p) => emitted.push(p));
  const bytes = new TextEncoder().encode(transcript);
  if (chunkSize === undefined) {
    onChunk(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      onChunk(bytes.subarray(i, i + chunkSize));
    }
  }
  return emitted;
}

describe("createProgressParser — push transcript (probe 5)", () => {
  // "Enumerating objects: 5, done.\nCounting objects:  20% (1/5)\rCounting objects:  40% (2/5)\r
  //  Counting objects:  60% (3/5)\rCounting objects:  80% (4/5)\rCounting objects: 100% (5/5),
  //  done.\nWriting objects: 100% (3/3), 217 bytes | 217.00 KiB/s, done.\n
  //  Total 3 (delta 0), reused 0 (delta 0), pack-reused 0\n"
  const transcript =
    "Enumerating objects: 5, done.\n" +
    "Counting objects:  20% (1/5)\r" +
    "Counting objects:  40% (2/5)\r" +
    "Counting objects:  60% (3/5)\r" +
    "Counting objects:  80% (4/5)\r" +
    "Counting objects: 100% (5/5), done.\n" +
    "Writing objects: 100% (3/3), 217 bytes | 217.00 KiB/s, done.\n" +
    "Total 3 (delta 0), reused 0 (delta 0), pack-reused 0\n";

  test("emits the exact recognised sequence, in order, all remote:false", () => {
    const emitted = feed(transcript);
    expect(emitted).toEqual([
      { phase: "Enumerating objects", done: 5, remote: false },
      { phase: "Counting objects", percent: 20, done: 1, total: 5, remote: false },
      { phase: "Counting objects", percent: 40, done: 2, total: 5, remote: false },
      { phase: "Counting objects", percent: 60, done: 3, total: 5, remote: false },
      { phase: "Counting objects", percent: 80, done: 4, total: 5, remote: false },
      { phase: "Counting objects", percent: 100, done: 5, total: 5, remote: false },
      { phase: "Writing objects", percent: 100, done: 3, total: 3, remote: false },
      // "Total 3 (delta 0), reused 0 (delta 0), pack-reused 0" matches neither pattern —
      // dropped from progress, exactly per spec.
    ]);
  });

  test("byte-for-byte identical when delivered as a single chunk vs. one byte at a time", () => {
    const whole = feed(transcript);
    const oneByte = feed(transcript, 1);
    expect(oneByte).toEqual(whole);
  });

  test("split at a pathological offset mid-percentage still emits correctly", () => {
    // Split right inside "Counting objects: 100%" — after "Counting objects: 10", before "0%".
    const idx = transcript.indexOf("Counting objects: 100% (5/5)") + "Counting objects: 10".length;
    const baseline = feed(transcript);
    const bytes = new TextEncoder().encode(transcript);
    const emittedSplit: ParsedProgress[] = [];
    const onChunk = createProgressParser((p) => emittedSplit.push(p));
    onChunk(bytes.subarray(0, idx));
    onChunk(bytes.subarray(idx));
    expect(emittedSplit).toEqual(baseline);
  });
});

describe("createProgressParser — fetch transcript (probe 6)", () => {
  // remote: (server-side) phases prefixed; local phases (Receiving/Resolving) are not; trailing
  // "From …" and the ref-update line are not progress at all.
  const transcript =
    "remote: Enumerating objects: 91, done.\n" +
    "remote: Counting objects:  31% (29/91)\r" +
    "remote: Counting objects: 100% (91/91)\r" +
    "remote: Counting objects: 100% (91/91), done.\n" +
    "remote: Compressing objects: 100% (88/88), done.\n" +
    "Receiving objects: 100% (89/89), 3.42 MiB | 12.10 MiB/s, done.\n" +
    "Resolving deltas: 100% (74/74), completed with 1 local object.\n" +
    "From /path/to/rem\n" +
    "   d876420..b5c3142  main       -> origin/main\n";

  test("emits the exact recognised sequence with remote:true/false split correctly", () => {
    const emitted = feed(transcript);
    expect(emitted).toEqual([
      { phase: "Enumerating objects", done: 91, remote: true },
      { phase: "Counting objects", percent: 31, done: 29, total: 91, remote: true },
      { phase: "Counting objects", percent: 100, done: 91, total: 91, remote: true },
      { phase: "Counting objects", percent: 100, done: 91, total: 91, remote: true },
      { phase: "Compressing objects", percent: 100, done: 88, total: 88, remote: true },
      { phase: "Receiving objects", percent: 100, done: 89, total: 89, remote: false },
      { phase: "Resolving deltas", percent: 100, done: 74, total: 74, remote: false },
      // "From /path/to/rem" and the "   d876420..b5c3142  main -> origin/main" ref-update line
      // match neither pattern — dropped from progress, exactly as the fetch-progress framing
      // note says: they are the ref-update block, not progress.
    ]);
  });

  test("byte-for-byte identical split one byte at a time", () => {
    expect(feed(transcript, 1)).toEqual(feed(transcript));
  });
});

describe("createProgressParser — edge cases", () => {
  test("a trivially small local-transport op that emits no progress at all is normal", () => {
    expect(feed("")).toEqual([]);
  });

  test("a trailing partial line with no terminator yet is never emitted", () => {
    const emitted: ParsedProgress[] = [];
    const onChunk = createProgressParser((p) => emitted.push(p));
    onChunk(new TextEncoder().encode("Counting objects:  50% (5/10)")); // no \r or \n yet
    expect(emitted).toEqual([]);
    onChunk(new TextEncoder().encode("\r"));
    expect(emitted).toEqual([
      { phase: "Counting objects", percent: 50, done: 5, total: 10, remote: false },
    ]);
  });

  test("an empty line between terminators is silently skipped, not emitted as garbage", () => {
    const emitted = feed("\n\n\rCounting objects: 5, done.\n");
    expect(emitted).toEqual([{ phase: "Counting objects", done: 5, remote: false }]);
  });

  test("a line matching neither pattern is dropped, and parsing continues after it", () => {
    const emitted = feed("some unrelated line\nCounting objects: 5, done.\n");
    expect(emitted).toEqual([{ phase: "Counting objects", done: 5, remote: false }]);
  });

  test("a multi-byte UTF-8 character split across chunks decodes correctly", () => {
    // "Résolving" — é is 2 bytes in UTF-8; split the callback's chunk right inside it.
    const line = "Résolving deltas: 100% (1/1)\n";
    const bytes = new TextEncoder().encode(line);
    const splitIndex = line.indexOf("R") + 2; // inside the 2-byte 'é' sequence
    const emitted: ParsedProgress[] = [];
    const onChunk = createProgressParser((p) => emitted.push(p));
    onChunk(bytes.subarray(0, splitIndex));
    onChunk(bytes.subarray(splitIndex));
    expect(emitted).toEqual([
      { phase: "Résolving deltas", percent: 100, done: 1, total: 1, remote: false },
    ]);
  });
});
