import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P4.md` W13 — the visual regression suite. `commitList.spec.ts` covers behaviour;
 * this file only screenshots and reads computed style, per that file's own "this file never
 * screenshots" line. Six scenarios, matching the plan's own list verbatim:
 *
 *  1. `badges` in all four theme kinds — one screenshot per kind, the widest single-scenario
 *     coverage of decoration kinds, node shapes, and lane colours in one row set.
 *  2. The three §6.3 breakpoints (wide/narrow/overlay) at one theme kind.
 *  3. One screenshot after a `Load more`, to catch a lane discontinuity at a page boundary —
 *     `pagedBranch` (P4 W13) exists specifically for this; see its own doc comment.
 *  4. One screenshot at `deviceScaleFactor: 1.5` — the fractional-DPR seam W8's per-row-SVG
 *     overdraw risk cares about.
 *  5. A theme-switch-with-no-reload assertion — the graph's `<svg>` nodes are drawn once and
 *     carry only CSS classes (`palette.ts`'s own doc comment: "no JavaScript executed" on a
 *     theme switch), so flipping the theme kind *without* touching the grid must still change
 *     what those already-drawn nodes render as. A live pixel-buffer diff has no baseline to
 *     compare against and pixelmatch is not a dependency here, so this reads computed style
 *     instead of a screenshot — same signal ("did the colour move"), deterministic, and it can
 *     also assert the DOM node itself was never replaced (a marker attribute would vanish if a
 *     re-render touched it), which a screenshot diff could not tell apart from a repaint.
 *  6. A lane's colour read off computed style — confirms the class→CSS-variable→rendered-colour
 *     pipeline actually resolves to the palette's own token value, not just "some colour".
 *
 * P5 W13 adds a seventh scenario, the commit-detail pane (`detail.ts`'s eight-file-kind `tip`
 * commit): the populated pane and the open diff view in all four theme kinds, the overlay
 * breakpoint's diff at one kind, and the binary/LFS rows (where a "labelled rather than rendered
 * as garbage" regression would actually show) at one kind.
 */

const THEME_KINDS = [
  "vscode-dark",
  "vscode-light",
  "vscode-high-contrast",
  "vscode-high-contrast-light",
] as const;

// `Window.__kiraHarness`'s ambient type is declared once, project-wide, in `shell.spec.ts` — see
// that file's own comment on why this file does not repeat it.

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
  await expect(page.locator('.slick-row[data-row="0"]')).toBeVisible();
  // The row div itself paints before its graph cell's SVG does — layout is a separate async pass
  // (`GraphViewState.onChunkLayout`, `CommitGrid.vue`'s own `handleChunkLayout`) — so a row being
  // visible is not enough to guarantee row 0's node dot exists yet; a test that reads it
  // immediately after the row check alone is a real, observed race, not a hypothetical one.
  await expect(page.locator('.slick-row[data-row="0"] .kv-graph-svg circle.kv-node')).toHaveCount(
    1,
  );
}

test.describe("visual baseline: badges across theme kinds", () => {
  for (const kind of THEME_KINDS) {
    test(`badges: ${kind}`, async ({ page }) => {
      await page.goto(`/?scenario=badges&theme=${kind}`);
      await ready(page);
      // Scoped to the grid itself, not `toHaveScreenshot(page)`, and with a tight absolute pixel
      // budget rather than `playwright.config.ts`'s own 2%-of-page-area default: the graph column
      // is a narrow strip even of just `.kv-commit-grid`, and a lane recolouring only ever touches
      // that strip's own thin lines and small node dots — nowhere near 2% of either area. This is
      // not a hypothetical margin: confirmed empirically, while validating W13's own palette-swap
      // canary (`P4.md`'s "Done when"), that neither the full-page nor the whole-grid default
      // tolerance actually catches a deliberate two-lane colour swap. `maxDiffPixels: 40` does —
      // large enough to absorb anti-aliasing noise between runs (rendering here is otherwise
      // deterministic: headless Chromium, no animation, `reducedMotion: "reduce"`), nowhere near
      // large enough to absorb an entire lane's worth of recoloured line and dot pixels.
      await expect(page.locator(".kv-commit-grid")).toHaveScreenshot(`graph-badges-${kind}.png`, {
        maxDiffPixels: 40,
      });
    });
  }
});

test.describe("visual baseline: §6.3 breakpoints", () => {
  // One theme kind, per the plan — the four-kind sweep above already covers colour; this sweep
  // is about layout (docked pane, collapsed pane, overlay drawer), which does not vary by theme.
  const BREAKPOINTS = [
    { name: "wide", width: 1000, height: 600 },
    { name: "narrow", width: 750, height: 600 },
    { name: "overlay", width: 480, height: 600 },
  ] as const;

  for (const { name, width, height } of BREAKPOINTS) {
    test(`breakpoint: ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto("/?scenario=badges&theme=vscode-dark");
      await ready(page);
      // Select a row at every width so all three screenshots actually render the detail pane's
      // content (docked open at "wide"; §6.3's "opens on selection" brings it up at the other
      // two, which would otherwise screenshot as permanently collapsed/absent and prove nothing
      // about the docked-vs-overlay chrome this sweep exists to catch).
      await page.locator('.slick-row[data-row="0"]').click();
      await expect(page.getByTestId("detail-region")).toBeVisible();
      await expect(page).toHaveScreenshot(`graph-breakpoint-${name}.png`);
    });
  }
});

test.describe("visual baseline: fractional DPR", () => {
  test.use({ deviceScaleFactor: 1.5 });

  test("badges at deviceScaleFactor 1.5", async ({ page }) => {
    await page.goto("/?scenario=badges&theme=vscode-dark");
    await ready(page);
    await expect(page).toHaveScreenshot("graph-dpr-1.5.png");
  });
});

test.describe("visual baseline: load more lane continuity", () => {
  // `pagedBranch` (P4 W13, `apps/harness/src/scenarios/pagedBranch.ts`) is built so its one
  // long-lived side branch's row-span straddles the default page-size boundary (row 4999/5000) —
  // rows 4799-5198 are branch commits, so both the fork point and a mid-branch cut sit inside
  // page one, and `Load more` is what resolves the rest. `--kv-row-height`'s default is 22px
  // (`theme/density.css`) — used here only to compute a scroll offset, not asserted on.
  const ROW_HEIGHT_PX = 22;

  test("screenshot brackets the page-boundary seam after Load more", async ({ page }) => {
    await page.goto("/?scenario=pagedBranch&theme=vscode-dark");
    await page.getByTestId("connection-state").waitFor();
    await expect(page.locator(".kv-load-more-button:not([disabled])")).toBeVisible();

    await page.locator(".kv-load-more-button").click();
    // `graph.loadMore`'s new rows land as they stream in, not atomically — row 6399 (the trunk's
    // own head-side tail, the very last row this scenario has) existing is the one visible signal
    // the whole of page two has actually landed, matching `commitList.spec.ts`'s own
    // `readyToLoadMore` reasoning for page one.
    await page.locator(".kv-load-more-button").waitFor({ state: "detached" });

    // Scroll so the boundary (row 4999/5000) sits mid-viewport rather than at an edge, where a
    // discontinuity would be half-clipped out of the screenshot.
    const targetTop = (5000 - 10) * ROW_HEIGHT_PX;
    await page.evaluate((top) => {
      const viewport = document.querySelector(".kv-commit-grid .slick-viewport");
      if (!(viewport instanceof HTMLElement)) throw new Error("slick-viewport not found");
      viewport.scrollTop = top;
      viewport.dispatchEvent(new Event("scroll"));
    }, targetTop);
    await expect(page.locator('.slick-row[data-row="5000"]')).toBeVisible();

    await expect(page.getByTestId("graph-region")).toHaveScreenshot("graph-load-more-seam.png");
  });
});

test.describe("lane colour resolves through the cascade", () => {
  /** The node dot in row 0's graph cell (`rowSvg.ts`'s `<circle class="kv-lane-N kv-node">`),
   *  plus which lane `N` it is. Specifically the `circle`, not any `.kv-lane-N`-classed element:
   *  the edge `<path>` next to it is deliberately given an inline `style="fill: none"`
   *  (`rowSvg.ts`'s own comment — an edge is stroked, never filled) which, having higher
   *  specificity than the class rule, would make a fill read off *that* element always "none"
   *  regardless of theme. `palette.ts`'s own doc comment: a lane's colour is never computed in
   *  JavaScript, only a class name is, so reading it back only ever needs the DOM and
   *  `getComputedStyle`. */
  async function firstLaneFill(page: Page): Promise<{ index: number; fill: string }> {
    return page.evaluate(() => {
      const el = document.querySelector('.slick-row[data-row="0"] .kv-graph-svg circle.kv-node');
      if (!el) throw new Error("no circle.kv-node found in row 0's graph cell");
      const match = /kv-lane-(\d+)/.exec(el.getAttribute("class") ?? "");
      if (!match) throw new Error("kv-lane-N class not found on the node circle");
      return { index: Number(match[1]), fill: getComputedStyle(el).fill };
    });
  }

  /** Resolves a CSS colour value (a custom property's own current value, e.g. `"#569cd6"`) to
   *  the same `rgb(...)` form `getComputedStyle(...).fill` returns, via a throwaway element —
   *  the browser's own colour-parsing, not a hand-rolled hex→rgb conversion. */
  async function resolveColor(page: Page, cssValue: string): Promise<string> {
    return page.evaluate((value) => {
      const probe = document.createElement("span");
      probe.style.color = value;
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    }, cssValue);
  }

  test("a rendered lane's fill matches its own --kv-graph-lane-N token", async ({ page }) => {
    await page.goto("/?scenario=badges&theme=vscode-dark");
    await ready(page);

    const { index, fill } = await firstLaneFill(page);
    const tokenValue = await page.evaluate(
      (i) => getComputedStyle(document.documentElement).getPropertyValue(`--kv-graph-lane-${i}`),
      index,
    );
    expect(tokenValue.trim().length).toBeGreaterThan(0);
    expect(fill).toBe(await resolveColor(page, tokenValue));
  });

  test("switching theme with no reload recolours the already-drawn SVG in place", async ({
    page,
  }) => {
    await page.goto("/?scenario=badges&theme=vscode-dark");
    await ready(page);

    // A lane's *fill* is not actually a fair signal here: this harness's `themeSwitcher.ts` is
    // deliberately P0 fidelity ("a small hand-written dev palette for the --vscode-* tokens the
    // placeholder shell reads", its own doc comment) and never sets the per-kind
    // `--vscode-kiraVersion-graphLane*` ids a real VS Code host would — every kind here falls
    // through to `vscode-tokens.css`'s own literal fallback, so `--kv-graph-lane-N`, and thus
    // fill, never actually moves between kinds in this harness. `.kv-node`'s *stroke*, by
    // contrast, genuinely does: `vscode-tokens.css`'s own `body.vscode-high-contrast,
    // body.vscode-high-contrast-light` block is exactly where `--kv-graph-node-outline` and its
    // width are set at all (`none`/`0` everywhere else) — a real, harness-driven, theme-kind-
    // dependent change, and the one §6.1 calls out ("high-contrast kinds get explicit node
    // outlines"). Tagging the exact DOM node this test reads also catches a re-render directly
    // (which would replace it, not restyle it), not just infer one from the colour happening to
    // differ.
    await page.evaluate(() => {
      const el = document.querySelector('.slick-row[data-row="0"] .kv-graph-svg circle.kv-node');
      if (!el) throw new Error("no circle.kv-node found in row 0's graph cell");
      el.setAttribute("data-theme-switch-probe", "1");
    });
    const probe = page.locator('[data-theme-switch-probe="1"]');
    const darkStroke = await probe.evaluate((el) => getComputedStyle(el).stroke);
    const darkStrokeWidth = await probe.evaluate((el) => getComputedStyle(el).strokeWidth);
    expect(darkStroke).toBe("none");
    expect(darkStrokeWidth).toBe("0px");

    // `themeSwitcher.ts`'s `applyThemeKind`: a `<body>` class swap plus a handful of
    // `--vscode-*` custom-property writes on `document.documentElement` — no grid/graph code
    // runs, matching `palette.ts`'s own "no JavaScript executed" claim for a real theme switch.
    await page.evaluate(() => window.__kiraHarness.setTheme("vscode-high-contrast"));

    // Still the same node — proves the recolour below is a cascade repaint, not a re-render that
    // happened to draw the same class in a different theme's colour. (Before P4 W13's own
    // `readTokens.ts` fix, *any* theme switch replaced this node regardless: `TokenReader.watch`
    // notified on every `<body>` class/style mutation unconditionally, and `CommitGrid.vue`'s
    // listener always ran a full `invalidateAllRows()` — see that file's own doc comment.)
    await expect(probe).toHaveCount(1);
    const hcStroke = await probe.evaluate((el) => getComputedStyle(el).stroke);
    const hcStrokeWidth = await probe.evaluate((el) => getComputedStyle(el).strokeWidth);

    expect(hcStroke).not.toBe(darkStroke);
    expect(hcStrokeWidth).not.toBe(darkStrokeWidth);

    // `--kv-graph-node-outline` is only ever set inside the `body.vscode-high-contrast*` rule
    // itself (`vscode-tokens.css`) — a custom property does not inherit "upward" from `<body>` to
    // `:root`, so this reads it from `document.body`, the element that actually carries the rule,
    // not `document.documentElement` (which every other token read in this file uses because
    // `applyThemeKind` writes those directly onto `:root`'s own inline style).
    const hcOutlineToken = await page.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue("--kv-graph-node-outline"),
    );
    expect(hcStroke).toBe(await resolveColor(page, hcOutlineToken));
  });
});

test.describe("visual baseline: commit-detail pane across theme kinds", () => {
  // `detail.ts`'s topology (P5 W12/W13): "tip" (row 1) is the eight-file-kind workhorse this
  // whole scenario exists for — "manyFiles" (row 0) is the render-cap fixture, out of scope here.
  for (const kind of THEME_KINDS) {
    test(`detail pane: ${kind}`, async ({ page }) => {
      await page.goto(`/?scenario=detail&theme=${kind}`);
      await ready(page);
      await page.locator('.slick-row[data-row="1"]').click();
      await expect(page.getByTestId("detail-region")).toBeVisible();
      await expect(page.getByTestId("file-tree")).toBeVisible();
      await expect(page.getByTestId("detail-region")).toHaveScreenshot(`detail-pane-${kind}.png`);
    });

    test(`open diff view: ${kind}`, async ({ page }) => {
      await page.goto(`/?scenario=detail&theme=${kind}`);
      await ready(page);
      await page.locator('.slick-row[data-row="1"]').click();
      await page.locator(".kv-file-tree-row", { hasText: "modified.ts" }).click();
      await expect(page.getByTestId("diff-view")).toBeVisible();
      await expect(page.getByTestId("diff-view").locator(".kv-diff-body")).toBeVisible();
      await expect(page.getByTestId("detail-region")).toHaveScreenshot(`detail-diff-${kind}.png`);
    });
  }
});

test.describe("visual baseline: commit-detail overlay breakpoint diff", () => {
  test("the diff opens full-width at the overlay breakpoint", async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 600 });
    await page.goto("/?scenario=detail&theme=vscode-dark");
    await ready(page);
    await page.locator('.slick-row[data-row="1"]').click();
    await page.locator(".kv-file-tree-row", { hasText: "modified.ts" }).click();
    await expect(page.getByTestId("diff-view")).toBeVisible();
    await expect(page).toHaveScreenshot("detail-diff-overlay.png");
  });
});

test.describe("visual baseline: binary and LFS diff rows", () => {
  // §6.4/D14a: the risk this baseline exists to catch is a binary or LFS body rendering as raw
  // (garbage) diff text instead of its own labelled message row — one kind is enough, matching
  // the plan's own list for this scenario.
  test("a binary file's diff shows its labelled message, not its bytes", async ({ page }) => {
    await page.goto("/?scenario=detail&theme=vscode-dark");
    await ready(page);
    await page.locator('.slick-row[data-row="1"]').click();
    await page.locator(".kv-file-tree-row", { hasText: "image.png" }).click();
    await expect(page.getByTestId("diff-view").locator(".kv-diff-message")).toBeVisible();
    await expect(page.getByTestId("diff-view")).toHaveScreenshot("detail-diff-binary.png");
  });

  test("an LFS pointer's diff shows its labelled message, not a pointer blob", async ({ page }) => {
    await page.goto("/?scenario=detail&theme=vscode-dark");
    await ready(page);
    await page.locator('.slick-row[data-row="1"]').click();
    await page.locator(".kv-file-tree-row", { hasText: "large-asset.bin" }).click();
    await expect(page.getByTestId("diff-view").locator(".kv-diff-message")).toBeVisible();
    await expect(page.getByTestId("diff-view")).toHaveScreenshot("detail-diff-lfs.png");
  });
});
