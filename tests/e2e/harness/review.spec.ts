import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P7.md` W16 — the interaction suite for the review sidebar view (§6.8), against the
 * harness's `mockBridge.ts` (P7 W15's four scenarios plus `reviewPaged`, a hidden fifth). Visual
 * regression is `reviewVisual.spec.ts`'s job; this file never screenshots, matching
 * `commitDetail.spec.ts`'s own precedent for the panel's detail pane.
 *
 * The harness serves one view per page load (`main.ts`'s own `?view=` seam), so "both entry
 * points open the review on the right branch" cannot literally reveal a second, already-rendered
 * webview the way the real host does. Each entry-point test instead proves the same thing in two
 * steps, exactly as `mockBridge.ts`'s own `RecordedReviewOpen` doc comment describes: read back
 * the `review.open` request the menu actually sent (`window.__kiraHarness.lastReviewOpen`), then
 * open a second page at `?view=review&branch=<that>` to prove the request resolves to real,
 * correct content.
 */

// `Window.__kiraHarness`'s ambient type is declared once, project-wide, in `shell.spec.ts`.

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
}

function reviewRow(page: Page, subject: string): Locator {
  return page.locator(".kv-review-row", { hasText: subject });
}

/** `.kv-review-row` wraps its own expanded body — once expanded, its bounding-box centre (a
 *  plain `.click()`'s default target) sits over the `FileTree` content, not the header, and a
 *  click there opens whatever file happens to be underneath instead of toggling the row. Every
 *  toggle in this file goes through the header/subject specifically to avoid that. */
async function toggleRow(row: Locator): Promise<void> {
  await row.locator(".kv-review-row-subject").click();
}

function fileRow(page: Page, name: string): Locator {
  return page.locator(".kv-file-tree-row", { hasText: name });
}

async function shaOfRow(row: Locator): Promise<string> {
  const testid = await row.getAttribute("data-testid");
  if (!testid?.startsWith("review-row-")) {
    throw new Error(`shaOfRow: unexpected data-testid '${testid}'`);
  }
  return testid.slice("review-row-".length);
}

async function lastReviewOpen(page: Page): Promise<unknown> {
  return page.evaluate(() => window.__kiraHarness.lastReviewOpen);
}

async function lastEditorAction(page: Page): Promise<unknown> {
  return page.evaluate(() => window.__kiraHarness.lastEditorAction);
}

async function detailCallCount(page: Page, sha: string): Promise<number> {
  return page.evaluate((s) => window.__kiraHarness.getCommitDetailCallCount(s), sha);
}

test.describe("entry points: both open the review on the right branch", () => {
  test("the branch picker's own menu", async ({ page }) => {
    await page.goto("/?scenario=tags");
    await ready(page);
    await page.locator(".kv-branch-trigger").click();
    const row = page.locator('[aria-label="Branches"] .kv-branch-row', { hasText: "main" });
    await row.locator(".kv-icon-button[title='More actions']").click();
    // The picker's own row menu has no separate heading (`BranchPicker.vue`'s own `RowContextMenu`
    // usage passes no `title` — the row it applies to is already visually the row you right-
    // clicked, unlike a graph ref badge with no row of its own); its accessible name is `label`.
    const menu = page.locator('[role="menu"]');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAccessibleName("main actions");
    await menu.getByRole("menuitem", { name: "Review branch changes" }).click();
    expect(await lastReviewOpen(page)).toEqual({ repoId: "/repos/tags", branch: "main" });

    // Proves the request itself resolves to real content, not merely that it was sent.
    await page.goto("/?scenario=tags&view=review&branch=main");
    await ready(page);
    await expect(page.getByTestId("review-branch-name")).toHaveText("main");
    const trigger = page.getByTestId("base-selector-trigger");
    await expect(trigger).toContainText("origin/main");
    await expect(trigger).toContainText("upstream");
    await expect(page.locator(".kv-review-commit-count")).toHaveText("1 commit");
  });

  test("the branch picker's own menu via a right-click on the row (not just the kebab)", async ({
    page,
  }) => {
    // Exit criteria: "the branch picker's context menu (kebab *and* right-click)" — the test
    // above already drives a plain click on the kebab button; `BranchPicker.vue`'s own markup
    // wires both `@click` and `@contextmenu` to that same "More actions" button (there is no
    // separate `@contextmenu` handler on the row itself, e.g. `.kv-branch-row-main`), so the
    // second entry point this exercises is a right-click on that same button.
    await page.goto("/?scenario=tags");
    await ready(page);
    await page.locator(".kv-branch-trigger").click();
    const row = page.locator('[aria-label="Branches"] .kv-branch-row', { hasText: "main" });
    await row.locator(".kv-icon-button[title='More actions']").click({ button: "right" });
    const menu = page.locator('[role="menu"]');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAccessibleName("main actions");
    await menu.getByRole("menuitem", { name: "Review branch changes" }).click();
    expect(await lastReviewOpen(page)).toEqual({ repoId: "/repos/tags", branch: "main" });
  });

  test("a right-click on a branch badge in the message column — one pixel to the side still opens the commit menu", async ({
    page,
  }) => {
    await page.goto("/?scenario=tags");
    await ready(page);
    const row = page.locator(".slick-row").filter({ has: page.locator('[data-ref-name="main"]') });
    const badge = row.locator('[data-ref-name="main"]');
    await badge.click({ button: "right" });

    const refMenu = page.locator('[role="menu"]');
    await expect(refMenu).toBeVisible();
    await expect(refMenu.locator(".kv-row-menu-heading")).toHaveText("main");
    await refMenu.getByRole("menuitem", { name: "Review branch changes" }).click();
    expect(await lastReviewOpen(page)).toEqual({ repoId: "/repos/tags", branch: "main" });

    // One pixel — in practice, comfortably past the badge — to the side: the same right-click
    // hits ordinary row content instead, and opens the *commit* menu, not the ref menu.
    const badgesContainer = row.locator(".kv-ref-badges");
    const box = await badgesContainer.boundingBox();
    if (!box) throw new Error("badges container not visible");
    await page.mouse.click(box.x + box.width + 10, box.y + box.height / 2, { button: "right" });
    const commitMenu = page.locator('[role="menu"]');
    await expect(commitMenu).toBeVisible();
    await expect(commitMenu.getByRole("menuitem", { name: "Revert this commit…" })).toBeVisible();
    await expect(commitMenu.getByRole("menuitem", { name: "Review branch changes" })).toHaveCount(
      0,
    );
  });
});

test.describe("the palette entry point's no-branch state", () => {
  test("no repo open names the fallback copy; with one open, picking a branch resolves it", async ({
    page,
  }) => {
    await page.goto("/?scenario=review&view=review");
    await ready(page);
    await expect(page.getByText("Open a repository first")).toBeVisible();

    await page.goto("/?scenario=review&view=review&openRepo=1");
    await ready(page);
    const picker = page.getByTestId("review-no-branch");
    await expect(picker).toBeVisible();
    await picker.locator(".kv-review-picker-filter").fill("feat");
    await picker.getByRole("button", { name: "feature" }).click();

    await expect(page.getByTestId("review-branch-name")).toHaveText("feature");
    await expect(page.locator(".kv-review-commit-count")).toHaveText("10 commits");
  });
});

test.describe("resolution: the header names the reason", () => {
  test("upstream naming a different branch", async ({ page }) => {
    await page.goto("/?scenario=reviewUpstream&view=review&branch=feature");
    await ready(page);
    const trigger = page.getByTestId("base-selector-trigger");
    await expect(trigger).toContainText("origin/develop");
    await expect(trigger).toContainText("upstream");
  });

  test("a detected default branch", async ({ page }) => {
    await page.goto("/?scenario=review&view=review&branch=feature");
    await ready(page);
    const trigger = page.getByTestId("base-selector-trigger");
    await expect(trigger).toContainText("main");
    await expect(trigger).toContainText("default branch");
  });

  test("the ask state: no reason to show, no base assumed", async ({ page }) => {
    await page.goto("/?scenario=reviewAsk&view=review&branch=feature");
    await ready(page);
    const trigger = page.getByTestId("base-selector-trigger");
    await expect(trigger).toContainText("Choose a base");
    await expect(page.getByTestId("review-ask")).toContainText("feature");
  });
});

test.describe("the base override re-runs in place, and unrelated histories say so", () => {
  test("picking an unrelated branch from the ask state moves straight to 'unrelated', without remounting the view", async ({
    page,
  }) => {
    await page.goto("/?scenario=reviewAsk&view=review&branch=feature");
    await ready(page);
    await expect(page.getByTestId("review-ask")).toBeVisible();

    const rootHandle = await page.evaluateHandle(() => document.querySelector(".kv-review-view"));

    await page.getByTestId("base-selector-trigger").click();
    await page.locator(".kv-base-row", { hasText: "other" }).click();

    const unrelated = page.getByTestId("review-unrelated");
    await expect(unrelated).toBeVisible();
    await expect(unrelated).toContainText("feature");
    await expect(unrelated).toContainText("other");

    const stillSame = await page.evaluate(
      (el) => el === document.querySelector(".kv-review-view"),
      rootHandle,
    );
    expect(stillSame).toBe(true);
  });
});

test.describe("'nothing to review' names both refs", () => {
  test("a fully-merged branch", async ({ page }) => {
    await page.goto("/?scenario=reviewMerged&view=review&branch=feature");
    await ready(page);
    const empty = page.getByTestId("review-empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("feature");
    await expect(empty).toContainText("main");
  });
});

test.describe("row expansion: FileTree.vue's own edge cases inside a review row", () => {
  test("a rename, a merge parent selector, a binary and an LFS file", async ({ page }) => {
    await page.goto("/?scenario=review&view=review&branch=feature");
    await ready(page);

    await toggleRow(reviewRow(page, "rename1"));
    const renamed = fileRow(page, "renamed-new.ts");
    await expect(renamed.locator(".kv-file-tree-status")).toHaveText("R");
    await expect(renamed).toContainText("renamed-old.ts");
    await toggleRow(reviewRow(page, "rename1")); // collapse before expanding the next row

    await toggleRow(reviewRow(page, "feat3"));
    const select = page.locator("#kv-parent-select");
    await expect(select).toHaveValue("0");
    await expect(select.locator("option")).toHaveCount(2);
    await expect(fileRow(page, "feat2.ts")).toBeVisible();
    await select.selectOption("1");
    await expect(fileRow(page, "side1.ts")).toBeVisible();
    await expect(fileRow(page, "feat2.ts")).toHaveCount(0);
    await toggleRow(reviewRow(page, "feat3"));

    await toggleRow(reviewRow(page, "binary1"));
    const binary = fileRow(page, "icon.png");
    await expect(binary.locator(".kv-file-tree-status")).toHaveText("M");
    await expect(binary.locator(".kv-file-tree-counts")).toHaveCount(0);
    await toggleRow(reviewRow(page, "binary1"));

    await toggleRow(reviewRow(page, "lfs1"));
    const lfs = fileRow(page, "large-asset.bin");
    await expect(lfs.locator(".kv-file-tree-status")).toHaveText("A");
    await toggleRow(reviewRow(page, "lfs1"));
  });

  test("a merge parent outside the walked range falls back to a subject-less label (V5)", async ({
    page,
  }) => {
    // `feat3`'s two parents above (`feat2`/`side1`) are both reachable from `feature`, so both
    // already have a known subject — this scenario's merge instead has a second parent
    // (`main`'s own tip) reachable only from `main`, outside `main..feature`, which is the case
    // `FileTree.vue`'s `parentOptions` falls back for: no row in the review's own commit store,
    // so no subject to show, leaving just `Parent 2 · <short sha>`.
    await page.goto("/?scenario=reviewMergeFromBase&view=review&branch=feature");
    await ready(page);
    await toggleRow(reviewRow(page, "merge1"));
    const select = page.locator("#kv-parent-select");
    await expect(select.locator("option")).toHaveCount(2);
    await expect(select.locator("option").nth(0)).toContainText("feat1");
    await expect(select.locator("option").nth(1)).toHaveText(/^Parent 2 · [0-9a-f]{7}$/);
    await expect(fileRow(page, "feat1.ts")).toBeVisible();
    await select.selectOption("1");
    await expect(fileRow(page, "frommain.ts")).toBeVisible();
    await expect(fileRow(page, "feat1.ts")).toHaveCount(0);
  });

  test("two rows expanded at once", async ({ page }) => {
    await page.goto("/?scenario=review&view=review&branch=feature");
    await ready(page);
    await toggleRow(reviewRow(page, "feat1"));
    await toggleRow(reviewRow(page, "feat2"));
    await expect(page.locator(".kv-review-row-body")).toHaveCount(2);
    await expect(fileRow(page, "feat1.ts")).toBeVisible();
    await expect(fileRow(page, "feat2.ts")).toBeVisible();
  });

  test("a collapsed-then-re-expanded row does not re-request", async ({ page }) => {
    await page.goto("/?scenario=review&view=review&branch=feature");
    await ready(page);
    const row = reviewRow(page, "feat1");
    await toggleRow(row);
    const sha = await shaOfRow(row);
    expect(await detailCallCount(page, sha)).toBe(1);

    await toggleRow(row); // collapse
    await expect(page.locator(".kv-review-row-body")).toHaveCount(0);
    await toggleRow(row); // re-expand
    await expect(fileRow(page, "feat1.ts")).toBeVisible();
    expect(await detailCallCount(page, sha)).toBe(1);
  });
});

test.describe("the diff overlay: full-height, Esc closes it then the row, arrows follow the file cursor", () => {
  test("opens over the whole list; Esc closes the diff, a second Esc collapses the row", async ({
    page,
  }) => {
    await page.goto("/?scenario=review&view=review&branch=feature");
    await ready(page);
    const row = reviewRow(page, "rename1");
    await toggleRow(row);
    const overlay = page.locator(".kv-review-diff-overlay");
    const diffView = page.getByTestId("diff-view");

    await fileRow(page, "renamed-new.ts").click();
    await expect(overlay).toBeVisible();
    await expect(diffView.locator(".kv-diff-path")).toHaveText("src/renamed-new.ts");

    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    await expect(fileRow(page, "renamed-new.ts")).toBeVisible(); // back to the tree, still expanded

    await page.keyboard.press("Escape");
    await expect(page.locator(".kv-review-row-body")).toHaveCount(0); // the row itself collapsed
  });

  test("arrow keys move between files while the diff follows", async ({ page }) => {
    await page.goto("/?scenario=review&view=review&branch=feature");
    await ready(page);
    await toggleRow(reviewRow(page, "feat5"));
    await fileRow(page, "feat5.ts").click();
    const diffView = page.getByTestId("diff-view");
    await expect(diffView.locator(".kv-diff-path")).toHaveText("feat5.ts");

    await page.keyboard.press("Escape"); // back to the tree, cursor still on feat5.ts
    await page.locator(".kv-file-tree-rows").focus();
    await page.keyboard.press("ArrowDown");
    await expect(diffView.locator(".kv-diff-path")).toHaveText("feat5b.ts");
  });
});

test.describe("'Go to file' from a review row lands in the virtual blob, at the mapped line", () => {
  test("a branch that is not checked out always resolves virtual — the review scenario checks out nothing", async ({
    page,
  }) => {
    await page.goto("/?scenario=review&view=review&branch=feature");
    await ready(page);
    await toggleRow(reviewRow(page, "feat1"));
    await fileRow(page, "feat1.ts").click();
    const diffView = page.getByTestId("diff-view");

    // The added row carries its own new-side line number (1) directly — `commitDetail.spec.ts`'s
    // own "line map end to end" test already exhaustively covers the re-mapped cases; this is the
    // one representative case proving the review row's own actions reach the same code path.
    await diffView.locator(".kv-diff-row", { hasText: "new feat1.ts" }).click();
    await diffView.getByRole("button", { name: "Go to file" }).click();
    await expect(diffView.locator(".kv-diff-action-message")).toContainText(
      "this path is not in your checkout",
    );
    expect(await lastEditorAction(page)).toMatchObject({
      kind: "reveal",
      ref: { kind: "virtual" },
      line: 1,
    });
  });
});

test.describe("Load more appends without moving the scroll position", () => {
  test("5,010 commits: the first page loads 5,000, Load more fetches the rest", async ({
    page,
  }) => {
    await page.goto("/?scenario=reviewPaged&view=review&branch=feature");
    await ready(page);
    const rows = page.locator('[role="treeitem"]');
    await expect(rows).toHaveCount(5000);

    const rowsEl = page.locator(".kv-review-rows");
    await rowsEl.evaluate((el) => {
      el.scrollTop = 1000;
    });
    const scrollBefore = await rowsEl.evaluate((el) => el.scrollTop);
    expect(scrollBefore).toBeGreaterThan(0);

    await page.locator(".kv-review-load-more-button").click();
    await expect(rows).toHaveCount(5010);
    await expect(page.locator(".kv-review-load-more")).toHaveCount(0); // exhausted now

    const scrollAfter = await rowsEl.evaluate((el) => el.scrollTop);
    expect(scrollAfter).toBe(scrollBefore);
  });
});
