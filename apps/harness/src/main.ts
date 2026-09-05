import { CommitStore, layoutAppend } from "@kira-version/core";
import {
  createLayoutClient,
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_DETAIL_WIDTH,
  mount,
  type TokenMap,
  TokenReader,
} from "@kira-version/ui";
import { createMockBridge, type HarnessEditorAction } from "./mockBridge.ts";
import { loadScenario } from "./scenarios/index.ts";
import { EPOCH_SECONDS, STEP_SECONDS, topology } from "./scenarios/topology.ts";
import { SessionStorageViewStateStore } from "./sessionViewStateStore.ts";
import { applyThemeKind, isThemeKind, type ThemeKind } from "./themeSwitcher.ts";

declare global {
  interface Window {
    __kiraHarness: {
      setTheme(kind: ThemeKind): void;
      readTokens(): TokenMap;
      checkLayoutWorker(): Promise<boolean>;
      triggerRefsChanged(): void;
      /** P5 W12/W13: the most recent `editor.openDiff`/`editor.goToFile` action the mock
       *  bridge recorded — a plain property, not a method, so a Playwright spec reads it with a
       *  bare `page.evaluate(() => window.__kiraHarness.lastEditorAction)`. */
      readonly lastEditorAction: HarnessEditorAction | undefined;
    };
  }
}

/**
 * A deterministic clock (P4 W12). `dateFormat.ts`'s own doc comment already anticipates this:
 * `formatRelativeDate`'s `nowMs` is a parameter "precisely so a fixed-clock test... can assert an
 * exact string instead of a moving target" — but nothing wired a frozen value into it yet.
 * `CommitGrid.vue`'s `now: () => Date.now()` is the one call site that reads real wall-clock
 * time for the date column's relative form; overriding the global `Date.now` here, once, reaches
 * it (and every other relative-date consumer) with no change to `packages/ui` at all — this is a
 * harness/test concern, not a UI one.
 *
 * Pinned relative to `topology.ts`'s own fixed timestamps (20 "hours" past the fixture epoch, in
 * the same synthetic 3600s-per-commit units every scenario's commits are laid out in) rather
 * than the real current time, so a relative-date cell renders the exact same text no matter when
 * the harness actually runs — the plan's own "'2h' does not become '3h' and break a baseline an
 * hour later." `EPOCH_SECONDS + 20 * STEP_SECONDS` sits comfortably past `clean`'s and `badges`'
 * own newest commits (5 and 15 entries respectively), so both show a small, stable "Nh ago"
 * rather than clamping to "now"; `hugeRepo`/`ceiling` run tens of thousands of "hours" past this
 * frozen point and so show `"now"` for their newest rows — harmless, since neither is screenshot
 * for its date column's exact text (W13 reads `.slick-row` counts and the graph column there).
 */
const HARNESS_FROZEN_NOW_MS = (EPOCH_SECONDS + 20 * STEP_SECONDS) * 1000;
Date.now = (): number => HARNESS_FROZEN_NOW_MS;

/**
 * P4 W4's own "Done when": an integration-style test drives the *real* module worker (not a
 * `WorkerLike` stub — `tests/unit/ui/layoutClient.test.ts` already covers the stub) through a
 * couple of pages and compares its output, row for row, against a synchronous `layoutAppend`
 * call fed the same input. This only needs to run in a real browser (a module worker is not
 * constructible under Bun), so it lives here as a harness hook a Playwright spec drives, rather
 * than as a `bun:test` unit test.
 *
 * The topology mixes a merge commit into an otherwise-linear chain so the two pages actually
 * exercise a patch (§5.2): the merge's second parent resolves in the first page, forcing the
 * worker to see `resolvedParentSlots` do real work, not just append straight edges.
 */
async function checkLayoutWorker(): Promise<boolean> {
  const spec = ["base", "side:base", "merge:base,side"];
  for (let i = 0; i < 20; i++) {
    spec.push(i === 0 ? `c0:merge` : `c${i}:c${i - 1}`);
  }
  const allRecords = topology(spec);

  const oracleStore = new CommitStore();
  oracleStore.appendPage(allRecords);
  const pageSize = 8;
  let oracleFrontier: ReturnType<typeof layoutAppend>["frontier"] | undefined;
  const oracleChunks: ReturnType<typeof layoutAppend>["chunk"][] = [];
  for (let from = 0; from < allRecords.length; from += pageSize) {
    const to = Math.min(from + pageSize, allRecords.length);
    const input = oracleStore.layoutInput(from, to);
    const result = layoutAppend(input, oracleFrontier);
    oracleFrontier = result.frontier;
    oracleChunks.push(result.chunk);
  }

  const workerStore = new CommitStore();
  workerStore.appendPage(allRecords);
  const client = createLayoutClient();
  try {
    const workerChunks = [];
    for (let from = 0; from < allRecords.length; from += pageSize) {
      const to = Math.min(from + pageSize, allRecords.length);
      const input = workerStore.layoutInput(from, to);
      workerChunks.push(await client.submit(input));
    }

    if (workerChunks.length !== oracleChunks.length) return false;
    for (let i = 0; i < oracleChunks.length; i++) {
      const oracle = oracleChunks[i];
      const worker = workerChunks[i];
      if (!oracle || !worker) return false;
      if (!arraysEqual(oracle.laneOf, worker.laneOf)) return false;
      if (!arraysEqual(oracle.colorOf, worker.colorOf)) return false;
      if (!arraysEqual(oracle.edges, worker.edges)) return false;
      if (!arraysEqual(oracle.edgeIndex, worker.edgeIndex)) return false;
      if (!arraysEqual(oracle.patches, worker.patches)) return false;
      if (oracle.laneCount !== worker.laneCount) return false;
      if (oracle.maxEdgeSpan !== worker.maxEdgeSpan) return false;
    }
    return true;
  } finally {
    client.dispose();
  }
}

function arraysEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const params = new URLSearchParams(location.search);
const scenarioName = params.get("scenario") ?? "clean";
const themeParam = params.get("theme") ?? "vscode-dark";

applyThemeKind(isThemeKind(themeParam) ? themeParam : "vscode-dark");

// Exercises the same getComputedStyle bridge the grid/graph row geometry reads --kv-row-height
// through (P4 W1 on) — re-read on every theme switch via the same MutationObserver path, not a
// fresh instance.
const tokenReader = new TokenReader();
tokenReader.watch();

const container = document.getElementById("app");
if (!container) {
  throw new Error("harness: #app container missing from index.html");
}

const transport = createMockBridge(scenarioName);

window.__kiraHarness = {
  setTheme(kind: ThemeKind): void {
    applyThemeKind(kind);
  },
  readTokens(): TokenMap {
    return tokenReader.tokens;
  },
  checkLayoutWorker,
  triggerRefsChanged(): void {
    transport.triggerRefsChanged();
  },
  get lastEditorAction(): HarnessEditorAction | undefined {
    return transport.getLastEditorAction();
  },
};

// `App.vue`'s own `bootstrap()` only opens a repo automatically when `viewState.read()` returns
// a persisted, non-null `repoId` — exploited here to get every scenario auto-loading on mount,
// same as before `SessionStorageViewStateStore` (P4 W13) replaced the old in-memory store. The
// difference that matters now: seed a default state only when nothing is there yet. The old
// in-memory store started empty on every navigation by construction, so writing fresh defaults
// unconditionally was a no-op difference; `sessionStorage` genuinely survives a `page.reload()`,
// and unconditionally overwriting it here would silently discard whatever `App.vue`'s own
// persistence watch (a column resize, say) had just written — defeating the one thing this
// store swap exists to let a Playwright spec exercise.
const viewState = new SessionStorageViewStateStore();
if (viewState.read() === null) {
  let repoId: string | null = null;
  try {
    const scenario = loadScenario(scenarioName);
    if (scenario.repoOpen.kind === "ok") repoId = scenario.repoOpen.repo.repoId;
  } catch {
    // An unimplemented scenario stub (dirty/conflicted, see their own files) throws on any
    // property access by design — leave repoId null and let bootstrap() run without opening a
    // repo, rather than crash the page before the shell itself has a chance to render.
  }
  viewState.write({
    version: 2,
    repoId,
    loadedRows: 0,
    detailOpen: true,
    scrollRow: 0,
    selectedSha: null,
    columnWidths: DEFAULT_COLUMN_WIDTHS,
    dateFormat: "relative",
    detailWidth: DEFAULT_DETAIL_WIDTH,
  });
}

mount(container, { transport, viewState, host: "harness" });
