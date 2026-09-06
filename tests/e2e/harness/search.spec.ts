import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P11.md` W20: §7.8's search box driven end to end against the `search` scenario
 * (`apps/harness/src/scenarios/search.ts`, W15) — a real (mock) `search.run` handler running the
 * actual `@kira-version/core` matcher, not a hand-rolled stand-in (that scenario's own doc
 * comment). Nine commits, root to `main tip`, carry the same case/whole-word/regex discriminators
 * `tests/fixtures/generateRepo.ts`'s `searchable()` fixture uses in miniature: `WIDGETS` vs
 * `widget` vs `subwidgetary` (case and whole-word), and one commit whose only match is in its
 * body (`gizmocratic`, via `Scenario.searchBodies`) — a hit the client-side loaded scan cannot
 * produce at all (`packages/ui/src/state/search.ts`'s own "hard part 1"), proving the tail half
 * earns its keep even against a repo small enough to load in full.
 *
 * The grid renders newest first (row 0 is `main tip`, the last row is `root`) regardless of
 * `COMMIT_SPEC`'s own spec-order array, so every assertion below locates a row by its commit's
 * own subject text (`hasText`) rather than a numeric `data-row` index, the same convention
 * `refsA11y.spec.ts`/`refsVisual.spec.ts` already use for content that is not the very first row.
 */

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
  await expect(page.locator('.slick-row[data-row="0"]')).toBeVisible();
}

function searchInput(page: Page) {
  return page.getByTestId("search-input");
}

function rowWithSubject(page: Page, subject: string) {
  return page.locator(".slick-row", { hasText: subject });
}

async function expectSelected(page: Page, subject: string): Promise<void> {
  await expect(rowWithSubject(page, subject)).toHaveClass(/kv-row-selected/);
}

test.describe("focus (§6.6)", () => {
  test("/ focuses the search input from anywhere in the panel", async ({ page }) => {
    await page.goto("/?scenario=search");
    await ready(page);
    await rowWithSubject(page, "root").click();
    await expect(searchInput(page)).not.toBeFocused();

    await page.keyboard.press("/");
    await expect(searchInput(page)).toBeFocused();
  });

  test("Ctrl/Cmd+F focuses the search input even from another editable control", async ({
    page,
  }) => {
    await page.goto("/?scenario=search");
    await ready(page);
    // A literal "/" typed into the box itself must not be hijacked (§6.6's own carve-out) — typed
    // here to prove the box is a normal editable control, then Ctrl+F still wins over it.
    await searchInput(page).fill("a/b");
    await searchInput(page).blur();
    await expect(searchInput(page)).not.toBeFocused();

    await page.keyboard.press("Control+f");
    await expect(searchInput(page)).toBeFocused();
  });
});

test.describe("typing shows grouped results with a live match count (§7.8)", () => {
  test("a query opens the dropdown and the inline count tracks it", async ({ page }) => {
    await page.goto("/?scenario=search");
    await ready(page);
    await searchInput(page).fill("widget");

    await expect(page.getByTestId("search-results")).toBeVisible();
    // The inline count is commit-only (judgment call 6 — it mirrors what Enter/Shift+Enter step
    // through), so it reads "1 of 3" even though a 4th option — `v1.0.0`'s own annotation body
    // ("Includes the widget cache fix.") — also renders in the dropdown's Tags group.
    await expect(page.getByTestId("search-count")).toHaveText("1 of 3");
    await expect(page.locator(".kv-search-section-title", { hasText: "Tags" })).toBeVisible();
    await expect(page.locator(".kv-search-section-title", { hasText: "Commits" })).toBeVisible();
    await expect(page.locator('[role="option"]')).toHaveCount(4);
  });

  test("an empty box shows no dropdown and no count", async ({ page }) => {
    await page.goto("/?scenario=search");
    await ready(page);
    await expect(page.getByTestId("search-results")).toHaveCount(0);
    await expect(page.getByTestId("search-count")).toHaveCount(0);
  });
});

test.describe("each toggle changes the result set (§7.8)", () => {
  test("case-sensitive drops the plural, differently-cased subject", async ({ page }) => {
    await page.goto("/?scenario=search");
    await ready(page);
    await searchInput(page).fill("widget");
    await expect(page.getByTestId("search-count")).toHaveText("1 of 3");

    await page.getByTestId("search-toggle-case").click();
    await expect(page.getByTestId("search-toggle-case")).toHaveAttribute("aria-pressed", "true");
    // "add WIDGETS to the list" no longer matches lowercase "widget"; "Fix the widget cache" and
    // "subwidgetary refactor" (a genuine substring, not a whole word) both still do.
    await expect(page.getByTestId("search-count")).toHaveText("1 of 2");
  });

  test("whole-word drops the substring hit inside 'subwidgetary' and the plural", async ({
    page,
  }) => {
    await page.goto("/?scenario=search");
    await ready(page);
    await searchInput(page).fill("widget");
    await page.getByTestId("search-toggle-whole-word").click();
    await expect(page.getByTestId("search-toggle-whole-word")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Only "Fix the widget cache" has "widget" as a whole word — "WIDGETS" has a trailing "S" and
    // "subwidgetary" has "sub"/"ary" on either side, neither a word boundary.
    await expect(page.getByTestId("search-count")).toHaveText("1 of 1");
    await expect(rowWithSubject(page, "Fix the widget cache")).toBeVisible();
  });

  test("regex switches the box from a literal string to a pattern", async ({ page }) => {
    await page.goto("/?scenario=search");
    await ready(page);
    await searchInput(page).fill("wid.et");
    // Literal: no subject contains the four characters "wid.et" verbatim.
    await expect(page.getByTestId("search-count")).toHaveText("No matches");

    await page.getByTestId("search-toggle-regex").click();
    await expect(page.getByTestId("search-toggle-regex")).toHaveAttribute("aria-pressed", "true");
    // "." now matches any character, so this is exactly the "widget" query again.
    await expect(page.getByTestId("search-count")).toHaveText("1 of 3");
  });
});

test.describe("the scope selector switches which groups render (§7.8)", () => {
  test("'release' names a branch, a tag and a commit at once — scope narrows the dropdown to one kind", async ({
    page,
  }) => {
    await page.goto("/?scenario=search");
    await ready(page);
    await searchInput(page).fill("release");

    // Both (default): all three groups, none of them false economy — a branch, a tag and a
    // commit genuinely share this name across independent objects.
    await expect(page.locator(".kv-search-section-title", { hasText: "Branches" })).toBeVisible();
    await expect(page.locator(".kv-search-section-title", { hasText: "Tags" })).toBeVisible();
    await expect(page.locator(".kv-search-section-title", { hasText: "Commits" })).toBeVisible();

    await page.getByTestId("search-scope").selectOption("commits");
    await expect(page.locator(".kv-search-section-title", { hasText: "Branches" })).toHaveCount(0);
    await expect(page.locator(".kv-search-section-title", { hasText: "Tags" })).toHaveCount(0);
    await expect(page.locator(".kv-search-section-title", { hasText: "Commits" })).toBeVisible();

    // Refs: the commit group disappears, and so does the inline match count entirely — §7.8's
    // "next/previous" only ever steps through commit matches, so a count here would describe a
    // thing this scope has no way to walk.
    await page.getByTestId("search-scope").selectOption("refs");
    await expect(page.locator(".kv-search-section-title", { hasText: "Commits" })).toHaveCount(0);
    await expect(page.locator(".kv-search-section-title", { hasText: "Branches" })).toBeVisible();
    await expect(page.locator(".kv-search-section-title", { hasText: "Tags" })).toBeVisible();
    await expect(page.getByTestId("search-count")).toHaveCount(0);
  });
});

test.describe("Enter/Shift+Enter walk commit matches and move the grid selection (§7.8)", () => {
  test("Enter steps forward through matches, wrapping at the end; Shift+Enter steps back", async ({
    page,
  }) => {
    await page.goto("/?scenario=search");
    await ready(page);
    await searchInput(page).fill("widget");
    await expect(page.getByTestId("search-count")).toHaveText("1 of 3");

    // Ascending row order (walk order — the grid renders newest first, so `main tip` is row 0
    // and `root` is the last row): "subwidgetary refactor", then "Fix the widget cache", then
    // "add WIDGETS to the list".
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("search-count")).toHaveText("1 of 3");
    await expectSelected(page, "subwidgetary refactor");

    await page.keyboard.press("Enter");
    await expect(page.getByTestId("search-count")).toHaveText("2 of 3");
    await expectSelected(page, "Fix the widget cache");

    await page.keyboard.press("Enter");
    await expect(page.getByTestId("search-count")).toHaveText("3 of 3");
    await expectSelected(page, "add WIDGETS to the list");

    // Wraps back to the first match.
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("search-count")).toHaveText("1 of 3");
    await expectSelected(page, "subwidgetary refactor");

    await page.keyboard.press("Shift+Enter");
    await expect(page.getByTestId("search-count")).toHaveText("3 of 3");
    await expectSelected(page, "add WIDGETS to the list");
  });
});

test.describe("an invalid regex reports itself inline without breaking the app (§7.8)", () => {
  test("an unmatched '(' shows the inline error, hides the dropdown, and recovers the moment it's fixed", async ({
    page,
  }) => {
    await page.goto("/?scenario=search");
    await ready(page);
    await searchInput(page).fill("widget");
    await expect(page.getByTestId("search-count")).toHaveText("1 of 3");

    await page.getByTestId("search-toggle-regex").click();
    await searchInput(page).fill("wid(get");
    await expect(page.getByTestId("search-error")).toBeVisible();
    await expect(searchInput(page)).toHaveAttribute("aria-invalid", "true");
    // Nothing to walk while the pattern doesn't compile — no dropdown, no stale count either.
    await expect(page.getByTestId("search-results")).toHaveCount(0);
    await expect(page.getByTestId("search-count")).toHaveCount(0);
    // The app is still alive: the grid is untouched and a plain click still selects a row.
    await rowWithSubject(page, "root").click();
    await expectSelected(page, "root");

    // Closing the paren makes it valid again with no reload, no stuck error.
    await searchInput(page).fill("wid(get)?");
    await expect(page.getByTestId("search-error")).toHaveCount(0);
    await expect(page.getByTestId("search-results")).toBeVisible();
  });
});

test.describe("a body-only hit is findable on demand (§7.8, hard part 1, OQ1)", () => {
  test("'gizmocratic' matches nothing in any subject or author, and the tail is skipped by default here — but 'search message bodies' finds it", async ({
    page,
  }) => {
    await page.goto("/?scenario=search");
    await ready(page);
    await searchInput(page).fill("gizmocratic");
    // The scenario's own 9 commits are small enough to load in full, so OQ1's skip applies: no
    // automatic tail runs (the client-side scan alone reports nothing), and the on-demand
    // "search message bodies" affordance appears instead of a silent, wasted ~1s walk.
    await expect(page.getByTestId("search-count")).toHaveText("No matches");
    await expect(page.getByTestId("search-body-button")).toBeVisible();

    await page.getByTestId("search-body-button").click();
    await expect(page.getByTestId("search-count")).toHaveText("1 of 1");
    const option = page.locator('[role="option"]');
    await expect(option).toHaveCount(1);
    await expect(option).toContainText("tail commit only body match");
    // The field label names exactly why this row is here — not its subject.
    await expect(option.locator(".kv-search-option-field")).toHaveText("body");

    await option.click();
    await expectSelected(page, "tail commit only body match");
  });
});

test.describe("a ref hit scrolls to and selects the commit it points at (§7.8)", () => {
  test("selecting the 'main' branch selects main tip; selecting the annotated tag peels to the commit it dereferences", async ({
    page,
  }) => {
    await page.goto("/?scenario=search");
    await ready(page);
    await page.getByTestId("search-scope").selectOption("refs");

    await searchInput(page).fill("main");
    await page.locator(".kv-search-option-main", { hasText: /^main$/ }).click();
    await expectSelected(page, "main tip");

    await searchInput(page).fill("v1.0.0");
    await page.locator('[role="option"]', { hasText: "v1.0.0" }).click();
    // `v1.0.0` is annotated and points at `main tip` via `peeledObjectId` — the same commit,
    // reached through the tag object rather than the branch.
    await expectSelected(page, "main tip");
  });
});

test.describe("Escape's two-stage order (§6.6, OQ5)", () => {
  test("first Escape only dismisses the dropdown; the second clears the query and returns focus to the grid", async ({
    page,
  }) => {
    await page.goto("/?scenario=search");
    await ready(page);
    await searchInput(page).fill("widget");
    await expect(page.getByTestId("search-results")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("search-results")).toHaveCount(0);
    // The query itself survives the first Escape — this was "close the dropdown", not "cancel
    // the search".
    await expect(searchInput(page)).toHaveValue("widget");
    await expect(searchInput(page)).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(searchInput(page)).toHaveValue("");
    await expect(searchInput(page)).not.toBeFocused();
    await expect(page.locator(".slick-row:focus")).toHaveCount(1);
  });
});
