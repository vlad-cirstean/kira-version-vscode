import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P6.md` W19: `ConflictBanner.vue`, driven from a real (fixture) mid-operation repo —
 * `conflicted` (a merge, two conflicted paths, `canContinue`/`canAbort` both true) and `rebasing`
 * (a rebase, `canContinue: false` per `InProgressOperation`'s own "false for rebase and bisect,
 * regardless of `unmergedCount`" rule). Uses `window.__kiraHarness.resolveOneConflictedPath` —
 * see that hook's own doc comment in `mockBridge.ts` — to prove Continue re-enables the moment
 * `status` reports zero unmerged paths, with no manual refresh in between.
 */

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
}

function banner(page: Page) {
  return page.getByTestId("conflict-banner");
}

test.describe("conflict banner (§7.11)", () => {
  test("appears with role=status, names the operation and the unmerged count", async ({ page }) => {
    await page.goto("/?scenario=conflicted");
    await ready(page);

    const region = banner(page);
    await expect(region).toBeVisible();
    await expect(region).toHaveAttribute("role", "status");
    await expect(region).not.toHaveAttribute("role", "alert");
    await expect(region).toContainText("2 unresolved files");
    const paths = await region.locator(".kv-conflict-banner-paths code").allTextContents();
    expect(paths).toEqual(["src/shared.ts", "docs/notes.md"]);
  });

  test("gates checkout and revert with the banner's reason, leaves branch creation alone", async ({
    page,
  }) => {
    await page.goto("/?scenario=conflicted");
    await ready(page);
    await expect(banner(page)).toBeVisible();

    // Checkout, from a ref row's own context menu. The row's own checkout button is still
    // clickable (§7.5's own gate lives in the pre-flight response, not a disabled row) — but the
    // resulting dialog explains rather than proceeding, already covered by `checkout.spec.ts`'s
    // own "in-progress operation" case. This spec's own job is the *menu-level* gate: the row
    // context menu's own "Checkout" entry is disabled with a reason.
    await page.locator(".kv-branch-trigger").click();
    const moreActions = page
      .locator(".kv-branch-row", { hasText: "topic" })
      .locator('[aria-label="More actions"]');
    await moreActions.click();
    const checkoutMenuItem = page.getByRole("menuitem", { name: "Checkout" });
    await expect(checkoutMenuItem).toHaveAttribute("aria-disabled", "true");
    await expect(checkoutMenuItem).toHaveAttribute("aria-describedby", /.+/);
    // Closes the ref menu (focus is already on a menu item, so this reaches its own handler).
    await page.keyboard.press("Escape");

    // Revert, from a commit row's own context menu.
    const row = page.locator(".slick-row", { hasText: "main" }).first();
    await row.click({ button: "right" });
    await expect(page.locator('[role="menu"]')).toBeVisible();
    const revertItem = page.getByRole("menuitem", { name: "Revert this commit…" });
    await expect(revertItem).toHaveAttribute("aria-disabled", "true");
    // Branch creation is never gated by an in-progress operation (§7.8 has no such rule) — present
    // and enabled in the very same menu.
    const createBranchItem = page.getByRole("menuitem", { name: "Create branch here…" });
    await expect(createBranchItem).toHaveAttribute("aria-disabled", "false");
    await page.keyboard.press("Escape");
  });

  test("Continue is disabled while unmerged paths remain, and enables the moment they reach zero — with no manual refresh", async ({
    page,
  }) => {
    await page.goto("/?scenario=conflicted");
    await ready(page);
    const region = banner(page);
    const continueButton = region.getByRole("button", { name: "Continue" });
    await expect(continueButton).toBeDisabled();
    await expect(continueButton).toHaveAttribute("aria-describedby", /.+/);

    await page.evaluate(() => window.__kiraHarness.resolveOneConflictedPath());
    await expect(region).toContainText("1 unresolved file");
    await expect(continueButton).toBeDisabled();

    await page.evaluate(() => window.__kiraHarness.resolveOneConflictedPath());
    await expect(continueButton).toBeEnabled();
    await expect(region).not.toContainText("unresolved");

    await continueButton.click();
    await expect(region).toBeHidden();
  });

  test("Abort clears the banner outright, even with unmerged paths remaining", async ({ page }) => {
    await page.goto("/?scenario=conflicted");
    await ready(page);
    const region = banner(page);
    await region.getByRole("button", { name: "Abort" }).click();
    await expect(region).toBeHidden();
  });

  test("a rebase offers no Continue at all, regardless of unmergedCount", async ({ page }) => {
    await page.goto("/?scenario=rebasing");
    await ready(page);
    const region = banner(page);
    await expect(region).toBeVisible();
    await expect(region.getByRole("button", { name: "Continue" })).toHaveCount(0);
    await expect(region.getByRole("button", { name: "Abort" })).toBeEnabled();
  });

  test("with resolveConflict:false the Resolve action is absent, not merely disabled", async ({
    page,
  }) => {
    // `conflictedNoResolve`: the same mid-merge fixture as `conflicted`, with
    // `capabilities.resolveConflict` false (a hidden scenario — see its own doc comment).
    await page.goto("/?scenario=conflictedNoResolve");
    await ready(page);
    const region = banner(page);
    await expect(region).toBeVisible();
    await expect(region.getByRole("button", { name: "Resolve in VS Code" })).toHaveCount(0);
    // The rest of the banner is unaffected — Continue/Abort still render and gate normally.
    await expect(region.getByRole("button", { name: "Continue" })).toBeDisabled();
    await expect(region.getByRole("button", { name: "Abort" })).toBeEnabled();
  });
});
