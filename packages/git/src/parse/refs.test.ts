import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitRecords } from "@kira-version/core";
import { parseRefRecord, REFS_RECORD_DELIMITER } from "./refs.ts";

const FIXTURES = join(import.meta.dir, "../../../../tests/fixtures/porcelain/refs");
const HAND_AUTHORED = join(import.meta.dir, "../../../../tests/fixtures/porcelain/handAuthored");

async function* toAsyncIterable(bytes: Uint8Array) {
  yield bytes;
}

async function loadRefs(dir: string, name: string, withSubject = false) {
  const bytes = readFileSync(join(dir, `${name}.bin`));
  const records = [];
  for await (const record of splitRecords(toAsyncIterable(bytes), {
    delimiter: REFS_RECORD_DELIMITER,
  })) {
    records.push(record);
  }
  return records.map((record) => parseRefRecord(record, withSubject));
}

// withWorktree.bin: captured from a real repository (git 2.43.0) with `main` (this session's own
// checked-out branch, ahead of origin/main by one) and `side` checked out in a LINKED worktree,
// plus origin/main (a remote-tracking ref) and two tags with no subject requested (the base,
// 11-field REFS_FORMAT — `refsArgs("all")`/`refsArgs("heads")`'s shape).
describe("parseRefRecord — the base (subject-less) 11-field format", () => {
  test("a head (this session's own checked-out branch): worktreepath IS populated even for the local checkout (probe P6)", async () => {
    const refs = await loadRefs(FIXTURES, "withWorktree");
    const main = refs.find((r) => r.refname === "refs/heads/main");
    expect(main).toBeDefined();
    expect(main?.kind).toBe("branch");
    expect(main?.shortName).toBe("main");
    expect(main?.isHead).toBe(true);
    expect(main?.upstream).toBe("refs/remotes/origin/main");
    expect(main?.track).toEqual({ ahead: 1, behind: 0 });
    // Populated for the branch checked out HERE too — the "checked out ELSEWHERE" distinction is
    // the service's job (subtracting its own toplevel), not the parser's (§4.4/D12).
    expect(main?.checkedOutIn).toBe("/tmp/kv-fixture/repo");
  });

  test("a branch checked out in a LINKED worktree: worktreepath is that worktree's path", async () => {
    const refs = await loadRefs(FIXTURES, "withWorktree");
    const side = refs.find((r) => r.refname === "refs/heads/side");
    expect(side).toBeDefined();
    expect(side?.isHead).toBe(false);
    expect(side?.checkedOutIn).toBe("/tmp/kv-fixture/repo-wt");
  });

  test("a remote head: kind remoteBranch, shortName strips refs/remotes/, no worktreepath", async () => {
    const refs = await loadRefs(FIXTURES, "withWorktree");
    const remote = refs.find((r) => r.refname === "refs/remotes/origin/main");
    expect(remote).toBeDefined();
    expect(remote?.kind).toBe("remoteBranch");
    expect(remote?.shortName).toBe("origin/main");
    expect(remote?.checkedOutIn).toBeUndefined();
  });

  test("a lightweight tag in this format: objectType commit, no annotation (taggername empty)", async () => {
    const refs = await loadRefs(FIXTURES, "withWorktree");
    const lw = refs.find((r) => r.refname === "refs/tags/lw");
    expect(lw).toBeDefined();
    expect(lw?.kind).toBe("tag");
    expect(lw?.objectType).toBe("commit");
    expect(lw?.annotation).toBeUndefined();
  });

  test("an annotated tag in this format: objectType tag, peeled commit id, tagger/date populated, subject NOT requested here", async () => {
    const refs = await loadRefs(FIXTURES, "withWorktree");
    const ann = refs.find((r) => r.refname === "refs/tags/ann");
    expect(ann).toBeDefined();
    expect(ann?.objectType).toBe("tag");
    expect(ann?.objectId).toMatch(/^[0-9a-f]{40}$/);
    expect(ann?.peeledObjectId).toMatch(/^[0-9a-f]{40}$/);
    expect(ann?.objectId).not.toBe(ann?.peeledObjectId);
    expect(ann?.annotation).toEqual({ tagger: "Test Committer", date: 1_700_006_400, subject: "" });
  });

  test("a record whose LAST field is empty parses correctly (framing does not drop a trailing empty field)", async () => {
    // Every branch/remote/lightweight-tag record in this fixture ends with two empty fields
    // (taggername, taggerdate) — this is the naive-`split`-gets-wrong case named in W4's "Done
    // when". Asserting on the remote-tracking record, which has no upstream either, so the
    // fixture is exercising trailing emptiness at multiple field positions at once.
    const refs = await loadRefs(FIXTURES, "withWorktree");
    const remote = refs.find((r) => r.refname === "refs/remotes/origin/main");
    expect(remote?.annotation).toBeUndefined();
    expect(remote?.upstream).toBeUndefined();
    expect(remote?.track).toBeUndefined();
  });
});

describe("parseRefRecord — the tags-only, subject-bearing format (refsArgs('tags'))", () => {
  test("version-aware sort: v10, v9, lw, ann — git's --sort=-v:refname, not a JS string/number sort", async () => {
    const bytes = readFileSync(join(FIXTURES, "tagsWithSubject.bin"));
    const records = [];
    for await (const record of splitRecords(toAsyncIterable(bytes), {
      delimiter: REFS_RECORD_DELIMITER,
    })) {
      records.push(record);
    }
    const refs = records.map((r) => parseRefRecord(r, true));
    expect(refs.map((r) => r.shortName)).toEqual(["v10", "v9", "lw", "ann"]);
  });

  test("a LIGHTWEIGHT tag's %(contents:subject) is the pointed-at COMMIT's subject — and the parser discards it (probe P3)", async () => {
    const refs = await loadRefs(FIXTURES, "tagsWithSubject", true);
    const lw = refs.find((r) => r.shortName === "lw");
    expect(lw?.objectType).toBe("commit");
    // The raw field for `lw` genuinely carries the commit's subject; annotation must still be
    // undefined — this is the whole point of gating on `objecttype`, not on "is subject non-empty".
    expect(lw?.annotation).toBeUndefined();
  });

  test("an ANNOTATED tag's subject is its own annotation message, not the commit's", async () => {
    const refs = await loadRefs(FIXTURES, "tagsWithSubject", true);
    const ann = refs.find((r) => r.shortName === "ann");
    expect(ann?.annotation?.subject).toBe("annotated tag subject line");
    expect(ann?.annotation?.tagger).toBe("Test Committer");
  });
});

describe("parseRefRecord — no upstream configured", () => {
  test("upstream/track/peeled/annotation are all undefined; the trailing two fields (worktreepath is populated, tagger fields empty) still parse", async () => {
    const refs = await loadRefs(HAND_AUTHORED, "refsNoUpstream");
    const main = refs.find((r) => r.refname === "refs/heads/main");
    expect(main?.upstream).toBeUndefined();
    expect(main?.track).toBeUndefined();
    expect(main?.peeledObjectId).toBeUndefined();
    expect(main?.annotation).toBeUndefined();
    expect(main?.isHead).toBe(true);
    expect(main?.checkedOutIn).toBe("/tmp/kv-fixture/noup");
  });
});
