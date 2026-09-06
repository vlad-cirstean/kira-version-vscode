import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitRecords } from "@kira-version/core";
import { parseLogRecord } from "./log.ts";

const FIXTURES = join(import.meta.dir, "../../../../tests/fixtures/porcelain/log");

async function loadRecords(name: string) {
  const bytes = readFileSync(join(FIXTURES, `${name}.bin`));
  const out = [];
  for await (const record of splitRecords(toAsyncIterable(bytes))) out.push(record);
  return out;
}

async function* toAsyncIterable(bytes: Uint8Array) {
  yield bytes;
}

describe("parseLogRecord", () => {
  test("parses parent counts across the linear chain", async () => {
    const records = await loadRecords("linear");
    const commits = records.map(parseLogRecord);
    const parentCounts = commits.map((c) => c.parents.length).sort();
    // Exactly one commit with 0 parents (the root); the rest have exactly 1.
    expect(parentCounts).toEqual([0, 1, 1, 1, 1]);
    for (const commit of commits) {
      expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(commit.author.name).toBe("Kira Fixture");
      expect(commit.author.email).toBe("fixture@kira-version.test");
      expect(commit.subject.length).toBeGreaterThan(0);
    }
  });

  test("parses a branchy history's merge commit decoration (HEAD -> main)", async () => {
    const records = await loadRecords("branchy");
    const commits = records.map(parseLogRecord);
    const head = commits.find((c) => c.decoration.some((d) => d.kind === "branch" && d.isHead));
    expect(head).toBeDefined();
    const branchDecoration = head?.decoration.find((d) => d.kind === "branch" && d.isHead);
    expect(branchDecoration).toEqual({ kind: "branch", name: "main", isHead: true });
  });

  test("parses an octopus merge's 3+ parents", async () => {
    const records = await loadRecords("octopus");
    const commits = records.map(parseLogRecord);
    const merge = commits.find((c) => c.parents.length >= 3);
    expect(merge).toBeDefined();
    // main (unmoved since it is the merge base) plus the three topic branches merged into it.
    expect(merge?.parents).toHaveLength(4);
    for (const parent of merge?.parents ?? []) expect(parent).toMatch(/^[0-9a-f]{40}$/);
  });

  test("parses a criss-cross history's two merge commits, each with 2 parents", async () => {
    const records = await loadRecords("crissCross");
    const commits = records.map(parseLogRecord);
    const merges = commits.filter((c) => c.parents.length === 2);
    expect(merges).toHaveLength(2);
  });

  test("stash entries appear in the --all --glob=refs/stash walk", async () => {
    const records = await loadRecords("withStash");
    const commits = records.map(parseLogRecord);
    const stashCommit = commits.find((c) => c.parents.length === 2);
    expect(stashCommit).toBeDefined();
  });

  test("the stash tip decorates as {kind: 'stash'}, not a branch literally named refs/stash", async () => {
    const records = await loadRecords("withStash");
    const commits = records.map(parseLogRecord);
    const stashCommit = commits.find((c) => c.parents.length === 2);
    expect(stashCommit?.decoration).toEqual([{ kind: "stash", index: 0 }]);
  });
});

describe("parseLogRecord — hand-authored pathological cases", () => {
  const HAND_AUTHORED = join(import.meta.dir, "../../../../tests/fixtures/porcelain/handAuthored");

  async function loadOne(name: string) {
    const bytes = readFileSync(join(HAND_AUTHORED, `${name}.bin`));
    const records = [];
    for await (const record of splitRecords(toAsyncIterable(bytes))) records.push(record);
    return records.map(parseLogRecord);
  }

  test("a subject containing a literal 0x1f byte does not corrupt earlier fields", async () => {
    const [commit] = await loadOne("subjectWith0x1f-log");
    expect(commit?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(commit?.author.email).toBe("fixture@kira-version.test");
    // The stray 0x1f split the subject field itself — this asserts containment, not fidelity.
    expect(commit?.subject.startsWith("subject with a literal")).toBe(true);
  });

  test("a CRLF subject round-trips without corrupting field framing", async () => {
    const [commit] = await loadOne("crlfSubject-log");
    expect(commit?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(commit?.subject).toContain("line one");
  });

  test("an empty subject parses to an empty string, not undefined or a shifted field", async () => {
    const [commit] = await loadOne("emptySubject-log");
    expect(commit?.subject).toBe("");
    expect(commit?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("full decoration: HEAD -> branch, an annotated tag, and three remotes on one commit", async () => {
    const [commit] = await loadOne("fullDecoration-log");
    expect(commit).toBeDefined();
    const kinds = commit?.decoration.map((d) => d.kind).sort();
    expect(kinds).toEqual(["branch", "remoteBranch", "remoteBranch", "remoteBranch", "tag"]);
    const branch = commit?.decoration.find((d) => d.kind === "branch");
    expect(branch).toEqual({ kind: "branch", name: "main", isHead: true });
    const tag = commit?.decoration.find((d) => d.kind === "tag");
    expect(tag).toEqual({ kind: "tag", name: "v1" });
    const remotes = commit?.decoration
      .filter((d) => d.kind === "remoteBranch")
      .map((d) => d.name)
      .sort();
    expect(remotes).toEqual(["fork/main", "origin/main", "upstream/main"]);
  });
});
