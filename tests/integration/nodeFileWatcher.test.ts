import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLogger } from "../../packages/core/src/ports/testFakes.ts";
import { NodeFileWatcher } from "../../packages/git/src/nodeFileWatcher.ts";

/** Polls rather than awaiting a fixed delay: `fs.watch` latency is real and platform-dependent
 *  (§4.5's "re-read state, don't trust the event" caveat), so a test should return as soon as
 *  something arrives instead of always paying the worst case. */
async function waitFor(predicate: () => boolean, maxMs = 5000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("NodeFileWatcher", () => {
  test("a file write inside a watched directory produces an event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kira-watch-"));
    const watcher = new NodeFileWatcher();
    const events: { path: string; kind: string }[] = [];
    const sub = watcher.watch([dir], { recursive: false }, (event) => events.push(event));
    try {
      writeFileSync(join(dir, "a.txt"), "hello");
      await waitFor(() => events.length > 0);
      expect(events.some((event) => event.path.endsWith("a.txt"))).toBe(true);
    } finally {
      sub.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recursive: true also catches a write inside a nested subdirectory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kira-watch-"));
    mkdirSync(join(dir, "nested"));
    const watcher = new NodeFileWatcher();
    const events: { path: string }[] = [];
    const sub = watcher.watch([dir], { recursive: true }, (event) => events.push(event));
    try {
      // A fresh recursive watch takes a moment to finish enumerating existing subdirectories
      // before it reliably reports events inside them — the same "don't trust the event to be
      // instant" caveat as macOS's FSEvents coalescing, just at setup time instead of delivery
      // time. Writing immediately can race that enumeration, so give it a beat first.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const nestedFile = join(dir, "nested", "b.txt");
      writeFileSync(nestedFile, "hi");
      await waitFor(() => events.some((event) => event.path === nestedFile));
      expect(events.some((event) => event.path === nestedFile)).toBe(true);
    } finally {
      sub.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dispose() stops delivering further events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kira-watch-"));
    const watcher = new NodeFileWatcher();
    const events: unknown[] = [];
    const sub = watcher.watch([dir], { recursive: false }, (event) => events.push(event));
    sub.dispose();
    writeFileSync(join(dir, "c.txt"), "x");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events.length).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a nonexistent path logs and is skipped; other watched paths still work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kira-watch-"));
    const missing = join(dir, "does-not-exist");
    const logger = new FakeLogger();
    const watcher = new NodeFileWatcher(logger);
    const events: unknown[] = [];
    const sub = watcher.watch([missing, dir], { recursive: false }, (event) => events.push(event));
    try {
      expect(logger.entries.some((entry) => entry.level === "error")).toBe(true);
      writeFileSync(join(dir, "d.txt"), "x");
      await waitFor(() => events.length > 0);
      expect(events.length).toBeGreaterThan(0);
    } finally {
      sub.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
