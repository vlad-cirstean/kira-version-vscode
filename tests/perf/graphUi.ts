#!/usr/bin/env bun
/**
 * `docs/plans/P4.md` W15 — the renderer's own budgets, measured for the first time (P2 declined
 * to claim them from a headless process; P3 measured only the wire hop `streamRoundTrip.ts`
 * owns). Follows `run.ts`'s (P0) and `streamRoundTrip.ts`'s (W17) established conventions
 * exactly: a committed baseline JSON, 20% regression tolerance, `--update-baseline`, a non-zero
 * exit on regression, and a `GATED_METRICS`/`RECORDED_ONLY_METRICS` split. It drives the harness
 * through CDP the way `run.ts` does — but, unlike `run.ts`, against a production build of the
 * harness that this script builds and previews itself, not `bun run dev:harness`'s dev server.
 * See the third departure below for why; `KIRA_HARNESS_URL` overrides this and is trusted as-is.
 *
 * Unlike the three scripts before it, this one gates on an *absolute* ceiling per metric (§5.1's
 * own numbers — 300ms first paint, 32ms worst frame, 80MB first page, …), not only on a 20%
 * regression against the previous run: a metric that has always been slow would pass the
 * regression check forever without a ceiling beside it. Both are checked; either one failing
 * fails the run.
 *
 * `kira:first-paint` and `kira:layout-complete` already existed as marks in `App.vue` (P0 put
 * them there for a placeholder shell). `kira:layout-complete` changes meaning in this phase, per
 * the plan's own instruction to note it at the mark rather than silently — see that mark's new
 * home, `CommitGrid.vue`'s `handleChunkLayout`, and `App.vue`'s own doc comment on why it moved.
 *
 * `docs/plans/P5.md` W15 adds `detailPaintMs` (recorded only — §5.1 sets no separate renderer
 * budget for the detail pane): selection to the pane's file tree in the DOM, over the mock
 * bridge, so it isolates render cost from `historyPipeline.ts`'s `commitDetailMs`, which measures
 * the *other* half of the same §5.1 number (real git spawns, no renderer at all).
 *
 * **Deliberate departures from the plan's literal wording, all because the literal reading was
 * impractical (or, in the third case, actively misleading) at this scale, recorded here and in
 * the phase's own Findings:**
 *  - "a scripted `mouse.wheel` scroll" — 2,000 real `page.mouse.wheel()` calls per position (x3
 *    positions) is ~6,000 CDP round trips, each with its own IPC latency that would dwarf the
 *    16-32ms frame budget being measured and make the run take minutes for no benefit. Instead,
 *    an in-page rAF loop advances `.slick-viewport`'s own `scrollTop` by a fixed per-frame
 *    delta, which reaches the identical code path a real wheel-driven scroll would (SlickGrid's
 *    native `scroll` listener → `cleanupRows`/`render`) without paying for synthetic input
 *    replay. The measurement mechanism the plan actually cares about — `requestAnimationFrame`
 *    deltas, not CDP tracing — is unchanged.
 *  - `bundleKB` ("the gzipped delta `slickgrid` adds") reports the whole webview+renderer JS
 *    output's gzipped size, not an isolated delta — isolating it would need a second build with
 *    `slickgrid` stubbed out, which is disproportionate effort for a metric this item itself
 *    says exists only "to make the cost visible rather than to gate on it". Recorded as a
 *    Finding, not silently substituted.
 *  - **The harness is served from a production build (`vite build` + `vite preview`), not from
 *    `bun run dev:harness`'s dev server, despite `run.ts`'s own convention doing exactly that.**
 *    Measured directly: `firstPaintMs` on the `clean` scenario reads **~400ms against the dev
 *    server and ~195ms against a static production build of the identical code** — Vite's dev
 *    server serves the module graph as hundreds of individual unbundled ES module requests,
 *    which is the right trade for iteration speed and the wrong one for a §5.1 budget that is
 *    about the *renderer*, not about Vite's own request-fanout cost. A packaged webview always
 *    loads one bundled, minified file from disk (`vscode-webview://`) — a production build
 *    statically served is the closer proxy of the two, so that is what this script measures by
 *    default. `KIRA_HARNESS_URL`, if set, is trusted as-is and skips the build+preview step
 *    entirely (useful for pointing this script at a server started some other way); left unset,
 *    this script builds `apps/harness` into its own `dist/` (gitignored, like every other `dist/`
 *    in this repo) and previews it on an ephemeral port, tearing the preview server down in the
 *    same `finally` that closes the browser.
 */
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium, type CDPSession, type Page } from "playwright-core";
import { build as viteBuild, preview as vitePreview, type PreviewServer } from "vite";

// Mirrors `packages/ui/src/graph/graphColumn.ts`'s own `declare global` for the same property —
// `tests/perf` sits outside that package's TS program, so `page.evaluate`'s in-browser callbacks
// need their own copy of the ambient type rather than inheriting it.
declare global {
  interface Window {
    __kiraRowBuildSamplesMs?: number[];
  }
}

const HARNESS_ROOT = join(import.meta.dir, "..", "..", "apps", "harness");
const BASELINE_PATH = join(import.meta.dir, "graphUi.budget.json");
const REGRESSION_TOLERANCE = 0.2; // 20%, matching every other tests/perf/*.ts script's §5.1 convention
const HEAP_SAMPLES = 5;
const CEILING_ROW_COUNT = 100_000;
const FRAME_SAMPLE_COUNT = 2000;
const FRAME_SCROLL_PX_PER_FRAME = 48; // a brisk fling, not a lazy drag
const FRAME_SCROLL_ROWS = [0, 50_000, 90_000] as const;

interface Measurement {
  readonly firstPaintMs: number;
  readonly firstPageMs: number;
  readonly loadMoreMs: number;
  readonly worstFrameMs: number;
  readonly medianFrameMs: number;
  readonly heapFirstPageMB: number;
  readonly heapFullMB: number;
  readonly layoutSubmitMs: number;
  readonly rowBuildMedianMs: number;
  readonly rowBuildP99Ms: number;
  readonly svgNodesPerRow: number;
  readonly bundleKB: number;
  readonly scenarioBuildMsReference: number;
  /** `docs/plans/P5.md` W15 — the renderer half of §5.1's "commit select → detail pane populated
   *  ≤ 80 ms": selection to the pane's file tree being in the DOM, over the mock bridge (zero
   *  added latency), so this isolates render cost alone from `historyPipeline.ts`'s
   *  `commitDetailMs` (the host half, real git spawns, no renderer). Recorded only — §5.1 sets no
   *  separate renderer-side budget for the detail pane. */
  readonly detailPaintMs: number;
}

const CEILINGS: Readonly<Record<string, number>> = {
  firstPaintMs: 300,
  firstPageMs: 400,
  loadMoreMs: 400,
  worstFrameMs: 32,
  medianFrameMs: 1000 / 60,
  heapFirstPageMB: 80,
  heapFullMB: 250,
};

const GATED_METRICS = [
  "firstPaintMs",
  "firstPageMs",
  "loadMoreMs",
  "worstFrameMs",
  "medianFrameMs",
  "heapFirstPageMB",
  "heapFullMB",
] as const;

const RECORDED_ONLY_METRICS = [
  "layoutSubmitMs",
  "rowBuildMedianMs",
  "rowBuildP99Ms",
  "svgNodesPerRow",
  "bundleKB",
  "scenarioBuildMsReference",
  "detailPaintMs",
] as const;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

async function measureDurationByName(page: Page, name: string): Promise<number> {
  return page.evaluate(
    (n) => performance.getEntriesByName(n).find((e) => e.entryType === "measure")?.duration ?? 0,
    name,
  );
}

/** `run.ts`'s own discipline: a single `JSHeapUsedSize` reading is noise, so force a collection
 *  and take the median of a few samples. */
async function sampleHeapMB(client: CDPSession): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < HEAP_SAMPLES; i++) {
    await client.send("HeapProfiler.collectGarbage");
    const metrics = await client.send("Performance.getMetrics");
    const heapEntry = metrics.metrics.find((m) => m.name === "JSHeapUsedSize");
    samples.push(heapEntry?.value ?? 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return median(samples) / (1024 * 1024);
}

/**
 * One `Load more` press: click, wait for the button to re-enable (`commitList.spec.ts`'s own
 * `readyToLoadMore` signal — a direct read of `GraphViewState.loading` returning to `"idle"`),
 * and confirm the scroll position the press started at is exactly where it ends, since §5.1's own
 * bar for this metric names that explicitly.
 *
 * Deliberately **not** "wait for `aria-rowcount` to change": that attribute is only refreshed by
 * `applyAccessibility`, itself only reachable from SlickGrid's own `onRendered` passes, which can
 * fire — and be observed by a waiting `waitForFunction` — on an intermediate, partially-applied
 * value before the button's own `disabled` binding (a direct, synchronous read of `loading`) has
 * caught up. Timing "click to rowcount-changed" would then measure only part of the press; timing
 * "click to button-enabled-again" measures the operation `GraphViewState.loading` itself defines
 * as complete.
 */
async function pressLoadMoreOnce(page: Page): Promise<number> {
  // A plain `document.querySelector` (not a Playwright `locator`), matching `a11y.spec.ts`'s own
  // "scroll to end" code: SlickGrid always builds four viewport panes (top/bottom x left/right,
  // one per axis this grid could freeze but does not), and the first one in document order is
  // the live, scrolling one — a strict-mode `locator()` call errors on the other three matches.
  const readScrollTop = () =>
    page.evaluate(() => {
      const viewport = document.querySelector(".kv-commit-grid .slick-viewport");
      return viewport instanceof HTMLElement ? viewport.scrollTop : -1;
    });
  const scrollBefore = await readScrollTop();

  const start = performance.now();
  await page.locator(".kv-load-more-button:not([disabled])").click();
  await page.locator(".kv-load-more-button:not([disabled])").waitFor({ state: "visible" });
  const elapsed = performance.now() - start;

  const scrollAfter = await readScrollTop();
  if (scrollAfter !== scrollBefore) {
    throw new Error(
      `loadMoreMs: scroll position moved from ${scrollBefore} to ${scrollAfter} — §5.1 requires it unchanged`,
    );
  }
  return elapsed;
}

/**
 * Runs an in-page rAF loop that advances `.slick-viewport`'s own `scrollTop` by a fixed
 * per-frame delta for `frameCount` frames, recording the wall-clock delta between consecutive
 * `requestAnimationFrame` callbacks — see this file's own top doc comment for why this replaces
 * a literal `mouse.wheel`-per-frame drive. The first sample (the frame before any scroll delta
 * has had a chance to matter) is dropped by the caller, not here.
 */
async function scriptedScrollFrameDurations(
  page: Page,
  frameCount: number,
  pxPerFrame: number,
): Promise<number[]> {
  return page.evaluate(
    ({ frameCount, pxPerFrame }) => {
      return new Promise<number[]>((resolve) => {
        const viewport = document.querySelector(".kv-commit-grid .slick-viewport");
        if (!(viewport instanceof HTMLElement)) {
          resolve([]);
          return;
        }
        const durations: number[] = [];
        let last = performance.now();
        let n = 0;
        function step(now: number): void {
          durations.push(now - last);
          last = now;
          n++;
          if (n >= frameCount) {
            resolve(durations);
            return;
          }
          (viewport as HTMLElement).scrollTop += pxPerFrame;
          requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      });
    },
    { frameCount, pxPerFrame },
  );
}

async function scrollToRow(page: Page, row: number, rowHeightPx = 22): Promise<void> {
  await page.evaluate(
    ({ row, rowHeightPx }) => {
      const viewport = document.querySelector(".kv-commit-grid .slick-viewport");
      if (viewport instanceof HTMLElement) viewport.scrollTop = row * rowHeightPx;
    },
    { row, rowHeightPx },
  );
  // Let the grid actually rebuild rows at the new position before frame timing starts, so the
  // jump itself (a much bigger single render than any one fling frame) is never in-sample.
  await page.waitForTimeout(150);
}

/** Reads the emitted webview+renderer JS output's total gzipped size out of `dist/ui`, rebuilt
 *  fresh so this number reflects the tree being measured, not a stale prior build. See this
 *  file's own top doc comment for why this is the whole bundle, not slickgrid's isolated delta. */
function measureBundleKB(): number {
  const repoRoot = join(import.meta.dir, "..", "..");
  execSync("bun run build", { cwd: repoRoot, stdio: "pipe" });
  const distDir = join(repoRoot, "dist", "ui");
  let totalGzipBytes = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".js")) {
        totalGzipBytes += gzipSync(readFileSync(full)).byteLength;
      }
    }
  };
  walk(distDir);
  return totalGzipBytes / 1024;
}

interface HarnessServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

/** See this file's own top doc comment for why a production build, not `bun run dev:harness`'s
 *  dev server, is what this script measures against by default. `KIRA_HARNESS_URL` bypasses this
 *  entirely and is trusted as-is, matching `run.ts`'s own escape hatch.
 *
 *  Builds into a fresh `os.tmpdir()` directory, deliberately **not** `apps/harness/dist` — that
 *  path is already `tsc --build`'s own `outDir` for the harness project's declaration output
 *  (`apps/harness/tsconfig.json`), and Vite's default `emptyOutDir: true` would delete whatever
 *  `.d.ts` files are sitting there for the project-reference graph `tests/tsconfig.json` now
 *  depends on (`../apps/harness`, added so `measureScenarioBuildReference` below can import
 *  `apps/harness/src/scenarios/topology.ts` at all). Two independent build systems writing to one
 *  directory is exactly the kind of state-corruption bug that is invisible until the *other* tool
 *  runs next and finds its output gone. */
async function startHarnessServer(): Promise<HarnessServer> {
  const explicit = process.env.KIRA_HARNESS_URL;
  if (explicit) return { baseUrl: explicit, close: async () => {} };

  const outDir = mkdtempSync(join(tmpdir(), "kira-harness-perf-"));
  await viteBuild({ root: HARNESS_ROOT, logLevel: "warn", build: { outDir, emptyOutDir: true } });
  const server: PreviewServer = await vitePreview({
    root: HARNESS_ROOT,
    logLevel: "warn",
    build: { outDir },
    preview: { port: 4173, strictPort: false },
  });
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error("vite preview did not resolve a local URL for the harness build");
  return {
    baseUrl: url.replace(/\/$/, ""),
    close: async () => {
      await server.close();
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}

/** `firstPageMs`'s single biggest confound in this scenario: `ceiling.ts`'s own doc comment says
 *  building its 100,000 `chain()` records "costs real seconds", and that build runs synchronously,
 *  in-browser, before the mock bridge can answer the very first RPC — so it is unavoidably inside
 *  the `navigation → kira:layout-complete` window `firstPageMs` measures, and it is a harness-only
 *  cost with no equivalent in the real host (which streams from an already-open `git log`, not
 *  from an eagerly-materialized array). Timed here, directly, in the same JS engine family
 *  (V8) the browser measurement runs on, as a reference for attributing a `firstPageMs` miss —
 *  not gated, per this file's own `RECORDED_ONLY_METRICS` convention.
 */
async function measureScenarioBuildReference(): Promise<number> {
  const { chain } = await import("../../apps/harness/src/scenarios/topology.ts");
  const start = performance.now();
  chain(CEILING_ROW_COUNT, "ceiling");
  return performance.now() - start;
}

async function measure(): Promise<Measurement> {
  const bundleKB = measureBundleKB();
  const scenarioBuildMsReference = await measureScenarioBuildReference();
  const harness = await startHarnessServer();
  const HARNESS_BASE = harness.baseUrl;

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

    // --- firstPaintMs: the `clean` scenario, §5.1's own "panel open -> first commits painted". ---
    await page.goto(`${HARNESS_BASE}/?scenario=clean`);
    await page.waitForFunction(() => performance.getEntriesByName("kira:first-paint").length > 0);
    const firstPaintMs = await measureDurationByName(page, "kira:first-paint");

    // --- firstPageMs / layoutSubmitMs / heapFirstPageMB: `ceiling`, the 100k-row scenario. ---
    await page.goto(`${HARNESS_BASE}/?scenario=ceiling`);
    await page.waitForFunction(
      () => performance.getEntriesByName("kira:layout-complete").length > 0,
    );
    const firstPageMs = await measureDurationByName(page, "kira:layout-complete");
    const layoutSubmitMs = await measureDurationByName(page, "kira:layout-submit");
    const heapFirstPageMB = await sampleHeapMB(client);

    // --- loadMoreMs: worst of five presses, scroll position unchanged each time. ---
    const loadMoreSamples: number[] = [];
    for (let i = 0; i < 5; i++) {
      loadMoreSamples.push(await pressLoadMoreOnce(page));
    }
    const loadMoreMs = Math.max(...loadMoreSamples);

    // --- Load every remaining page (Alt-click, same "load all" gesture the interaction suite
    // already exercises) before either the frame-timing scroll or heapFullMB below: rows 50k and
    // 90k do not exist yet after only the first six pages loaded above, so scrolling to them now
    // (rather than after) is what makes those two offsets real, distinct positions instead of
    // both clamping to the same partially-loaded bottom. One click, not a loop: `handlePress`
    // (`LoadMoreButton.vue`) reads the Alt modifier once and calls `loadAll()`, which already
    // loops pages internally until the host reports the history exhausted. `page.locator(...)
    // .click()` on a `:not([disabled])`-qualified locator auto-waits for the button to actually
    // be enabled before clicking — load-bearing here, since the last `loadMoreMs` press above may
    // still be settling (`GraphViewState.loading` returns to `"idle"` a render tick after
    // `pressLoadMoreOnce` observes the button re-enable) when this line runs.
    await page.locator(".kv-load-more-button:not([disabled])").click({ modifiers: ["Alt"] });
    await page.waitForFunction(
      () => document.querySelector(".kv-load-more-button") === null,
      undefined,
      {
        timeout: 60_000,
      },
    );
    // `aria-rowcount` is only refreshed by `applyAccessibility`, which only runs from SlickGrid's
    // own `onRendered` — a pass over whatever range is *currently visible*. The frame-timing
    // scroll below re-renders the visible range anyway, but this read happens first, so a nudge
    // forces a fresh pass before trusting the count rather than racing the same staleness window
    // a real scrollbar-drag would never hit (a user's own scroll to the end always re-renders the
    // range they land on). `scrollTop` sits at (or near) 0 here — the five `loadMoreMs` presses
    // above never moved it — so a `-= 1` nudge would clamp to the same 0 and fire no `scroll`
    // event at all; `+= 1` always has room once more content exists below.
    await page.evaluate(() => {
      const viewport = document.querySelector(".kv-commit-grid .slick-viewport");
      if (viewport instanceof HTMLElement) viewport.scrollTop += 1;
    });
    await page.waitForFunction(
      (expected) =>
        document.querySelector(".kv-grid-host")?.getAttribute("aria-rowcount") === expected,
      String(CEILING_ROW_COUNT),
      { timeout: 5_000 },
    );
    const rowCount = await page.locator(".kv-grid-host").getAttribute("aria-rowcount");
    if (rowCount !== String(CEILING_ROW_COUNT)) {
      throw new Error(`heapFullMB: expected ${CEILING_ROW_COUNT} rows loaded, got ${rowCount}`);
    }

    // --- rowBuildMs sampling: armed before the frame-timing scroll below, which is the one
    // phase that builds thousands of rows in quick succession — plenty of samples without a
    // dedicated pass of its own. ---
    await page.evaluate(() => {
      window.__kiraRowBuildSamplesMs = [];
    });

    // --- worstFrameMs / medianFrameMs: a scripted scroll at three row offsets, combined, now
    // that the full 100k-row `ceiling` dataset is loaded. ---
    const allFrameDurations: number[] = [];
    for (const row of FRAME_SCROLL_ROWS) {
      await scrollToRow(page, row);
      const durations = await scriptedScrollFrameDurations(
        page,
        FRAME_SAMPLE_COUNT,
        FRAME_SCROLL_PX_PER_FRAME,
      );
      allFrameDurations.push(...durations.slice(1)); // drop the pre-scroll settle frame
    }
    const worstFrameMs = Math.max(...allFrameDurations);
    const medianFrameMs = median(allFrameDurations);

    const rowBuildSamples = await page.evaluate(() => window.__kiraRowBuildSamplesMs ?? []);
    const rowBuildMedianMs = median(rowBuildSamples);
    const rowBuildP99Ms = percentile(rowBuildSamples, 99);

    // --- heapFullMB: sampled now, with all 100k rows loaded and the frame-timing scroll's own
    // row churn settled. ---
    const heapFullMB = await sampleHeapMB(client);

    // --- svgNodesPerRow: the `badges` scenario, mean SVG child elements per rendered graph cell.
    // Waits for `kira:layout-complete` (a fresh navigation resets `performance`'s own entry list,
    // so this is a second wait for it, not a reuse of the `ceiling` one above), not merely for
    // row 0 to be visible: text renders a frame before lanes do (`GraphViewState`'s own doc
    // comment), so counting immediately on row-visibility would count every row's `<svg>` while
    // it still has zero children — a real zero, but not the number this metric means to report. ---
    await page.goto(`${HARNESS_BASE}/?scenario=badges`);
    await page.waitForFunction(
      () => performance.getEntriesByName("kira:layout-complete").length > 0,
    );
    const svgNodesPerRow = await page.evaluate(() => {
      const svgs = document.querySelectorAll(".kv-graph-svg");
      if (svgs.length === 0) return 0;
      let total = 0;
      for (const svg of svgs) total += svg.children.length;
      return total / svgs.length;
    });

    // --- detailPaintMs: `docs/plans/P5.md` W15 — the `detail` scenario's `manyFiles` row (row 0,
    // the 5,000-file commit topology.ts's own doc comment names) is what makes the W8 render
    // cap's number meaningful rather than assumed. A fresh navigation (rather than reusing
    // `badges` above) so `selection → file tree in the DOM` is not sharing a page with any prior
    // scenario's own leftover detail state. Node-side start/elapsed around the click, same
    // bracket `pressLoadMoreOnce` above already uses for `loadMoreMs` — the one CDP round trip
    // each of `.click()`/`.waitFor()` costs is the same on both sides of the measurement in every
    // run, so it does not bias a regression comparison against the committed baseline. ---
    await page.goto(`${HARNESS_BASE}/?scenario=detail`);
    await page.waitForFunction(
      () => document.querySelector('[data-testid="connection-state"]') !== null,
    );
    const detailPaintStart = performance.now();
    await page.locator('.slick-row[data-row="0"]').click();
    await page.locator('[data-testid="file-tree"]').waitFor({ state: "attached" });
    const detailPaintMs = performance.now() - detailPaintStart;

    return {
      firstPaintMs,
      firstPageMs,
      loadMoreMs,
      worstFrameMs,
      medianFrameMs,
      heapFirstPageMB,
      heapFullMB,
      layoutSubmitMs,
      rowBuildMedianMs,
      rowBuildP99Ms,
      svgNodesPerRow,
      bundleKB,
      scenarioBuildMsReference,
      detailPaintMs,
    };
  } finally {
    await browser.close();
    await harness.close();
  }
}

function loadBaseline(): Measurement | undefined {
  if (!existsSync(BASELINE_PATH)) return undefined;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Measurement;
}

function saveBaseline(measurement: Measurement): void {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(measurement, null, 2)}\n`);
}

function report(actual: Measurement, baseline: Measurement): boolean {
  let regressed = false;
  const rows: string[] = [];

  for (const name of GATED_METRICS) {
    const base = baseline[name];
    const value = actual[name];
    const delta = base === 0 ? (value === 0 ? 0 : Number.POSITIVE_INFINITY) : (value - base) / base;
    const ceiling = CEILINGS[name];
    const overCeiling = ceiling !== undefined && value > ceiling;
    const isRegression = delta > REGRESSION_TOLERANCE || overCeiling;
    if (isRegression) regressed = true;
    const ceilingNote = ceiling !== undefined ? ` ceiling=${ceiling.toFixed(2)}` : "";
    rows.push(
      `  ${isRegression ? "✗" : "✓"} ${name}: baseline=${base.toFixed(2)} actual=${value.toFixed(2)} delta=${(delta * 100).toFixed(1)}%${ceilingNote}`,
    );
  }
  for (const name of RECORDED_ONLY_METRICS) {
    rows.push(`  · ${name} (recorded, not gated): ${actual[name].toFixed(2)}`);
  }

  console.log(
    "test:perf (graph UI) —",
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
    console.log(`test:perf (graph UI) — baseline written to ${BASELINE_PATH}`);
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
