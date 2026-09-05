import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P4.md` W14 — the accessibility pass's own verification suite. `commitList.spec.ts`
 * covers the scripted keyboard-only pass this file's own "Done when" also names (its own
 * "selection and keyboard" describe carries it, since it already owns every other
 * keyboard-behaviour assertion this grid has); this file owns everything else W14 promises:
 * axe scans across all four theme kinds, and the `aria-rowcount`/`aria-rowindex` bookkeeping a
 * 20,000-row scenario needs to get right, including after a scroll to the very end.
 */

const THEME_KINDS = [
  "vscode-dark",
  "vscode-light",
  "vscode-high-contrast",
  "vscode-high-contrast-light",
] as const;

/**
 * P6a W6 — one theme per surface runs axe's full (default) ruleset; the other three run only its
 * `cat.color`-tagged rules (`color-contrast`, `link-in-text-block`, `color-contrast-enhanced` in
 * axe-core@4.13.0 — the *tag*, not a hand-listed id, so a future axe-core release that adds a
 * colour-dependent rule is still picked up), minus `color-contrast-enhanced` — see
 * `COLOR_ONLY_DISABLED_RULES` below for why. Themes here only change CSS custom properties and a
 * `body` class — never the DOM, roles, accessible names, ARIA relationships, tab order or
 * heading structure, which is what every other rule inspects. Verified, not assumed: the premise
 * probe recorded in `docs/plans/P6a-test-perf.md`'s Findings ran the full ruleset in all four
 * themes for every surface in both a11y files and found the non-`cat.color` violation sets
 * identical everywhere, so `FULL_SCAN_THEME` is an arbitrary pick among four equivalent themes,
 * not a special one.
 */
const FULL_SCAN_THEME: (typeof THEME_KINDS)[number] = "vscode-dark";

/**
 * `color-contrast-enhanced` (WCAG AAA, a 7:1 ratio) ships in axe-core with `enabled: false` —
 * axe's default ruleset (what `FULL_SCAN_THEME`'s plain `new AxeBuilder({ page })` runs, and what
 * every theme ran before this file existed) never executes it. `withTags(["cat.color"])` does not
 * respect that default: a tag-based `runOnly` pulls in every rule carrying the tag regardless of
 * its own `enabled` flag, so naively using the tag on the three abbreviated scans would start
 * checking an AAA rule three themes never had to satisfy before — a stricter, *different* test,
 * not the same coverage run cheaper, and a real one: this app has several real (7:1-only) AAA
 * contrast shortfalls, caught the hard way while landing this. Disabled here to keep the
 * abbreviated scan's coverage identical to what the full ruleset already checked everywhere.
 */
const COLOR_ONLY_DISABLED_RULES = ["color-contrast-enhanced"];

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
}

/**
 * `.kv-row-selected`'s own text genuinely passes WCAG AA — verified directly via
 * `getComputedStyle` against a live page: white text on the row's real, rendered `#0060c0`
 * background is a 6.11:1 ratio, comfortably over the 4.5:1 floor. axe itself reports it as a
 * ~1.1:1 failure against `#f3f3f3` instead — the *panel's* background, not the row's own. This is
 * a known category of axe-core false positive with absolutely-positioned, `transform:
 * translateY(...)`-placed elements (exactly how every SlickGrid row is laid out, W6): axe's
 * background-detection walk does not reliably find a transformed ancestor's own fill when
 * computing what a text node paints over.
 *
 * Filtered out per-node, by matching the exact known offending node (row-selected's message or
 * author cell) rather than by rule id or a blanket element exclusion — a real `color-contrast`
 * regression anywhere else, `.kv-row-selected` included for any *other* pair of classes, still
 * fails the assertion below. SlickGrid's own `aria-describedby` values embed a per-instance
 * numeric grid id (`slickgrid_<id>message`), so this matches on the stable class names within the
 * target path instead of the full selector string.
 */
function isKnownRowSelectedContrastFalsePositive(violationId: string, target: string[]): boolean {
  if (violationId !== "color-contrast") return false;
  const joined = target.join(" ");
  return (
    joined.includes("kv-row-selected") &&
    (joined.includes("kv-message-subject") || joined.includes("kv-cell-author"))
  );
}

async function unexpectedSeriousViolations(
  page: Page,
  kind: (typeof THEME_KINDS)[number],
): Promise<string[]> {
  const builder = new AxeBuilder({ page });
  const results = await (kind === FULL_SCAN_THEME
    ? builder
    : builder.withTags(["cat.color"]).disableRules(COLOR_ONLY_DISABLED_RULES)
  ).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .flatMap((v) =>
      v.nodes
        .filter((n) => !isKnownRowSelectedContrastFalsePositive(v.id, n.target as string[]))
        .map((n) => `${v.id} [${v.impact}]: ${n.target.join(" ")} — ${n.failureSummary}`),
    );
}

/** Appended to every axe test's name so a reader can tell, without opening the file, which scan
 *  ran the full ruleset and which ran `cat.color` only. */
function scanLabel(kind: (typeof THEME_KINDS)[number]): string {
  return kind === FULL_SCAN_THEME ? "full ruleset" : "color-contrast only";
}

test.describe("axe: no serious/critical violations", () => {
  for (const kind of THEME_KINDS) {
    test(`badges scenario, with a row selected: ${kind} (${scanLabel(kind)})`, async ({ page }) => {
      await page.goto(`/?scenario=badges&theme=${kind}`);
      await ready(page);
      await page.locator('.slick-row[data-row="0"]').waitFor({ state: "visible" });
      // A selected row (not just the at-rest grid) exercises the selection-only CSS this scan
      // otherwise never sees — `--kv-row-selected-bg`/`-fg`'s own contrast, in particular.
      await page.locator('.slick-row[data-row="0"]').click();

      expect(await unexpectedSeriousViolations(page, kind)).toEqual([]);
    });
  }

  for (const kind of THEME_KINDS) {
    test(`authFailure scenario (git-blocked panel): ${kind} (${scanLabel(kind)})`, async ({
      page,
    }) => {
      await page.goto(`/?scenario=authFailure&theme=${kind}`);
      await page.getByTestId("git-blocked-panel").waitFor();

      expect(await unexpectedSeriousViolations(page, kind)).toEqual([]);
    });
  }

  // P5 W14's own "Done when": the populated commit-detail pane and the open diff, each scanned
  // in all four theme kinds — `detail.ts`'s "tip" commit (row 1) is the one scenario carrying
  // every `FileChangeKind`/non-text `FileDiffBody` shape, so this exercises the file tree's
  // status letters and the diff's binary/LFS/too-large message rows in the same pass.
  for (const kind of THEME_KINDS) {
    test(`commit-detail pane, populated: ${kind} (${scanLabel(kind)})`, async ({ page }) => {
      await page.goto(`/?scenario=detail&theme=${kind}`);
      await ready(page);
      await page.locator('.slick-row[data-row="1"]').click();
      await expect(page.getByTestId("file-tree")).toBeVisible();

      expect(await unexpectedSeriousViolations(page, kind)).toEqual([]);
    });

    test(`commit-detail pane, diff open: ${kind} (${scanLabel(kind)})`, async ({ page }) => {
      await page.goto(`/?scenario=detail&theme=${kind}`);
      await ready(page);
      await page.locator('.slick-row[data-row="1"]').click();
      await page.locator(".kv-file-tree-row", { hasText: "modified.ts" }).click();
      await expect(page.getByTestId("diff-view").locator(".kv-diff-body")).toBeVisible();

      expect(await unexpectedSeriousViolations(page, kind)).toEqual([]);
    });
  }
});

test.describe("row accessibility bookkeeping at scale", () => {
  test("aria-rowcount tracks rows loaded so far, and aria-rowindex is correct once all 20,000 are loaded, including after scrolling to the end", async ({
    page,
  }) => {
    await page.goto("/?scenario=hugeRepo");
    await ready(page);
    const loadMore = page.locator(".kv-load-more-button:not([disabled])");
    await expect(loadMore).toBeVisible();

    const grid = page.locator(".kv-grid-host");
    // `docs/plans/P4.md`'s own words: "the *total loaded* rows, not the rendered ones" — this is
    // the grid's loaded count, not the repo's full commit count, so it only reaches 20,000 once
    // every page has actually landed (Alt-click below loads everything remaining in one go, same
    // as `commitList.spec.ts`'s own "Load more" test).
    await expect(grid).toHaveAttribute("aria-rowcount", "5000");
    await expect(grid).toHaveAttribute("aria-colcount", /^\d+$/);

    const row0 = page.locator('.slick-row[data-row="0"]');
    await expect(row0).toHaveAttribute("aria-rowindex", "1");
    const row10 = page.locator('.slick-row[data-row="10"]');
    await expect(row10).toHaveAttribute("aria-rowindex", "11");

    await loadMore.click({ modifiers: ["Alt"] });
    await expect(page.locator(".kv-load-more-button")).toBeHidden({ timeout: 10_000 });
    await expect(grid).toHaveAttribute("aria-rowcount", "20000");

    await page.evaluate(() => {
      const viewport = document.querySelector(".kv-commit-grid .slick-viewport");
      if (!(viewport instanceof HTMLElement)) throw new Error("slick-viewport not found");
      viewport.scrollTop = viewport.scrollHeight;
    });
    const lastRow = page.locator('.slick-row[data-row="19999"]');
    await expect(lastRow).toBeVisible();
    await expect(lastRow).toHaveAttribute("aria-rowindex", "20000");
    // The count itself does not move with scroll position — it already reflects everything
    // loaded, regardless of what is currently rendered in the viewport.
    await expect(grid).toHaveAttribute("aria-rowcount", "20000");
  });

  test("aria-selected and roving tabindex track the selected row, and only it", async ({
    page,
  }) => {
    await page.goto("/?scenario=clean");
    await ready(page);
    const row0 = page.locator('.slick-row[data-row="0"]');
    const row1 = page.locator('.slick-row[data-row="1"]');

    await expect(row0).toHaveAttribute("aria-selected", "false");
    await row0.click();
    await expect(row0).toHaveAttribute("aria-selected", "true");
    await expect(row0).toHaveAttribute("tabindex", "0");
    await expect(row1).toHaveAttribute("aria-selected", "false");
    await expect(row1).toHaveAttribute("tabindex", "-1");

    await page.keyboard.press("ArrowDown");
    await expect(row1).toHaveAttribute("aria-selected", "true");
    await expect(row1).toHaveAttribute("tabindex", "0");
    await expect(row0).toHaveAttribute("aria-selected", "false");
    await expect(row0).toHaveAttribute("tabindex", "-1");
  });

  test("the graph cell is hidden from assistive tech and the row itself carries the accessible name", async ({
    page,
  }) => {
    await page.goto("/?scenario=clean");
    await ready(page);
    const row0 = page.locator('.slick-row[data-row="0"]');
    await expect(row0.locator(".kv-cell-graph")).toHaveAttribute("aria-hidden", "true");
    const label = await row0.getAttribute("aria-label");
    expect(label).toContain("tip");
    expect(label).toContain("Kira Fixture");
  });

  test("SlickGrid's own structural elements are never tab stops", async ({ page }) => {
    await page.goto("/?scenario=clean");
    await ready(page);
    // W14/V2's own requirement: none of SlickGrid's fourteen internal panes/viewports/canvases/
    // focus sinks may carry a `tabindex` attribute once this grid has mounted (the sweep in
    // `CommitGrid.vue`'s `onMounted` removes it outright, not merely sets it to `-1` — see that
    // sweep's own doc comment for why the *attribute* has to be gone, not just the property).
    // `.kv-cell-sha` is excluded too, but for a different, deliberate reason (P5 W10): its
    // `tabindex` is real and present on purpose, `0` on the one tabbable row's own button and
    // `-1` everywhere else — `applyAccessibility`'s own doc comment on why that roving scheme
    // has to extend to this button, not just the row.
    const stray = await page
      .locator(".kv-grid-host [tabindex]:not(.slick-row):not(.slick-cell):not(.kv-cell-sha)")
      .count();
    expect(stray).toBe(0);
  });
});
