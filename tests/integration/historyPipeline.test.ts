/**
 * W14: the whole path from `openLogSession` through `CommitStore` to `layoutAppend`, over real
 * git and real generated repositories — the composition P2 declines to ship as a class (P3's
 * `RepoService` owns that), exercised here exactly as docs/plans/P2.md's own sketch does.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layoutAppend } from "../../packages/core/src/graph/layout.ts";
import type { LayoutChunk, LayoutFrontier } from "../../packages/core/src/graph/types.ts";
import { EDGE_STRIDE, EDGE_TO_ROW } from "../../packages/core/src/graph/types.ts";
import { CommitStore } from "../../packages/core/src/store/commitStore.ts";
import { locateGit } from "../../packages/git/src/discovery.ts";
import { openGitDriver } from "../../packages/git/src/driver.ts";
import { openLogSession } from "../../packages/git/src/logSession.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { refs } from "../../packages/git/src/queries.ts";
import { noopCatFileSession } from "../../packages/git/src/testFakes.ts";
import {
  baseEnv,
  branchy,
  crissCross,
  largeBranchy,
  linear,
  octopus,
  withStash,
} from "../fixtures/generateRepo.ts";

const runner = new NodeProcessRunner();
const noopCatFile = noopCatFileSession();
const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

async function resolvedGit() {
  const resolution = await locateGit({ runner });
  if (resolution.kind !== "ok") throw new Error("no usable system git found for this test");
  return resolution.git;
}

/** Runs the whole pipeline in `pageSize`-sized pages, returning the final store and the
 *  concatenated layout chunks — the sketch from docs/plans/P2.md's W14 section, made concrete. */
async function runPipeline(dir: string, pageSize: number) {
  const git = await resolvedGit();
  const session = openLogSession(git, runner, dir, { scope: "all", pageSize });
  const store = new CommitStore();
  const chunks: LayoutChunk[] = [];
  let frontier: LayoutFrontier | undefined;
  try {
    for (;;) {
      const before = store.rowCount;
      const outcome = await session.readPage((r) => store.append(r));
      if (outcome.kind === "stale") throw new Error("unexpected stale during a fixed-repo test");
      const result = layoutAppend(store.layoutInput(before, store.rowCount), frontier);
      frontier = result.frontier;
      chunks.push(result.chunk);
      if (outcome.exhausted) break;
    }
  } finally {
    session.dispose();
  }
  return { store, chunks };
}

function reassembleEdges(chunks: readonly LayoutChunk[]): Uint32Array {
  const totalEdges = chunks.reduce((sum, c) => sum + c.edges.length / EDGE_STRIDE, 0);
  const out = new Uint32Array(totalEdges * EDGE_STRIDE);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk.edges, offset);
    offset += chunk.edges.length;
  }
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.patches.length; i += 2) {
      out[(chunk.patches[i] as number) * EDGE_STRIDE + EDGE_TO_ROW] = chunk.patches[
        i + 1
      ] as number;
    }
  }
  return out;
}

describe("history pipeline — walk correctness against known fixture shapes", () => {
  const shapes: Array<[string, () => { dir: string; commits: readonly string[] }]> = [
    ["linear", () => linear(6)],
    ["branchy", () => branchy()],
    ["octopus", () => octopus()],
    ["crissCross", () => crissCross()],
  ];

  for (const [name, build] of shapes) {
    test(`${name}: store rows match the fixture's known commits exactly`, async () => {
      const { dir, commits } = build();
      const { store } = await runPipeline(dir, 1000);
      const storeShas = Array.from({ length: store.rowCount }, (_, r) => store.shaAt(r));
      expect(new Set(storeShas)).toEqual(new Set(commits));
      // Every parent link resolves to a real row (a fully-loaded single-page walk should
      // never leave a parent unresolved).
      for (let row = 0; row < store.rowCount; row++) {
        expect(Array.from(store.parentsOf(row)).every((p) => p >= 0)).toBe(true);
      }
    });
  }

  test("withStash: every fixture-known commit is a store row (plus the stash's own commits)", async () => {
    const { dir, commits } = withStash();
    const { store } = await runPipeline(dir, 1000);
    const storeShas = new Set(Array.from({ length: store.rowCount }, (_, r) => store.shaAt(r)));
    for (const sha of commits) expect(storeShas.has(sha)).toBe(true);
    expect(store.rowCount).toBeGreaterThan(commits.length); // the stash entry itself, at least
  });
});

describe("history pipeline — page-boundary invariant over real git output", () => {
  const shapes: Array<[string, () => { dir: string }]> = [
    ["linear", () => linear(17)],
    ["branchy", () => branchy({ mainCommits: 5, featureCommits: 4 })],
    ["octopus", () => octopus()],
    ["crissCross", () => crissCross()],
  ];

  for (const [name, build] of shapes) {
    for (const pageSize of [1, 2, 1000]) {
      test(`${name} @ pageSize=${pageSize}: paged pipeline matches a single full page`, async () => {
        const { dir } = build();
        const full = await runPipeline(dir, 1_000_000);
        const paged = await runPipeline(dir, pageSize);

        expect(paged.store.rowCount).toBe(full.store.rowCount);
        for (let row = 0; row < full.store.rowCount; row++) {
          expect(paged.store.shaAt(row)).toBe(full.store.shaAt(row));
        }

        const fullLane = full.chunks.flatMap((c) => Array.from(c.laneOf));
        const pagedLane = paged.chunks.flatMap((c) => Array.from(c.laneOf));
        expect(pagedLane).toEqual(fullLane);

        expect(Array.from(reassembleEdges(paged.chunks))).toEqual(
          Array.from(reassembleEdges(full.chunks)),
        );
      });
    }
  }
});

describe("history pipeline — stash entries appear as rows", () => {
  test("a stash entry is walked and appears in the store (--glob=refs/stash)", async () => {
    const { dir } = withStash();
    const { store } = await runPipeline(dir, 1000);
    const git = await resolvedGit();
    const driver = openGitDriver(git, runner, dir, noopCatFile);
    const stashSha = execFileSync("git", ["rev-parse", "refs/stash"], {
      cwd: dir,
      env: baseEnv(dir),
      encoding: "utf8",
    }).trim();
    expect(store.rowOfSha(stashSha)).toBeGreaterThanOrEqual(0);
    driver.dispose();
  });
});

describe("history pipeline — refs resolve to store rows, including an annotated tag", () => {
  test("branch, remote and annotated-tag refs all resolve through rowOfSha", async () => {
    const { dir } = linear(5);
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      env: baseEnv(dir),
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["tag", "-a", "v1", "-m", "release", headSha], {
      cwd: dir,
      env: {
        ...baseEnv(dir),
        GIT_AUTHOR_NAME: "Kira Fixture",
        GIT_AUTHOR_EMAIL: "fixture@kira-version.test",
        GIT_COMMITTER_NAME: "Kira Fixture",
        GIT_COMMITTER_EMAIL: "fixture@kira-version.test",
      },
    });

    const { store } = await runPipeline(dir, 1000);
    const git = await resolvedGit();
    const driver = openGitDriver(git, runner, dir, noopCatFile);
    const refRecords = await refs(driver);
    driver.dispose();

    const tag = refRecords.find((r) => r.shortName === "v1");
    expect(tag).toBeDefined();
    expect(tag?.peeledObjectId).toBe(headSha);
    expect(store.rowOfSha(tag?.peeledObjectId ?? "")).toBeGreaterThanOrEqual(0);

    const mainRef = refRecords.find((r) => r.shortName === "main");
    expect(mainRef).toBeDefined();
    expect(store.rowOfSha(mainRef?.objectId ?? "")).toBeGreaterThanOrEqual(0);
  });
});

describe("history pipeline — remaining() reaches exactly zero", () => {
  test("remaining() decreases to zero as the real walk completes", async () => {
    const { dir, commits } = linear(9);
    const git = await resolvedGit();
    const session = openLogSession(git, runner, dir, { scope: "all", pageSize: 4 });
    try {
      expect(await session.remaining()).toBe(commits.length);
      let outcome = await session.readPage(() => {});
      while (outcome.kind === "page" && !outcome.exhausted) {
        outcome = await session.readPage(() => {});
      }
      expect(await session.remaining()).toBe(0);
    } finally {
      session.dispose();
    }
  });
});

describe("history pipeline — edge cases", () => {
  test("an unborn HEAD yields an empty store rather than an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kira-fixture-unborn-"));
    cleanupDirs.push(dir);
    execFileSync("git", ["init", "--quiet"], { cwd: dir, env: baseEnv(dir) });
    const { store } = await runPipeline(dir, 1000);
    expect(store.rowCount).toBe(0);
  });

  test("a single-commit repo lays out one row in one lane", async () => {
    const { dir } = linear(1);
    const { store, chunks } = await runPipeline(dir, 1000);
    expect(store.rowCount).toBe(1);
    const chunk = chunks[0] as LayoutChunk;
    expect(chunk.laneCount).toBe(1);
    expect(Array.from(chunk.laneOf)).toEqual([0]);
  });
});

describe("history pipeline — page-boundary invariant at 100k scale", () => {
  test("largeBranchy(100_000) at pageSize=5000 matches a single full-repo pass, byte for byte", async () => {
    const { dir } = largeBranchy(100_000);
    const onePass = await runPipeline(dir, 1_000_000);
    const paged = await runPipeline(dir, 5000);

    expect(paged.store.rowCount).toBe(onePass.store.rowCount);
    expect(paged.store.rowCount).toBe(100_000);

    const onePassLane = onePass.chunks.flatMap((c) => Array.from(c.laneOf));
    const pagedLane = paged.chunks.flatMap((c) => Array.from(c.laneOf));
    expect(pagedLane).toEqual(onePassLane);

    expect(Array.from(reassembleEdges(paged.chunks))).toEqual(
      Array.from(reassembleEdges(onePass.chunks)),
    );
  }, 60_000);
});
