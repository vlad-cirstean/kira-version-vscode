import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { baseEnv, clearLargeCache, largeBranchy } from "./generateRepo.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  clearLargeCache();
});

function commitCount(dir: string): number {
  const out = execFileSync("git", ["rev-list", "--count", "--all"], {
    cwd: dir,
    env: baseEnv(dir),
    encoding: "utf8",
  });
  return Number(out.trim());
}

function laneCountEstimate(dir: string): number {
  // How many distinct branch refs exist — a cheap proxy for "uses more than one lane".
  const out = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/heads"], {
    cwd: dir,
    env: baseEnv(dir),
    encoding: "utf8",
  });
  return out.trim().split("\n").filter(Boolean).length;
}

describe("largeBranchy()", () => {
  test("builds a repo with exactly n commits, using more than one branch", () => {
    const { dir } = largeBranchy(600, { branchCount: 4, commitsPerRound: 20 });
    dirs.push(dir);
    expect(commitCount(dir)).toBe(600);
    expect(laneCountEstimate(dir)).toBeGreaterThan(1);
  });

  test("is deterministic: regenerating twice yields identical shas", () => {
    clearLargeCache();
    const a = largeBranchy(300, { branchCount: 3, commitsPerRound: 15 });
    dirs.push(a.dir);
    const shaA = execFileSync("git", ["rev-parse", "main"], {
      cwd: a.dir,
      env: baseEnv(a.dir),
      encoding: "utf8",
    }).trim();
    clearLargeCache();
    const b = largeBranchy(300, { branchCount: 3, commitsPerRound: 15 });
    dirs.push(b.dir);
    const shaB = execFileSync("git", ["rev-parse", "main"], {
      cwd: b.dir,
      env: baseEnv(b.dir),
      encoding: "utf8",
    }).trim();
    expect(shaA).toBe(shaB);
  });

  test("writes a commit-graph by default; commitGraph: false omits it", () => {
    const withGraph = largeBranchy(200, { branchCount: 2, commitsPerRound: 10 });
    dirs.push(withGraph.dir);
    expect(
      existsSync(
        join(withGraph.dir, ".git", "objects", "info", "commit-graphs", "commit-graph-chain"),
      ) || existsSync(join(withGraph.dir, ".git", "objects", "info", "commit-graph")),
    ).toBe(true);

    const noGraph = largeBranchy(200, {
      branchCount: 2,
      commitsPerRound: 10,
      commitGraph: false,
    });
    dirs.push(noGraph.dir);
    expect(
      existsSync(
        join(noGraph.dir, ".git", "objects", "info", "commit-graphs", "commit-graph-chain"),
      ) || existsSync(join(noGraph.dir, ".git", "objects", "info", "commit-graph")),
    ).toBe(false);
  });

  test("the layout uses more than one lane over a real walk", async () => {
    const { dir } = largeBranchy(400, { branchCount: 5, commitsPerRound: 20 });
    dirs.push(dir);
    const { locateGit } = await import("../../packages/git/src/discovery.ts");
    const { openGitDriver } = await import("../../packages/git/src/driver.ts");
    const { NodeProcessRunner } = await import("../../packages/git/src/nodeProcessRunner.ts");
    const { log } = await import("../../packages/git/src/queries.ts");
    const { noopCatFileSession } = await import("../../packages/git/src/testFakes.ts");
    const { CommitStore } = await import("../../packages/core/src/store/commitStore.ts");
    const { layoutAppend } = await import("../../packages/core/src/graph/layout.ts");

    const runner = new NodeProcessRunner();
    const resolution = await locateGit({ runner });
    if (resolution.kind !== "ok") throw new Error("no usable system git");
    const driver = openGitDriver(resolution.git, runner, dir, noopCatFileSession());
    const store = new CommitStore();
    for await (const record of log(driver, { scope: "all", pageSize: 1000 })) {
      store.append(record);
    }
    const { chunk } = layoutAppend(store.layoutInput(0, store.rowCount), undefined);
    expect(chunk.laneCount).toBeGreaterThan(1);
    driver.dispose();
  });
});
