import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P4.md` W13 — the interaction suite: everything §6.4/§6.2/§5.1.1 describe as a
 * behaviour, exercised against the harness's `mockBridge.ts` (P3 W14, extended P4 W12). Visual
 * regression is `graph.spec.ts`'s job; this file never screenshots.
 */

// `Window.__kiraHarness`'s ambient type is declared once, project-wide, in `shell.spec.ts` —
// see that file's own comment on why this file does not repeat it.

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
}

/**
 * SlickGrid stamps every row div with a stable `data-row="N"` attribute (its own
 * `appendRowHtml`), but a row's *position among its DOM siblings* is not stable: `invalidateRows`
 * removes a row's node and `render()` re-`appendChild`s a fresh one at the *end* of the row
 * container (positioned back to the right place on screen only via `transform: translateY(...)`)
 * — so once a row has been invalidated even once (a selection change, a layout patch, …),
 * `.slick-row` DOM order no longer matches row order at all. Every test here that needs a
 * *specific* row targets it by `data-row`, never by `.first()`/`.nth()` on `.slick-row`.
 */
function rowByIndex(page: Page, index: number): ReturnType<Page["locator"]> {
  return page.locator(`.slick-row[data-row="${index}"]`);
}

/**
 * `graph.stream` (the mock's replay of `Scenario.commits`, `mockBridge.ts`) delivers a scenario's
 * first page in 500-row chunks, not all at once — a scenario with more than one page's worth of
 * history (`hugeRepo`) is still mid-stream for a little while after `ready()` resolves.
 * `LoadMoreButton.vue`'s `disabled` attribute is a direct read of `GraphViewState.loading`, so
 * "the button exists and isn't disabled" is the one visible signal that the *first* page has
 * fully landed — anything that depends on an exact loaded-row count (End's clamp, "N remaining")
 * needs to wait for it first. Only meaningful for a scenario with more than one page; a fully
 * exhausted scenario never renders this button at all.
 */
async function readyToLoadMore(page: Page): Promise<void> {
  await expect(page.locator(".kv-load-more-button:not([disabled])")).toBeVisible();
}

/** What `document.activeElement` actually is, in a form a test can match against without caring
 *  about SlickGrid's per-instance-id `aria-describedby` values or exact class ordering. */
interface FocusInfo {
  tag: string;
  classList: string[];
  dataRow: string | null;
}

async function focusInfo(page: Page): Promise<FocusInfo> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName.toLowerCase() ?? "",
      classList: el ? Array.from(el.classList) : [],
      dataRow: el?.getAttribute("data-row") ?? null,
    };
  });
}

/**
 * Presses real `Tab` keys — the same input a keyboard-only user sends — until `document
 * .activeElement` matches `predicate`, rather than hard-coding a step count: the exact number of
 * tab stops between two points in the panel is an implementation detail of what else the toolbar
 * currently renders (P4 only builds part of §6.2's toolbar — see `AppToolbar.vue`'s own doc
 * comment), not something this test should have to track. What is under test is that the
 * predicate's target is reachable by `Tab` *at all*, in order, with nothing un-skippable in
 * front of it — a SlickGrid focus sink, in particular (W14/V2).
 */
async function tabUntil(
  page: Page,
  predicate: (info: FocusInfo) => boolean,
  maxPresses = 25,
): Promise<void> {
  for (let i = 0; i < maxPresses; i++) {
    if (predicate(await focusInfo(page))) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`tabUntil: condition not met within ${maxPresses} Tab presses`);
}

test.describe("rows and columns", () => {
  test("the clean scenario's tip row renders real subject, author, date and sha text", async ({
    page,
  }) => {
    await page.goto("/?scenario=clean");
    await ready(page);
    const firstRow = rowByIndex(page, 0);

    // `topology.ts`'s `clean` spec ends with "tip:merge" — newest-first, so row 0 is "tip".
    await expect(firstRow.locator(".kv-message-subject")).toHaveText("tip");
    await expect(firstRow.locator(".kv-cell-author")).toHaveText("Kira Fixture");
    // The harness's frozen clock (P4 W12) pins every relative date to a small, stable "Nh".
    await expect(firstRow.locator(".kv-cell-date")).toHaveText(/^\d+h$/);
    await expect(firstRow.locator(".kv-cell-sha")).toHaveText(/^[0-9a-f]{7}$/);
  });

  test(".slick-row count stays bounded at rest and after scrolling hugeRepo to its end", async ({
    page,
  }) => {
    await page.goto("/?scenario=hugeRepo");
    await ready(page);
    await readyToLoadMore(page);
    await expect(rowByIndex(page, 0)).toBeVisible();

    const atRest = await page.locator(".slick-row").count();
    // A materialized-array regression would render every loaded row at once (thousands); the
    // viewport this test runs at fits well under 60 in view plus SlickGrid's own render buffer.
    expect(atRest).toBeLessThan(80);

    await page.evaluate(() => {
      const viewport = document.querySelector(".kv-commit-grid .slick-viewport");
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
    await page.waitForTimeout(200);

    const atEnd = await page.locator(".slick-row").count();
    expect(atEnd).toBeLessThan(80);
    expect(atEnd).toBeGreaterThan(0);
  });

  test("the graph column's per-row element count stays bounded", async ({ page }) => {
    await page.goto("/?scenario=badges");
    await ready(page);
    const rows = page.locator(".slick-row");
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);

    const totalGraphElements = await page.locator(".kv-cell-graph svg *").count();
    // One path per lane colour present in the row plus at most two node shapes (dot + ring) —
    // rowSvg.ts's own doc comment: "~4 elements typical", never one element per graph segment.
    expect(totalGraphElements).toBeLessThan(rowCount * 8);
  });
});

test.describe("selection and keyboard", () => {
  test("click selects; a second click on the same row toggles the detail pane closed", async ({
    page,
  }) => {
    await page.goto("/?scenario=clean");
    await ready(page);
    const firstRow = rowByIndex(page, 0);
    const detail = page.getByTestId("detail-region");

    await firstRow.click();
    await expect(firstRow).toHaveClass(/kv-row-selected/);
    await expect(detail).toBeVisible();
    await expect(detail.locator(".kv-meta-subject")).toHaveText("tip");

    await firstRow.click();
    await expect(detail).toBeHidden();
  });

  test("arrow keys, Home, End, PageUp and PageDown move selection and keep it in view", async ({
    page,
  }) => {
    await page.goto("/?scenario=hugeRepo");
    await ready(page);
    // End's expected landing spot depends on exactly how many rows are loaded (moveSelection
    // clamps to `loadedRows - 1`, CommitGrid.vue) — wait for the first page to fully land first.
    await readyToLoadMore(page);
    const detail = page.getByTestId("detail-region");
    const firstRow = rowByIndex(page, 0);
    await firstRow.click();
    await expect(detail.locator(".kv-meta-subject")).toHaveText("huge-19999");

    await page.keyboard.press("ArrowDown");
    await expect(detail.locator(".kv-meta-subject")).toHaveText("huge-19998");

    await page.keyboard.press("ArrowUp");
    await expect(detail.locator(".kv-meta-subject")).toHaveText("huge-19999");

    // §5.1.1: "explicit load more, never infinite scroll" — only the first page (pageSize=5000
    // rows, hugeRepo's own comment) is loaded yet, so End clamps to row 4999 ("huge-15000"), not
    // all the way to the repo's actual root ("huge-0"); reaching that needs Load more/all first.
    await page.keyboard.press("End");
    await expect(detail.locator(".kv-meta-subject")).toHaveText("huge-15000");
    // "keeps it in view": the newly selected row must actually be visible, not merely selected.
    await expect(page.locator(".slick-row.kv-row-selected")).toBeVisible();

    await page.keyboard.press("Home");
    await expect(detail.locator(".kv-meta-subject")).toHaveText("huge-19999");
    await expect(page.locator(".slick-row.kv-row-selected")).toBeVisible();

    await page.keyboard.press("PageDown");
    // A direct, non-retrying textContent() read here would race the watch-driven re-render (the
    // same one-tick gap `toHaveClass`/`toHaveText` below exist to absorb) — assert through an
    // auto-retrying matcher instead of reading the text out first.
    await expect(detail.locator(".kv-meta-subject")).not.toHaveText("huge-19999");
    await expect(page.locator(".slick-row.kv-row-selected")).toBeVisible();

    await page.keyboard.press("PageUp");
    await expect(detail.locator(".kv-meta-subject")).toHaveText("huge-19999");
  });

  test("Esc closes the detail pane", async ({ page }) => {
    await page.goto("/?scenario=clean");
    await ready(page);
    const detail = page.getByTestId("detail-region");
    await rowByIndex(page, 0).click();
    await expect(detail).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(detail).toBeHidden();
  });

  // `docs/plans/P4.md` W14's own "Done when": every one of these steps — tab in, pick a repo,
  // move selection, open and close the pane, resize a column, load more, refresh — possible
  // without a mouse, scripted here rather than merely asserted piecemeal by the tests above (each
  // of which still uses `.click()` to get to the behaviour it actually tests). No `page.mouse.*`
  // call and no `.click()` appears anywhere in this test.
  test("keyboard-only pass: tab in, pick a repo, move selection, open/close the pane, resize a column, load more, refresh", async ({
    page,
  }) => {
    await page.goto("/?scenario=hugeRepo");
    await ready(page);
    await readyToLoadMore(page);

    // Tab in: the very first Tab press from a blank focus state lands on the repo trigger — the
    // panel's first real interactive element (`AppToolbar.vue`'s own child order) — never a
    // SlickGrid focus sink, which would sit ahead of it in the DOM if W14's tabindex sweep
    // (`CommitGrid.vue`'s `onMounted`) had not neutralised it.
    await page.keyboard.press("Tab");
    expect((await focusInfo(page)).classList).toContain("kv-repo-trigger");

    // Pick a repo: Enter opens the dropdown (a native <button>'s default activation), Tab reaches
    // its first option, Enter selects it.
    await page.keyboard.press("Enter");
    await expect(page.locator(".kv-repo-list")).toBeVisible();
    await tabUntil(page, (info) => info.classList.includes("kv-repo-item"));
    await page.keyboard.press("Enter");
    await expect(page.locator(".kv-repo-list")).toBeHidden();
    // Picking a repo resets `GraphViewState` and re-opens the stream (App.vue's handleRepoOpened,
    // W11) — the mock answers with the same one repo either way (`commitList.spec.ts`'s own "the
    // repo picker opens a candidate" test carries the identical reasoning), so this is still
    // `hugeRepo`'s 20,000-commit history, freshly re-streamed.
    await ready(page);
    await readyToLoadMore(page);

    // Tabbing on into the panel from here lands on a row — never a focus sink — and specifically
    // on row 0, the roving tabindex's default target with nothing selected yet (`applyAccessibility`,
    // CommitGrid.vue: `selectedRow >= 0 ? selectedRow : 0`). This is W14's own last "Done when"
    // clause, exercised with real Tab presses rather than inferred from the sweep alone.
    await tabUntil(page, (info) => info.classList.includes("slick-row"));
    const onRow = await focusInfo(page);
    expect(onRow.classList).toContain("slick-row");
    expect(onRow.dataRow).toBe("0");

    // Move selection: real keydowns on the row that already holds DOM focus, not a synthetic
    // dispatch. Nothing is selected yet at this point (row 0 is only the *tabbable* default, not
    // a selection — `applyAccessibility`'s own `tabbableRow` comment), so the first ArrowDown
    // moves selection from "none" to row 0, same as `moveSelection`'s clamp does for any other
    // unselected grid; a second ArrowDown is what actually advances it to row 1.
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".slick-row.kv-row-selected")).toHaveAttribute("data-row", "0");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".slick-row.kv-row-selected")).toHaveAttribute("data-row", "1");

    // Open/close the pane: `detailOpen` (App.vue) defaults to `true` at the `wide` breakpoint
    // this viewport uses (§6.3), so it is already open from the two `ArrowDown` presses above —
    // `Enter` toggles it, same as a second click on an already-selected row does
    // (`commitList.spec.ts`'s own first test), so it closes here rather than opens.
    const detail = page.getByTestId("detail-region");
    await expect(detail).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(detail).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(detail).toBeVisible();
    // `Escape` unconditionally closes it (`closeDetail`, App.vue), regardless of how it got open.
    await page.keyboard.press("Escape");
    await expect(detail).toBeHidden();

    // Resize a column: Tab from the row on to the next real tab stop after it — the selected
    // row's own sha copy button (P5 W10 enables it; `CommitGrid.vue`'s `applyAccessibility`
    // keeps it a roving tab stop, `tabIndex 0` only on the tabbable row, exactly like the row
    // itself, so this is still exactly one hop away, not one per loaded row) — then the
    // message|author resize handle right after it.
    await tabUntil(page, (info) => info.classList.includes("kv-resize-handle"));
    const widthBefore = await page.locator(":focus").getAttribute("aria-valuenow");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(":focus")).not.toHaveAttribute("aria-valuenow", widthBefore ?? "");

    // Load more: Tab on to the Load more button, activate it with Space (a native <button>'s
    // other default activation key, distinct from Enter, already used above).
    await tabUntil(page, (info) => info.classList.includes("kv-load-more-button"));
    await page.keyboard.press("Space");
    await expect(page.locator(".kv-load-more-button")).toContainText("10,000 remaining");
    // `GraphViewState.refresh()`'s own idempotency guard ("a second press while running is a
    // no-op", `graphView.ts`) silently no-ops unless `loading` is back to `"idle"` — the label
    // text above updates before that settles, so F5 immediately after it is a real, once-observed
    // race that made the refresh below silently do nothing. `readyToLoadMore`'s own "button not
    // disabled" check is this file's established signal that a load has actually finished.
    await readyToLoadMore(page);

    // Refresh: F5 while the grid has focus (`CommitGrid.vue`'s own `handleKeyDown`) reaches the
    // same action the toolbar's refresh button does (`AppToolbar.vue`'s `defineExpose`) — tab
    // back onto a row first, since the button just pressed re-renders once its own click resolves.
    await tabUntil(page, (info) => info.classList.includes("slick-row"));
    await page.keyboard.press("F5");
    await expect(page.getByTestId("chunk-source")).toHaveText("git");
  });
});

test.describe("loading more", () => {
  test("Load more appends one page, keeps the top row and selection, updates remaining, then disappears", async ({
    page,
  }) => {
    await page.goto("/?scenario=hugeRepo");
    await ready(page);
    await readyToLoadMore(page);
    const firstRow = rowByIndex(page, 0);
    await firstRow.click();
    const selectedSubject = await page
      .getByTestId("detail-region")
      .locator(".kv-meta-subject")
      .textContent();
    const topSubjectBefore = await firstRow.locator(".kv-message-subject").textContent();

    const loadMore = page.locator(".kv-load-more-button");
    await expect(loadMore).toBeVisible();
    const labelBefore = await loadMore.textContent();
    expect(labelBefore).toContain("15,000 remaining"); // 20,000 - the first page's 5,000

    await loadMore.click();
    await expect(loadMore).toContainText("10,000 remaining");

    // Unchanged: the top visible row and the selection, per §5.1.1's own "Done when".
    await expect(firstRow.locator(".kv-message-subject")).toHaveText(topSubjectBefore ?? "");
    await expect(page.getByTestId("detail-region").locator(".kv-meta-subject")).toHaveText(
      selectedSubject ?? "",
    );

    // Alt-click loads everything remaining in one go; the button disappears at exhaustion.
    await loadMore.click({ modifiers: ["Alt"] });
    await expect(loadMore).toBeHidden({ timeout: 10_000 });
  });
});

test.describe("refresh", () => {
  test("Refresh re-walks and preserves selection and scroll; a mock refsChanged shows the stale dot", async ({
    page,
  }) => {
    await page.goto("/?scenario=clean");
    await ready(page);
    await rowByIndex(page, 0).click();
    await expect(page.getByTestId("detail-region").locator(".kv-meta-subject")).toHaveText("tip");

    const dot = page.locator(".kv-refresh-dot");
    await expect(dot).toBeHidden();
    await page.evaluate(() => window.__kiraHarness.triggerRefsChanged());
    await expect(dot).toBeVisible();

    await page.locator(".codicon-refresh").click();
    await expect(dot).toBeHidden();
    await expect(page.getByTestId("chunk-source")).toHaveText("git");
    // Selection survives the re-walk (App.vue's pendingSelectionSha mechanism, W11).
    await expect(page.getByTestId("detail-region").locator(".kv-meta-subject")).toHaveText("tip");
    await expect(page.locator(".slick-row.kv-row-selected")).toBeVisible();
  });
});

test.describe("repo picker and git-blocked state", () => {
  test("the repo picker opens a candidate", async ({ page }) => {
    await page.goto("/?scenario=clean");
    await ready(page);

    await page.locator(".kv-repo-trigger").click();
    const list = page.locator(".kv-repo-list");
    await expect(list).toBeVisible();
    const otherCandidate = page.locator(".kv-repo-item", { hasText: "other-repo" });
    await expect(otherCandidate).toBeVisible();

    await otherCandidate.click();
    await expect(list).toBeHidden();
    // Opening a candidate resets the *client's* store and re-opens the stream (App.vue's
    // handleRepoOpened, W11) — but the mock answers with the same one repo either way
    // (`repoOpen`'s own doc comment) and that repo's *session* was never closed, so its rows are
    // still cached host-side: exactly `RepoService.streamGraph`'s "cache" branch, a full replay
    // with no new git read, not the "git" source a genuinely first-ever open gets.
    await expect(page.getByTestId("chunk-source")).toHaveText("cache");
    await expect(rowByIndex(page, 0)).toBeVisible();
  });

  test("the tooOld scenario renders the git-blocked state", async ({ page }) => {
    await page.goto("/?scenario=tooOld");
    await ready(page);

    await expect(page.locator(".codicon-warning")).toBeVisible();
    await expect(page.getByText("Git is too old")).toBeVisible();
    // §4.2: "the repo picker, prompted, and nothing else" — no toolbar in this state.
    await expect(page.locator(".kv-repo-trigger")).toHaveCount(0);
    await expect(page.locator(".slick-row")).toHaveCount(0);
  });
});

test.describe("persistence", () => {
  test("a column resize persists across a reload of the harness page", async ({ page }) => {
    await page.goto("/?scenario=clean");
    await ready(page);

    const readAuthorWidth = () =>
      page.evaluate(() => {
        const raw = sessionStorage.getItem("kira-harness-viewState");
        return raw ? (JSON.parse(raw).columnWidths.author as number) : null;
      });

    const before = await readAuthorWidth();
    expect(before).toBe(140); // DEFAULT_COLUMN_WIDTHS.author

    const handle = page.locator(".kv-resize-handle").first();
    const box = await handle.boundingBox();
    if (!box) throw new Error("no bounding box for the author resize handle");
    await handle.hover();
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y);
    await page.mouse.up();

    await expect.poll(readAuthorWidth).not.toBe(before);
    const afterDrag = await readAuthorWidth();

    await page.reload();
    await ready(page);
    expect(await readAuthorWidth()).toBe(afterDrag);
  });
});
