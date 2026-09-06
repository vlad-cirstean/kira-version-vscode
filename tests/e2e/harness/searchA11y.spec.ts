import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P11.md` W20 — the accessibility pass over §7.8's own two new surfaces: the search
 * box itself (a combobox, per `SearchBox.vue`'s own doc comment on the ARIA combobox pattern it
 * follows) and its open, grouped dropdown, both scanned in the theme sweep `refsA11y.spec.ts`
 * already establishes (that file's own doc comment on `FULL_SCAN_THEME`/`COLOR_ONLY_DISABLED_RULES`
 * — reproduced identically here, this project's convention of each spec file staying
 * self-contained). Beyond the axe scans themselves, a `describe` block below covers what a scan
 * cannot see on its own: the combobox's `aria-activedescendant`/`aria-expanded` contract, and the
 * inline error's `aria-describedby` wiring.
 */

const THEME_KINDS = [
  "vscode-dark",
  "vscode-light",
  "vscode-high-contrast",
  "vscode-high-contrast-light",
] as const;

const FULL_SCAN_THEME: (typeof THEME_KINDS)[number] = "vscode-dark";
const COLOR_ONLY_DISABLED_RULES = ["color-contrast-enhanced"];

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
  await expect(page.locator('.slick-row[data-row="0"]')).toBeVisible();
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

test.describe("axe: search box & dropdown, no serious/critical violations", () => {
  for (const kind of THEME_KINDS) {
    test(`empty search box: ${kind} (${scanLabel(kind)})`, async ({ page }) => {
      await page.goto(`/?scenario=search&theme=${kind}`);
      await ready(page);
      expect(await unexpectedSeriousViolations(page, kind)).toEqual([]);
    });

    test(`open dropdown, both groups populated: ${kind} (${scanLabel(kind)})`, async ({ page }) => {
      await page.goto(`/?scenario=search&theme=${kind}`);
      await ready(page);
      await page.getByTestId("search-input").fill("release");
      await expect(page.getByTestId("search-results")).toBeVisible();
      expect(await unexpectedSeriousViolations(page, kind)).toEqual([]);
    });

    test(`inline regex error: ${kind} (${scanLabel(kind)})`, async ({ page }) => {
      await page.goto(`/?scenario=search&theme=${kind}`);
      await ready(page);
      await page.getByTestId("search-toggle-regex").click();
      await page.getByTestId("search-input").fill("wid(get");
      await expect(page.getByTestId("search-error")).toBeVisible();
      expect(await unexpectedSeriousViolations(page, kind)).toEqual([]);
    });
  }
});

test.describe("the combobox contract: aria-expanded, aria-activedescendant, and the error's aria-describedby (W20)", () => {
  test("aria-expanded tracks the dropdown, aria-activedescendant tracks the arrowed-to option", async ({
    page,
  }) => {
    await page.goto("/?scenario=search");
    await ready(page);
    const input = page.getByTestId("search-input");
    await expect(input).toHaveAttribute("aria-expanded", "false");
    await expect(input).not.toHaveAttribute("aria-activedescendant", /.+/);

    await input.fill("widget");
    await expect(input).toHaveAttribute("aria-expanded", "true");
    await expect(input).not.toHaveAttribute("aria-activedescendant", /.+/);

    await page.keyboard.press("ArrowDown");
    const activeId = await input.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    // Ref-based option ids embed a refname (e.g. "kv-search-option-ref-refs/tags/v1.0.0"), whose
    // literal "/" breaks an unescaped `#id` CSS selector — an attribute-equals selector doesn't
    // parse the id as CSS at all. The id genuinely names the highlighted option, not a dangling
    // reference.
    await expect(page.locator(`[id="${activeId}"]`)).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Escape");
    await expect(input).toHaveAttribute("aria-expanded", "false");
  });

  test("an invalid pattern's error is reachable via aria-describedby, not only visually", async ({
    page,
  }) => {
    await page.goto("/?scenario=search");
    await ready(page);
    const input = page.getByTestId("search-input");
    await page.getByTestId("search-toggle-regex").click();
    await input.fill("wid(get");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    const describedBy = await input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const reasonText = await page.locator(`#${describedBy}`).innerText();
    expect(reasonText.trim().length).toBeGreaterThan(0);
  });
});
