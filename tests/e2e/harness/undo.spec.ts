import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P6.md` W19: `UndoButton.vue`/`OpsState.undo`, against §7.12. The mock has no real
 * git object database behind it, so there is no literal argv to replay the way
 * `repoService.test.ts`'s own real-git "branchDelete undo restores upstream tracking config" test
 * can assert — `PendingUndo.restore()` (`mockBridge.ts`) instead pushes back the exact original
 * `RefRow` it captured, and this file's own "argv" equivalent is observing that the row comes back
 * with everything that row carried, not merely a same-named, freshly-reconstructed one: the
 * upstream-tracking badge for a branch, and the annotation (not a `tagPush -f`-style downgrade to
 * lightweight) for a tag.
 */

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
}

async function openPicker(page: Page): Promise<void> {
  const panel = page.locator(".kv-branch-panel");
  if (!(await panel.isVisible())) {
    await page.locator(".kv-branch-trigger").click();
    await expect(panel).toBeVisible();
  }
}

async function deleteViaMenu(page: Page, rowText: string, itemLabel: string): Promise<void> {
  const row = page.locator(".kv-branch-row", { hasText: rowText });
  await row.locator('[aria-label="More actions"]').click();
  await page.getByRole("menuitem", { name: itemLabel }).click();
}

test.describe("undo (§7.12)", () => {
  test("branchDelete: undo restores the ref and its upstream-tracking config, not just the name", async ({
    page,
  }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);
    await openPicker(page);

    const row = page.locator(".kv-branch-row", { hasText: "feature-carry" });
    await expect(row.locator(".kv-branch-track")).toHaveText("↓2");

    await deleteViaMenu(page, "feature-carry", "Delete branch");
    const lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toEqual({ kind: "branchDelete", name: "feature-carry", force: false });
    await expect(row).toHaveCount(0);

    const undoButton = page.locator(".kv-undo-button");
    await expect(undoButton).toHaveText("Undo delete of branch feature-carry");
    await undoButton.click();

    const lastUndo = await page.evaluate(() => window.__kiraHarness.lastUndo);
    expect(lastUndo?.result.ok).toBe(true);
    // The undo button lives outside `.kv-branch-picker`'s own root element, so clicking it fires
    // `BranchPicker.vue`'s own outside-pointerdown-closes-the-panel handler — expected behavior,
    // not a bug — so the panel needs reopening to see the restored row.
    await openPicker(page);
    await expect(row).toBeVisible();
    // The config, not only the ref: the same upstream-tracking badge as before the delete.
    await expect(row.locator(".kv-branch-track")).toHaveText("↓2");
    await expect(page.locator(".kv-undo")).toHaveCount(0);
  });

  test("tagDelete: undo restores an annotated tag as annotated, with its original target and message", async ({
    page,
  }) => {
    await page.goto("/?scenario=tags");
    await ready(page);
    await openPicker(page);

    const row = page.locator(".kv-branch-row", { hasText: "v1.0.0" });
    const targetBefore = await row.locator(".kv-tag-target").innerText();
    await expect(row.locator(".kv-tag-kind")).toHaveText("annotated");
    await expect(row.locator(".kv-tag-subject")).toHaveText("Release 1.0.0");

    await deleteViaMenu(page, "v1.0.0", "Delete tag");
    const lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toEqual({ kind: "tagDelete", name: "v1.0.0" });
    await expect(row).toHaveCount(0);

    const undoButton = page.locator(".kv-undo-button");
    await expect(undoButton).toHaveText("Undo delete of tag v1.0.0");
    await undoButton.click();

    // See the branchDelete case above: clicking the undo button (outside the panel) closes it.
    await openPicker(page);
    await expect(row).toBeVisible();
    // Restored as the SAME annotated tag object — not recreated as a bare, lightweight ref
    // pointing at the same commit (the mock's own analogue of "`update-ref`, not `tag -a`").
    await expect(row.locator(".kv-tag-kind")).toHaveText("annotated");
    await expect(row.locator(".kv-tag-subject")).toHaveText("Release 1.0.0");
    await expect(row.locator(".kv-tag-target")).toHaveText(targetBefore);
  });

  test("a second, non-undoable operation clears the slot", async ({ page }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);
    await openPicker(page);

    await deleteViaMenu(page, "feature-clean", "Delete branch");
    await expect(page.locator(".kv-undo-button")).toHaveText("Undo delete of branch feature-clean");

    // `checkout` is `notUndoable` (`UNDO_POLICY`) — running it clears the slot outright, with no
    // undo ever run.
    await openPicker(page);
    await page.locator(".kv-branch-row", { hasText: "feature-carry" }).locator(".kv-branch-row-main").click();

    await expect(page.locator(".kv-undo")).toHaveCount(0);
  });
});
