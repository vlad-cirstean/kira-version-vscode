import { defineConfig, devices } from "@playwright/test";

/**
 * Two projects: `harness` drives `apps/harness` in a plain browser tab against a mock bridge
 * (fast, runs on every commit); `vscode` drives a downloaded VS Code build with the extension
 * installed (§8.4). A third project drove our own standalone desktop shell through P3 and was
 * retired along with it — see `docs/plans/P4b-remove-electron.md`.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: false,
  retries: 0,
  reporter: [["list"]],
  // P6a W7: a percentage tracks the machine instead of encoding this container's core count (a
  // hardcoded `4` would be wrong on anyone else's box). Measured on this 4-vCPU container, on
  // the pre-W5/W6 workload: 2 workers (Playwright's own default of half the logical CPUs) — 140.5s
  // wall, 263s of test CPU-time; 4 workers — 109.6s wall, 416s of CPU-time. Going 2→4 cut wall
  // time 22% but inflated total CPU-time 58% — this container saturates at 4 Chromium workers and
  // each test gets slower under the added contention. Re-measured post-W5/W6 (their ~92s of
  // CPU-time removed first, since that's worth more than the extra contention): see
  // docs/plans/P6a-test-perf.md's Findings for the numbers that decided this stays at "100%".
  workers: "100%",
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
    // From P3: Playwright driving a downloaded VS Code build with the extension installed.
    {
      name: "vscode",
      testMatch: "vscode/**/*.spec.ts",
    },
  ],
  // Stays at the config root rather than under the `harness` project: `@playwright/test@1.62.1`
  // (the version this repo pins) only declares `webServer` on the top-level `TestConfig`, not on
  // `TestProject` — confirmed by reading its own shipped `types/test.d.ts`, which has no
  // `webServer` member on any project-shaped interface. It only ever starts a server the
  // `vscode` project doesn't reach (it doesn't load `http://localhost:5173`), so this is the
  // closest correct equivalent to W15's "move it under harness" instruction until a Playwright
  // version that supports per-project `webServer` is pinned.
  //
  // P6a W5: serves the *built* app (`vite build` then `vite preview`), not the dev server. Every
  // fresh browser context under `vite dev` pulled the unbundled ES module graph one file at a
  // time — measured at 585-695ms and 159 requests per boot; the built app measured 278-313ms and
  // 5 requests, ≈315ms × 182 tests ≈ 57s of CPU-time saved, against a one-off build cost of
  // ~1s. `reuseExistingServer: true` still means a developer holding a server open opts out of
  // rebuilding — set KIRA_PLAYWRIGHT_DEV_SERVER=1 to fall back to `vite dev` for a spec you're
  // actively iterating on against HMR.
  webServer: {
    command: process.env.KIRA_PLAYWRIGHT_DEV_SERVER
      ? "bun run --filter '@kira-version/harness' dev"
      : "bun run --filter '@kira-version/harness' build && bun run --filter '@kira-version/harness' preview",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
