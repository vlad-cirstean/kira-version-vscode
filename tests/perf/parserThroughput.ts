#!/usr/bin/env bun
/**
 * W12: bytes/second and records/second streaming a full `git log` over the cached
 * `large(100_000)` repo through `nulSplit` (core) and `parse/log.ts` (git) — the parse
 * layer's own throughput ceiling, isolated from everything P2 adds around it (a worker, the
 * lane algorithm, the typed-array store).
 *
 * This is a measurement, not a §5.1 budget: it does not gate P1's exit. It gates P2's —
 * P2's ≤400ms first-page budget is unachievable if the parser itself is slow, and finding
 * that out here, while the parser is the only thing in the path, makes the number
 * attributable instead of buried under a worker and a store.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locateGit } from "../../packages/git/src/discovery.ts";
import { openGitDriver } from "../../packages/git/src/driver.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { logArgs, parseLogRecord } from "../../packages/git/src/parse/log.ts";
import { noopCatFileSession } from "../../packages/git/src/testFakes.ts";
import { large } from "../fixtures/generateRepo.ts";

const BASELINE_PATH = join(import.meta.dir, "parserThroughput.budget.json");
const REGRESSION_TOLERANCE = 0.2; // 20%, matching run.ts's §5.1 convention
const COMMIT_COUNT = 100_000;

interface Measurement {
  readonly bytesPerSecond: number;
  readonly recordsPerSecond: number;
}

const noopCatFile = noopCatFileSession();

async function measure(): Promise<Measurement> {
  const { dir } = large(COMMIT_COUNT);
  const runner = new NodeProcessRunner();
  const resolution = await locateGit({ runner });
  if (resolution.kind !== "ok") {
    throw new Error("no usable system git found for this measurement");
  }
  const driver = openGitDriver(resolution.git, runner, dir, noopCatFile);

  const read = driver.read(logArgs({ scope: "all", maxCount: COMMIT_COUNT }));
  let totalBytes = 0;
  let totalRecords = 0;
  const start = performance.now();
  for await (const record of read.records(0x00)) {
    if (record.length === 0) continue; // the trailing empty record after the last delimiter
    totalBytes += record.length + 1; // +1: the NUL delimiter, stripped by splitRecords
    parseLogRecord(record);
    totalRecords++;
  }
  await read.done;
  const elapsedSeconds = (performance.now() - start) / 1000;

  driver.dispose();
  if (totalRecords !== COMMIT_COUNT) {
    throw new Error(`expected ${COMMIT_COUNT} log records, parsed ${totalRecords}`);
  }

  return {
    bytesPerSecond: totalBytes / elapsedSeconds,
    recordsPerSecond: totalRecords / elapsedSeconds,
  };
}

function loadBaseline(): Measurement | undefined {
  if (!existsSync(BASELINE_PATH)) return undefined;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Measurement;
}

function saveBaseline(measurement: Measurement): void {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(measurement, null, 2)}\n`);
}

function formatRate(bytesOrRecordsPerSecond: number, unit: string): string {
  return `${bytesOrRecordsPerSecond.toFixed(0)} ${unit}/s`;
}

/** Unlike run.ts's timings, a throughput metric regresses when it *drops*, not when it
 *  rises — the tolerance check is the mirror image of the time-budget one. */
function report(actual: Measurement, baseline: Measurement): boolean {
  let regressed = false;
  const rows: string[] = [];

  for (const [name, unit] of [
    ["bytesPerSecond", "bytes"],
    ["recordsPerSecond", "records"],
  ] as const) {
    const base = baseline[name];
    const value = actual[name];
    const delta = base === 0 ? 0 : (value - base) / base;
    const isRegression = delta < -REGRESSION_TOLERANCE;
    if (isRegression) regressed = true;
    rows.push(
      `  ${isRegression ? "✗" : "✓"} ${name}: baseline=${formatRate(base, unit)} actual=${formatRate(value, unit)} delta=${(delta * 100).toFixed(1)}%`,
    );
  }

  console.log(
    "test:perf (parser throughput) —",
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
    console.log(`test:perf (parser throughput) — baseline written to ${BASELINE_PATH}`);
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
