import { describe, expect, test } from "bun:test";
import { type CatFileSession, openGitDriver } from "./driver.ts";
import { GitCancelled, GitError } from "./errors.ts";
import { FakeProcessRunner, fakeResolvedGit, flushUntil, noopCatFileSession } from "./testFakes.ts";

const noopCatFile: CatFileSession = noopCatFileSession();

/** `read.done` only settles once `read.bytes` has been driven to completion (driver.ts's
 *  `read()` doc comment) — every test that checks `done` must drain `bytes` first, exactly as
 *  every real caller in queries.ts does. */
async function drain(bytes: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const _chunk of bytes) {
    // discard
  }
}

describe("openGitDriver — argv and env", () => {
  test("read() prepends the config overrides, --no-pager, and --no-optional-locks", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile);

    const read = driver.read(["log", "--format=%H"]);
    await Promise.resolve();
    await Promise.resolve();
    const proc = runner.processes.at(-1);
    expect(proc).toBeDefined();
    proc?.finish(0);
    await drain(read.bytes);
    await read.done;

    const call = runner.calls.at(-1);
    expect(call?.executable).toBe(git.path);
    expect(call?.request.argv).toEqual([
      "-c",
      "core.quotepath=false",
      "-c",
      "color.ui=false",
      "-c",
      "log.showSignature=false",
      "-c",
      "i18n.logOutputEncoding=UTF-8",
      "--no-pager",
      "--no-optional-locks",
      "log",
      "--format=%H",
    ]);
  });

  test("write() carries the same config overrides but never --no-optional-locks", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile);

    const writePromise = driver.write(["commit", "-m", "msg"]);
    await Promise.resolve();
    await Promise.resolve();
    const proc = runner.processes.at(-1);
    proc?.finish(0);
    await writePromise;

    const call = runner.calls.at(-1);
    expect(call?.request.argv).toEqual([
      "-c",
      "core.quotepath=false",
      "-c",
      "color.ui=false",
      "-c",
      "log.showSignature=false",
      "-c",
      "i18n.logOutputEncoding=UTF-8",
      "--no-pager",
      "commit",
      "-m",
      "msg",
    ]);
    expect(call?.request.argv).not.toContain("--no-optional-locks");
  });

  test("every spawn's env carries the §4.3 hygiene", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile);

    const writePromise = driver.write(["status"]);
    await Promise.resolve();
    await Promise.resolve();
    runner.processes.at(-1)?.finish(0);
    await writePromise;

    const env = runner.calls.at(-1)?.request.env;
    expect(env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env?.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(env?.GIT_PAGER).toBe("cat");
    expect(env?.LC_ALL).toBe("C");
  });
});

describe("openGitDriver — read pool bound", () => {
  test("never spawns more concurrent reads than the configured bound", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile, { readConcurrency: 2 });

    const reads = [driver.read(["a"]), driver.read(["b"]), driver.read(["c"]), driver.read(["d"])];
    // Let every read's pool-acquire microtask chain settle.
    await flushUntil(() => runner.processes.length >= 2);

    expect(runner.processes.length).toBe(2); // bound respected: only the first two have started

    // Finishing one frees a pool slot for the next queued read.
    runner.processes[0]?.finish(0);
    if (reads[0]) await drain(reads[0].bytes);
    await reads[0]?.done;
    await flushUntil(() => runner.processes.length >= 3);
    expect(runner.processes.length).toBe(3);

    runner.processes[1]?.finish(0);
    runner.processes[2]?.finish(0);
    if (reads[1]) await drain(reads[1].bytes);
    if (reads[2]) await drain(reads[2].bytes);
    await Promise.all([reads[1]?.done, reads[2]?.done]);
    await flushUntil(() => runner.processes.length >= 4);
    expect(runner.processes.length).toBe(4);
    runner.processes[3]?.finish(0);
    if (reads[3]) await drain(reads[3].bytes);
    await reads[3]?.done;
  });
});

describe("openGitDriver — write queue", () => {
  test("serializes a burst of ten writes: never two in flight at once", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile);

    const results = Array.from({ length: 10 }, (_, i) => driver.write(["tag", `t${i}`]));

    for (let round = 0; round < 10; round++) {
      await flushUntil(() => runner.processes.length === round + 1);
      expect(runner.processes.length).toBe(round + 1);
      // Exactly one write process should be outstanding at a time.
      const outstanding = runner.processes.filter((p) => !p.settled);
      expect(outstanding.length).toBeLessThanOrEqual(1);
      runner.processes.at(-1)?.finish(0);
    }

    await Promise.all(results);
    expect(runner.processes).toHaveLength(10);
  });

  test("an abort on an in-flight write is a no-op; the write still completes", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile);

    const controller = new AbortController();
    const writePromise = driver.write(["commit", "-m", "x"], { signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();
    // The write has already started (spawned) by the time we abort.
    controller.abort();
    const proc = runner.processes.at(-1);
    proc?.finish(0, "");
    const result = await writePromise;
    expect(result.stdout).toBeInstanceOf(Uint8Array);
    expect(proc?.killedWith).toEqual([]); // never killed — only queued writes are cancellable
  });

  test("an abort on a still-queued write removes it and rejects with GitCancelled", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile);

    const controller = new AbortController();
    const firstWrite = driver.write(["tag", "first"]);
    const queuedWrite = driver.write(["tag", "queued"], { signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();

    controller.abort(); // still queued behind `firstWrite` — removable
    await expect(queuedWrite).rejects.toBeInstanceOf(GitCancelled);

    runner.processes.at(-1)?.finish(0);
    await firstWrite;
    expect(runner.processes).toHaveLength(1); // the cancelled write never spawned at all
  });
});

describe("openGitDriver — read cancellation", () => {
  test("cancel() kills the process and done rejects with GitCancelled", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile);

    const read = driver.read(["log", "--all"]);
    await Promise.resolve();
    await Promise.resolve();
    const proc = runner.processes.at(-1);
    expect(proc).toBeDefined();

    read.cancel();
    await drain(read.bytes);
    await expect(read.done).rejects.toBeInstanceOf(GitCancelled);
    expect(proc?.killedWith).toContain("SIGTERM");
  });

  test("a failed read (non-zero exit) rejects with a classified GitError, not GitCancelled", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile);

    const read = driver.read(["show", "badsha"]);
    await Promise.resolve();
    await Promise.resolve();
    runner.processes.at(-1)?.finish(128, "fatal: invalid reference: badsha\n");

    await drain(read.bytes);
    await expect(read.done).rejects.toBeInstanceOf(GitError);
  });
});

describe("openGitDriver — invalidation", () => {
  test("a completed write bumps generation and fires onInvalidated listeners", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile);

    let firedCount = 0;
    driver.onInvalidated(() => {
      firedCount++;
    });
    expect(driver.generation).toBe(0);

    const writePromise = driver.write(["tag", "v1"]);
    await Promise.resolve();
    await Promise.resolve();
    runner.processes.at(-1)?.finish(0);
    await writePromise;

    expect(driver.generation).toBe(1);
    expect(firedCount).toBe(1);
  });

  test("a failed write does not bump generation or fire listeners", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    const driver = openGitDriver(git, runner, "/repo", noopCatFile);

    let fired = false;
    driver.onInvalidated(() => {
      fired = true;
    });

    const writePromise = driver.write(["tag", "bad"]);
    await Promise.resolve();
    await Promise.resolve();
    runner.processes.at(-1)?.finish(128, "fatal: invalid reference\n");
    await expect(writePromise).rejects.toBeInstanceOf(GitError);

    expect(driver.generation).toBe(0);
    expect(fired).toBe(false);
  });

  test("dispose() rejects queued writes and disposes the cat-file session", async () => {
    const runner = new FakeProcessRunner();
    const git = await fakeResolvedGit();
    let catFileDisposed = false;
    const catFile: CatFileSession = {
      ...noopCatFileSession(),
      dispose: () => {
        catFileDisposed = true;
      },
    };
    const driver = openGitDriver(git, runner, "/repo", catFile);

    const first = driver.write(["tag", "a"]);
    const queued = driver.write(["tag", "b"]);
    await Promise.resolve();
    await Promise.resolve();

    driver.dispose();
    await expect(queued).rejects.toBeInstanceOf(GitCancelled);
    expect(catFileDisposed).toBe(true);

    runner.processes.at(-1)?.finish(0);
    await first;
  });
});
