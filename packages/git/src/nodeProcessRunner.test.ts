import { describe, expect, test } from "bun:test";
import { NodeProcessRunner, ProcessSpawnError } from "./nodeProcessRunner.ts";

const runner = new NodeProcessRunner();
const baseEnv = { PATH: process.env.PATH ?? "" };

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("NodeProcessRunner", () => {
  test("streams stdout from a simple command", async () => {
    const proc = runner.spawn("/bin/echo", { argv: ["hello", "world"], cwd: "/", env: baseEnv });
    const out = await collect(proc.stdout);
    expect(out.toString("utf8")).toBe("hello world\n");
    expect(await proc.exit).toEqual({ code: 0, signal: null });
    expect((await proc.stderr).length).toBe(0);
  });

  test("pipes request.stdin through to a one-shot process and closes it", async () => {
    const input = new TextEncoder().encode("piped through cat\n");
    const proc = runner.spawn("/bin/cat", { argv: [], cwd: "/", env: baseEnv, stdin: input });
    const out = await collect(proc.stdout);
    expect(out.toString("utf8")).toBe("piped through cat\n");
    expect((await proc.exit).code).toBe(0);
  });

  test("supports manual write() for a persistent process, then kill()", async () => {
    const proc = runner.spawn("/bin/cat", { argv: [], cwd: "/", env: baseEnv });
    await proc.write(new TextEncoder().encode("line one\n"));
    await proc.write(new TextEncoder().encode("line two\n"));

    const received: Buffer[] = [];
    const reader = (async () => {
      for await (const chunk of proc.stdout) received.push(Buffer.from(chunk));
    })();

    // Give cat a moment to echo what was written before we tear it down.
    await new Promise((resolve) => setTimeout(resolve, 100));
    proc.kill("SIGTERM");
    await reader;

    expect(Buffer.concat(received).toString("utf8")).toBe("line one\nline two\n");
    const exit = await proc.exit;
    expect(exit.signal).toBe("SIGTERM");
  });

  test("handles a large volume of piped data byte-identically", async () => {
    const size = 4 * 1024 * 1024; // 4 MiB — enough to force multiple pipe reads/writes
    const input = new Uint8Array(size);
    for (let i = 0; i < size; i++) input[i] = i % 256;
    const proc = runner.spawn("/bin/cat", { argv: [], cwd: "/", env: baseEnv, stdin: input });
    const out = await collect(proc.stdout);
    expect(out.length).toBe(size);
    expect(out.equals(Buffer.from(input))).toBe(true);
  });

  test("kills the process on abort mid-stream", async () => {
    const controller = new AbortController();
    const proc = runner.spawn("/bin/sleep", {
      argv: ["30"],
      cwd: "/",
      env: baseEnv,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const exit = await proc.exit;
    expect(exit.signal).toBe("SIGTERM");
  });

  test("escalates to SIGKILL when the process ignores SIGTERM", async () => {
    const proc = runner.spawn("/bin/bash", {
      argv: ["-c", "trap '' TERM; sleep 10"],
      cwd: "/",
      env: baseEnv,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    proc.kill();
    const exit = await proc.exit;
    expect(exit.signal).toBe("SIGKILL");
  }, 10_000);

  test("surfaces ENOENT as a typed spawn error rather than an unhandled event", async () => {
    const proc = runner.spawn("/no/such/git-binary", { argv: [], cwd: "/", env: baseEnv });
    await expect(proc.exit).rejects.toBeInstanceOf(ProcessSpawnError);
    const out = await collect(proc.stdout);
    expect(out.length).toBe(0);
  });

  test("bounds and marks truncated stderr", async () => {
    const proc = runner.spawn("/bin/bash", {
      argv: ["-c", "head -c 2000000 /dev/zero | tr '\\0' 'e' 1>&2"],
      cwd: "/",
      env: baseEnv,
    });
    await collect(proc.stdout);
    const err = await proc.stderr;
    expect(err.length).toBeLessThan(1024 * 1024 + 100);
    expect(Buffer.from(err).toString("utf8")).toContain("truncated");
  });

  test("onStderr tees every chunk, and stderr still resolves with the full buffer", async () => {
    const seen: string[] = [];
    const proc = runner.spawn("/bin/bash", {
      argv: ["-c", "printf 'one\\ntwo\\n' 1>&2"],
      cwd: "/",
      env: baseEnv,
      onStderr: (chunk) => seen.push(Buffer.from(chunk).toString("utf8")),
    });
    await collect(proc.stdout);
    const err = await proc.stderr;
    expect(seen.join("")).toBe("one\ntwo\n");
    expect(Buffer.from(err).toString("utf8")).toBe("one\ntwo\n");
  });

  test("a throwing onStderr does not break the spawn — stderr and exit still resolve", async () => {
    const proc = runner.spawn("/bin/bash", {
      argv: ["-c", "printf 'boom\\n' 1>&2"],
      cwd: "/",
      env: baseEnv,
      onStderr: () => {
        throw new Error("progress parser exploded");
      },
    });
    await collect(proc.stdout);
    const err = await proc.stderr;
    expect(Buffer.from(err).toString("utf8")).toBe("boom\n");
    expect((await proc.exit).code).toBe(0);
  });

  test("without onStderr, behavior is byte-for-byte unaffected (no callback path at all)", async () => {
    const proc = runner.spawn("/bin/bash", {
      argv: ["-c", "printf 'plain\\n' 1>&2"],
      cwd: "/",
      env: baseEnv,
    });
    await collect(proc.stdout);
    const err = await proc.stderr;
    expect(Buffer.from(err).toString("utf8")).toBe("plain\n");
  });
});
