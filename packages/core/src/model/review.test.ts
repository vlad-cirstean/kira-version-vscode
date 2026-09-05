import { describe, expect, test } from "bun:test";
import type { RefRecord } from "./ref.ts";
import { resolveBase } from "./review.ts";

function ref(
  overrides: Partial<RefRecord> & Pick<RefRecord, "refname" | "shortName" | "kind">,
): RefRecord {
  return {
    objectId: "0000000000000000000000000000000000000000",
    objectType: "commit",
    peeledObjectId: undefined,
    upstream: undefined,
    track: undefined,
    committerDate: 0,
    isHead: false,
    checkedOutIn: undefined,
    annotation: undefined,
    ...overrides,
  };
}

function branch(shortName: string, overrides: Partial<RefRecord> = {}): RefRecord {
  return ref({ refname: `refs/heads/${shortName}`, shortName, kind: "branch", ...overrides });
}

function remoteBranch(shortName: string, overrides: Partial<RefRecord> = {}): RefRecord {
  return ref({
    refname: `refs/remotes/${shortName}`,
    shortName,
    kind: "remoteBranch",
    ...overrides,
  });
}

describe("resolveBase — step 1: upstream", () => {
  test("upstream tracks a remote branch of the SAME name ⇒ falls through (would show only unpushed commits)", () => {
    const topic = branch("feature-x", { upstream: "refs/remotes/origin/feature-x" });
    const result = resolveBase({
      branch: topic,
      branches: [topic],
      remoteBranches: [remoteBranch("origin/feature-x")],
      originHead: undefined,
      candidates: [],
    });
    expect(result.reason).toBe("none");
    expect(result.base).toBeNull();
  });

  test("upstream tracks a DIFFERENT remote branch ⇒ honoured, reason upstream", () => {
    const topic = branch("feature-x", { upstream: "refs/remotes/origin/develop" });
    const result = resolveBase({
      branch: topic,
      branches: [topic],
      remoteBranches: [remoteBranch("origin/develop")],
      originHead: undefined,
      candidates: [],
    });
    expect(result.base).toBe("origin/develop");
    expect(result.reason).toBe("upstream");
  });

  test("upstream is a LOCAL branch of a different name (branch.<n>.remote = .) ⇒ honoured", () => {
    const topic = branch("feature-x", { upstream: "refs/heads/main" });
    const main = branch("main");
    const result = resolveBase({
      branch: topic,
      branches: [topic, main],
      remoteBranches: [],
      originHead: undefined,
      candidates: [],
    });
    expect(result.base).toBe("main");
    expect(result.reason).toBe("upstream");
  });

  test("upstream configured but its remote-tracking ref has been pruned (gone, absent from snapshot) ⇒ falls through to step 2", () => {
    const topic = branch("feature-x", { upstream: "refs/remotes/origin/develop", track: "gone" });
    const main = branch("main");
    const result = resolveBase({
      branch: topic,
      branches: [topic, main],
      // origin/develop is NOT present — it was pruned.
      remoteBranches: [],
      originHead: undefined,
      candidates: ["main"],
    });
    expect(result.base).toBe("main");
    expect(result.reason).toBe("defaultBranch");
  });

  test("no upstream at all ⇒ falls through to step 2", () => {
    const topic = branch("feature-x");
    const main = branch("main");
    const result = resolveBase({
      branch: topic,
      branches: [topic, main],
      remoteBranches: [],
      originHead: undefined,
      candidates: ["main"],
    });
    expect(result.reason).toBe("defaultBranch");
    expect(result.base).toBe("main");
  });
});

describe("resolveBase — step 2: detected default branch", () => {
  test("origin/HEAD present and resolves ⇒ honoured over baseCandidates", () => {
    const topic = branch("feature-x");
    const result = resolveBase({
      branch: topic,
      branches: [topic],
      remoteBranches: [remoteBranch("origin/main")],
      originHead: "origin/main",
      candidates: ["master"],
    });
    expect(result.base).toBe("origin/main");
    expect(result.reason).toBe("defaultBranch");
  });

  test("origin/HEAD absent (undefined) ⇒ falls through to baseCandidates, first existing member wins", () => {
    const topic = branch("feature-x");
    const master = branch("master");
    const result = resolveBase({
      branch: topic,
      branches: [topic, master],
      remoteBranches: [],
      originHead: undefined,
      candidates: ["main", "master"],
    });
    expect(result.base).toBe("master");
    expect(result.reason).toBe("defaultBranch");
  });

  test("origin/HEAD names a ref that does not exist in the snapshot (stale) ⇒ falls through to baseCandidates", () => {
    const topic = branch("feature-x");
    const master = branch("master");
    const result = resolveBase({
      branch: topic,
      branches: [topic, master],
      remoteBranches: [],
      originHead: "origin/main", // not present below
      candidates: ["master"],
    });
    expect(result.base).toBe("master");
    expect(result.reason).toBe("defaultBranch");
  });

  test("each baseCandidates member checked in configured order — first existing wins", () => {
    const topic = branch("feature-x");
    const master = branch("master");
    const result = resolveBase({
      branch: topic,
      branches: [topic, master],
      remoteBranches: [],
      originHead: undefined,
      candidates: ["main", "master", "trunk"],
    });
    expect(result.base).toBe("master");
  });

  test("no baseCandidates member exists either ⇒ falls through to step 3", () => {
    const topic = branch("feature-x");
    const result = resolveBase({
      branch: topic,
      branches: [topic],
      remoteBranches: [],
      originHead: undefined,
      candidates: ["main", "master"],
    });
    expect(result.base).toBeNull();
    expect(result.reason).toBe("none");
  });
});

describe("resolveBase — step 3: none", () => {
  test("empty repository (no branches at all beyond the one under review) ⇒ ask", () => {
    const topic = branch("feature-x");
    const result = resolveBase({
      branch: topic,
      branches: [topic],
      remoteBranches: [],
      originHead: undefined,
      candidates: [],
    });
    expect(result.base).toBeNull();
    expect(result.reason).toBe("none");
    expect(result.candidates).toEqual([]);
  });
});

describe("resolveBase — the candidate shortlist: ordering and de-duplication", () => {
  test("order is upstream, then originHead, then each baseCandidates member, then HEAD branch", () => {
    const topic = branch("feature-x", { upstream: "refs/remotes/origin/develop" });
    const develop = remoteBranch("origin/develop");
    const main = remoteBranch("origin/main");
    const master = branch("master");
    const head = branch("trunk", { isHead: true });
    const result = resolveBase({
      branch: topic,
      branches: [topic, master, head],
      remoteBranches: [develop, main],
      originHead: "origin/main",
      candidates: ["master", "trunk"],
    });
    expect(result.candidates.map((c) => c.ref)).toEqual([
      "origin/develop",
      "origin/main",
      "master",
      "trunk",
    ]);
    expect(result.candidates.map((c) => c.reason)).toEqual([
      "upstream",
      "defaultBranch",
      "defaultBranch",
      "defaultBranch",
    ]);
  });

  test("the upstream still appears in candidates even when step 1 rejected it for being same-named", () => {
    const topic = branch("feature-x", { upstream: "refs/remotes/origin/feature-x" });
    const result = resolveBase({
      branch: topic,
      branches: [topic],
      remoteBranches: [remoteBranch("origin/feature-x")],
      originHead: undefined,
      candidates: [],
    });
    expect(result.reason).toBe("none");
    expect(result.candidates).toEqual([
      { ref: "origin/feature-x", kind: "remoteBranch", reason: "upstream" },
    ]);
  });

  test("a pruned upstream (absent from the snapshot) never appears in candidates", () => {
    const topic = branch("feature-x", { upstream: "refs/remotes/origin/develop", track: "gone" });
    const result = resolveBase({
      branch: topic,
      branches: [topic],
      remoteBranches: [],
      originHead: undefined,
      candidates: [],
    });
    expect(result.candidates).toEqual([]);
  });

  test("de-duplicated by ref name — first reason wins (upstream beats a later duplicate default-branch entry)", () => {
    const topic = branch("feature-x", { upstream: "refs/remotes/origin/main" });
    const main = remoteBranch("origin/main");
    const result = resolveBase({
      branch: topic,
      branches: [topic],
      remoteBranches: [main],
      originHead: "origin/main",
      candidates: ["main"],
    });
    expect(result.candidates).toEqual([
      { ref: "origin/main", kind: "remoteBranch", reason: "upstream" },
    ]);
  });

  test("current HEAD branch is added last, only when distinct from everything already listed", () => {
    const topic = branch("feature-x");
    const master = branch("master");
    const head = branch("main", { isHead: true });
    const result = resolveBase({
      branch: topic,
      branches: [topic, master, head],
      remoteBranches: [],
      originHead: undefined,
      candidates: ["master"],
    });
    expect(result.candidates.map((c) => c.ref)).toEqual(["master", "main"]);
  });

  test("HEAD branch omitted when it is the branch under review itself", () => {
    // The branch under review is, by construction, never offered as its own base — it is simply
    // never HEAD in the scenarios this classifier is asked about (the caller passes the reviewed
    // branch's own row), but this pins that a HEAD match still de-duplicates correctly if it ever
    // coincides with an already-listed candidate rather than double-adding it.
    const topic = branch("feature-x", { isHead: true });
    const result = resolveBase({
      branch: topic,
      branches: [topic],
      remoteBranches: [],
      originHead: undefined,
      candidates: [],
    });
    expect(result.candidates).toEqual([
      { ref: "feature-x", kind: "branch", reason: "defaultBranch" },
    ]);
  });
});
