import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  _electron as electron,
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { type GeneratedRepo, linear } from "../support/generateRepo.ts";

/**
 * P3 W15 — the real VS Code host: a downloaded VS Code build launched with this repo's
 * extension loaded via `--extensionDevelopmentPath`, driven through Playwright via
 * `@vscode/test-electron`'s `_electron.launch` — VS Code's own Electron binary, a completely
 * different thing from the standalone Electron shell this package used to also ship and build
 * against, removed per `docs/plans/P4b-remove-electron.md`.
 *
 * There is no repo-picker UI yet (P4+), so `html.ts` threads `KIRA_REPO` through its bootstrap
 * island, rebuilt fresh on every `resolveWebviewView` (`html.ts`'s own doc comment explains why).
 *
 * There is no app-level theme setting to exercise from a VS Code settings command — v1 has none.
 * What VS Code genuinely owns is its own built-in colour theme, which `vscode-tokens.css` (W12)
 * keys the whole palette off — this file's theme test exercises exactly that, via
 * `workbench.action.selectTheme`, the same UI a person would use.
 *
 * **Environment reality (P4c, `docs/plans/P4c-linux-test-infra.md`).** This spec had never run on
 * any platform before that plan: `downloadAndUnzipVSCode()` was blocked here through P4b, and its
 * launch had a bug that could not have worked on any OS — see `launchVSCode()` below. Both are
 * fixed now. Run it with:
 *
 *   bun run build && bun run test:e2e:vscode
 *
 * which starts Xvfb itself on Linux (`scripts/e2e-display.ts`) and is a plain passthrough to
 * `playwright test --project=vscode` on macOS. macOS remains the platform D27 and §8.4 treat as
 * authoritative for the shipped extension; running headlessly on Linux is dev/test infra only
 * (P4c), not a support claim.
 *
 * `EXTENSION_DEVELOPMENT_PATH` resolves off `process.cwd()`, not `import.meta.url`: the pinned
 * `@playwright/test@1.62.1`'s own test-file transform cannot load a spec that references
 * `import.meta` at all (confirmed with a one-line repro file, independently of any binary being
 * reachable). `playwright.config.ts`'s `testDir` is already root-relative, so Playwright always
 * runs from the repo root.
 */

const EXTENSION_DEVELOPMENT_PATH = resolve(process.cwd(), "packages", "host-vscode");

/**
 * Launches VS Code's own Electron binary — not its `code` CLI wrapper script.
 *
 * `resolveCliArgsFromVSCodeExecutablePath()`'s first element is
 * `resolveCliPathFromVSCodeExecutablePath()`, which returns the `code` shell script (it re-execs
 * the real Electron with `ELECTRON_RUN_AS_NODE=1` running `out/cli.js`, launching the actual
 * window as a detached grandchild). Playwright's `_electron.launch` appends `--inspect=0` and
 * `--remote-debugging-port=0` and waits for both a "Debugger listening" and a "DevTools
 * listening" line on *that launched process's own* stderr — under the CLI wrapper those flags
 * land on the Node-mode `cli.js`, whose stdio is not the detached window's, so the wait can never
 * resolve. This cannot have worked on any platform. The fix: pass the real Electron executable
 * `downloadAndUnzipVSCode()` already returns as `executablePath`.
 *
 * VS Code's own root check (W5) still requires `--extensions-dir` and `--user-data-dir` — but
 * `resolveCliArgsFromVSCodeExecutablePath()`'s own default for these
 * (`getProfileArguments()`, rooted under `process.cwd()/.vscode-test`) is unusable in a deep
 * worktree checkout: VS Code derives a Unix-domain-socket path from `--user-data-dir` for its
 * single-instance lock, and that path silently exceeds the ~107-byte `sun_path` limit here,
 * producing `listen EINVAL` and a launch that never reaches a window (verified directly:
 * P4c's Findings record the exact path and length). A short, per-launch directory under
 * `os.tmpdir()` avoids that regardless of how deep the repo itself is checked out.
 */
async function launchVSCode(repo: GeneratedRepo): Promise<ElectronApplication> {
  const vscodeExecutablePath = await downloadAndUnzipVSCode();
  const profileDir = mkdtempSync(join(tmpdir(), "kira-vscode-profile-"));
  return electron.launch({
    executablePath: vscodeExecutablePath,
    args: [
      `--extensions-dir=${join(profileDir, "extensions")}`,
      `--user-data-dir=${join(profileDir, "user-data")}`,
      `--extensionDevelopmentPath=${EXTENSION_DEVELOPMENT_PATH}`,
      "--disable-extensions",
      "--skip-release-notes",
      "--skip-welcome",
      // A fresh --user-data-dir profile has never seen this folder before, so VS Code's
      // Workspace Trust feature pops a modal "Do you trust..." dialog that steals focus from
      // the workbench — confirmed live: it appears between the two `runCommand` calls in
      // `openPanel`, not at startup, so it silently swallows the second one's F1 (P4c). This
      // flag is the standard automation switch for exactly that (used by VS Code's own smoke
      // tests); it is not a security relaxation of the *extension* itself.
      "--disable-workspace-trust",
      // On Linux, Electron probes libsecret/gnome-keyring for its safe storage; with no D-Bus
      // session bus in this container that probe can stall the launch. Inert on macOS, so this
      // goes in the shared args rather than behind a platform branch.
      "--password-store=basic",
      repo.dir,
    ],
    env: { ...process.env, KIRA_REPO: repo.dir },
  });
  // No `--no-sandbox`, and `chromiumSandbox` is deliberately left unset: Playwright's own
  // Electron launcher already unshifts `--no-sandbox` on Linux unless `chromiumSandbox` is
  // truthy (`node_modules/playwright-core/lib/coreBundle.js`), so setting `chromiumSandbox: true`
  // is the one way to break this, and hand-rolling the flag ourselves would just read as though
  // it were required.
}

/** Matches `text` as a literal prefix (case-sensitive) of a quick-pick row's own label — used to
 *  pick the *intended* row out of several the palette's fuzzy filter accepts, rather than
 *  whichever one it ranks first. */
function startsWithLabel(text: string): RegExp {
  return new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
}

/** Drives VS Code's command palette exactly as a person would: open it, type a command's
 *  title, and accept it — there is no scriptable command-execution API from outside the
 *  extension host, so this is the only way in from a Playwright-driven window.
 *
 *  Clicking the row whose label starts with `title`, rather than pressing `Enter` on whatever
 *  the palette ranks first, is deliberate — confirmed live (P4c): typing `>Preferences: Color
 *  Theme` also fuzzy-matches `"Preferences: Browse Color Themes in Marketplace"`, and this build
 *  ranks that *above* the exact command, so blindly accepting the top row silently ran the wrong
 *  command (and its own quick pick then hangs forever on a network theme search that this
 *  sandbox can't reach). Matching the row by its own label, rather than by list position, is
 *  immune to however the palette happens to rank or reorder matches.
 *
 *  Waiting for the widget to actually close before returning is deliberate too, not cosmetic —
 *  confirmed live (P4c): without it, a second `runCommand` call's `F1` can land while the
 *  previous palette instance is still tearing down, and that second `F1` is silently swallowed
 *  (the next `input.fill` then times out waiting on an input that never (re)opens). Each call
 *  owning the full open-to-close lifecycle of its own palette instance avoids the race.
 *
 *  `awaitClose: false` is for the one command in this file that does not follow this lifecycle —
 *  `"Preferences: Color Theme"` does not close the widget on accept, it morphs the same widget
 *  into a *different* quick pick (the theme list) — confirmed live (P4c): waiting for `hidden`
 *  after it hangs forever. The caller is expected to keep driving that follow-up picker directly
 *  (see `typeAndAccept`) rather than issuing a fresh `F1`, so the open-palette race this default
 *  guards against does not apply there. */
async function runCommand(
  page: Page,
  title: string,
  { awaitClose = true }: { awaitClose?: boolean } = {},
): Promise<void> {
  await page.keyboard.press("F1");
  const input = page.locator(".quick-input-widget input");
  await input.waitFor({ state: "visible" });
  await input.fill(`>${title}`);
  const row = page.locator(".quick-input-widget .monaco-list-row", {
    hasText: startsWithLabel(title),
  });
  await row.first().waitFor();
  await row.first().click();
  if (awaitClose) await input.waitFor({ state: "hidden" });
}

/** VS Code nests a webview view's document two `iframe`s deep: the outer `iframe.webview.ready`
 *  (one per view, sandboxed) and, inside it, `#active-frame` (the document `html.ts` renders).
 *  Re-locating both on every call is deliberate — `resolveWebviewView` runs again on every
 *  hide/reveal (§2.1, no `retainContextWhenHidden`), which replaces both iframes' contents. */
function graphFrame(page: Page) {
  return page.frameLocator("iframe.webview.ready").frameLocator("#active-frame");
}

/** Types into an already-open quick pick (e.g. the theme list `runCommand(page, "Preferences:
 *  Color Theme")` opens) and accepts the match whose own label starts with `text` — the same
 *  match-the-row-by-its-label discipline `runCommand` applies to the command palette itself, and
 *  needed here for the same reason (P4c): accepting whatever row the list ranks first (rather
 *  than the row that actually matches) can select this picker's own live "Searching for
 *  themes…"/marketplace-search entry instead of the installed theme, which never resolves in this
 *  sandbox. Closing before the next quick pick's `F1`/keystrokes avoids the same teardown race
 *  `runCommand` documents. */
async function typeAndAccept(page: Page, text: string): Promise<void> {
  const input = page.locator(".quick-input-widget input");
  await page.keyboard.type(text);
  const row = page.locator(".quick-input-widget .monaco-list-row", { hasText: text });
  await row.first().waitFor();
  await row.first().click();
  await input.waitFor({ state: "hidden" });
}

/** `.slick-row` count is deliberately *not* the assertion here — the grid virtualizes rows
 *  (`tests/e2e/harness/commitList.spec.ts`'s own ".slick-row count stays bounded" test), and a
 *  real VS Code panel is short enough that even a 10-row repo does not fit in one screen's worth
 *  of virtualized rows (confirmed live: P4c). Scrolling the viewport to its end and checking the
 *  *last* row is what actually confirms every row arrived, matching how the harness suite itself
 *  already verifies a big scenario loaded rather than counting rendered DOM nodes. */
async function expectAllRowsLoaded(frame: ReturnType<typeof graphFrame>, rowCount: number) {
  await expect(frame.locator('.slick-row[data-row="0"]')).toBeVisible();
  // SlickGrid always renders all four top/bottom × left/right viewport panes (frozen-column
  // support), even though this grid uses neither — only the top-left one is sized and holds the
  // rendered rows (confirmed live: P4c), so `.first()` picks it deterministically rather than
  // the strict-mode violation an unqualified `.slick-viewport` locator hits here (the harness's
  // own precedent uses `document.querySelector`, which silently takes the first match the same
  // way, rather than Playwright's stricter locator `.evaluate`).
  await frame
    .locator(".kv-commit-grid .slick-viewport")
    .first()
    .evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  await expect(frame.locator(`.slick-row[data-row="${rowCount - 1}"]`)).toBeVisible();
}

async function openPanel(page: Page): Promise<void> {
  // Xvfb runs with no window manager, so nothing gives the freshly created BrowserWindow OS-level
  // input focus the instant `firstWindow()` resolves — confirmed live (P4c): the very first F1
  // this function sends is silently dropped without this, and every following wait times out on
  // a command palette that never opens. A real user's first action is a click into the window
  // anyway, so this click is also the thing that establishes focus.
  await page.locator(".monaco-workbench").waitFor();
  await page.locator(".monaco-workbench").click({ position: { x: 5, y: 5 } });
  await runCommand(page, "View: Toggle Panel");
  await runCommand(page, "Kira Version: Focus Graph");
  await graphFrame(page).getByTestId("connection-state").waitFor();
}

test.describe("vscode panel", () => {
  // Serial, not `fullyParallel`'s default — confirmed live (P4c): two of these tests' real VS
  // Code windows running at once under Xvfb (no window manager to separate them) fight over the
  // same input focus, so a keystroke meant for one window's command palette can land on the
  // other's instead, and the failure only shows up under >1 worker. Each test already launches
  // and tears down its own VS Code instance, so serializing them costs wall-clock time, not
  // coverage.
  test.describe.configure({ mode: "serial" });

  test("opens the panel and shows the generated repository's live values", async () => {
    const repo = linear(10);
    const app = await launchVSCode(repo);

    try {
      const page = await app.firstWindow();
      await openPanel(page);
      const frame = graphFrame(page);

      await expect(frame.getByTestId("connection-state")).toHaveText("connected");
      // P4 W11 deleted the live-data strip and its `repo-root`/`commit-count` testids — the real
      // list is the replacement.
      await expectAllRowsLoaded(frame, repo.commits.length);
      await expect(frame.locator(".kv-message-subject").first()).not.toBeEmpty();
      // Nothing is cached before this session's very first stream, so every row this load emits
      // comes from git.
      await expect(frame.getByTestId("chunk-source")).toHaveText("git");

      // P15 W9: a rendered grid with *some* text in it is not proof the seven `PackedCommitChunk`
      // columns actually crossed the real `WebviewView` boundary intact — a wrong `bufferEncoding`
      // (P15's W1 finding) would still paint a grid, just one with garbage or empty cells, and
      // `.not.toBeEmpty()` above would not catch that. `linear()`'s commits are in creation order
      // (oldest first); `git log`'s own default is newest first, so row 0 is the newest commit —
      // its own real sha (not just "a sha-shaped string") and its own real subject.
      const newestSha = repo.commits.at(-1);
      if (!newestSha) throw new Error("linear(10) produced no commits");
      // `expectAllRowsLoaded` just scrolled the viewport to its very bottom to prove the last row
      // arrived — SlickGrid virtualizes rows the same way in a real VS Code panel as it does in
      // the harness (`expectAllRowsLoaded`'s own doc comment), so on a repo this small that scroll
      // evicts row 0 from the DOM entirely. Scroll back to the top first so row 0 is actually
      // rendered again before asserting on its content.
      await frame
        .locator(".kv-commit-grid .slick-viewport")
        .first()
        .evaluate((el) => {
          el.scrollTop = 0;
        });
      const row0 = frame.locator('.slick-row[data-row="0"]');
      await expect(row0.locator(".kv-cell-sha")).toHaveText(newestSha.slice(0, 7));
      await expect(row0.locator(".kv-message-subject")).toHaveText(`commit ${repo.commits.length - 1}`);
    } finally {
      await app.close();
    }
  });

  test("hiding and revealing the panel rehydrates from cache, not git", async () => {
    const repo = linear(10);
    const app = await launchVSCode(repo);

    try {
      const page = await app.firstWindow();
      await openPanel(page);
      await expectAllRowsLoaded(graphFrame(page), repo.commits.length);

      // Closing and reopening the panel disposes and recreates the webview view (panelView.ts's
      // own doc comment: `retainContextWhenHidden` is deliberately off), which is exactly the
      // scenario §5.4's rehydration exists for — the RepoService's row cache outlives the
      // webview, only the webview's own JS heap is lost.
      await runCommand(page, "View: Toggle Panel");
      await runCommand(page, "View: Toggle Panel");
      await runCommand(page, "Kira Version: Focus Graph");
      const frame = graphFrame(page);

      // The toggle recreates the webview view from scratch (panelView.ts's own doc comment,
      // quoted above) — same as the very first `openPanel`, this new instance needs to finish
      // connecting before its grid has any rows to find.
      await frame.getByTestId("connection-state").waitFor();
      await expectAllRowsLoaded(frame, repo.commits.length);
      // The rehydration round trip replays every row the host still has cached — never a fresh
      // git read — so unlike the very first load, `chunk-source` must land on "cache".
      await expect(frame.getByTestId("chunk-source")).toHaveText("cache");
    } finally {
      await app.close();
    }
  });

  test("switching VS Code's own colour theme repaints the webview, with no reload", async () => {
    const repo = linear(3);
    const app = await launchVSCode(repo);

    try {
      const page = await app.firstWindow();
      await openPanel(page);
      const frame = graphFrame(page);
      const readAppBg = () =>
        frame
          .locator(".kv-app")
          .evaluate((el) => getComputedStyle(el).getPropertyValue("--kv-app-bg").trim());

      // This build's built-in theme labels are "Light Modern"/"Dark Modern" — no "Default "
      // prefix (confirmed live, P4c: `theme-defaults`'s own package.nls.json). The older
      // "Default Light/Dark Modern" names this test used to pass never match any installed
      // theme, so the picker falls through to its own live marketplace search, which never
      // resolves in this sandbox (no network) — exactly the hang `typeAndAccept`'s doc comment
      // describes.
      await runCommand(page, "Preferences: Color Theme", { awaitClose: false });
      await typeAndAccept(page, "Light Modern");
      const light = await readAppBg();

      await runCommand(page, "Preferences: Color Theme", { awaitClose: false });
      await typeAndAccept(page, "Dark Modern");

      await expect.poll(readAppBg).not.toBe(light);
      const dark = await readAppBg();
      expect(dark).not.toBe(light);
    } finally {
      await app.close();
    }
  });
});
