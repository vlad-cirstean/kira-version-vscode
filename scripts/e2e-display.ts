#!/usr/bin/env bun
/**
 * P4c W3 — a display for `--project=vscode` on Linux, without a dependency.
 *
 * Playwright's own Electron launcher watches the child's stderr for "Unable to open X display"
 * and answers it with "Use 'xvfb-run' on Linux to launch your tests with an emulated display
 * server" — this container (headless, root, no `DISPLAY`) hits exactly that. `xvfb-run -a` is
 * this repo's established idiom for it (P3, the retired `electron` project).
 *
 * This is plumbing, not the "non-trivial infrastructure" `AGENTS.md`'s prefer-a-library rule is
 * aimed at — the packages that wrap `xvfb-run` (`xvfb-maybe` and friends) are unmaintained, and
 * a Playwright `globalSetup` can't be scoped to one project in the pinned `@playwright/test`
 * version, so it would start Xvfb for the `harness` project too, which needs no display. Twenty
 * lines of `spawn` here beats both.
 *
 * On macOS (or anywhere `DISPLAY` is already set, or `xvfb-run` isn't on `PATH`) this is a
 * straight passthrough to `playwright`, args untouched.
 */
import { spawnSync } from "node:child_process";

function commandExists(name: string): boolean {
  const result = spawnSync("command", ["-v", name], { shell: "/bin/sh" });
  return result.status === 0;
}

const args = process.argv.slice(2);
const needsXvfb = process.platform === "linux" && !process.env.DISPLAY && commandExists("xvfb-run");

const [command, commandArgs] = needsXvfb
  ? ["xvfb-run", ["-a", "bunx", "playwright", ...args]]
  : ["bunx", ["playwright", ...args]];

const result = spawnSync(command, commandArgs, { stdio: "inherit" });
if (result.error) {
  console.error(`e2e-display: failed to run '${command}': ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
