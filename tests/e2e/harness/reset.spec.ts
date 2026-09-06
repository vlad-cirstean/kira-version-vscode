import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P10.md` W20: `ResetDialog.vue`/`OpsState.runReset`, against §7.7. Uses `dirty` —
 * P6's own real dirty-tree scenario (`src/tracked.ts`, `README.md`), reused here rather than
 * invented fresh, since resetting its `main` back to `root` produces a genuine, non-empty
 * `destroys` list for `--hard` and a real leaving commit to name.
 *
 * Judgment call 18: unlike `checkout.spec.ts`/`revert.spec.ts`, EVERY reset opens this dialog —
 * there is no "clean, skip the dialog" fast path — so choosing a mode IS the confirm step, and
 * every test below drives it through `ResetDialog.vue` rather than expecting a bypass.
 */

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
}

async function resetRow(page: Page, rowText: string): Promise<void> {
  const row = page.locator(".slick-row", { hasText: rowText }).first();
  await row.click({ button: "right" });
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await page.getByRole("menuitem", { name: "Reset to this commit…" }).click();
}

function dialog(page: Page) {
  return page.locator('[aria-labelledby="kv-reset-dialog-title"]');
}

test.describe("reset pre-flight and confirmation (§7.7)", () => {
  test("mode selection changes the destructive state live, typed confirmation gates Reset, and undo restores HEAD", async ({
    page,
  }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);

    await resetRow(page, "root");
    const modal = dialog(page);
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("1 commit will leave");
    const leaving = await modal
      .locator(".kv-modal-file-list")
      .first()
      .locator("li")
      .allTextContents();
    expect(leaving.join(" ")).toContain("main");
    // The short target sha the dialog itself displays — read back rather than hard-coded, since
    // the fixture's own FNV-1a shas are an implementation detail of `topology()`.
    const shortTarget = await modal.locator(".kv-modal-title code").nth(1).innerText();

    const confirmButton = modal.getByTestId("reset-confirm");
    // The row menu's own initial mode (`App.vue`'s `runReset(commit.sha, "mixed")`, OQ1) — no
    // destroys yet, so Reset is enabled with nothing typed.
    await expect(modal.locator("input[value='mixed']")).toBeChecked();
    await expect(confirmButton).toHaveText("Reset");
    await expect(confirmButton).toBeEnabled();

    // OQ11: switching modes re-derives `destroys`/`requiresTypedConfirmation` client-side, with
    // no second `preflight.reset` round trip — this is the one client-recomputed screen in the
    // whole confirm-dialog family.
    await modal.locator("input[value='hard']").click();
    await expect(modal).toContainText("This will permanently discard these uncommitted changes:");
    const destroyed = await modal
      .locator(".kv-modal-file-list")
      .nth(1)
      .locator("li")
      .allTextContents();
    expect(destroyed.sort()).toEqual(["README.md", "src/tracked.ts"]);
    await expect(modal).toContainText("Untracked and ignored files are not affected.");
    await expect(confirmButton).toHaveText("Reset (discard changes)");
    await expect(confirmButton).toBeDisabled();

    const token = page.getByTestId("reset-confirm-token");
    await token.fill("wrong");
    await expect(confirmButton).toBeDisabled();
    await token.fill(shortTarget);
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    await expect(modal).toBeHidden();
    await expect(page.getByTestId("live-announcements")).toHaveText(
      `Reset (hard) to ${shortTarget}`,
    );

    // D61: the undo record replays the mode that actually ran (`hard`), not a generic re-checkout
    // — `UndoButton.vue` surfaces the mock's own `PendingUndo.snapshot.label` verbatim.
    const undoButton = page.locator(".kv-undo-button");
    await expect(undoButton).toHaveText("Reset (hard) to root");
    await undoButton.click();
    const lastUndo = await page.evaluate(() => window.__kiraHarness.lastUndo);
    expect(lastUndo?.result.ok).toBe(true);
    await expect(page.locator(".kv-undo")).toHaveCount(0);
  });

  test("resetting onto a descendant reports both counts and needs no confirmation at all", async ({
    page,
  }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);

    await resetRow(page, "feature-clean");
    const modal = dialog(page);
    await expect(modal).toBeVisible();
    // `gaining !== 0` alone drives this copy path (`ResetDialog.vue`'s own template), regardless
    // of whether anything is also leaving — a fast-forward onto a descendant already exercises it.
    await expect(modal).toContainText(
      "This moves to a different line of history: 0 commits leave, 1 arrive.",
    );

    const confirmButton = modal.getByTestId("reset-confirm");
    await expect(confirmButton).toHaveText("Reset");
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();
    await expect(modal).toBeHidden();
    await expect(page.getByTestId("live-announcements")).toContainText("Reset (mixed) to");
  });

  test("the stash-first route stashes the destroyed changes instead of discarding them, with no typed token", async ({
    page,
  }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);

    await resetRow(page, "root");
    const modal = dialog(page);
    await modal.locator("input[value='hard']").click();
    await expect(modal).toContainText("This will permanently discard");
    const confirmButton = modal.getByTestId("reset-confirm");
    await expect(confirmButton).toBeDisabled();

    await modal
      .getByRole("checkbox", { name: "Stash these changes first instead of discarding them" })
      .check();
    // D62/judgment call 19: the typed token is theatre once the tree is stashed clean first — the
    // field disappears rather than staying present-but-ignored.
    await expect(page.getByTestId("reset-confirm-token")).toHaveCount(0);
    await expect(confirmButton).toHaveText("Stash and reset");
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    await expect(modal).toBeHidden();
    // `runReset`'s own stash-then-reset sequence (D63: stash-then-stop, not stash-and-carry) runs
    // `stashPush` before `reset`, dropping `confirmToken` — `lastOp` is overwritten by each
    // `op.run` in turn, so by the time both have run it names the reset, confirmToken-less.
    const lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toMatchObject({ kind: "reset", mode: "hard", confirmToken: undefined });
    await expect(page.getByTestId("live-announcements")).toContainText("Reset (hard) to");
  });
});
