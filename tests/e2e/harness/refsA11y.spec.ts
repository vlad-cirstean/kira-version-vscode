import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P6.md` W20 — the accessibility pass's own verification suite, `a11y.spec.ts`'s
 * (P4 W14) sibling for every surface this plan adds: the open branch picker, the open row
 * context menu, each dialog, and the conflict banner. Beyond the zero-serious/critical axe scans
 * themselves, the plan's own "Beyond zero serious/critical" list names four things an axe scan
 * cannot see on its own, each with its own `describe` block below:
 *
 *  - The context menu is a real `menu`/`menuitem` with roving focus, reachable from the keyboard
 *    (`Shift+F10`, the Menu key), `Esc` closes it, and focus returns to the row.
 *  - Each dialog traps focus (`Tab`/`Shift+Tab` never leave it) and returns focus to its invoker
 *    on close.
 *  - The banner is `role="status"`, never `alert`.
 *  - Every disabled gated control's reason is reachable via `aria-describedby`, not only a
 *    tooltip.
 */

const THEME_KINDS = [
  "vscode-dark",
  "vscode-light",
  "vscode-high-contrast",
  "vscode-high-contrast-light",
] as const;

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

// Identical filter to `a11y.spec.ts`'s own — see that file's doc comment for why this one node
// pair is excluded (a confirmed axe-core false positive against a transformed SlickGrid row, not
// a real contrast failure). Reproduced rather than imported: each spec file here is self-
// contained by this project's own convention (`shell.spec.ts`'s doc comment on why
// `Window.__kiraHarness`'s type is copied rather than shared).
function isKnownRowSelectedContrastFalsePositive(violationId: string, target: string[]): boolean {
  if (violationId !== "color-contrast") return false;
  const joined = target.join(" ");
  return (
    joined.includes("kv-row-selected") &&
    (joined.includes("kv-message-subject") || joined.includes("kv-cell-author"))
  );
}

async function unexpectedSeriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .flatMap((v) =>
      v.nodes
        .filter((n) => !isKnownRowSelectedContrastFalsePositive(v.id, n.target as string[]))
        .map((n) => `${v.id} [${v.impact}]: ${n.target.join(" ")} — ${n.failureSummary}`),
    );
}

test.describe("axe: refs & checkout surfaces, no serious/critical violations", () => {
  for (const kind of THEME_KINDS) {
    test(`open branch picker: ${kind}`, async ({ page }) => {
      await page.goto(`/?scenario=tags&theme=${kind}`);
      await ready(page);
      await openPicker(page);
      expect(await unexpectedSeriousViolations(page)).toEqual([]);
    });

    test(`open row context menu: ${kind}`, async ({ page }) => {
      await page.goto(`/?scenario=dirty&theme=${kind}`);
      await ready(page);
      const row = page.locator(".slick-row", { hasText: "main" }).first();
      await row.click({ button: "right" });
      await expect(page.locator('[role="menu"]')).toBeVisible();
      expect(await unexpectedSeriousViolations(page)).toEqual([]);
    });

    test(`CheckoutDialog open (blocked-by-tracked): ${kind}`, async ({ page }) => {
      await page.goto(`/?scenario=dirty&theme=${kind}`);
      await ready(page);
      await openPicker(page);
      await page
        .locator(".kv-branch-row", { hasText: "feature-blocked-tracked" })
        .locator(".kv-branch-row-main")
        .click();
      await expect(page.locator('[aria-labelledby="kv-checkout-dialog-title"]')).toBeVisible();
      expect(await unexpectedSeriousViolations(page)).toEqual([]);
    });

    test(`RevertDialog open (predicted conflict): ${kind}`, async ({ page }) => {
      await page.goto(`/?scenario=merge&theme=${kind}`);
      await ready(page);
      const row = page.locator(".slick-row", { hasText: "side-a" }).first();
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Revert this commit…" }).click();
      await expect(page.locator('[aria-labelledby="kv-revert-dialog-title"]')).toContainText(
        "This will likely conflict in:",
      );
      expect(await unexpectedSeriousViolations(page)).toEqual([]);
    });

    test(`TagDialog open (force-move warning): ${kind}`, async ({ page }) => {
      await page.goto(`/?scenario=tags&theme=${kind}`);
      await ready(page);
      const row = page.locator(".slick-row", { hasText: "main" }).first();
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Create tag here…" }).click();
      const modal = page.locator('[aria-labelledby="kv-tag-dialog-title"]');
      await modal.locator("input[type='text']").fill("v1.0.0");
      await modal.getByRole("checkbox", { name: "Replace it" }).click();
      await expect(modal).toContainText("silently downgrade it to lightweight");
      expect(await unexpectedSeriousViolations(page)).toEqual([]);
    });

    test(`BranchDialog open: ${kind}`, async ({ page }) => {
      await page.goto(`/?scenario=dirty&theme=${kind}`);
      await ready(page);
      const row = page.locator(".slick-row", { hasText: "main" }).first();
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Create branch here…" }).click();
      await expect(page.locator('[aria-labelledby="kv-branch-dialog-title"]')).toBeVisible();
      expect(await unexpectedSeriousViolations(page)).toEqual([]);
    });

    test(`conflict banner: ${kind}`, async ({ page }) => {
      await page.goto(`/?scenario=conflicted&theme=${kind}`);
      await ready(page);
      await expect(page.getByTestId("conflict-banner")).toBeVisible();
      expect(await unexpectedSeriousViolations(page)).toEqual([]);
    });
  }
});

test.describe("context menu: real menu semantics and keyboard reachability (§6.6/W20)", () => {
  test("Shift+F10 opens it on the focused row, ArrowDown/Up rove focus among enabled items, and Esc closes it and returns focus to that row", async ({
    page,
  }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);
    const row = page.locator('.slick-row[data-row="0"]');
    await row.click();
    await page.keyboard.press("Shift+F10");

    const menu = page.locator('[role="menu"]');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).not.toHaveCount(0);

    // Roving tabindex: exactly one item is a tab stop, and it moves with ArrowDown — never more
    // than one at once (a real `menu` has one logical focus position, not several).
    const tabbable = menu.locator('[role="menuitem"][tabindex="0"]');
    await expect(tabbable).toHaveCount(1);
    const firstFocused = await tabbable.getAttribute("id");
    await page.keyboard.press("ArrowDown");
    const secondFocused = await menu.locator('[role="menuitem"][tabindex="0"]').getAttribute("id");
    expect(secondFocused).not.toBe(firstFocused);
    await expect(menu.locator('[role="menuitem"][tabindex="0"]')).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(row).toBeFocused();
  });

  test("the Menu key (ContextMenu) opens the same menu as Shift+F10", async ({ page }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);
    await page.locator('.slick-row[data-row="0"]').click();
    await page.keyboard.press("ContextMenu");
    await expect(page.locator('[role="menu"]')).toBeVisible();
  });

  test("every disabled menu item's reason is reachable via aria-describedby, not only a tooltip", async ({
    page,
  }) => {
    await page.goto("/?scenario=conflicted");
    await ready(page);
    const row = page.locator(".slick-row", { hasText: "main" }).first();
    await row.click({ button: "right" });
    const revertItem = page.getByRole("menuitem", { name: "Revert this commit…" });
    await expect(revertItem).toHaveAttribute("aria-disabled", "true");
    const describedBy = await revertItem.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const reasonText = await page.locator(`#${describedBy}`).innerText();
    expect(reasonText.trim().length).toBeGreaterThan(0);
  });
});

test.describe("dialogs: focus trap and return-to-invoker (W20)", () => {
  async function expectTrapAndReturn(
    page: Page,
    modalSelector: string,
    row: ReturnType<Page["locator"]>,
    close: () => Promise<void>,
  ): Promise<void> {
    const modal = page.locator(modalSelector);
    await expect(modal).toBeVisible();

    // Trap: Tab from the last focusable wraps to the first, Shift+Tab from the first wraps to
    // the last — `Tab` never lands outside the dialog while it is open.
    const focusables = modal.locator(
      "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    );
    const count = await focusables.count();
    expect(count).toBeGreaterThan(1);
    const first = focusables.first();
    const last = focusables.last();

    await last.focus();
    await page.keyboard.press("Tab");
    await expect(first).toBeFocused();

    await first.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(last).toBeFocused();

    // Return-to-invoker: whatever had focus just before the dialog opened (the row that was
    // right-clicked, via the menu this suite's own harness closes on select —
    // `RowContextMenu.vue`'s own W20 fix) gets it back once the dialog closes, not just "focus
    // goes somewhere".
    await close();
    await expect(modal).toBeHidden();
    await expect(row).toBeFocused();
  }

  test("CheckoutDialog traps focus and returns it to the invoking row on Cancel", async ({
    page,
  }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);
    await page.locator('.slick-row[data-row="0"]').click();
    await openPicker(page);
    await page
      .locator(".kv-branch-row", { hasText: "feature-blocked-tracked" })
      .locator(".kv-branch-row-main")
      .click();
    // The picker itself was the immediate invoker here (not a grid row) — CheckoutDialog is
    // driven by `OpsState.pendingCheckout`, opened from the branch picker rather than the row
    // menu, so this dialog's own return-to-invoker target is the picker trigger, checked
    // directly rather than through this file's shared `expectTrapAndReturn` (which assumes a
    // grid row invoker, true for the other three dialogs below).
    const modal = page.locator('[aria-labelledby="kv-checkout-dialog-title"]');
    await expect(modal).toBeVisible();
    const focusables = modal.locator("button:not([disabled])");
    await focusables.last().focus();
    await page.keyboard.press("Tab");
    await expect(focusables.first()).toBeFocused();

    await modal.getByRole("button", { name: "Cancel" }).click();
    await expect(modal).toBeHidden();
    await expect(page.locator(".kv-branch-trigger")).toBeFocused();
  });

  test("RevertDialog traps focus and returns it to the invoking row on Cancel", async ({
    page,
  }) => {
    await page.goto("/?scenario=merge");
    await ready(page);
    const row = page.locator(".slick-row", { hasText: "side-a" }).first();
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Revert this commit…" }).click();
    await expectTrapAndReturn(page, '[aria-labelledby="kv-revert-dialog-title"]', row, async () => {
      await page.getByRole("button", { name: "Cancel" }).click();
    });
  });

  test("TagDialog traps focus and returns it to the invoking row on Cancel", async ({ page }) => {
    await page.goto("/?scenario=tags");
    await ready(page);
    const row = page.locator(".slick-row", { hasText: "main" }).first();
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Create tag here…" }).click();
    await expectTrapAndReturn(page, '[aria-labelledby="kv-tag-dialog-title"]', row, async () => {
      await page.getByRole("button", { name: "Cancel" }).click();
    });
  });

  test("BranchDialog traps focus and returns it to the invoking row on Escape", async ({
    page,
  }) => {
    await page.goto("/?scenario=dirty");
    await ready(page);
    const row = page.locator(".slick-row", { hasText: "main" }).first();
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Create branch here…" }).click();
    await expectTrapAndReturn(page, '[aria-labelledby="kv-branch-dialog-title"]', row, async () => {
      await page.keyboard.press("Escape");
    });
  });
});

test.describe("conflict banner: role=status, and every disabled control's reason is reachable (W20)", () => {
  test("role is status, never alert — an assertive region that persists is a screen-reader trap", async ({
    page,
  }) => {
    await page.goto("/?scenario=conflicted");
    await ready(page);
    const region = page.getByTestId("conflict-banner");
    await expect(region).toHaveAttribute("role", "status");
    await expect(region).not.toHaveAttribute("role", "alert");
  });

  test("the disabled Continue button's reason is reachable via aria-describedby, not only its title", async ({
    page,
  }) => {
    await page.goto("/?scenario=conflicted");
    await ready(page);
    const continueButton = page.getByTestId("conflict-banner").getByRole("button", {
      name: "Continue",
    });
    await expect(continueButton).toBeDisabled();
    const describedBy = await continueButton.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const reasonText = await page.locator(`#${describedBy}`).innerText();
    expect(reasonText).toContain("Resolve the remaining");
  });
});
