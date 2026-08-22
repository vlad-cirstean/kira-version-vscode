#!/usr/bin/env bun
/**
 * Measures the §5.1 time and heap budgets against the harness and fails on a >20%
 * regression. Built in P0 — before there is anything slow — is the point: a budget
 * adopted after the code exists gets set to whatever the code currently does.
 *
 * P0 measures the placeholder shell (`?scenario=hugeRepo`, the ceiling scenario W9 needs),
 * so every number here is near zero. That is expected: what P0 must prove is that the
 * plumbing reports a number, compares it, and fails on a deliberately introduced
 * regression — not that the placeholder shell is fast.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const HARNESS_URL = "http://localhost:5173/?scenario=hugeRepo";
const BASELINE_PATH = join(import.meta.dir, "budgets.json");
const REGRESSION_TOLERANCE = 0.2; // 20%, per §5.1
const HEAP_SAMPLES = 5;

interface Budget {
  readonly timeMs: Readonly<Record<string, number>>;
  readonly heapMB: number;
}

interface Measurement {
  readonly timeMs: Readonly<Record<string, number>>;
  readonly heapMB: number;
}

async function measure(): Promise<Measurement> {
  const executablePath = process.env.KIRA_PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    const page = await browser.newPage();
    const client = await page.context().newCDPSession(page);
    await client.send("Performance.enable");
    await client.send("HeapProfiler.enable");

    await page.goto(HARNESS_URL);
    await page.waitForFunction(
      () => performance.getEntriesByName("kira:layout-complete").length > 0,
    );

    const entries = await page.evaluate(() =>
      performance.getEntriesByType("measure").map((e) => ({ name: e.name, duration: e.duration })),
    );
    const timeMs: Record<string, number> = {};
    for (const entry of entries) timeMs[entry.name] = entry.duration;

    // JS heap readings are noisy: force a collection, sample a few times, take the median.
    const samples: number[] = [];
    for (let i = 0; i < HEAP_SAMPLES; i++) {
      await client.send("HeapProfiler.collectGarbage");
      const metrics = await client.send("Performance.getMetrics");
      const heapEntry = metrics.metrics.find((m) => m.name === "JSHeapUsedSize");
      samples.push(heapEntry?.value ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    samples.sort((a, b) => a - b);
    const medianBytes = samples[Math.floor(samples.length / 2)] ?? 0;

    return { timeMs, heapMB: medianBytes / (1024 * 1024) };
  } finally {
    await browser.close();
  }
}

function loadBaseline(): Budget | undefined {
  if (!existsSync(BASELINE_PATH)) return undefined;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Budget;
}

function saveBaseline(budget: Budget): void {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(budget, null, 2)}\n`);
}

function formatMs(value: number): string {
  return `${value.toFixed(2)}ms`;
}

function report(actual: Measurement, baseline: Budget): boolean {
  let regressed = false;
  const rows: string[] = [];

  const metricNames = new Set([...Object.keys(baseline.timeMs), ...Object.keys(actual.timeMs)]);
  for (const name of metricNames) {
    const base = baseline.timeMs[name];
    const value = actual.timeMs[name];
    if (base === undefined || value === undefined) {
      rows.push(`  ${name}: baseline=${base ?? "missing"} actual=${value ?? "missing"}`);
      continue;
    }
    const delta = base === 0 ? (value === 0 ? 0 : Number.POSITIVE_INFINITY) : (value - base) / base;
    const isRegression = delta > REGRESSION_TOLERANCE;
    if (isRegression) regressed = true;
    rows.push(
      `  ${isRegression ? "✗" : "✓"} ${name}: baseline=${formatMs(base)} actual=${formatMs(value)} delta=${(delta * 100).toFixed(1)}%`,
    );
  }

  const heapDelta =
    baseline.heapMB === 0
      ? actual.heapMB === 0
        ? 0
        : Number.POSITIVE_INFINITY
      : (actual.heapMB - baseline.heapMB) / baseline.heapMB;
  const heapRegressed = heapDelta > REGRESSION_TOLERANCE;
  if (heapRegressed) regressed = true;
  rows.push(
    `  ${heapRegressed ? "✗" : "✓"} heap: baseline=${baseline.heapMB.toFixed(2)}MB actual=${actual.heapMB.toFixed(2)}MB delta=${(heapDelta * 100).toFixed(1)}%`,
  );

  console.log(
    "test:perf —",
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
    console.log(`test:perf — baseline written to ${BASELINE_PATH}`);
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
