import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P9.md` W21: create/list/apply/drop-and-undo, plus one blocked-checkout
 * `stashAndCarry` route through to a clean pop — against the `stash` scenario
 * (`apps/harness/src/scenarios/stash.ts`), which seeds two stash entries ("Backend refactor
 * (WIP)" at `stash@{0}`, two files; "Docs pass" at `stash@{1}`, one file) alongside one dirty
 * tracked file (`src/app.ts`) and a `feature` branch whose checkout is `blockedByTracked` with
 * both `discard` and `stashAndCarry` routes.
 *
 * Each test navigates fresh (this file's own `ready`/`openPicker`, mirroring `undo.spec.ts`'s and
 * `checkout.spec.ts`'s own conventions) rather than chaining steps in one page load — the plan's
 * own prose lists the behaviours as a checklist, not a script, and a couple of them (an entry's
 * own pop being blocked; the toolbar stash consuming the only dirty file) need mutually exclusive
 * starting conditions that a single run-through can't give all of at once.
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

async function openStashMenu(page: Page, rowText: string): Promise<void> {
  const row = page.locator(".kv-branch-row", { hasText: rowText });
  await row.locator('[aria-label="More actions"]').click();
}

test.describe("stash (§7.6)", () => {
  test("create from the toolbar (including the untracked checkbox): the list renders three entries with counts", async ({
    page,
  }) => {
    await page.goto("/?scenario=stash");
    await ready(page);

    await page.getByTestId("stash-changes-button").click();
    const dialog = page.locator('[aria-labelledby="kv-stash-dialog-title"]');
    await expect(dialog).toBeVisible();
    await dialog.getByRole("checkbox", { name: /Include untracked files/ }).click();
    await dialog.getByRole("button", { name: "Stash" }).click();
    await expect(dialog).toBeHidden();

    const lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toMatchObject({ kind: "stashPush", includeUntracked: true });

    await openPicker(page);
    const rows = page
      .locator(".kv-branch-section", { hasText: "Stashes" })
      .locator(".kv-branch-row");
    await expect(rows).toHaveCount(3);

    // The freshly created entry lands at stash@{0}; the two seeded ones shift down one slot each.
    await expect(rows.nth(0).locator(".kv-stash-index")).toHaveText("stash@{0}");
    await expect(rows.nth(0).locator(".kv-stash-untracked")).toHaveCount(1);
    await expect(rows.nth(0).locator(".kv-stash-filecount")).toHaveText("1 file");

    await expect(rows.nth(1)).toContainText("Backend refactor (WIP)");
    await expect(rows.nth(1).locator(".kv-stash-index")).toHaveText("stash@{1}");
    await expect(rows.nth(1).locator(".kv-stash-filecount")).toHaveText("2 files");

    await expect(rows.nth(2)).toContainText("Docs pass");
    await expect(rows.nth(2).locator(".kv-stash-index")).toHaveText("stash@{2}");
    await expect(rows.nth(2).locator(".kv-stash-filecount")).toHaveText("1 file");
  });

  test("apply one: a clean apply keeps the entry in the list", async ({ page }) => {
    await page.goto("/?scenario=stash");
    await ready(page);
    await openPicker(page);

    // "Docs pass" touches only README.md — no overlap with the scenario's own dirty src/app.ts,
    // so the mock's default classifier predicts clean and applies with no confirmation dialog.
    await openStashMenu(page, "Docs pass");
    await page.getByRole("menuitem", { name: "Apply" }).click();

    const lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toMatchObject({ kind: "stashApply" });
    await expect(page.locator('[aria-labelledby="kv-stash-dialog-title"]')).toHaveCount(0);

    await openPicker(page);
    const rows = page
      .locator(".kv-branch-section", { hasText: "Stashes" })
      .locator(".kv-branch-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Docs pass" })).toHaveCount(1);
  });

  test("drop one and undo it: the announcement reads 'Restored as stash@{0}', not the original slot", async ({
    page,
  }) => {
    await page.goto("/?scenario=stash");
    await ready(page);
    await openPicker(page);

    await openStashMenu(page, "Backend refactor (WIP)");
    await page.getByRole("menuitem", { name: "Drop" }).click();

    const undoButton = page.locator(".kv-undo-button");
    await expect(undoButton).toHaveText("Dropped stash@{0}: Backend refactor (WIP)");
    await openPicker(page);
    await expect(page.locator(".kv-branch-row", { hasText: "Backend refactor (WIP)" })).toHaveCount(
      0,
    );

    await undoButton.click();
    await expect(page.getByTestId("live-announcements")).toHaveText("Restored as stash@{0}");

    // Undo closes the picker (outside-pointerdown) same as branchDelete's/tagDelete's own undo —
    // reopen to see the restored row, now at stash@{0} rather than its original slot (probe 9).
    await openPicker(page);
    const rows = page
      .locator(".kv-branch-section", { hasText: "Stashes" })
      .locator(".kv-branch-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Backend refactor (WIP)");
    await expect(rows.nth(0).locator(".kv-stash-index")).toHaveText("stash@{0}");
    await expect(page.locator(".kv-undo")).toHaveCount(0);
  });

  test("a blocked pop (local changes would be overwritten) opens StashDialog's popConfirm mode", async ({
    page,
  }) => {
    await page.goto("/?scenario=stash");
    await ready(page);
    await openPicker(page);

    // "Backend refactor (WIP)" deliberately stashed src/app.ts alongside src/backend.ts — the
    // scenario's own dirty file — so the mock's real, computed `localChangesWouldBeOverwritten`
    // blocker fires popping (or applying) THIS entry, not a scenario-only fixture.
    await openStashMenu(page, "Backend refactor (WIP)");
    await page.getByRole("menuitem", { name: "Pop" }).click();

    const dialog = page.locator('[aria-labelledby="kv-stash-dialog-title"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      "Your uncommitted changes to these files would be overwritten",
    );
    await expect(dialog).toContainText("src/app.ts");

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("live-announcements")).toHaveText("Stash pop cancelled.");
    // Nothing ran — the entry is still there, untouched.
    await openPicker(page);
    await expect(page.locator(".kv-branch-row", { hasText: "Backend refactor (WIP)" })).toHaveCount(
      1,
    );
  });

  test("a blocked checkout (feature) offers stashAndCarry, and it runs through to a clean pop", async ({
    page,
  }) => {
    await page.goto("/?scenario=stash");
    await ready(page);
    await openPicker(page);

    await page
      .locator(".kv-branch-row", { hasText: "feature" })
      .locator(".kv-branch-row-main")
      .click();
    const modal = page.locator('[aria-labelledby="kv-checkout-dialog-title"]');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("src/app.ts");

    const stashButton = modal.getByRole("button", { name: "Stash changes and check out" });
    await expect(stashButton).toBeVisible();
    await stashButton.click();
    await expect(modal).toBeHidden();

    await expect(page.getByTestId("live-announcements")).toHaveText("Checked out feature");

    // `window.__kiraHarness.lastOp` only ever holds the single most recent `op.run` — the final
    // one here is the pop that `#stashAndCarry` runs automatically once it predicts clean, so
    // asserting on it (rather than a full call sequence the harness has no hook for) is this
    // test's own evidence that the route actually ran the pop and not just the checkout half.
    const lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toMatchObject({ kind: "stashPop" });

    // The dirty file rode along and came back after the pop — nothing left stashed on its
    // account (both original entries are still there, none extra), and HEAD really moved to
    // feature.
    await openPicker(page);
    const rows = page
      .locator(".kv-branch-section", { hasText: "Stashes" })
      .locator(".kv-branch-row");
    await expect(rows).toHaveCount(2);
    await expect(page.locator(".kv-branch-row--current")).toContainText("feature");
  });
});
