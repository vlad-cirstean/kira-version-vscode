import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P6.md` W19: `BranchPicker.vue`/`TagList.vue`/`refListModel.ts`, driven end to end —
 * the picker opens, filters across all three sections with one box, sorts tags version-aware, and
 * shows the D12 worktree badge. The fifth thing W19 names for this file — "checking out a clean
 * target runs with no dialog and updates the toolbar's branch name" — is also here rather than in
 * `checkout.spec.ts`, since it is a picker interaction first and a checkout-hazard one only
 * incidentally (the `dirty` scenario's `feature-clean` target is the plan's own §7.5 "clean"
 * verdict, with nothing to confirm).
 */

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
}

async function openPicker(page: Page): Promise<void> {
  await page.locator(".kv-branch-trigger").click();
  await expect(page.locator(".kv-branch-panel")).toBeVisible();
}

test.describe("branch picker", () => {
  test("opens from the toolbar trigger and closes on Escape", async ({ page }) => {
    await page.goto("/?scenario=tags");
    await ready(page);
    await expect(page.locator(".kv-branch-panel")).toBeHidden();
    await openPicker(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".kv-branch-panel")).toBeHidden();
  });

  test("one filter box narrows all three sections by substring, case-insensitively", async ({
    page,
  }) => {
    await page.goto("/?scenario=tags");
    await ready(page);
    await openPicker(page);

    await page.locator(".kv-branch-filter").fill("MAIN");

    await expect(
      page.locator('.kv-branch-section[aria-label="Branches"] .kv-branch-row'),
    ).toHaveCount(1);
    await expect(
      page.locator('.kv-branch-section[aria-label="Branches"] .kv-branch-row-name'),
    ).toHaveText("main");
    await expect(
      page.locator('.kv-branch-section[aria-label="Remote branches"] .kv-branch-row'),
    ).toHaveCount(1);
    await expect(
      page.locator('.kv-branch-section[aria-label="Remote branches"] .kv-branch-row-name'),
    ).toHaveText("origin/main");
    // Neither tag name contains "main" — the third section empties out rather than falling back
    // to "show everything" once the other two have a match.
    await expect(page.locator('.kv-branch-section[aria-label="Tags"] .kv-branch-row')).toHaveCount(
      0,
    );
    await expect(page.locator('.kv-branch-section[aria-label="Tags"] .kv-branch-empty')).toHaveText(
      "No tags",
    );
  });

  test("tags sort version-aware, v9 before v10, both after a plain name", async ({ page }) => {
    await page.goto("/?scenario=tags");
    await ready(page);
    await openPicker(page);

    const names = await page
      .locator('.kv-branch-section[aria-label="Tags"] .kv-branch-row-name')
      .allTextContents();
    expect(names).toEqual(["checkpoint", "v1.0.0", "v9.0.0", "v10.0.0"]);
  });

  test("a branch checked out in another worktree shows the badge with its path", async ({
    page,
  }) => {
    await page.goto("/?scenario=worktrees");
    await ready(page);
    await openPicker(page);

    const row = page.locator(".kv-branch-row", { hasText: "linked-work" });
    const badge = row.locator(".kv-branch-badge");
    await expect(badge).toHaveText("worktree");
    await expect(badge).toHaveAttribute("title", "Checked out in /repos/worktrees-linked");
    // The row genuinely not checked out here carries no badge at all.
    await expect(
      page.locator(".kv-branch-row", { hasText: "main" }).locator(".kv-branch-badge"),
    ).toHaveCount(0);
  });

  test("checking out a clean target runs with no dialog and updates the toolbar", async ({
    page,
  }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);
    await expect(page.locator(".kv-branch-trigger-label")).toHaveText("main");
    await openPicker(page);

    await page.locator(".kv-branch-row", { hasText: "feature-clean" }).locator(".kv-branch-row-main").click();

    await expect(page.locator(".kv-modal-backdrop")).toHaveCount(0);
    await expect(page.locator(".kv-branch-panel")).toBeHidden();
    await expect(page.locator(".kv-branch-trigger-label")).toHaveText("feature-clean");
    await expect(page.getByTestId("live-announcements")).toHaveText("Checked out feature-clean");
  });
});
