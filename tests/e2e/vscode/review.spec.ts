import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { branchy, type GeneratedBranchyRepo } from "../support/generateRepo.ts";

/**
 * `docs/plans/P7.md` W20 — the VS Code e2e tier for the review sidebar (§6.8), beside
 * `panel.spec.ts` and reusing its own launch/command-palette machinery (`launchVSCode`,
 * `runCommand`, `startsWithLabel`) rather than re-deriving it; see that file's own doc comment
 * for the environment realities (Xvfb, `--user-data-dir` socket-path length, the workspace-trust
 * dialog) this file inherits unchanged.
 *
 * **Entry point.** `review.spec.ts` (the harness tier, P7 W16) already pins that both of §6.8's
 * entry points — the branch picker's own row menu and a graph ref badge's context menu — send the
 * identical `review.open` request; this file drives the ref-badge one, since it is the one that
 * proves something the palette's bare `Kira Version: Review Branch Changes` command (§6.8/D40,
 * `reviewBranch(undefined, undefined)`) cannot: a real `repoId`+`branch` reaching
 * `RepoService.resolveReviewBase` end to end, with no in-view branch picker for this spec to
 * drive on top of a real Electron window.
 *
 * **Locating the review webview.** `panelView.ts`'s webview lives in the bottom *panel*
 * (`viewsContainers.panel`); `reviewView.ts`'s lives in the primary *side bar*
 * (`viewsContainers.activitybar`, §"Two things a future reader may be tempted to fix" in
 * `reviewView.ts`'s own doc comment) — once both are open at once (this file's whole point),
 * `panel.spec.ts`'s own unscoped `iframe.webview.ready` locator would match both and hit
 * Playwright's strict-mode check. `.part.panel`/`.part.sidebar` are VS Code workbench's own
 * top-level layout part classes (stable across recent versions, unlike a view's `aria-label`
 * text which is themeable/localizable) — scoping each frame lookup to its own part is what keeps
 * this file's locators unambiguous with both webviews live simultaneously.
 */

const EXTENSION_DEVELOPMENT_PATH = resolve(process.cwd(), "packages", "host-vscode");

/** `panel.spec.ts`'s own `launchVSCode`, verbatim apart from the repo type — see that file's own
 *  doc comment for why every one of these flags/env vars is here. Not imported from that file:
 *  Playwright collects `vscode/**\/*.spec.ts` as independent top-level specs, and duplicating an
 *  eleven-line function reads more honestly here than a cross-spec-file import would. */
async function launchVSCode(repo: GeneratedBranchyRepo): Promise<ElectronApplication> {
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
      "--disable-workspace-trust",
      "--password-store=basic",
      repo.dir,
    ],
    env: { ...process.env, KIRA_REPO: repo.dir },
  });
}

function startsWithLabel(text: string): RegExp {
  return new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
}

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

async function typeAndAccept(page: Page, text: string): Promise<void> {
  const input = page.locator(".quick-input-widget input");
  await page.keyboard.type(text);
  const row = page.locator(".quick-input-widget .monaco-list-row", { hasText: text });
  await row.first().waitFor();
  await row.first().click();
  await input.waitFor({ state: "hidden" });
}

function graphFrame(page: Page) {
  return page.frameLocator(".part.panel iframe.webview.ready").frameLocator("#active-frame");
}

function reviewFrame(page: Page) {
  return page.frameLocator(".part.sidebar iframe.webview.ready").frameLocator("#active-frame");
}

async function openPanel(page: Page): Promise<void> {
  await page.locator(".monaco-workbench").waitFor();
  await page.locator(".monaco-workbench").click({ position: { x: 5, y: 5 } });
  await runCommand(page, "View: Toggle Panel");
  await runCommand(page, "Kira Version: Focus Graph");
  await graphFrame(page).getByTestId("connection-state").waitFor();
}

/** Right-clicks the `feature` branch's own ref badge in the graph and picks "Review branch
 *  changes" — `review.spec.ts`'s (harness) own "one pixel to the side" test already pins the
 *  badge's own selector (`[data-ref-name="<branch>"]`) and the menu's own accessible role. */
async function reviewBranchFromGraph(page: Page, branch: string): Promise<void> {
  const frame = graphFrame(page);
  const row = frame
    .locator(".slick-row")
    .filter({ has: frame.locator(`[data-ref-name="${branch}"]`) });
  const badge = row.locator(`[data-ref-name="${branch}"]`);
  await badge.click({ button: "right" });
  const menu = frame.locator('[role="menu"]');
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Review branch changes" }).click();
}

test.describe("vscode review sidebar", () => {
  // Serial for the same reason `panel.spec.ts` is (P4c): concurrent real VS Code windows under
  // Xvfb (no window manager) fight over input focus.
  test.describe.configure({ mode: "serial" });

  test("resolves in its own activity-bar container and paints real rows from a real repository", async () => {
    const repo = branchy({ mainCommits: 3, featureCommits: 2 });
    const app = await launchVSCode(repo);

    try {
      const page = await app.firstWindow();
      await openPanel(page);
      await reviewBranchFromGraph(page, "feature");

      const frame = reviewFrame(page);
      await frame.getByTestId("connection-state").waitFor();
      await expect(frame.getByTestId("review-branch-name")).toHaveText("feature");
      // "main" is this repo's own default branch (§6.8 rule 2/3 — no upstream, no origin/HEAD,
      // "main" is the first `kiraVersion.review.baseCandidates` member) and its own two commits
      // ahead: real content crossed the wire, not merely that the webview exists (P15 W9's own
      // precedent, restated in this plan section's own text).
      await expect(frame.locator(".kv-review-commit-count")).toHaveText("2 commits");

      const rows = frame.locator(".kv-review-row");
      await expect(rows).toHaveCount(2);
      // review.spec.ts's own (harness) newest-first convention: row 0 is the branch's own tip.
      await expect(rows.nth(0)).toContainText("feature commit 1");
      await expect(rows.nth(1)).toContainText("feature commit 0");
    } finally {
      await app.close();
    }
  });

  test("hiding the review sidebar never disturbs the graph panel", async () => {
    const repo = branchy({ mainCommits: 3, featureCommits: 2 });
    const app = await launchVSCode(repo);

    try {
      const page = await app.firstWindow();
      await openPanel(page);
      const graph = graphFrame(page);
      // `expectAllRowsLoaded`'s own scroll-to-bottom trick isn't needed here — this repo is small
      // enough that its own row 0 already proves the grid painted; what this test actually cares
      // about is that this state is *unchanged* by the sidebar's own hide, not that every row of
      // it loaded.
      await expect(graph.locator('.slick-row[data-row="0"]')).toBeVisible();
      const graphSubjectBefore = await graph.locator(".kv-message-subject").first().textContent();

      await reviewBranchFromGraph(page, "feature");
      await reviewFrame(page).getByTestId("connection-state").waitFor();

      // The `setUiVisible` trap this plan section names: closing the sidebar the review view
      // lives in must never look, to the panel's own `RepoService` session, like the *panel*
      // itself was hidden (which would arm eviction / pause its watcher for a repo the panel
      // still has fully visible and in active use).
      await runCommand(page, "View: Close Primary Side Bar");

      await expect(graph.locator('.slick-row[data-row="0"]')).toBeVisible();
      await expect(graph.locator(".kv-message-subject").first()).toHaveText(
        graphSubjectBefore ?? "",
      );
      await expect(graph.getByTestId("connection-state")).toHaveText("connected");
    } finally {
      await app.close();
    }
  });

  test("hiding and re-revealing the review view re-resolves and re-walks from scratch", async () => {
    const repo = branchy({ mainCommits: 3, featureCommits: 2 });
    const app = await launchVSCode(repo);

    try {
      const page = await app.firstWindow();
      await openPanel(page);
      await reviewBranchFromGraph(page, "feature");
      const frame = reviewFrame(page);
      await frame.getByTestId("connection-state").waitFor();
      await expect(frame.locator(".kv-review-row")).toHaveCount(2);

      await runCommand(page, "View: Close Primary Side Bar");
      // `reviewView.ts`'s own doc comment, D38: "when the sidebar is hidden and the webview
      // disposed, the session is simply gone" — there is no cache for this reveal to replay from
      // the way the panel's own hide/reveal (`panel.spec.ts`'s own "rehydrates from cache" test)
      // has one. Unlike that test, this file does not need a `chunk-source`/cache-vs-git signal
      // to prove freshness: content correctly reappearing at all *is* the proof, since nothing
      // here could have survived to be replayed instead.
      await runCommand(page, "View: Open View...");
      await typeAndAccept(page, "Branch Review");

      const revealed = reviewFrame(page);
      await revealed.getByTestId("connection-state").waitFor();
      await expect(revealed.getByTestId("review-branch-name")).toHaveText("feature");
      await expect(revealed.locator(".kv-review-row")).toHaveCount(2);
      await expect(revealed.locator(".kv-review-row").first()).toContainText("feature commit 1");
    } finally {
      await app.close();
    }
  });

  test("'Go to file' from a review diff, on a branch not checked out, opens the virtual document", async () => {
    const repo = branchy({ mainCommits: 3, featureCommits: 2 });
    const app = await launchVSCode(repo);

    try {
      const page = await app.firstWindow();
      await openPanel(page);
      await reviewBranchFromGraph(page, "feature");
      const frame = reviewFrame(page);
      await frame.getByTestId("connection-state").waitFor();

      // `feature` was left un-checked-out by `branchy()` (its own doc comment) — real VS Code's
      // own working tree is genuinely on `main` for the whole of this test, exactly the case the
      // plan names.
      const row = frame.locator(".kv-review-row", { hasText: "feature commit 0" });
      await row.locator(".kv-review-row-subject").click();
      const fileRow = frame.locator(".kv-file-tree-row", { hasText: "feat0.ts" });
      await fileRow.click();

      const diffView = frame.getByTestId("diff-view");
      // `feat0.ts` is a brand-new file in this commit (`branchy()`'s own construction) — a pure
      // addition renders as the single synthetic "new <path>" row, `review.spec.ts`'s (harness)
      // own "Go to file" test's exact precedent for the equivalent fixture commit.
      await expect(diffView.locator(".kv-diff-path")).toHaveText("feat0.ts");
      await diffView.locator(".kv-diff-row", { hasText: "new feat0.ts" }).click();
      await diffView.getByRole("button", { name: "Go to file" }).click();

      // `VsCodeEditorIntegration.reveal` (P5 W5) opens a real editor tab for a
      // `kira-version:/<key>/feat0.ts` virtual document — VS Code names editor tabs by the URI's
      // own last path segment, so this repo's real, un-checked-out `feat0.ts` is what a person
      // would actually see appear in their own tab bar.
      await expect(page.locator(".tab", { hasText: "feat0.ts" })).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
