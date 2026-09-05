import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P6.md` W19: `RevertDialog.vue`/`OpsState.runRevert`, against §7.10. Uses `merge` —
 * P5's own octopus-merge scenario, reused here rather than invented fresh (its own doc comment:
 * three parents, each with a different file list) — plus `merge.ts`'s own new `preflight.revert`
 * fixture for `side-a` (P6 W19: no other scenario has a reason to name a revert-conflict fixture
 * by hand).
 *
 * A genuinely multi-sha revert (`shas.length > 1`) has no reachable entry point through this
 * phase's UI: `CommitGrid.vue`'s own doc comment states multi-row selection does not exist this
 * phase ("exists for multi-select and cell ranges this app does not want"), and `App.vue`'s own
 * `onCommitMenuSelect` only ever calls `runRevert([commit.sha])` with one sha. `RevertDialog.vue`'s
 * `isMultiSha` branch is real, written code with nobody to drive it from the DOM — recorded as a
 * disclosed gap in `docs/plans/P6.md`'s Findings rather than exercised through an invented
 * affordance this phase does not otherwise have.
 */

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
}

async function revertRow(page: Page, rowText: string): Promise<void> {
  const row = page.locator(".slick-row", { hasText: rowText }).first();
  await row.click({ button: "right" });
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await page.getByRole("menuitem", { name: "Revert this commit…" }).click();
}

function dialog(page: Page) {
  return page.locator('[aria-labelledby="kv-revert-dialog-title"]');
}

test.describe("revert pre-flight (§7.10)", () => {
  test("a non-merge commit reverts immediately, with no parent picker", async ({ page }) => {
    await page.goto("/?scenario=merge");
    await ready(page);

    // `side-b` has one parent and no `preflight.revert` fixture — the default classifier's plain
    // "clean" verdict, so `runRevert` never awaits the dialog at all (`OpsState.runRevert`'s own
    // doc comment: verdict === "clean" and no mainline needed skips confirmation outright).
    await revertRow(page, "side-b");

    await expect(dialog(page)).toBeHidden();
    await expect(page.getByTestId("live-announcements")).toContainText("Reverted commit");
  });

  test("an octopus merge cannot proceed without an explicit mainline, and offers every parent", async ({
    page,
  }) => {
    await page.goto("/?scenario=merge");
    await ready(page);

    await revertRow(page, "merge");
    const modal = dialog(page);
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('pick which parent\'s history to treat as the "mainline"');

    const parents = await modal.locator(".kv-revert-parent").allTextContents();
    expect(parents).toHaveLength(3);
    expect(parents.join(" ")).toContain("Parent 1");
    expect(parents.join(" ")).toContain("Parent 2");
    expect(parents.join(" ")).toContain("Parent 3");

    const revertButton = modal.getByRole("button", { name: "Revert" });
    await expect(revertButton).toBeDisabled();

    // `.click()`, not `.check()`: picking a mainline triggers `previewRevertMainline`, whose
    // re-fetched preflight has `mainlineRequired: []` — the whole `v-if="needsMainline"` block
    // these radios live in (`RevertDialog.vue`) then unmounts. `.check()`'s own post-click
    // "still checked" assertion would wait on a radio no longer in the DOM until it times out.
    await modal.locator("input[type='radio']").nth(1).click();
    await expect(revertButton).toBeEnabled();
  });

  test("a predicted conflict names the files and offers --no-commit", async ({ page }) => {
    await page.goto("/?scenario=merge");
    await ready(page);

    await revertRow(page, "side-a");
    const modal = dialog(page);
    await expect(modal).toBeVisible();
    // Non-merge: no mainline picker at all, straight to the prediction.
    await expect(modal.locator(".kv-revert-mainline-group")).toHaveCount(0);
    await expect(modal).toContainText("This will likely conflict in:");
    const files = await modal.locator(".kv-modal-file-list li").allTextContents();
    expect(files).toEqual(["a-only.ts"]);

    const noCommit = modal.getByRole("checkbox", { name: /no-commit/ });
    await expect(noCommit).toBeVisible();
    await noCommit.check();
    await modal.getByRole("button", { name: "Revert" }).click();

    // The mock always makes a "conflicts" prediction come true (`mockBridge.ts`'s own `revert`
    // case) — `--no-commit` changes nothing about *that*, it only ever governs what a *clean*
    // revert leaves behind (`checkout.spec.ts`'s sibling case for that half). So the confirmed
    // request still carries `noCommit: true`, but the op itself fails as a real conflict and the
    // banner takes over, exactly `conflictBanner.spec.ts`'s own fixture for this same scenario.
    const lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toMatchObject({ noCommit: true });
    await expect(page.getByTestId("live-announcements")).toHaveText(
      "Revert failed — conflicts need resolving.",
    );
    await expect(page.getByTestId("conflict-banner")).toBeVisible();
  });
});
