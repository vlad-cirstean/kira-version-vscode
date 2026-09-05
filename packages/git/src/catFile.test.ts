import { describe, expect, test } from "bun:test";
import { openCatFileSession } from "./catFile.ts";
import { FakeProcessRunner, fakeResolvedGit, flushUntil } from "./testFakes.ts";

const encoder = new TextEncoder();

function headerAndContent(oid: string, type: string, content: Uint8Array): Uint8Array {
  const header = encoder.encode(`${oid} ${type} ${content.length}\n`);
  const trailer = encoder.encode("\n");
  const out = new Uint8Array(header.length + content.length + trailer.length);
  out.set(header, 0);
  out.set(content, header.length);
  out.set(trailer, header.length + content.length);
  return out;
}

function checkHeader(oid: string, type: string, size: number): Uint8Array {
  return encoder.encode(`${oid} ${type} ${size}\n`);
}

function missingLine(oid: string): Uint8Array {
  return encoder.encode(`${oid} missing\n`);
}

// Splits a byte sequence into N roughly-even pieces, to feed a state machine chunk by chunk
// at arbitrary boundaries — including mid-header and mid-content splits.
function splitInto(bytes: Uint8Array, pieces: number): Uint8Array[] {
  const size = Math.max(1, Math.ceil(bytes.length / pieces));
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

describe("openCatFileSession — found, small blob", () => {
  test("reads a text blob byte-identically, via --batch-check then --batch", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const session = openCatFileSession(git, runner, "/repo");
    const oid = "a".repeat(40);
    const content = encoder.encode("hello\nworld\n");

    const resultPromise = session.read(oid);
    await flushUntil(() => runner.processes.length >= 1);
    const checkProc = runner.processes[0];
    expect(checkProc).toBeDefined();
    checkProc?.emitStdout(checkHeader(oid, "blob", content.length));

    await flushUntil(() => runner.processes.length >= 2);
    const batchProc = runner.processes[1];
    expect(batchProc).toBeDefined();
    batchProc?.emitStdout(headerAndContent(oid, "blob", content));

    const result = await resultPromise;
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.type).toBe("blob");
      expect(result.size).toBe(content.length);
      expect(Buffer.from(result.content).equals(Buffer.from(content))).toBe(true);
    }

    session.dispose();
  });

  test("a binary blob with embedded NUL and LF bytes round-trips exactly", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const session = openCatFileSession(git, runner, "/repo");
    const oid = "b".repeat(40);
    const content = new Uint8Array([0x00, 0x0a, 0xff, 0x0a, 0x00, 0x01, 0x0a]);

    const resultPromise = session.read(oid);
    await flushUntil(() => runner.processes.length >= 1);
    runner.processes[0]?.emitStdout(checkHeader(oid, "blob", content.length));
    await flushUntil(() => runner.processes.length >= 2);
    runner.processes[1]?.emitStdout(headerAndContent(oid, "blob", content));

    const result = await resultPromise;
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(Buffer.from(result.content).equals(Buffer.from(content))).toBe(true);
    }
  });

  test("parses correctly no matter how the response is chunked across the wire", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const session = openCatFileSession(git, runner, "/repo");
    const oid = "c".repeat(40);
    const content = encoder.encode(
      "a fairly long blob body used to exercise chunk splits across the header/content boundary",
    );

    const resultPromise = session.read(oid);
    await flushUntil(() => runner.processes.length >= 1);
    for (const piece of splitInto(checkHeader(oid, "blob", content.length), 5)) {
      runner.processes[0]?.emitStdout(piece);
    }
    await flushUntil(() => runner.processes.length >= 2);
    for (const piece of splitInto(headerAndContent(oid, "blob", content), 7)) {
      runner.processes[1]?.emitStdout(piece);
    }

    const result = await resultPromise;
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(Buffer.from(result.content).equals(Buffer.from(content))).toBe(true);
    }
  });
});

describe("openCatFileSession — missing and tooLarge", () => {
  test("a missing oid short-circuits before the --batch process is ever spawned", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const session = openCatFileSession(git, runner, "/repo");
    const oid = "d".repeat(40);

    const resultPromise = session.read(oid);
    await flushUntil(() => runner.processes.length >= 1);
    runner.processes[0]?.emitStdout(missingLine(oid));

    const result = await resultPromise;
    expect(result).toEqual({ kind: "missing", oid });
    // Only the --batch-check process was ever spawned for a missing object.
    expect(runner.processes).toHaveLength(1);
  });

  test("a blob over the size gate returns tooLarge without spawning --batch", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const session = openCatFileSession(git, runner, "/repo", { maxBlobBytes: 1024 });
    const oid = "e".repeat(40);

    const resultPromise = session.read(oid);
    await flushUntil(() => runner.processes.length >= 1);
    runner.processes[0]?.emitStdout(checkHeader(oid, "blob", 5_000_000));

    const result = await resultPromise;
    expect(result).toEqual({ kind: "tooLarge", oid, type: "blob", size: 5_000_000 });
    expect(runner.processes).toHaveLength(1); // no --batch spawn — the whole point of the gate
  });
});

describe("openCatFileSession — <rev>:<path> requests with spaces (P1 fix)", () => {
  test("a missing <rev>:<path> whose path contains spaces is still recognised as missing", async () => {
    // The missing reply echoes the raw request string verbatim — `#tryParseHeader` used to
    // split on space and count fields, which broke as soon as the echoed request itself had
    // more than one space in it (space in the ref, "HEAD:my file.txt" being just one example).
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const session = openCatFileSession(git, runner, "/repo");
    const request = "HEAD:my file with several spaces.txt";

    const resultPromise = session.read(request);
    await flushUntil(() => runner.processes.length >= 1);
    runner.processes[0]?.emitStdout(missingLine(request));

    const result = await resultPromise;
    expect(result).toEqual({ kind: "missing", oid: request });
    expect(runner.processes).toHaveLength(1);
  });

  test("a found <rev>:<path> whose path contains spaces still resolves via the clean oid", async () => {
    // The found reply's first field is always the resolved 40-hex oid, never the echoed
    // request — so this direction was never actually broken, but it must stay that way.
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const session = openCatFileSession(git, runner, "/repo");
    const request = "HEAD:my file with several spaces.txt";
    const resolvedOid = "a".repeat(40);
    const content = encoder.encode("hello\n");

    const resultPromise = session.read(request);
    await flushUntil(() => runner.processes.length >= 1);
    runner.processes[0]?.emitStdout(checkHeader(resolvedOid, "blob", content.length));
    await flushUntil(() => runner.processes.length >= 2);
    runner.processes[1]?.emitStdout(headerAndContent(resolvedOid, "blob", content));

    const result = await resultPromise;
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.type).toBe("blob");
      expect(Buffer.from(result.content).equals(Buffer.from(content))).toBe(true);
    }
  });
});

describe("openCatFileSession — request serialization", () => {
  test("does not write the second oid until the first response has arrived", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const session = openCatFileSession(git, runner, "/repo");
    const oidA = "1".repeat(40);
    const oidB = "2".repeat(40);
    const contentA = encoder.encode("A");
    const contentB = encoder.encode("B");

    const first = session.read(oidA);
    const second = session.read(oidB);
    await flushUntil(() => runner.processes.length >= 1);
    const checkProc = runner.processes[0];
    expect(checkProc?.writes).toHaveLength(1);
    expect(new TextDecoder().decode(checkProc?.writes[0])).toBe(`${oidA}\n`);

    checkProc?.emitStdout(checkHeader(oidA, "blob", contentA.length));
    await flushUntil(() => runner.processes.length >= 2);
    runner.processes[1]?.emitStdout(headerAndContent(oidA, "blob", contentA));
    await first;

    // Only now should the check process have been asked about the second oid.
    await flushUntil(() => (checkProc?.writes.length ?? 0) >= 2);
    expect(checkProc?.writes).toHaveLength(2);
    expect(new TextDecoder().decode(checkProc?.writes[1])).toBe(`${oidB}\n`);

    checkProc?.emitStdout(checkHeader(oidB, "blob", contentB.length));
    await flushUntil(() => runner.processes.length >= 2);
    runner.processes[1]?.emitStdout(headerAndContent(oidB, "blob", contentB));
    const result = await second;
    expect(result.kind).toBe("found");
  });
});

describe("openCatFileSession — crash and restart", () => {
  test("killing the batch process fails the in-flight request; the next request restarts it", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const session = openCatFileSession(git, runner, "/repo");
    const oidA = "3".repeat(40);
    const oidB = "4".repeat(40);
    const content = encoder.encode("ok");

    const first = session.read(oidA);
    await flushUntil(() => runner.processes.length >= 1);
    runner.processes[0]?.emitStdout(checkHeader(oidA, "blob", content.length));
    await flushUntil(() => runner.processes.length >= 2);
    const firstBatchProc = runner.processes[1];

    firstBatchProc?.kill(); // simulate the batch process dying mid-request
    await expect(first).rejects.toBeInstanceOf(Error);

    // The --batch-check process was never killed, so it stays alive and answers the second
    // request itself — only --batch needs to respawn.
    const second = session.read(oidB);
    await flushUntil(() => (runner.processes[0]?.writes.length ?? 0) >= 2);
    runner.processes[0]?.emitStdout(checkHeader(oidB, "blob", content.length));
    await flushUntil(() => runner.processes.length >= 3);
    const restartedBatchProc = runner.processes[2];
    expect(restartedBatchProc).not.toBe(firstBatchProc);
    restartedBatchProc?.emitStdout(headerAndContent(oidB, "blob", content));

    const result = await second;
    expect(result.kind).toBe("found");
  });
});

describe("openCatFileSession — dispose", () => {
  test("kills both underlying processes and leaves nothing running", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const session = openCatFileSession(git, runner, "/repo");
    const oid = "5".repeat(40);
    const content = encoder.encode("x");

    const readPromise = session.read(oid).catch(() => {});
    await flushUntil(() => runner.processes.length >= 1);
    runner.processes[0]?.emitStdout(checkHeader(oid, "blob", content.length));
    await flushUntil(() => runner.processes.length >= 2);

    session.dispose();
    await readPromise;
    for (const proc of runner.processes) {
      expect(proc.killedWith.length).toBeGreaterThan(0);
    }
  });

  test("a request after dispose() is rejected rather than spawning anything new", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const session = openCatFileSession(git, runner, "/repo");
    session.dispose();

    await expect(session.read("f".repeat(40))).rejects.toBeInstanceOf(Error);
    expect(runner.processes).toHaveLength(0);
  });
});
