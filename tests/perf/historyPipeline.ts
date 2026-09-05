#!/usr/bin/env bun
/**
 * W15: first page and Load-more-to-100k, time and heap, against `largeBranchy(100_000)` —
 * the layout-stress counterpart to P1's `parserThroughput.ts` (which measures the parser
 * alone) and P0's `run.ts` (which measures the renderer, which does not exist yet at P2).
 *
 * The breakdown is two-way, not three: `sessionMs` (git spawn + stream + parse + `store.append`,
 * inherently pipelined by `logSession.ts`'s design and not meaningfully separable further
 * without instrumenting it) and `layoutMs` (`layoutAppend()`, a clean, separately-timeable
 * synchronous step). `firstPageMs`/`loadMoreMs` are their sum — the number the ≤400ms budget
 * (§5.1) actually gates on.
 *
 * What this measures is explicitly *not* §5.1's renderer figures (80MB / 250MB) — there is no
 * renderer yet (P4's). It measures the retained cost of what P2 built: the store plus the
 * layout buffers, headless, which per §5.5's own arithmetic should be a small fraction of the
 * renderer budget it hands P4.
 *
 * `docs/plans/P5.md` W15 adds `commitDetailMs`/`commitDetailCachedMs`/`fileDiffMs`
 * (`measureCommitDetail`) — §5.1's *other* number, "commit select → detail pane populated
 * ≤ 80 ms". Unlike the graph pipeline above, this is not answerable from the harness (which has
 * no git): it stands up a second, small, real repository (`detailWorkload()` — 20 commits, not
 * `largeBranchy`'s scale) and a real `RepoService`, and times exactly the two spawns behind that
 * budget — `detail()` and `fileDiff()` — not the graph-streaming path this file otherwise
 * measures.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { layoutAppend } from "../../packages/core/src/graph/layout.ts";
import type { LayoutChunk, LayoutFrontier } from "../../packages/core/src/graph/types.ts";
import { FakeLogger } from "../../packages/core/src/ports/testFakes.ts";
import { defaultSettings } from "../../packages/core/src/settings/schema.ts";
import { CommitStore } from "../../packages/core/src/store/commitStore.ts";
import { locateGit } from "../../packages/git/src/discovery.ts";
import { openLogSession } from "../../packages/git/src/logSession.ts";
import { NodeFileWatcher } from "../../packages/git/src/nodeFileWatcher.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { RepoService } from "../../packages/git/src/repoService.ts";
import { detailWorkload, largeBranchy } from "../fixtures/generateRepo.ts";

const BASELINE_PATH = join(import.meta.dir, "historyPipeline.budget.json");
const REGRESSION_TOLERANCE = 0.2; // 20%, matching run.ts's and parserThroughput.ts's §5.1 convention
const COMMIT_COUNT = 100_000;
const PAGE_SIZE = 5000;
const HEAP_SAMPLES = 7;

interface Measurement {
  readonly firstPageMs: number;
  readonly sessionMs: number;
  readonly layoutMs: number;
  readonly loadMoreMsWorst: number;
  readonly fullWalkMs: number;
  readonly storeBytes: number;
  readonly layoutBytes: number;
  readonly heapUsedMB: number;
  readonly firstPageMsNoGraph: number;
  /** §5.1: "commit select → detail pane populated ≤ 80 ms" — the host half, over
   *  `detailWorkload()`'s 20 real commits (one merge, one 500-file commit). */
  readonly commitDetailMs: number;
  /** The same 20 selections repeated — the cache path a keyboard walk back over history
   *  actually takes (`RepoService.detail`'s own `detailCache`). Recorded, not gated: §5.1 sets
   *  no separate budget for an already-cached re-select. */
  readonly commitDetailCachedMs: number;
  /** Median over 20 files from the many-files commit, one of them 5,000 lines. Recorded, not
   *  gated — §5.1 sets no budget for a per-file diff. */
  readonly fileDiffMs: number;
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/** W15's own host-half measurement: a real `RepoService` over `detailWorkload()`'s 20-commit
 *  repository, timing exactly the two spawns §5.1's budget is about — `detail()` (the four git
 *  spawns behind "commit select → detail pane populated") and `fileDiff()` (no separate budget,
 *  recorded for its own sake). Cold and cached passes over the *same* 20 commits are both timed
 *  in one loop — `detail()`'s second call for a given sha is the cache path by construction
 *  (`RepoService.detail`'s own `detailCache`), so this needs no separate warm-up phase. */
async function measureCommitDetail(): Promise<{
  commitDetailMs: number;
  commitDetailCachedMs: number;
  fileDiffMs: number;
}> {
  const repo = detailWorkload();
  const service = await RepoService.create({
    runner: new NodeProcessRunner(),
    fileWatcher: new NodeFileWatcher(),
    logger: new FakeLogger(),
    settings: defaultSettings(),
    configuredGitCandidates: [],
  });
  try {
    const opened = await service.open(repo.dir);
    if (opened.kind !== "ok") throw new Error(`detailWorkload() did not open: ${opened.kind}`);
    const { repoId } = opened;

    const coldMs: number[] = [];
    const cachedMs: number[] = [];
    let manyFilesSha = "";
    let manyFilesCount = 0;
    for (const sha of repo.commits) {
      const coldStart = performance.now();
      const detail = await service.detail(repoId, sha, 0);
      coldMs.push(performance.now() - coldStart);

      const cachedStart = performance.now();
      await service.detail(repoId, sha, 0);
      cachedMs.push(performance.now() - cachedStart);

      if (detail.files.length > manyFilesCount) {
        manyFilesCount = detail.files.length;
        manyFilesSha = sha;
      }
    }
    if (manyFilesCount < 500) {
      throw new Error(`expected a ≥500-file commit in detailWorkload(), found ${manyFilesCount}`);
    }

    const detail = await service.detail(repoId, manyFilesSha, 0);
    const sampleFiles = detail.files.slice(0, 20);
    const fileDiffSamples: number[] = [];
    for (const file of sampleFiles) {
      const start = performance.now();
      await service.fileDiff(repoId, manyFilesSha, file.path, file.originalPath, 0);
      fileDiffSamples.push(performance.now() - start);
    }

    return {
      commitDetailMs: median(coldMs),
      commitDetailCachedMs: median(cachedMs),
      fileDiffMs: median(fileDiffSamples),
    };
  } finally {
    service.dispose();
  }
}

function layoutRetainedBytes(chunks: readonly LayoutChunk[]): number {
  let total = 0;
  for (const chunk of chunks) {
    total +=
      chunk.laneOf.byteLength +
      chunk.colorOf.byteLength +
      chunk.edges.byteLength +
      chunk.edgeIndex.byteLength +
      chunk.patches.byteLength;
  }
  return total;
}

function medianHeapMB(): number {
  const samples: number[] = [];
  for (let i = 0; i < HEAP_SAMPLES; i++) {
    samples.push(process.memoryUsage().heapUsed / (1024 * 1024));
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] as number;
}

async function measureFirstPageNoGraph(dir: string): Promise<number> {
  const runner = new NodeProcessRunner();
  const resolution = await locateGit({ runner });
  if (resolution.kind !== "ok") throw new Error("no usable system git found for this measurement");
  const store = new CommitStore();
  const session = openLogSession(resolution.git, runner, dir, {
    scope: "all",
    pageSize: PAGE_SIZE,
  });
  const start = performance.now();
  await session.readPage((r) => store.append(r));
  const sessionMs = performance.now() - start;
  session.dispose();
  const layoutStart = performance.now();
  layoutAppend(store.layoutInput(0, store.rowCount), undefined);
  return sessionMs + (performance.now() - layoutStart);
}

async function measure(): Promise<Measurement> {
  const { dir } = largeBranchy(COMMIT_COUNT); // commitGraph: true by default (W13)
  const runner = new NodeProcessRunner();
  const resolution = await locateGit({ runner });
  if (resolution.kind !== "ok") throw new Error("no usable system git found for this measurement");

  const store = new CommitStore();
  const session = openLogSession(resolution.git, runner, dir, {
    scope: "all",
    pageSize: PAGE_SIZE,
  });
  let frontier: LayoutFrontier | undefined;
  const chunks: LayoutChunk[] = [];
  const pageMs: number[] = [];
  let sessionMsFirst = 0;
  let layoutMsFirst = 0;

  const fullWalkStart = performance.now();
  let pageIndex = 0;
  for (;;) {
    const before = store.rowCount;
    const sessionStart = performance.now();
    const outcome = await session.readPage((r) => store.append(r));
    const sessionMs = performance.now() - sessionStart;
    if (outcome.kind === "stale") throw new Error("unexpected stale during a perf measurement");

    const layoutStart = performance.now();
    const result = layoutAppend(store.layoutInput(before, store.rowCount), frontier);
    const layoutMs = performance.now() - layoutStart;
    frontier = result.frontier;
    chunks.push(result.chunk);

    pageMs.push(sessionMs + layoutMs);
    if (pageIndex === 0) {
      sessionMsFirst = sessionMs;
      layoutMsFirst = layoutMs;
    }
    pageIndex++;
    if (outcome.exhausted) break;
  }
  const fullWalkMs = performance.now() - fullWalkStart;
  session.dispose();

  if (store.rowCount !== COMMIT_COUNT) {
    throw new Error(`expected ${COMMIT_COUNT} rows, loaded ${store.rowCount}`);
  }

  const heapUsedMB = medianHeapMB();
  const firstPageMsNoGraph = await measureFirstPageNoGraph(
    largeBranchy(COMMIT_COUNT, { commitGraph: false }).dir,
  );
  const { commitDetailMs, commitDetailCachedMs, fileDiffMs } = await measureCommitDetail();

  return {
    firstPageMs: pageMs[0] as number,
    sessionMs: sessionMsFirst,
    layoutMs: layoutMsFirst,
    loadMoreMsWorst: Math.max(...pageMs.slice(1)),
    fullWalkMs,
    storeBytes: store.stats().totalBytes,
    layoutBytes: layoutRetainedBytes(chunks),
    heapUsedMB,
    firstPageMsNoGraph,
    commitDetailMs,
    commitDetailCachedMs,
    fileDiffMs,
  };
}

function loadBaseline(): Measurement | undefined {
  if (!existsSync(BASELINE_PATH)) return undefined;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Measurement;
}

function saveBaseline(measurement: Measurement): void {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(measurement, null, 2)}\n`);
}

const GATED_METRICS = [
  "firstPageMs",
  "loadMoreMsWorst",
  "storeBytes",
  "layoutBytes",
  "heapUsedMB",
  "commitDetailMs",
] as const;
const RECORDED_ONLY_METRICS = [
  "sessionMs",
  "layoutMs",
  "fullWalkMs",
  "firstPageMsNoGraph",
  "commitDetailCachedMs",
  "fileDiffMs",
] as const;

function report(actual: Measurement, baseline: Measurement): boolean {
  let regressed = false;
  const rows: string[] = [];

  for (const name of GATED_METRICS) {
    const base = baseline[name];
    const value = actual[name];
    const delta = base === 0 ? (value === 0 ? 0 : Number.POSITIVE_INFINITY) : (value - base) / base;
    const isRegression = delta > REGRESSION_TOLERANCE;
    if (isRegression) regressed = true;
    rows.push(
      `  ${isRegression ? "✗" : "✓"} ${name}: baseline=${base.toFixed(2)} actual=${value.toFixed(2)} delta=${(delta * 100).toFixed(1)}%`,
    );
  }
  for (const name of RECORDED_ONLY_METRICS) {
    rows.push(`  · ${name} (recorded, not gated): ${actual[name].toFixed(2)}`);
  }

  console.log(
    "test:perf (history pipeline) —",
    regressed ? "REGRESSION" : "within budget",
    `(tolerance ${REGRESSION_TOLERANCE * 100}%)`,
  );
  console.log(rows.join("\n"));
  return regressed;
}

async function main(): Promise<void> {
  const updateBaseline = process.argv.includes("--update-baseline");
  const measurement = await measure();

  if (updateBaseline || !existsSync(BASELINE_PATH)) {
    saveBaseline(measurement);
    console.log(`test:perf (history pipeline) — baseline written to ${BASELINE_PATH}`);
    return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    throw new Error("unreachable: baseline existence checked above");
  }

  const regressed = report(measurement, baseline);
  if (regressed) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
