import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P6.md` W19: `CheckoutDialog.vue`/`OpsState.runCheckout`, against §7.5's own five
 * verdicts — the four the `dirty` scenario states by hand (one per branch, `dirty.ts`'s own doc
 * comment) plus the fifth, D12's `worktreeConflict`, from `worktrees`.
 */

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
}

async function openPicker(page: Page): Promise<void> {
  await page.locator(".kv-branch-trigger").click();
  await expect(page.locator(".kv-branch-panel")).toBeVisible();
}

function dialog(page: Page) {
  return page.locator('[aria-labelledby="kv-checkout-dialog-title"]');
}

test.describe("checkout pre-flight", () => {
  test("clean-carry proceeds with no dialog and announces what carried", async ({ page }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);
    await openPicker(page);

    await page
      .locator(".kv-branch-row", { hasText: "feature-carry" })
      .locator(".kv-branch-row-main")
      .click();

    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId("live-announcements")).toHaveText(
      "Checked out feature-carry — 2 local changes carried over",
    );
  });

  test("blocked-by-tracked names the exact files and offers Discard / Cancel, not stash", async ({
    page,
  }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);
    await openPicker(page);

    await page
      .locator(".kv-branch-row", { hasText: "feature-blocked-tracked" })
      .locator(".kv-branch-row-main")
      .click();

    const modal = dialog(page);
    await expect(modal).toBeVisible();
    const files = await modal.locator(".kv-modal-file-list li").allTextContents();
    expect(files).toEqual(["src/tracked.ts", "README.md"]);
    await expect(
      modal.getByRole("button", { name: "Discard changes and check out" }),
    ).toBeVisible();
    await expect(modal.getByRole("button", { name: "Cancel" })).toBeVisible();
    // §7.5/P6: no stash route exists yet (a future version's own addition, per the dialog's own
    // disclosure note) — there is no actionable stash button/route, only Discard and Cancel.
    await expect(modal.getByRole("button", { name: /stash/i })).toHaveCount(0);

    await modal.getByRole("button", { name: "Cancel" }).click();
    await expect(modal).toBeHidden();
    // Cancelling leaves the branch trigger unchanged — the checkout never ran.
    await expect(page.locator(".kv-branch-trigger-label")).toHaveText("main");
  });

  test("blocked-by-untracked names the files and offers no discard route", async ({ page }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);
    await openPicker(page);

    await page
      .locator(".kv-branch-row", { hasText: "feature-blocked-untracked" })
      .locator(".kv-branch-row-main")
      .click();

    const modal = dialog(page);
    await expect(modal).toBeVisible();
    const files = await modal.locator(".kv-modal-file-list li").allTextContents();
    expect(files).toEqual(["src/scratch.ts"]);
    await expect(modal.getByRole("button", { name: "Discard changes and check out" })).toHaveCount(
      0,
    );
    await expect(modal.getByRole("button", { name: "Cancel" })).toBeVisible();
  });

  test("an in-progress operation explains and offers neither continue nor discard", async ({
    page,
  }) => {
    await page.goto("/?scenario=conflicted");
    await ready(page);
    await openPicker(page);

    await page
      .locator(".kv-branch-row", { hasText: "topic" })
      .locator(".kv-branch-row-main")
      .click();

    const modal = dialog(page);
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("An operation is already in progress");
    await expect(modal.getByRole("button", { name: "Discard changes and check out" })).toHaveCount(
      0,
    );
    await expect(modal.getByRole("button", { name: "Continue" })).toHaveCount(0);
    await expect(modal.getByRole("button", { name: "Cancel" })).toBeVisible();
  });

  test("worktreeConflict (D12): names the branch and the other worktree's path, offers only Cancel", async ({
    page,
  }) => {
    await page.goto("/?scenario=worktrees");
    await ready(page);
    await openPicker(page);

    await page
      .locator(".kv-branch-row", { hasText: "linked-work" })
      .locator(".kv-branch-row-main")
      .click();

    const modal = dialog(page);
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("linked-work");
    await expect(modal).toContainText("/repos/worktrees-linked");
    await expect(modal.getByRole("button", { name: "Discard changes and check out" })).toHaveCount(
      0,
    );
    await expect(modal.getByRole("button", { name: "Cancel" })).toBeVisible();

    await modal.getByRole("button", { name: "Cancel" }).click();
    await expect(modal).toBeHidden();
    await expect(page.locator(".kv-branch-trigger-label")).toHaveText("main");
  });
});
