#!/usr/bin/env bun
/**
 * P6a W4 — runs `tests/integration/*.test.ts` as N concurrent `bun test` child processes instead
 * of one serial run. `bun test` has no cross-file parallelism (measured directly, not assumed —
 * see `docs/plans/P6a-test-perf.md`'s own per-file table): one process running all 20 files pays
 * their full sum, serially, even on an idle multi-core box.
 *
 * **The concurrency hazard — read this before trusting a green run.** The plan's own two-group
 * probe, re-run after W3 landed the fixture cache, still reproduces, and `docs/plans/P6a-test-
 * perf.md`'s Findings records the full investigation. Short version: under real 4-way concurrency,
 * `repoService.test.ts` (every test opens a fresh `catFile.ts` `PersistentBatchProcess` pair via
 * `RepoService.create()`) sometimes has one `git cat-file` spawn stall past `bun test`'s per-test
 * timeout. Most runs are clean; when it fires it is usually one or two tests, past bun's default
 * 5,000 ms, and raising `--timeout` to 20,000 ms clears those. But one observed run cascaded
 * through eight consecutive `repoService.test.ts` tests, each eating the *full* 20,000 ms, for
 * 2m47s of wall time — continuing well after the other three shards had already exited and freed
 * three of four cores. That detail rules out pure external CPU starvation as the whole story: once
 * triggered, the stall did not self-heal when contention disappeared. The likelier explanation is
 * a real gap in `catFile.ts`'s `PersistentBatchProcess`: it has no per-request timeout of its own,
 * so a `git cat-file` child that stalls for any reason leaves that request's promise pending
 * forever, with only bun's own wall-clock test timeout as the backstop. **This is reported, not
 * fixed here** — fixing it means changing `catFile.ts`'s production request path, which is outside
 * this plan's infra-only scope and needs its own investigation and test coverage. `--timeout` is
 * kept at 20,000 ms as a mitigation that helps the common case, not a claim that the hazard is
 * gone: a shard can still, rarely, run far longer than its measured cost. Treat this runner as an
 * opt-in speedup, not something the default `test`/`test:integration` scripts should depend on.
 *
 * **Partitioned by measured cost, not alphabetically or round-robin.** `historyPipeline.test.ts`
 * alone costs as much as the next six files combined; a naive split leaves one shard running long
 * after the others are idle. `COST_MS` below is this file's own post-W3, warm-cache measurement
 * (`bun test <file>` individually, one at a time); a file with no entry falls back to
 * `FALLBACK_COST_MS` (this table's own median) rather than crashing, so a newly added test file is
 * merely a shard-balancing rounding error until someone updates the table, not a broken build.
 * Assignment is greedy longest-processing-time-first (LPT) — sort files by cost, descending,
 * repeatedly add the next one to whichever shard currently has the smallest total. Good enough for
 * 20 files across 4 shards; this is not a bin-packing solver.
 *
 * **Prefer-a-library, applied.** This is process plumbing of the same kind and size as
 * `scripts/e2e-display.ts` (glob some files, partition them, spawn a handful of child processes,
 * forward output, propagate the worst exit code) — not the "non-trivial infrastructure"
 * `AGENTS.md`'s prefer-a-library rule is aimed at. `bun test` itself has no built-in file-level
 * sharding flag to reach for instead (only `--max-concurrency`, which governs `test.concurrent()`
 * *within* one file, of which this suite uses none).
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";

const TEST_DIR = "tests/integration";
const RAISED_TIMEOUT_MS = 20_000;

// Measured via `bun test <file>` individually, warm `tests/fixtures/.cache/`, post-P6a-W3.
// Kept as a plain literal (not generated) so a stale entry is a visible, reviewable diff rather
// than a number nobody can see move.
const COST_MS: Record<string, number> = {
  "historyPipeline.test.ts": 8756,
  "watcher.test.ts": 3127,
  "repoService.test.ts": 2510,
  "commitDetail.test.ts": 797,
  "queries.test.ts": 777,
  "nodeFileWatcher.test.ts": 736,
  "tagAndBranchOps.test.ts": 667,
  "revertLifecycle.test.ts": 575,
  "checkoutAgreement.test.ts": 535,
  "checkoutSpecialPaths.test.ts": 496,
  "logSession.test.ts": 474,
  "errors.test.ts": 455,
  "discovery.test.ts": 454,
  "packedChunk.test.ts": 361,
  "inProgressStates.test.ts": 349,
  "catFile.test.ts": 321,
  "transportContract.test.ts": 216,
  "writeQueue.test.ts": 208,
  "lanePaletteGenerator.test.ts": 200,
  "settingsGenerator.test.ts": 128,
};

const knownCosts = Object.values(COST_MS).sort((a, b) => a - b);
const FALLBACK_COST_MS = knownCosts[Math.floor(knownCosts.length / 2)] as number;

function discoverTestFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".test.ts"))
    .sort();
}

/** Greedy LPT: sort descending by cost, always extend the currently-cheapest shard. */
function partition(files: string[], shardCount: number): string[][] {
  const shards: string[][] = Array.from({ length: shardCount }, () => []);
  const totals = new Array<number>(shardCount).fill(0);
  const sorted = [...files].sort(
    (a, b) => (COST_MS[b] ?? FALLBACK_COST_MS) - (COST_MS[a] ?? FALLBACK_COST_MS),
  );
  for (const file of sorted) {
    let cheapest = 0;
    for (let i = 1; i < shardCount; i++) {
      if ((totals[i] as number) < (totals[cheapest] as number)) cheapest = i;
    }
    (shards[cheapest] as string[]).push(file);
    totals[cheapest] = (totals[cheapest] as number) + (COST_MS[file] ?? FALLBACK_COST_MS);
  }
  return shards.filter((shard) => shard.length > 0);
}

function runShard(shard: string[], index: number): Promise<number> {
  const paths = shard.map((name) => join(TEST_DIR, name));
  return new Promise((resolve) => {
    const child = spawn("bun", ["test", `--timeout=${RAISED_TIMEOUT_MS}`, ...paths], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const prefix = `[shard ${index}] `;
    const forward = (chunk: Buffer, stream: NodeJS.WriteStream): void => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.length > 0) stream.write(`${prefix}${line}\n`);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => forward(chunk, process.stdout));
    child.stderr?.on("data", (chunk: Buffer) => forward(chunk, process.stderr));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const files = discoverTestFiles(TEST_DIR);
  const shardCount = Math.max(1, Math.min(cpus().length, files.length));
  const shards = partition(files, shardCount);

  console.log(
    `test-shard: ${files.length} files across ${shards.length} shard(s) (--timeout=${RAISED_TIMEOUT_MS}):`,
  );
  shards.forEach((shard, i) => {
    const totalMs = shard.reduce((sum, f) => sum + (COST_MS[f] ?? FALLBACK_COST_MS), 0);
    console.log(`  shard ${i} (~${totalMs} ms): ${shard.join(", ")}`);
  });

  const codes = await Promise.all(shards.map((shard, i) => runShard(shard, i)));
  const worst = Math.max(...codes);
  if (worst !== 0) {
    console.error(`test-shard: shard exit codes were [${codes.join(", ")}]`);
  }
  process.exit(worst);
}

await main();
