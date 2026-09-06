import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P7.md` W16's visual regression for the review sidebar view (§6.8) — the `harness`
 * project, no second Playwright project (this file's own header text explains why: a sidebar
 * width is not a different runtime, matching `graph.spec.ts`'s/`commitDetail.spec.ts`'s own
 * breakpoint precedent). Two widths — 300px (VS Code's own default sidebar) and 480px (a widened
 * one) — across all four theme kinds, of: the list, an expanded row, the diff overlay, the base
 * picker open, the ask state, and the nothing-to-review state. Linux baselines committed, per
 * `refsVisual.spec.ts`'s own standing arrangement (D27/P4c).
 */

const THEME_KINDS = [
  "vscode-dark",
  "vscode-light",
  "vscode-high-contrast",
  "vscode-high-contrast-light",
] as const;

const WIDTHS = [
  { name: "300", width: 300 },
  { name: "480", width: 480 },
] as const;

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
}

async function gotoReview(
  page: Page,
  opts: { scenario: string; branch: string; theme: string; width: number },
): Promise<void> {
  await page.setViewportSize({ width: opts.width, height: 600 });
  await page.goto(
    `/?scenario=${opts.scenario}&view=review&branch=${opts.branch}&theme=${opts.theme}`,
  );
  await ready(page);
}

for (const { name: widthName, width } of WIDTHS) {
  test.describe(`visual baseline: review list at ${widthName}px`, () => {
    for (const kind of THEME_KINDS) {
      test(`list: ${kind}`, async ({ page }) => {
        await gotoReview(page, { scenario: "review", branch: "feature", theme: kind, width });
        await expect(page.locator('[role="tree"]')).toBeVisible();
        await expect(page).toHaveScreenshot(`review-list-${widthName}-${kind}.png`);
      });
    }
  });

  test.describe(`visual baseline: an expanded row at ${widthName}px`, () => {
    for (const kind of THEME_KINDS) {
      test(`expanded row (rename): ${kind}`, async ({ page }) => {
        await gotoReview(page, { scenario: "review", branch: "feature", theme: kind, width });
        await page
          .locator(".kv-review-row", { hasText: "rename1" })
          .locator(".kv-review-row-subject")
          .click();
        await expect(
          page.locator(".kv-file-tree-row", { hasText: "renamed-new.ts" }),
        ).toBeVisible();
        await expect(page).toHaveScreenshot(`review-row-expanded-${widthName}-${kind}.png`);
      });
    }
  });

  test.describe(`visual baseline: the diff overlay at ${widthName}px`, () => {
    for (const kind of THEME_KINDS) {
      test(`diff overlay: ${kind}`, async ({ page }) => {
        await gotoReview(page, { scenario: "review", branch: "feature", theme: kind, width });
        await page
          .locator(".kv-review-row", { hasText: "rename1" })
          .locator(".kv-review-row-subject")
          .click();
        await page.locator(".kv-file-tree-row", { hasText: "renamed-new.ts" }).click();
        await expect(page.getByTestId("diff-view")).toBeVisible();
        await expect(page).toHaveScreenshot(`review-diff-overlay-${widthName}-${kind}.png`);
      });
    }
  });

  test.describe(`visual baseline: the base picker open at ${widthName}px`, () => {
    for (const kind of THEME_KINDS) {
      test(`base picker: ${kind}`, async ({ page }) => {
        await gotoReview(page, { scenario: "review", branch: "feature", theme: kind, width });
        await page.getByTestId("base-selector-trigger").click();
        await expect(page.locator(".kv-base-panel")).toBeVisible();
        await expect(page).toHaveScreenshot(`review-base-picker-${widthName}-${kind}.png`);
      });
    }
  });

  test.describe(`visual baseline: the ask state at ${widthName}px`, () => {
    for (const kind of THEME_KINDS) {
      test(`ask state: ${kind}`, async ({ page }) => {
        await gotoReview(page, { scenario: "reviewAsk", branch: "feature", theme: kind, width });
        await expect(page.getByTestId("review-ask")).toBeVisible();
        await expect(page).toHaveScreenshot(`review-ask-${widthName}-${kind}.png`);
      });
    }
  });

  test.describe(`visual baseline: nothing to review at ${widthName}px`, () => {
    for (const kind of THEME_KINDS) {
      test(`nothing to review: ${kind}`, async ({ page }) => {
        await gotoReview(page, { scenario: "reviewMerged", branch: "feature", theme: kind, width });
        await expect(page.getByTestId("review-empty")).toBeVisible();
        await expect(page).toHaveScreenshot(`review-empty-${widthName}-${kind}.png`);
      });
    }
  });
}
