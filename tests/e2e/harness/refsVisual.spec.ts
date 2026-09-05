import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P6.md` W19's "Visual regression" — committed Linux baselines, all four theme
 * kinds, of: the open branch picker, the row context menu, the conflict banner, and each of the
 * dialogs in its own hazardous state (the plan's own text names three; this file's own fourth,
 * `BranchDialog.vue`, has no comparable git-refusal hazard — see that file's own doc comment — so
 * its "hazardous state" here is the one real warning it can show, an invalid ref name). Plus the
 * `< 600px` breakpoint for the picker and the banner specifically — the two new full-width
 * elements in a panel `graph.spec.ts`'s own breakpoint sweep already treats as "often narrow".
 *
 * Follows `graph.spec.ts`'s/`shell.spec.ts`'s own conventions throughout: `ready()` waits for the
 * connection state and row 0 before any screenshot, and every baseline is named
 * `<subject>-<variant>.png` so `<name>-harness-linux.png` lands next to this file's own
 * `-snapshots` directory the same way theirs do.
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

async function openPicker(page: Page): Promise<void> {
  const panel = page.locator(".kv-branch-panel");
  if (!(await panel.isVisible())) {
    await page.locator(".kv-branch-trigger").click();
    await expect(panel).toBeVisible();
  }
}

test.describe("visual baseline: open branch picker", () => {
  for (const kind of THEME_KINDS) {
    test(`branch picker: ${kind}`, async ({ page }) => {
      // `tags`: one branch (with upstream track text), one remote branch, and four tags spanning
      // both kinds and the version-sort case — the richest single-scenario picker content this
      // suite has (see that scenario's own doc comment).
      await page.goto(`/?scenario=tags&theme=${kind}`);
      await ready(page);
      await openPicker(page);
      await expect(page).toHaveScreenshot(`picker-${kind}.png`);
    });
  }
});

test.describe("visual baseline: row context menu", () => {
  for (const kind of THEME_KINDS) {
    test(`row context menu: ${kind}`, async ({ page }) => {
      // The commit-row menu (`rowMenuModel.ts`'s `buildRowMenu`) — checkout detached / create
      // branch / create tag / revert / copy sha / copy message, the fullest item set this shared
      // `RowContextMenu.vue` ever renders (the ref-row menu it also drives has fewer items, and is
      // the same component under the same styles).
      await page.goto(`/?scenario=dirty&theme=${kind}`);
      await ready(page);
      const row = page.locator(".slick-row", { hasText: "main" }).first();
      await row.click({ button: "right" });
      await expect(page.locator('[role="menu"]')).toBeVisible();
      await expect(page).toHaveScreenshot(`row-menu-${kind}.png`);
    });
  }
});

test.describe("visual baseline: conflict banner", () => {
  for (const kind of THEME_KINDS) {
    test(`conflict banner: ${kind}`, async ({ page }) => {
      // `conflicted`: two conflicted paths, Resolve/Continue/Abort all present, Continue disabled
      // — the banner's own richest, most hazardous rendering.
      await page.goto(`/?scenario=conflicted&theme=${kind}`);
      await ready(page);
      await expect(page.getByTestId("conflict-banner")).toBeVisible();
      await expect(page).toHaveScreenshot(`conflict-banner-${kind}.png`);
    });
  }
});

test.describe("visual baseline: dialogs in their hazardous state", () => {
  for (const kind of THEME_KINDS) {
    test(`CheckoutDialog — blocked by tracked changes: ${kind}`, async ({ page }) => {
      await page.goto(`/?scenario=dirty&theme=${kind}`);
      await ready(page);
      await openPicker(page);
      await page
        .locator(".kv-branch-row", { hasText: "feature-blocked-tracked" })
        .locator(".kv-branch-row-main")
        .click();
      const modal = page.locator('[aria-labelledby="kv-checkout-dialog-title"]');
      await expect(modal).toBeVisible();
      await expect(page).toHaveScreenshot(`checkout-dialog-blocked-${kind}.png`);
    });

    test(`RevertDialog — predicted conflict: ${kind}`, async ({ page }) => {
      await page.goto(`/?scenario=merge&theme=${kind}`);
      await ready(page);
      const row = page.locator(".slick-row", { hasText: "side-a" }).first();
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Revert this commit…" }).click();
      const modal = page.locator('[aria-labelledby="kv-revert-dialog-title"]');
      await expect(modal).toContainText("This will likely conflict in:");
      await expect(page).toHaveScreenshot(`revert-dialog-conflict-${kind}.png`);
    });

    test(`TagDialog — force-move would silently drop the annotation: ${kind}`, async ({
      page,
    }) => {
      await page.goto(`/?scenario=tags&theme=${kind}`);
      await ready(page);
      const row = page.locator(".slick-row", { hasText: "main" }).first();
      await row.click({ button: "right" });
      await expect(page.locator('[role="menu"]')).toBeVisible();
      await page.getByRole("menuitem", { name: "Create tag here…" }).click();
      const modal = page.locator('[aria-labelledby="kv-tag-dialog-title"]');
      await modal.locator("input[type='text']").fill("v1.0.0");
      await modal.getByRole("checkbox", { name: "Replace it" }).click();
      await expect(modal).toContainText("silently downgrade it to lightweight");
      await expect(page).toHaveScreenshot(`tag-dialog-force-${kind}.png`);
    });

    test(`BranchDialog — invalid name: ${kind}`, async ({ page }) => {
      await page.goto(`/?scenario=dirty&theme=${kind}`);
      await ready(page);
      const row = page.locator(".slick-row", { hasText: "main" }).first();
      await row.click({ button: "right" });
      await expect(page.locator('[role="menu"]')).toBeVisible();
      await page.getByRole("menuitem", { name: "Create branch here…" }).click();
      const modal = page.locator('[aria-labelledby="kv-branch-dialog-title"]');
      // Probe P3 (`validateRefName`'s own doc comment): `@{` is rejected as a literal name since
      // git's own `check-ref-format` would otherwise resolve it as reflog shorthand instead.
      await modal.locator("input[type='text']").fill("release@{-1}");
      await expect(modal).toContainText("Name cannot contain '@{'");
      await expect(page).toHaveScreenshot(`branch-dialog-invalid-${kind}.png`);
    });
  }
});

test.describe("visual baseline: < 600px breakpoint", () => {
  test("branch picker at 380px", async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 600 });
    await page.goto("/?scenario=tags&theme=vscode-dark");
    await ready(page);
    await openPicker(page);
    await expect(page).toHaveScreenshot("picker-narrow-380.png");
  });

  test("conflict banner at 380px", async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 600 });
    await page.goto("/?scenario=conflicted&theme=vscode-dark");
    await ready(page);
    await expect(page.getByTestId("conflict-banner")).toBeVisible();
    await expect(page).toHaveScreenshot("conflict-banner-narrow-380.png");
  });
});
