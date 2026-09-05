import { expect, test } from "@playwright/test";

const THEME_KINDS = [
  "vscode-dark",
  "vscode-light",
  "vscode-high-contrast",
  "vscode-high-contrast-light",
] as const;

/** Mirrors `@kira-version/core`'s `DocumentRef` (`packages/core/src/ports/editorIntegration.ts`)
 *  and `apps/harness/src/mockBridge.ts`'s own `HarnessEditorAction` — reproduced structurally
 *  rather than imported, since `tests/` is not itself a bun workspace member (only `packages/*`
 *  and `apps/*` are, per the root `package.json`) and so has no `node_modules/@kira-version/*`
 *  symlink for `moduleResolution: "bundler"` to resolve, despite `tests/tsconfig.json` listing
 *  `packages/core` as a project *reference* (build-ordering only, not module resolution). Kept in
 *  sync by hand the same way this file's shape already tracks `window.__kiraHarness`'s real one. */
type HarnessDocumentRef =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "virtual"; readonly key: string; readonly label: string }
  | { readonly kind: "empty"; readonly label: string };

type HarnessEditorAction =
  | {
      readonly kind: "openDiff";
      readonly left: HarnessDocumentRef;
      readonly right: HarnessDocumentRef;
      readonly title: string;
    }
  | { readonly kind: "reveal"; readonly ref: HarnessDocumentRef; readonly line: number };

/** Mirrors `apps/harness/src/mockBridge.ts`'s own `OpRequest`/`OpResult` re-export shapes
 *  (`RecordedOp`/`RecordedUndo`) — reproduced structurally for the same reason
 *  `HarnessEditorAction` is above (P6 W19). Only the handful of `OpRequest` variants the new
 *  specs actually assert on are spelled out; the rest fall through the trailing member so this
 *  type never needs to track every field `contract.ts` adds to kinds no P6 spec touches. */
type HarnessOpRequest =
  | { readonly kind: "checkout"; readonly target: string; readonly mode: "switch" | "detach" }
  | {
      readonly kind: "branchCreate";
      readonly name: string;
      readonly startPoint: string;
      readonly checkout: boolean;
      readonly track: string | undefined;
    }
  | { readonly kind: "branchDelete"; readonly name: string; readonly force: boolean }
  | { readonly kind: "branchRename"; readonly from: string; readonly to: string }
  | {
      readonly kind: "tagCreate";
      readonly name: string;
      readonly target: string;
      readonly message: string | undefined;
      readonly force: boolean;
    }
  | { readonly kind: "tagDelete"; readonly name: string }
  | { readonly kind: "tagPush"; readonly remote: string; readonly names: readonly string[] | "all" }
  | { readonly kind: "tagDeleteRemote"; readonly remote: string; readonly name: string }
  | {
      readonly kind: "revert";
      readonly shas: readonly string[];
      readonly mainline: number | undefined;
      readonly noCommit: boolean;
    }
  | { readonly kind: "opContinue" }
  | { readonly kind: "opAbort" };

interface HarnessOpResult {
  readonly ok: boolean;
  readonly error: { readonly kind: string; readonly message: string } | undefined;
  readonly undo: { readonly id: string; readonly label: string; readonly recoverySha: string } | null;
}

declare global {
  interface Window {
    __kiraHarness: {
      setTheme(kind: (typeof THEME_KINDS)[number]): void;
      readTokens(): Record<string, string>;
      checkLayoutWorker(): Promise<boolean>;
      triggerRefsChanged(): void;
      /** P5 W12/W13: declared once, project-wide, here — `commitDetail.spec.ts` reads this
       *  without repeating the declaration, the same convention `commitList.spec.ts`'s own doc
       *  comment already states for this interface as a whole. */
      readonly lastEditorAction: HarnessEditorAction | undefined;
      /** P6 W19: declared once, project-wide, here — `refOps.spec.ts`/`undo.spec.ts` read this
       *  without repeating the declaration. */
      readonly lastOp: { readonly request: HarnessOpRequest; readonly result: HarnessOpResult } | undefined;
      /** P6 W19: ditto, for `undo.run`. */
      readonly lastUndo: { readonly id: string; readonly result: HarnessOpResult } | undefined;
      /** P6 W19: `conflictBanner.spec.ts`'s own hook — see `mockBridge.ts`'s
       *  `MockHandlers.resolveOneConflictedPath` doc comment. */
      resolveOneConflictedPath(): boolean;
    };
  }
}

test.describe("app shell", () => {
  test("renders its regions and reports a connected bridge", async ({ page }) => {
    await page.goto("/?scenario=clean");
    await expect(page.getByTestId("graph-region")).toBeVisible();
    await expect(page.getByTestId("detail-region")).toBeVisible();
    await expect(page.getByTestId("connection-state")).toHaveText("connected");
    // P4 W10/W11: the live-data strip's placeholder toolbar is gone — this is the real toolbar
    // (AppToolbar.vue), which owns only the repo picker and refresh for now (§6.2's scope
    // table; no search box until P10, so no `.codicon-search` to assert on any more).
    await expect(page.locator(".codicon-refresh")).toBeVisible();
    // The real list, replacing the deleted strip's `commit-count`/`repo-root` testids (P4 W11):
    // real rows exist and the first one's own content is visible.
    await expect(page.locator(".slick-row").first()).toBeVisible();
    await expect(page.locator(".kv-message-subject").first()).not.toBeEmpty();
    await expect(page.locator(".kv-cell-sha").first()).not.toBeEmpty();
    // `chunk-source` is the one strip testid kept — a real stream-chunk field (§5.4) with no
    // other visible surface, not a test hook.
    await expect(page.getByTestId("chunk-source")).toHaveText("git");
  });
});

test.describe("theming", () => {
  // P4 W1 narrowed `readTokens()` to the one thing JavaScript still needs as a number
  // (`--kv-row-height`, §6.1) — every colour token is now consumed purely through CSS classes
  // (W1, §3.4), so there is nothing left for readTokens() to report that a theme switch would
  // change; that claim moved to the visual baselines below instead. This just checks the bridge
  // itself reports what the cascade actually resolved, independent of theme.
  test("readTokens reports the live computed value of --kv-row-height", async ({ page }) => {
    await page.goto("/?scenario=clean&theme=vscode-dark");

    const readComputed = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--kv-row-height").trim(),
      );
    const readFromReader = () =>
      page.evaluate(() => window.__kiraHarness.readTokens()["--kv-row-height"]);

    expect(await readFromReader()).toBe(await readComputed());
  });

  for (const kind of THEME_KINDS) {
    test(`visual baseline: ${kind}`, async ({ page }) => {
      await page.goto(`/?scenario=clean&theme=${kind}`);
      await page.waitForSelector('[data-testid="connection-state"]');
      // W15: `connection-state` appears before the grid's own rows have been laid out — a real,
      // observed race (the same one `graph.spec.ts`'s own `ready()` documents), not a
      // hypothetical one. Without this, the screenshot below captures rows mid-construction —
      // still `position: static` for a frame before SlickGrid's row transforms apply — rather
      // than the settled state this baseline is meant to describe.
      await expect(page.locator('.slick-row[data-row="0"]')).toBeVisible();
      await expect(
        page.locator('.slick-row[data-row="0"] .kv-graph-svg circle.kv-node'),
      ).toHaveCount(1);
      await expect(page).toHaveScreenshot(`shell-${kind}.png`);
    });
  }
});
