import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P11.md` W20 — one committed baseline of §7.8's open dropdown with both groups
 * populated at once (a branch, a tag and a commit all named "release" — the richest single-query
 * rendering this scenario gives, `search.spec.ts`'s own scope test uses the same query for the
 * same reason). Follows `refsVisual.spec.ts`'s own conventions: `ready()` waits for the
 * connection state and row 0 first, one screenshot per theme kind, named `<subject>-<theme>.png`.
 */

const THEME_KINDS = [
  "vscode-dark",
  "vscode-light",
  "vscode-high-contrast",
  "vscode-high-contrast-light",
] as const;

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
  await expect(page.locator('.slick-row[data-row="0"]')).toBeVisible();
}

test.describe("visual baseline: open search dropdown, both groups populated", () => {
  for (const kind of THEME_KINDS) {
    test(`search dropdown: ${kind}`, async ({ page }) => {
      await page.goto(`/?scenario=search&theme=${kind}`);
      await ready(page);
      await page.getByTestId("search-input").fill("release");
      await expect(page.getByTestId("search-results")).toBeVisible();
      await expect(page).toHaveScreenshot(`search-dropdown-${kind}.png`);
    });
  }
});
