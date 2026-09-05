import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P6.md` W19: branch and tag mutations, each asserted on `window.__kiraHarness.lastOp`
 * — the `OpRequest` the mock bridge actually received — so the wire-level "argv" the UI builds is
 * checked from this side too, not only `packages/git`'s own real-argv unit tests. Uses `dirty`
 * (branch operations; a real not-fully-merged fixture, `notFullyMergedBranches`) and `tags`
 * (the §7.9 tag table: annotated create, the force-preserves-annotation path, and the
 * local-delete/remote-delete asymmetry).
 */

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
}

async function openRowMenu(page: Page, rowText: string): Promise<void> {
  const row = page.locator(".slick-row", { hasText: rowText }).first();
  await row.click({ button: "right" });
  await expect(page.locator('[role="menu"]')).toBeVisible();
}

async function openBranchMenu(page: Page, branchText: string) {
  // Idempotent about the panel's own open state — `onRefMenuSelect` closes the menu it opened but
  // deliberately leaves the panel itself open (BranchPicker.vue), so a second call in the same
  // test must not re-click the trigger, which would *toggle* an already-open panel closed.
  const panel = page.locator(".kv-branch-panel");
  if (!(await panel.isVisible())) {
    await page.locator(".kv-branch-trigger").click();
    await expect(panel).toBeVisible();
  }
  const row = page.locator(".kv-branch-row", { hasText: branchText });
  await row.locator('[aria-label="More actions"]').click();
  await expect(page.locator('[role="menu"]')).toBeVisible();
  return row;
}

test.describe("branch operations", () => {
  test("create: dialog pre-fills the start point, and the OpRequest matches it", async ({
    page,
  }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);

    await openRowMenu(page, "main");
    await page.getByRole("menuitem", { name: "Create branch here…" }).click();

    const modal = page.locator('[aria-labelledby="kv-branch-dialog-title"]');
    await expect(modal).toBeVisible();
    const shownSha = (await modal.locator("code").innerText()).trim();
    await modal.locator("input[type='text']").fill("new-feature");
    // "Switch to it" defaults on (BranchDialog.vue's own default) — left as is for this case.
    await modal.getByRole("button", { name: "Create branch" }).click();
    await expect(modal).toBeHidden();

    const lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toMatchObject({
      kind: "branchCreate",
      name: "new-feature",
      checkout: true,
      track: undefined,
    });
    expect(lastOp).toBeDefined();
    const request = lastOp?.request as { startPoint: string };
    expect(request.startPoint.startsWith(shownSha)).toBe(true);
    expect(lastOp?.result.ok).toBe(true);
    // `checkout: true` really switched — the toolbar reflects the new branch.
    await expect(page.locator(".kv-branch-trigger-label")).toHaveText("new-feature");
  });

  test("rename: the OpRequest carries from/to, and the row reflects the new name", async ({
    page,
  }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);

    await openBranchMenu(page, "feature-clean");
    await page.getByRole("menuitem", { name: "Rename branch…" }).click();
    // Not `row.locator(...)`: once renaming starts the row's own visible text becomes only the
    // `<input>`'s value, which Playwright's `hasText` does not match against — so a `row` locator
    // captured before the swap would no longer resolve. Scope to the panel instead (there is only
    // ever one rename input open at a time).
    const input = page.locator(".kv-branch-panel .kv-branch-rename-input");
    await expect(input).toBeVisible();
    await input.fill("feature-renamed");
    await input.press("Enter");

    const lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toEqual({
      kind: "branchRename",
      from: "feature-clean",
      to: "feature-renamed",
    });
    await expect(page.locator(".kv-branch-row-name", { hasText: "feature-renamed" })).toBeVisible();
  });

  test("delete: a fully-merged branch deletes on the first try", async ({ page }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);

    await openBranchMenu(page, "feature-clean");
    await page.getByRole("menuitem", { name: "Delete branch" }).click();

    const lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toEqual({ kind: "branchDelete", name: "feature-clean", force: false });
    expect(lastOp?.result.ok).toBe(true);
    await expect(page.locator(".kv-branch-row", { hasText: "feature-clean" })).toHaveCount(0);
  });

  test("delete: not-fully-merged offers an inline Force delete confirmation", async ({ page }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);

    await openBranchMenu(page, "feature-unmerged");
    await page.getByRole("menuitem", { name: "Delete branch" }).click();

    let lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toEqual({
      kind: "branchDelete",
      name: "feature-unmerged",
      force: false,
    });
    expect(lastOp?.result.ok).toBe(false);
    expect(lastOp?.result.error?.kind).toBe("NotFullyMerged");
    // Still present — the plain delete did not remove it.
    await expect(page.locator(".kv-branch-row", { hasText: "feature-unmerged" })).toBeVisible();

    const confirm = page.locator(".kv-branch-force-delete");
    await expect(confirm).toContainText("feature-unmerged");
    await confirm.getByRole("button", { name: "Force delete" }).click();

    lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toEqual({
      kind: "branchDelete",
      name: "feature-unmerged",
      force: true,
    });
    expect(lastOp?.result.ok).toBe(true);
    await expect(page.locator(".kv-branch-row", { hasText: "feature-unmerged" })).toHaveCount(0);
  });

  test("the current branch's delete entry is disabled with a reason, not gated by an in-progress op", async ({
    page,
  }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);
    await openBranchMenu(page, "main");
    const item = page.getByRole("menuitem", { name: "Delete branch" });
    await expect(item).toHaveAttribute("aria-disabled", "true");
    await expect(item.locator(".kv-visually-hidden")).toHaveText("This is the current branch.");
  });
});

test.describe("tag operations (§7.9)", () => {
  test("lightweight create: no message in the OpRequest", async ({ page }) => {
    await page.goto("/?scenario=tags");
    await ready(page);

    await openRowMenu(page, "main");
    await page.getByRole("menuitem", { name: "Create tag here…" }).click();
    const modal = page.locator('[aria-labelledby="kv-tag-dialog-title"]');
    await modal.locator("input[type='text']").fill("checkpoint-2");
    await modal.getByRole("button", { name: "Create tag" }).click();
    await expect(modal).toBeHidden();

    const lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toMatchObject({
      kind: "tagCreate",
      name: "checkpoint-2",
      message: undefined,
      force: false,
    });
  });

  test("annotated create: the message travels in the OpRequest", async ({ page }) => {
    await page.goto("/?scenario=tags");
    await ready(page);

    await openRowMenu(page, "main");
    await page.getByRole("menuitem", { name: "Create tag here…" }).click();
    const modal = page.locator('[aria-labelledby="kv-tag-dialog-title"]');
    await modal.locator("input[type='text']").fill("release-2.0");
    await modal.locator("input[type='checkbox']").check();
    await modal.locator("textarea").fill("Release 2.0.0");
    await modal.getByRole("button", { name: "Create tag" }).click();

    const lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toMatchObject({
      kind: "tagCreate",
      name: "release-2.0",
      message: "Release 2.0.0",
      force: false,
    });
  });

  test("force-moving an existing annotated tag requires re-supplying the message to preserve annotation", async ({
    page,
  }) => {
    await page.goto("/?scenario=tags");
    await ready(page);

    await openRowMenu(page, "main");
    await page.getByRole("menuitem", { name: "Create tag here…" }).click();
    const modal = page.locator('[aria-labelledby="kv-tag-dialog-title"]');
    await modal.locator("input[type='text']").fill("v1.0.0");
    await expect(modal).toContainText('A tag named "v1.0.0" already exists (annotated)');
    const createButton = modal.getByRole("button", { name: "Create tag" });
    await expect(createButton).toBeDisabled();

    // `.click()`, not `.check()`: checking "Replace it" flips `force`, which immediately swaps
    // `state.verdict` from `blockedByExisting` to `movesWithForce` — the whole block this checkbox
    // lives in (`TagDialog.vue`) is `v-if`-gated on `blockedByExisting`, so the checkbox itself
    // unmounts the instant it is checked. `.check()`'s own post-click "still checked" assertion
    // would wait on an element no longer in the DOM until it times out; `.click()` has no such
    // follow-up assertion.
    await modal.getByRole("checkbox", { name: "Replace it" }).click();
    await expect(modal).toContainText("silently downgrade it to lightweight");
    // Force alone (no annotation/message) still cannot submit — that is the whole point of the
    // warning just shown.
    await expect(createButton).toBeDisabled();

    await modal.getByRole("checkbox", { name: "Annotated" }).check();
    await modal.locator("textarea").fill("Re-tag 1.0.0");
    await expect(createButton).toBeEnabled();
    await createButton.click();

    const lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toMatchObject({
      kind: "tagCreate",
      name: "v1.0.0",
      message: "Re-tag 1.0.0",
      force: true,
    });
  });

  test("local delete is its own action and never also deletes on the remote", async ({ page }) => {
    await page.goto("/?scenario=tags");
    await ready(page);

    await openBranchMenu(page, "checkpoint");
    await page.getByRole("menuitem", { name: "Delete tag" }).click();

    const lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toEqual({ kind: "tagDelete", name: "checkpoint" });
    await expect(page.locator(".kv-branch-row", { hasText: "checkpoint" })).toHaveCount(0);
  });

  test("push and delete-on-remote are separate, explicitly labelled actions", async ({ page }) => {
    await page.goto("/?scenario=tags");
    await ready(page);

    await openBranchMenu(page, "v1.0.0");
    await expect(page.getByRole("menuitem", { name: "Push to origin" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Delete on origin" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Push to origin" }).click();

    let lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toEqual({ kind: "tagPush", remote: "origin", names: ["v1.0.0"] });
    // The tag is still local — pushing did not touch the local ref.
    await expect(page.locator(".kv-branch-row", { hasText: "v1.0.0" })).toBeVisible();

    await openBranchMenu(page, "v1.0.0");
    await page.getByRole("menuitem", { name: "Delete on origin" }).click();
    lastOp = await page.evaluate(() => window.__kiraHarness.lastOp);
    expect(lastOp?.request).toEqual({ kind: "tagDeleteRemote", remote: "origin", name: "v1.0.0" });
    // The asymmetry itself: deleting on the remote is a distinct action from "Delete tag" and
    // leaves the local ref alone.
    await expect(page.locator(".kv-branch-row", { hasText: "v1.0.0" })).toBeVisible();
  });
});
