import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { RepoIdentity } from "@kira-version/core";
import { FakeFileWatcher } from "./testFakes.ts";
import { type WatchSignal, watchRepo } from "./watcher.ts";

/**
 * Pure logic against a `FakeFileWatcher` — real `fs.watch` behaviour belongs to
 * `tests/integration/nodeFileWatcher.test.ts`, and `watchRepo` driven end to end against a real
 * repo belongs to `tests/integration/watcher.test.ts`, per the project's colocated-vs-integration
 * split (discovery.test.ts's precedent).
 */

const identity: RepoIdentity = {
  root: "/repo",
  gitDir: "/repo/.git",
  commonDir: "/repo/.git",
  isBare: false,
  isLinkedWorktree: false,
  head: { kind: "branch", name: "main" },
};

const refPath = join(identity.commonDir, "refs", "heads", "main");
const indexPath = join(identity.gitDir, "index");

/** One real event-loop tick — enough for `watchRepo`'s `setTimeout(check, 0|remaining)` to run,
 *  without ever waiting out a real debounce window (the tests fast-forward the injected clock
 *  instead). */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("watchRepo", () => {
  test("subscribes recursively under commonDir/refs, and non-recursively to the flat dir plus the shallow ref dirs", () => {
    const fw = new FakeFileWatcher();
    const rw = watchRepo(fw, identity);
    expect(fw.calls).toEqual([
      { paths: [join(identity.commonDir, "refs")], opts: { recursive: true } },
      {
        paths: [
          identity.commonDir,
          join(identity.commonDir, "refs", "heads"),
          join(identity.commonDir, "refs", "tags"),
          join(identity.commonDir, "refs", "remotes"),
        ],
        opts: { recursive: false },
      },
    ]);
    rw.dispose();
  });

  test("a linked worktree watches both the common dir and its own git dir", () => {
    const fw = new FakeFileWatcher();
    const linked: RepoIdentity = {
      ...identity,
      gitDir: "/repo/.git/worktrees/feature",
      isLinkedWorktree: true,
    };
    const rw = watchRepo(fw, linked);
    expect(fw.calls[1]).toEqual({
      paths: [
        linked.commonDir,
        linked.gitDir,
        join(linked.commonDir, "refs", "heads"),
        join(linked.commonDir, "refs", "tags"),
        join(linked.commonDir, "refs", "remotes"),
      ],
      opts: { recursive: false },
    });
    rw.dispose();
  });

  test("ten events inside one debounce window produce exactly one refsChanged", async () => {
    const fw = new FakeFileWatcher();
    let clock = 0;
    const rw = watchRepo(fw, identity, { debounceMs: 200, now: () => clock });
    const seen: WatchSignal[] = [];
    rw.onSignal((s) => seen.push(s));

    for (let i = 0; i < 10; i++) {
      fw.emit({ path: refPath, kind: "changed" });
    }
    clock = 1000; // fast-forward the injected clock past the debounce window
    await tick();

    expect(seen).toEqual(["refsChanged"]);
    rw.dispose();
  });

  test("a ref event and an index event in the same window fire both signals once each", async () => {
    const fw = new FakeFileWatcher();
    let clock = 0;
    const rw = watchRepo(fw, identity, { debounceMs: 200, now: () => clock });
    const seen: WatchSignal[] = [];
    rw.onSignal((s) => seen.push(s));

    fw.emit({ path: refPath, kind: "changed" });
    fw.emit({ path: indexPath, kind: "changed" });
    clock = 1000;
    await tick();

    expect(seen).toEqual(["refsChanged", "worktreeChanged"]);
    rw.dispose();
  });

  test("events outside the watched files are ignored", async () => {
    const fw = new FakeFileWatcher();
    let clock = 0;
    const rw = watchRepo(fw, identity, { debounceMs: 200, now: () => clock });
    const seen: WatchSignal[] = [];
    rw.onSignal((s) => seen.push(s));

    fw.emit({ path: join(identity.commonDir, "objects", "ab", "cdef"), kind: "created" });
    clock = 1000;
    await tick();

    expect(seen).toEqual([]);
    rw.dispose();
  });

  test("pause() drops a pending window and resume() does not replay it", async () => {
    const fw = new FakeFileWatcher();
    let clock = 0;
    const rw = watchRepo(fw, identity, { debounceMs: 200, now: () => clock });
    const seen: WatchSignal[] = [];
    rw.onSignal((s) => seen.push(s));

    fw.emit({ path: refPath, kind: "changed" });
    rw.pause();
    clock = 1000;
    await tick();
    expect(seen).toEqual([]);

    rw.resume();
    await tick();
    expect(seen).toEqual([]);

    fw.emit({ path: refPath, kind: "changed" });
    clock = 2000;
    await tick();
    expect(seen).toEqual(["refsChanged"]);

    rw.dispose();
  });

  test("dispose() clears pending state and unsubscribes from the FileWatcher", async () => {
    const fw = new FakeFileWatcher();
    let clock = 0;
    const rw = watchRepo(fw, identity, { debounceMs: 200, now: () => clock });
    const seen: WatchSignal[] = [];
    rw.onSignal((s) => seen.push(s));

    fw.emit({ path: refPath, kind: "changed" });
    rw.dispose();
    clock = 1000;
    await tick();

    expect(seen).toEqual([]);
    expect(fw.listenerCount).toBe(0);
  });

  test("onSignal's Disposable unsubscribes only that listener", async () => {
    const fw = new FakeFileWatcher();
    let clock = 0;
    const rw = watchRepo(fw, identity, { debounceMs: 200, now: () => clock });
    const a: WatchSignal[] = [];
    const b: WatchSignal[] = [];
    const subA = rw.onSignal((s) => a.push(s));
    rw.onSignal((s) => b.push(s));
    subA.dispose();

    fw.emit({ path: refPath, kind: "changed" });
    clock = 1000;
    await tick();

    expect(a).toEqual([]);
    expect(b).toEqual(["refsChanged"]);
    rw.dispose();
  });
});
