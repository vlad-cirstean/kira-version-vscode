import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P7.md` W17 — the accessibility pass for the review sidebar view (§6.8),
 * `refsA11y.spec.ts`'s (P6 W20) own sibling for this plan's surface. Beyond the zero-serious/
 * critical axe scans themselves, the plan's own "Beyond the scan" list names four things a scan
 * cannot check, each with its own `describe` block below:
 *
 *  - the commit list is a real `tree`/`treeitem` with `aria-expanded` on expandable rows and a
 *    roving `tabindex` — `FileTree.vue`'s own pattern, reused;
 *  - the base picker is keyboard-openable and its reason label is text in the accessible name,
 *    not a colour;
 *  - focus returns to the row's disclosure control when the diff overlay closes, and to the
 *    header trigger when the base picker closes — `modalFocus.ts`'s invoker-capture composable,
 *    reused (`ReviewView.vue`'s/`BaseSelector.vue`'s own doc comments on this);
 *  - the four non-list states (ask, unrelated, empty, error — "listing" is the list state itself,
 *    "resolving" is a brief in-flight moment neither the plan nor `ReviewView.vue`'s own switch
 *    bothers announcing) are announced through the live region when entered.
 */

const THEME_KINDS = [
  "vscode-dark",
  "vscode-light",
  "vscode-high-contrast",
  "vscode-high-contrast-light",
] as const;

// P6a W6's own premise, reused (see `refsA11y.spec.ts`'s doc comment): one theme runs the full
// axe ruleset, the other three run only `cat.color`-tagged rules minus `color-contrast-enhanced`
// (an AAA rule that ships `enabled: false` in axe-core; a tag-based `runOnly` ignores that
// default, so leaving it in would check three themes against a stricter ruleset than the full
// scan does).
const FULL_SCAN_THEME: (typeof THEME_KINDS)[number] = "vscode-dark";
const COLOR_ONLY_DISABLED_RULES = ["color-contrast-enhanced"];

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
}

function reviewRow(page: Page, subject: string) {
  return page.locator(".kv-review-row", { hasText: subject });
}

async function toggleRow(row: ReturnType<Page["locator"]>): Promise<void> {
  await row.locator(".kv-review-row-subject").click();
}

function fileRow(page: Page, name: string) {
  return page.locator(".kv-file-tree-row", { hasText: name });
}

async function unexpectedSeriousViolations(
  page: Page,
  kind: (typeof THEME_KINDS)[number],
): Promise<string[]> {
  const builder = new AxeBuilder({ page });
  const results = await (kind === FULL_SCAN_THEME
    ? builder
    : builder.withTags(["cat.color"]).disableRules(COLOR_ONLY_DISABLED_RULES)
  ).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .flatMap((v) =>
      v.nodes.map((n) => `${v.id} [${v.impact}]: ${n.target.join(" ")} — ${n.failureSummary}`),
    );
}

function scanLabel(kind: (typeof THEME_KINDS)[number]): string {
  return kind === FULL_SCAN_THEME ? "full ruleset" : "color-contrast only";
}

/**
 * `main.ts`'s own `Date.now = () => HARNESS_FROZEN_NOW_MS` (P4 W12, for stable relative-date
 * text) collides with Vue 3's own internal event-invoker bookkeeping: each DOM listener Vue
 * attaches is wrapped in an "invoker" stamped `invoker.attached = Date.now()` at creation, and on
 * first dispatch an event is stamped `event._vts = Date.now()` — a real invoker then no-ops
 * (silently, no error) whenever `event._vts <= invoker.attached`, a guard against a Safari/
 * `postMessage` re-dispatch bug that only ever matters because on a REAL clock a mounted
 * invoker's `.attached` is always safely in the past by the time a user's keypress dispatches.
 * With the clock frozen solid, every invoker mounted during initial render shares the exact same
 * `.attached` timestamp as any later event's `_vts` — so `<=` is trivially true, and every
 * Vue-attached `keydown` listener along a bubble path *except the first one an event reaches*
 * (here, the row's own) silently never runs, `.kv-review-rows`'s own `onRowsKeydown` included.
 * This can never happen to a real user (real time always advances between mount and a keypress);
 * it is purely an artifact of this harness's own frozen clock, so the fix belongs here, in the one
 * test that presses an arrow key through more than one Vue-managed listener — not in the app, and
 * not in `main.ts`'s shared freeze (every screenshot/relative-date assertion elsewhere depends on
 * that freeze staying exact). Nudging `Date.now()` forward by whole milliseconds *after* the page
 * has already mounted (every row and the wrapper already carry the original frozen `.attached`)
 * makes each subsequent event's `_vts` exceed all of them, with no visible effect on anything
 * already rendered.
 */
async function unfreezeClockForInvokers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frozen = Date.now();
    let tick = 0;
    Date.now = () => frozen + ++tick;
  });
}

test.describe("axe: review sidebar surfaces, no serious/critical violations", () => {
  for (const kind of THEME_KINDS) {
    test(`list: ${kind} (${scanLabel(kind)})`, async ({ page }) => {
      await page.goto(`/?scenario=review&view=review&branch=feature&theme=${kind}`);
      await ready(page);
      await expect(page.locator('[role="tree"]')).toBeVisible();
      expect(await unexpectedSeriousViolations(page, kind)).toEqual([]);
    });

    test(`expanded row: ${kind} (${scanLabel(kind)})`, async ({ page }) => {
      await page.goto(`/?scenario=review&view=review&branch=feature&theme=${kind}`);
      await ready(page);
      await toggleRow(reviewRow(page, "rename1"));
      await expect(fileRow(page, "renamed-new.ts")).toBeVisible();
      expect(await unexpectedSeriousViolations(page, kind)).toEqual([]);
    });

    test(`diff overlay: ${kind} (${scanLabel(kind)})`, async ({ page }) => {
      await page.goto(`/?scenario=review&view=review&branch=feature&theme=${kind}`);
      await ready(page);
      await toggleRow(reviewRow(page, "rename1"));
      await fileRow(page, "renamed-new.ts").click();
      await expect(page.getByTestId("diff-view")).toBeVisible();
      expect(await unexpectedSeriousViolations(page, kind)).toEqual([]);
    });

    test(`base picker open: ${kind} (${scanLabel(kind)})`, async ({ page }) => {
      await page.goto(`/?scenario=review&view=review&branch=feature&theme=${kind}`);
      await ready(page);
      await page.getByTestId("base-selector-trigger").click();
      await expect(page.locator(".kv-base-panel")).toBeVisible();
      expect(await unexpectedSeriousViolations(page, kind)).toEqual([]);
    });

    test(`ask state: ${kind} (${scanLabel(kind)})`, async ({ page }) => {
      await page.goto(`/?scenario=reviewAsk&view=review&branch=feature&theme=${kind}`);
      await ready(page);
      await expect(page.getByTestId("review-ask")).toBeVisible();
      expect(await unexpectedSeriousViolations(page, kind)).toEqual([]);
    });

    test(`nothing to review: ${kind} (${scanLabel(kind)})`, async ({ page }) => {
      await page.goto(`/?scenario=reviewMerged&view=review&branch=feature&theme=${kind}`);
      await ready(page);
      await expect(page.getByTestId("review-empty")).toBeVisible();
      expect(await unexpectedSeriousViolations(page, kind)).toEqual([]);
    });
  }
});

test.describe("the commit list: real tree/treeitem semantics with a roving tabindex (W17)", () => {
  test("role=tree with an accessible label; rows are treeitem with aria-expanded; exactly one row is a tab stop, and it roves with ArrowDown", async ({
    page,
  }) => {
    await page.goto("/?scenario=review&view=review&branch=feature");
    await ready(page);
    await unfreezeClockForInvokers(page);
    const tree = page.locator('[role="tree"][aria-label="Commits"]');
    await expect(tree).toHaveAccessibleName("Commits");

    // `.kv-review-row`, not a bare `[role="treeitem"]` — once a row expands, its own `FileTree`
    // nests a *second* tree (its own treeitems, `aria-label="File tree"`) inside this one's DOM,
    // and an unscoped descendant selector would count both lists' rows as one.
    const rows = page.locator(".kv-review-row");
    await expect(rows).not.toHaveCount(0);
    await expect(rows.first()).toHaveAttribute("role", "treeitem");

    // A middle row, not an end one — pressing ArrowDown from the *last* row has nowhere further
    // to go (`onRowsKeydown`'s own clamp), which would make "it moves" a false negative.
    const collapsed = reviewRow(page, "rename1");
    await expect(collapsed).toHaveAttribute("aria-expanded", "false");
    await toggleRow(collapsed);
    await expect(collapsed).toHaveAttribute("aria-expanded", "true");

    // Roving tabindex: exactly one row is a tab stop at a time, and it moves with the arrow
    // keys — never "every row tabbable" and never "none".
    const tabbable = page.locator('.kv-review-row[tabindex="0"]');
    await expect(tabbable).toHaveCount(1);
    const firstStopId = await tabbable.getAttribute("data-testid");
    // The tree container carries the keydown handler, but nothing auto-focuses a row on load
    // (matching `review.spec.ts`'s own established pattern) — focus the current tab stop
    // explicitly so the arrow key actually reaches it and bubbles up.
    await tabbable.focus();
    await page.keyboard.press("ArrowDown");
    // `focusRow`'s own DOM focus move happens inside a `nextTick` — an auto-retrying assertion,
    // not a one-shot `getAttribute`, so this does not race that microtask.
    const newTabbable = page.locator('.kv-review-row[tabindex="0"]');
    await expect(newTabbable).not.toHaveAttribute("data-testid", firstStopId ?? "");
    await expect(newTabbable).toHaveCount(1);
  });
});

test.describe("the base picker: keyboard-openable, and its reason is text in the accessible name (W17)", () => {
  test("Enter on the trigger opens the panel; Escape closes it and returns focus to the trigger", async ({
    page,
  }) => {
    await page.goto("/?scenario=review&view=review&branch=feature");
    await ready(page);
    const trigger = page.getByTestId("base-selector-trigger");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".kv-base-panel")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(".kv-base-panel")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("the resolution reason reads as text in the trigger's accessible name — 'default branch' here, not merely a colour", async ({
    page,
  }) => {
    await page.goto("/?scenario=review&view=review&branch=feature");
    await ready(page);
    await expect(page.getByTestId("base-selector-trigger")).toHaveAccessibleName(/default branch/i);
  });

  test("a different resolution reason ('upstream') reads the same way", async ({ page }) => {
    await page.goto("/?scenario=reviewUpstream&view=review&branch=feature");
    await ready(page);
    await expect(page.getByTestId("base-selector-trigger")).toHaveAccessibleName(/upstream/i);
  });
});

test.describe("focus returns to the invoking control when an overlay closes (W17)", () => {
  test("the diff overlay: Escape closes it and returns focus to whatever opened it", async ({
    page,
  }) => {
    await page.goto("/?scenario=review&view=review&branch=feature");
    await ready(page);
    await toggleRow(reviewRow(page, "feat1"));
    const file = fileRow(page, "feat1.ts");
    await file.click();
    await expect(page.getByTestId("diff-view")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("diff-view")).toHaveCount(0);
    await expect(file).toBeFocused();
  });

  test("the base picker: Escape closes it and returns focus to the header trigger, even after filtering", async ({
    page,
  }) => {
    await page.goto("/?scenario=review&view=review&branch=feature");
    await ready(page);
    const trigger = page.getByTestId("base-selector-trigger");
    await trigger.click();
    await page.locator(".kv-base-filter").fill("mai");
    await page.keyboard.press("Escape");
    await expect(page.locator(".kv-base-panel")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

test.describe("the live region announces the four non-list states on entry (W17)", () => {
  const liveRegion = (page: Page) => page.getByTestId("live-announcements");

  test("ask: no base detected", async ({ page }) => {
    await page.goto("/?scenario=reviewAsk&view=review&branch=feature");
    await ready(page);
    await expect(page.getByTestId("review-ask")).toBeVisible();
    await expect(liveRegion(page)).toHaveText(/no base detected for feature/i);
  });

  test("unrelated: picking a base with no shared history", async ({ page }) => {
    await page.goto("/?scenario=reviewAsk&view=review&branch=feature");
    await ready(page);
    await page.getByTestId("base-selector-trigger").click();
    await page.locator(".kv-base-row", { hasText: "other" }).click();
    await expect(page.getByTestId("review-unrelated")).toBeVisible();
    await expect(liveRegion(page)).toHaveText(/feature.*share no common history/i);
  });

  test("empty: nothing to review", async ({ page }) => {
    await page.goto("/?scenario=reviewMerged&view=review&branch=feature");
    await ready(page);
    await expect(page.getByTestId("review-empty")).toBeVisible();
    await expect(liveRegion(page)).toHaveText(/adds no commits to/i);
  });

  test("error: review.resolveBase itself fails", async ({ page }) => {
    // No mock scenario models a resolveBase failure directly — `pushReviewTarget` at a repoId no
    // session ever opened makes the mock's own `requireSession` throw, exercising the same
    // catch block a real transport/host error would (`ReviewSessionState.#resolve`'s own
    // doc comment).
    await page.goto("/?scenario=review&view=review&branch=feature");
    await ready(page);
    await page.evaluate(() => {
      window.__kiraHarness.pushReviewTarget("/repos/does-not-exist", "feature");
    });
    await expect(liveRegion(page)).not.toHaveText("");
    const text = await liveRegion(page).innerText();
    expect(text.toLowerCase()).toContain("couldn't compare");
  });
});
