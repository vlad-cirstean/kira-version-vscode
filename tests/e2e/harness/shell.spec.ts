import { expect, test } from "@playwright/test";

const THEME_KINDS = [
  "vscode-dark",
  "vscode-light",
  "vscode-high-contrast",
  "vscode-high-contrast-light",
] as const;

declare global {
  interface Window {
    __kiraHarness: {
      setTheme(kind: (typeof THEME_KINDS)[number]): void;
      readTokens(): Record<string, string>;
    };
  }
}

test.describe("app shell", () => {
  test("renders its regions and reports a connected bridge", async ({ page }) => {
    await page.goto("/?scenario=clean");
    await expect(page.getByTestId("graph-region")).toBeVisible();
    await expect(page.getByTestId("detail-region")).toBeVisible();
    await expect(page.getByTestId("connection-state")).toHaveText("connected");
    await expect(page.locator(".codicon-refresh")).toBeVisible();
    await expect(page.locator(".codicon-search")).toBeVisible();
  });
});

test.describe("theming", () => {
  test("switching theme kind changes both the computed token and what readTokens reports", async ({
    page,
  }) => {
    await page.goto("/?scenario=clean&theme=vscode-dark");

    const readComputed = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--kv-app-bg").trim(),
      );
    const readFromReader = () =>
      page.evaluate(() => window.__kiraHarness.readTokens()["--kv-app-bg"]);

    const darkComputed = await readComputed();
    const darkFromReader = await readFromReader();
    expect(darkComputed).toBe(darkFromReader);

    await page.evaluate(() => window.__kiraHarness.setTheme("vscode-light"));
    // TokenReader re-reads via a MutationObserver on <body>'s class/style attributes, which
    // fires asynchronously — poll rather than assume a synchronous update.
    await expect.poll(() => readFromReader()).not.toBe(darkFromReader);

    const lightComputed = await readComputed();
    const lightFromReader = await readFromReader();
    expect(lightComputed).toBe(lightFromReader);
    expect(lightComputed).not.toBe(darkComputed);
  });

  for (const kind of THEME_KINDS) {
    test(`visual baseline: ${kind}`, async ({ page }) => {
      await page.goto(`/?scenario=clean&theme=${kind}`);
      await page.waitForSelector('[data-testid="connection-state"]');
      await expect(page).toHaveScreenshot(`shell-${kind}.png`);
    });
  }
});
