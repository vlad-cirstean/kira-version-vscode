#!/usr/bin/env bun
/**
 * `docs/plans/P7.md` W21's V7 — the ≤300ms prelude, broken down per hop, against *real* git.
 *
 * W18's own `reviewFirstPaintMs` (`graphUi.ts`) measures the review sidebar's cold bootstrap
 * against the harness's mock bridge — a synthetic in-memory responder with no real git process
 * behind it, so that number is the JS/Vue side of the budget (bootstrap → mount → first render
 * frame), not the git side. The real per-hop cost V7 asks about — `repo.open`, `review.
 * resolveBase` (a `symbolic-ref`/`merge-base`/`rev-list --count` spawn sequence, V8's own count),
 * and the first `git log` chunk of the range — only exists when a real `RepoService` spawns real
 * git, which this script does directly (no browser, no webview, no mock bridge), the same way
 * `streamRoundTrip.ts`/`historyPipeline.ts` measure their own real-git hops. `app.init` itself
 * (parsing and mounting the webview's own JS before it ever calls `repo.open`) is not this
 * script's concern — that is pure JS bootstrap cost already tracked by `kira:page-parsed`/`kira:
 * first-paint` in the browser tier; this measures everything after it.
 *
 * Every metric here is recorded-only, never gated: a real git spawn's wall-clock cost is
 * dominated by OS process-creation overhead, which is noisy by nature and varies by host/CI
 * container in a way `graphUi.ts`'s own `firstPageMs`/`loadMoreMs` already show — a hard ms
 * threshold on it would be a flaky tripwire on hardware, not on a regression in this codebase.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSettings } from "../../packages/core/src/index.ts";
import { FakeLogger } from "../../packages/core/src/ports/testFakes.ts";
import { NodeFileWatcher } from "../../packages/git/src/nodeFileWatcher.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { RepoService } from "../../packages/git/src/repoService.ts";
import { branchy } from "../fixtures/generateRepo.ts";

const BASELINE_PATH = join(import.meta.dir, "reviewPrelude.budget.json");
const RANGE_COMMIT_COUNT = 200; // V7's own "a 200-commit range"

interface Measurement {
  /** `RepoService.create()` + `.open(dir)` — cold session bootstrap, no refs read yet. */
  readonly repoOpenMs: number;
  /** `resolveReviewBase(repoId, branch)`, natural resolution (no override): `refs()` (cold,
   *  spawns `for-each-ref` — a real ref-badge review-open has no earlier panel session's cache to
   *  reuse), one `symbolic-ref` (this fixture has no upstream and no origin, so the probe always
   *  falls through), `merge-base`, `rev-list --count`. */
  readonly resolveBaseMs: number;
  /** The walk's own first page: `logSession.ts`'s narrowed endpoint snapshot (`rev-parse base
   *  branch`) plus the first `git log` spawn, reusing `resolveReviewBase`'s own `rev-list --count`
   *  via `precomputedTotal` (V8) rather than paying for a second one. */
  readonly firstChunkMs: number;
  /** The full prelude a real ref-badge "Review branch changes" click pays, git-side: the sum of
   *  the three hops above. `app.init`'s own JS-only cost is deliberately not part of this number
   *  (see the file's own doc comment) — §10's ≤300ms budget is for the whole journey, so this
   *  total is the part of it this script can actually exercise against real git. */
  readonly totalMs: number;
}

async function measure(): Promise<Measurement> {
  const repo = branchy({ mainCommits: 3, featureCommits: RANGE_COMMIT_COUNT, mergeBack: false });
  const runner = new NodeProcessRunner();

  const openStart = performance.now();
  const service = await RepoService.create({
    runner,
    fileWatcher: new NodeFileWatcher(),
    logger: new FakeLogger(),
    settings: () => defaultSettings(),
    configuredGitCandidates: [],
  });
  const opened = await service.open(repo.dir);
  const repoOpenMs = performance.now() - openStart;
  if (opened.kind !== "ok") throw new Error("unreachable: repo failed to open");
  const { repoId } = opened;

  try {
    const resolveStart = performance.now();
    const resolution = await service.resolveReviewBase(repoId, "feature/a");
    const resolveBaseMs = performance.now() - resolveStart;
    if (resolution.range.kind !== "ready" || resolution.base === null) {
      throw new Error(`unreachable: expected a ready range, got ${JSON.stringify(resolution)}`);
    }
    if (resolution.range.commitCount !== RANGE_COMMIT_COUNT) {
      throw new Error(
        `expected a ${RANGE_COMMIT_COUNT}-commit range, got ${resolution.range.commitCount}`,
      );
    }

    const range = { base: resolution.base, branch: "feature/a" };
    let firstChunkRows = 0;
    const chunkStart = performance.now();
    await service.streamGraph(repoId, {
      range,
      onChunk: async (chunk) => {
        firstChunkRows += chunk.to - chunk.from;
      },
    });
    const firstChunkMs = performance.now() - chunkStart;
    if (firstChunkRows === 0) throw new Error("unreachable: first chunk carried no rows");

    return {
      repoOpenMs,
      resolveBaseMs,
      firstChunkMs,
      totalMs: repoOpenMs + resolveBaseMs + firstChunkMs,
    };
  } finally {
    service.dispose();
  }
}

function loadBaseline(): Measurement | undefined {
  if (!existsSync(BASELINE_PATH)) return undefined;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Measurement;
}

function saveBaseline(measurement: Measurement): void {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(measurement, null, 2)}\n`);
}

const METRICS = ["repoOpenMs", "resolveBaseMs", "firstChunkMs", "totalMs"] as const;

function report(actual: Measurement, baseline: Measurement | undefined): void {
  console.log(
    `test:perf (review prelude, V7) — ${RANGE_COMMIT_COUNT}-commit range, real git, recorded only:`,
  );
  for (const name of METRICS) {
    const value = actual[name];
    const base = baseline?.[name];
    const suffix = base === undefined ? "" : ` (baseline ${base.toFixed(2)}ms)`;
    console.log(`  · ${name}: ${value.toFixed(2)}ms${suffix}`);
  }
  const budgetNote = actual.totalMs <= 300 ? "within" : "OVER";
  console.log(`  (§10's ≤300ms budget, git-side hops only, app.init excluded): ${budgetNote}`);
}

async function main(): Promise<void> {
  const updateBaseline = process.argv.includes("--update-baseline");
  const measurement = await measure();
  const baseline = loadBaseline();
  report(measurement, baseline);
  if (updateBaseline || !baseline) {
    saveBaseline(measurement);
    console.log(`test:perf (review prelude) — baseline written to ${BASELINE_PATH}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
