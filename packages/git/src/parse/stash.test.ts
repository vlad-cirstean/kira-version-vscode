import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitRecords } from "@kira-version/core";
import { parseStashList } from "./stash.ts";

const FIXTURES = join(import.meta.dir, "../../../../tests/fixtures/porcelain/stash");

async function* toAsyncIterable(bytes: Uint8Array) {
  yield bytes;
}

async function loadRecords(name: string): Promise<Uint8Array[]> {
  const bytes = readFileSync(join(FIXTURES, name));
  const records: Uint8Array[] = [];
  for await (const record of splitRecords(toAsyncIterable(bytes))) records.push(record);
  return records;
}

describe("parseStashList", () => {
  test("round-trips a stack with a WIP entry, a `-u` entry, a pathspec entry and a colon/punctuation message", async () => {
    const records = await loadRecords("list.bin");
    const entries = parseStashList(records);

    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    for (const entry of entries) {
      expect(entry.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.baseSha).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.indexSha).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.timestamp).toBeGreaterThan(0);
    }

    // stash@{0}: the colon/punctuation message, two changed files.
    const newest = entries[0];
    expect(newest?.message).toBe("On main: fix: handle edge, case! (parens): done");
    expect(newest?.branch).toBe("main");
    expect(newest?.fileCount).toBe(2);
    expect(newest?.includedUntracked).toBe(false);
    expect(newest?.untrackedSha).toBeUndefined();

    // stash@{1}: the pathspec entry — only the one path it was given.
    const pathspec = entries[1];
    expect(pathspec?.message).toBe("On main: pathspec stash");
    expect(pathspec?.fileCount).toBe(1);

    // stash@{2}: the `-u` entry — a real third (untracked) parent.
    const untracked = entries[2];
    expect(untracked?.message).toBe("On main: with untracked");
    expect(untracked?.includedUntracked).toBe(true);
    expect(untracked?.untrackedSha).toMatch(/^[0-9a-f]{40}$/);
    expect(untracked?.fileCount).toBe(1); // the untracked file itself is never counted here

    // stash@{3}: the default (`WIP on <branch>: …`) message, no `-m`.
    const wip = entries[3];
    expect(wip?.message).toMatch(/^WIP on main: /);
    expect(wip?.branch).toBe("main");
    expect(wip?.includedUntracked).toBe(false);
  });

  test("an empty stack parses to zero entries, not an error", async () => {
    const records = await loadRecords("empty.bin");
    expect(parseStashList(records)).toEqual([]);
  });

  test("parseStashList([]) is the empty stack too", () => {
    expect(parseStashList([])).toEqual([]);
  });
});
