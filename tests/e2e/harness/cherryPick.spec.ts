import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P10.md` W20: `CherryPickDialog.vue`/`OpsState.runCherryPick`, against §7.13. Uses
 * `merge` — the same octopus-merge scenario `revert.spec.ts` (P6 W19) already reuses — plus this
 * phase's own new `preflight.cherryPick` fixture for `side-a` (`merge.ts`'s own doc comment: no
 * other scenario has a reason to name a cherry-pick-conflict fixture by hand).
 *
 * The empty-pick + Skip path (probe 6) is already covered end to end by
 * `conflictBanner.spec.ts`'s own `cherryPickEmpty` case (P10 W13) — this file's own Skip test
 * below exercises the *other* case `canSkip` covers: skipping out of a genuine conflict, not only
 * an already-empty one.
 */

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
}

async function cherryPickRow(page: Page, rowText: string): Promise<void> {
  const row = page.locator(".slick-row", { hasText: rowText }).first();
  await row.click({ button: "right" });
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await page.getByRole("menuitem", { name: "Cherry-pick this commit…" }).click();
}

function dialog(page: Page) {
  return page.locator('[aria-labelledby="kv-cherry-pick-dialog-title"]');
}

test.describe("cherry-pick pre-flight and confirmation (§7.13)", () => {
  test("a clean, non-merge pick applies immediately, with no dialog", async ({ page }) => {
    await page.goto("/?scenario=merge");
    await ready(page);

    // `side-b` has one parent and no `preflight.cherryPick` fixture — the default classifier's
    // plain "clean" verdict, so `runCherryPick` never awaits the dialog at all.
    await cherryPickRow(page, "side-b");

    await expect(dialog(page)).toBeHidden();
    await expect(page.getByTestId("live-announcements")).toContainText("Cherry-picked commit");
  });

  test("an octopus merge cannot proceed without an explicit mainline, and offers every parent", async ({
    page,
  }) => {
    await page.goto("/?scenario=merge");
    await ready(page);

    await cherryPickRow(page, "merge");
    const modal = dialog(page);
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('pick which parent\'s history to treat as the "mainline"');

    const parents = await modal.locator(".kv-cherry-pick-parent").allTextContents();
    expect(parents).toHaveLength(3);
    expect(parents.join(" ")).toContain("Parent 1");
    expect(parents.join(" ")).toContain("Parent 2");
    expect(parents.join(" ")).toContain("Parent 3");

    const confirmButton = modal.getByTestId("cherry-pick-confirm");
    await expect(confirmButton).toBeDisabled();
    await modal.locator("input[type='radio']").nth(1).click();
    await expect(confirmButton).toBeEnabled();
  });

  test("a predicted conflict names the files, offers --no-commit, and the banner's own Skip clears a genuine conflict", async ({
    page,
  }) => {
    await page.goto("/?scenario=merge");
    await ready(page);

    await cherryPickRow(page, "side-a");
    const modal = dialog(page);
    await expect(modal).toBeVisible();
    // Non-merge: straight to the prediction, no mainline picker at all.
    await expect(modal.locator(".kv-cherry-pick-parent")).toHaveCount(0);
    await expect(modal).toContainText("This will likely conflict in:");
    const files = await modal.locator(".kv-modal-file-list li").allTextContents();
    expect(files).toEqual(["a-only.ts"]);

    const noCommit = modal.getByRole("checkbox", { name: /no-commit/ });
    await expect(noCommit).toBeVisible();
    await expect(noCommit).not.toBeChecked();

    // The mock always makes a "conflicts" prediction come true regardless of `--no-commit`
    // (mirrors `revert.spec.ts`'s own "a predicted conflict" case) — the real conflict, not the
    // checkbox, is what drives the banner here.
    await modal.getByTestId("cherry-pick-confirm").click();

    await expect(page.getByTestId("live-announcements")).toHaveText(
      "Cherry-pick failed — conflicts need resolving.",
    );
    const banner = page.getByTestId("conflict-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("1 unresolved file");

    // D65: cherry-pick's own `canSkip` is unconditional on the conflict itself, not only on an
    // already-empty pick (probe 6) — Skip clears a genuinely conflicted pick just as readily.
    const skipButton = banner.getByRole("button", { name: "Skip" });
    await expect(skipButton).toBeEnabled();
    await skipButton.click();
    await expect(banner).toBeHidden();
  });
});
