import { defineConfig, devices } from "@playwright/test";

/**
 * Three projects declared, only `harness` runnable in P0. Declaring all three now means P3
 * wires a host into an existing slot rather than inventing test infrastructure while also
 * writing a host (§8.4).
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    viewport: { width: 1000, height: 500 },
    // Screenshot comparison needs a stable environment (W8); reduced motion removes the
    // ~100ms transitions VS Code itself uses (§6.1) from the render.
    reducedMotion: "reduce",
    launchOptions: {
      // Unset by default: `bunx playwright install` puts the browser where Playwright
      // expects it. Only set this if you're pointing at a browser installed out-of-band
      // (e.g. a shared cache whose revision doesn't match this pinned Playwright version).
      executablePath: process.env.KIRA_PLAYWRIGHT_CHROMIUM_PATH,
    },
  },
  expect: {
    toHaveScreenshot: {
      // Tolerant enough to absorb font rasterisation differences between machines, not to
      // hide a real regression.
      maxDiffPixelRatio: 0.02,
    },
  },
  projects: [
    {
      name: "harness",
      // Glob (relative to testDir), not a substring regex: this repo's own directory name
      // contains "vscode", which a naive /vscode\/.../ regex against absolute paths would
      // false-positive-match — every harness spec would also run under the vscode project.
      testMatch: "harness/**/*.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:5173" },
    },
    // From P3: Playwright driving the Electron host via _electron.launch.
    {
      name: "electron",
      testMatch: "electron/**/*.spec.ts",
    },
    // From P3: Playwright driving a downloaded VS Code build with the extension installed.
    {
      name: "vscode",
      testMatch: "vscode/**/*.spec.ts",
    },
  ],
  webServer: {
    command: "bun run --filter '@kira-version/harness' dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
