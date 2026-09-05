import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P5.md` W13 — the interaction suite for the commit-detail pane (message, file tree,
 * diff view, "Go to file", copy actions, feature detection, breakpoints), exercised against the
 * harness's `mockBridge.ts` (P5 W12). Visual regression is `graph.spec.ts`'s job; this file never
 * screenshots, matching `commitList.spec.ts`'s own precedent for the graph side of the pane.
 */

// `Window.__kiraHarness`'s ambient type (including `lastEditorAction`) is declared once,
// project-wide, in `shell.spec.ts` — see that file's own comment on why this file does not
// repeat it.

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
}

// Mirrors `commitList.spec.ts`'s own `rowByIndex` and its doc comment on why a row must be
// targeted by its stable `data-row` attribute rather than DOM position.
function rowByIndex(page: Page, index: number): ReturnType<Page["locator"]> {
  return page.locator(`.slick-row[data-row="${index}"]`);
}

function fileRow(page: Page, name: string): ReturnType<Page["locator"]> {
  return page.locator(".kv-file-tree-row", { hasText: name });
}

async function lastEditorAction(page: Page): Promise<unknown> {
  return page.evaluate(() => window.__kiraHarness.lastEditorAction);
}

const liveAnnouncement = (page: Page) => page.getByTestId("live-announcements");

/** What `document.activeElement` actually is — mirrors `commitList.spec.ts`'s own `FocusInfo`/
 *  `focusInfo`/`tabUntil` (that file's own doc comment explains why a predicate-driven `Tab` walk
 *  is used instead of a hard-coded stop count), with `id` added since this pane's own roving
 *  cursor identifies its tabbable row by id (`FileTree.vue`'s `rowId`), not by class alone. */
interface FocusInfo {
  tag: string;
  id: string;
  classList: string[];
}

async function focusInfo(page: Page): Promise<FocusInfo> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName.toLowerCase() ?? "",
      id: el?.id ?? "",
      classList: el ? Array.from(el.classList) : [],
    };
  });
}

async function tabUntil(
  page: Page,
  predicate: (info: FocusInfo) => boolean,
  maxPresses = 25,
): Promise<void> {
  for (let i = 0; i < maxPresses; i++) {
    if (predicate(await focusInfo(page))) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`tabUntil: condition not met within ${maxPresses} Tab presses`);
}

test.describe("commit meta: message, trailers, timestamps, refs, signature, parents", () => {
  test("selecting the tip commit populates every field, with the trailer paragraph absent from the body", async ({
    page,
  }) => {
    await page.goto("/?scenario=detail");
    await ready(page);
    // `detail.ts`'s own topology: "manyFiles" (row 0, the 5,000-file commit) is newest, "tip"
    // (row 1) is the eight-file-kind workhorse, "root" (row 2) is its parent.
    await rowByIndex(page, 1).click();

    const detail = page.getByTestId("detail-region");
    await expect(detail.locator(".kv-meta-subject")).toHaveText("tip");

    const body = detail.locator(".kv-meta-body");
    await expect(body).toContainText("Implements the commit-detail pane's fixture data.");
    await expect(body).toContainText("Covers every file-change kind and diff body shape");
    // §6.4: the trailer paragraph is parsed out of the body and shown as trailers, not repeated
    // inline — asserting its absence here is what "deleting the trailer split" (W1) would break.
    await expect(body).not.toContainText("Reviewed-by");
    await expect(body).not.toContainText("Fixes");

    const trailers = detail.locator(".kv-meta-trailers");
    await expect(trailers.locator("dt")).toHaveText(["Reviewed-by", "Fixes"]);
    await expect(trailers).toContainText("Ada Lovelace");
    await expect(trailers).toContainText("#42");

    const details = detail.locator(".kv-meta-details");
    await expect(details).toContainText("Good signature by Ada Lovelace <ada@example.com>");
    // Same identity, same timestamp for author/committer (`topology()`'s own single `identity`
    // object) — only one row, no separate "Committer" row.
    await expect(details.getByText("Committer", { exact: true })).toHaveCount(0);

    // Refs: `main`/HEAD moved to `manyFiles` in `detail.ts` (see its own doc comment) — "tip"
    // keeps only its tag.
    await expect(details.locator(".kv-meta-refs")).toContainText("v1.0.0");

    // Parent: one button, the root commit's short sha, enabled (it is loaded — only 3 commits).
    const parentButton = details.locator(".kv-meta-parent");
    await expect(parentButton).toHaveCount(1);
    await expect(parentButton).toBeEnabled();
  });

  test("clicking a parent commit's sha selects its row and updates the pane", async ({ page }) => {
    await page.goto("/?scenario=detail");
    await ready(page);
    await rowByIndex(page, 1).click(); // tip
    const detail = page.getByTestId("detail-region");
    await detail.locator(".kv-meta-parent").click();

    await expect(rowByIndex(page, 2)).toHaveClass(/kv-row-selected/); // root
    await expect(detail.locator(".kv-meta-subject")).toHaveText("root");
  });
});

test.describe("file tree: statuses, directory counts, tree/flat, filter, render cap", () => {
  test("every status kind renders its letter and its own additions/deletions", async ({ page }) => {
    await page.goto("/?scenario=detail");
    await ready(page);
    await rowByIndex(page, 1).click();

    const cases: readonly [name: string, letter: string, additions: string, deletions: string][] = [
      ["added.ts", "A", "+12", "-0"],
      ["modified.ts", "M", "+5", "-3"],
      ["deleted.ts", "D", "+0", "-20"],
      ["copied-new.ts", "C", "+0", "-0"],
      ["large-asset.bin", "A", "+3", "-0"],
      ["huge.log", "M", "+50000", "-1"],
    ];
    for (const [name, letter, additions, deletions] of cases) {
      const row = fileRow(page, name);
      await expect(row.locator(".kv-file-tree-status")).toHaveText(letter);
      await expect(row.locator(".kv-diff-added-fg")).toHaveText(additions);
      await expect(row.locator(".kv-diff-deleted-fg")).toHaveText(deletions);
    }

    // The rename: letter R, both the old and new basenames shown, no raw counts assertion needed
    // beyond the letter — `fileTreeModel.test.ts` already exhaustively covers `renameDisplay`.
    const renamed = fileRow(page, "renamed-new.ts");
    await expect(renamed.locator(".kv-file-tree-status")).toHaveText("R");
    await expect(renamed).toContainText("renamed-old.ts");
    await expect(renamed).toContainText("renamed-new.ts");

    // The binary file shows no +/- counts at all (§6.4/W7: additions/deletions are meaningless
    // for a binary diff).
    const binary = fileRow(page, "image.png");
    await expect(binary.locator(".kv-file-tree-status")).toHaveText("M");
    await expect(binary.locator(".kv-file-tree-counts")).toHaveCount(0);
  });

  test("directory rows carry the summed counts of their children", async ({ page }) => {
    await page.goto("/?scenario=detail");
    await ready(page);
    await rowByIndex(page, 1).click();

    const srcDir = page.locator(".kv-file-tree-row", {
      has: page.locator(".kv-file-tree-dir-name", { hasText: /^src$/ }),
    });
    await expect(srcDir.locator(".kv-file-tree-dir-stats")).toContainText("5 files");
    await expect(srcDir.locator(".kv-diff-added-fg")).toHaveText("+21");
    await expect(srcDir.locator(".kv-diff-deleted-fg")).toHaveText("-25");

    const assetsDir = page.locator(".kv-file-tree-row", {
      has: page.locator(".kv-file-tree-dir-name", { hasText: /^assets$/ }),
    });
    await expect(assetsDir.locator(".kv-file-tree-dir-stats")).toContainText("2 files");
    await expect(assetsDir.locator(".kv-diff-added-fg")).toHaveText("+3");
    await expect(assetsDir.locator(".kv-diff-deleted-fg")).toHaveText("-0");

    const logsDir = page.locator(".kv-file-tree-row", {
      has: page.locator(".kv-file-tree-dir-name", { hasText: /^logs$/ }),
    });
    // Singular "file" — `fileCount === 1`.
    await expect(logsDir.locator(".kv-file-tree-dir-stats")).toContainText("1 file");
    await expect(logsDir.locator(".kv-diff-added-fg")).toHaveText("+50000");
    await expect(logsDir.locator(".kv-diff-deleted-fg")).toHaveText("-1");
  });

  test("the tree/flat toggle and the filter narrow both modes identically", async ({ page }) => {
    await page.goto("/?scenario=detail");
    await ready(page);
    await rowByIndex(page, 1).click();
    const tree = page.getByTestId("file-tree");

    // Tree mode: 3 directories + 8 files = 11 rows.
    await expect(tree.locator(".kv-file-tree-row")).toHaveCount(11);

    await tree.getByRole("button", { name: "Flat" }).click();
    // Flat mode: files only, no directory rows.
    await expect(tree.locator(".kv-file-tree-row")).toHaveCount(8);

    await tree.locator(".kv-file-tree-filter").fill("asset");
    await expect(tree.locator(".kv-file-tree-row")).toHaveCount(2); // image.png, large-asset.bin

    await tree.getByRole("button", { name: "Tree" }).click();
    // Same filter, tree mode: the "assets" directory plus its two matching files.
    await expect(tree.locator(".kv-file-tree-row")).toHaveCount(3);
  });

  test("the 5,000-file commit renders the render cap plus its 'show all' row", async ({ page }) => {
    await page.goto("/?scenario=detail");
    await ready(page);
    await rowByIndex(page, 0).click(); // manyFiles
    const tree = page.getByTestId("file-tree");
    // Flat mode avoids the single collapsed directory row this scenario's one-path-chain would
    // otherwise add, so file-row counts below are exact.
    await tree.getByRole("button", { name: "Flat" }).click();

    await expect(tree.locator(".kv-file-tree-row")).toHaveCount(500); // FILE_TREE_ROW_CAP
    const showAll = tree.getByRole("button", { name: "Show all 5000 files" });
    await expect(showAll).toBeVisible();

    await showAll.click();
    await expect(tree.locator(".kv-file-tree-row")).toHaveCount(5000);
    await expect(tree.locator(".kv-file-tree-show-all")).toHaveCount(0);
  });
});

test.describe("diff view: opening, back, file-cursor sync, non-text bodies", () => {
  test("clicking a file opens the diff as the third region; the back affordance returns to the tree", async ({
    page,
  }) => {
    await page.goto("/?scenario=detail");
    await ready(page);
    await rowByIndex(page, 1).click();
    const tree = page.getByTestId("file-tree");
    const diffView = page.getByTestId("diff-view");

    await expect(tree).toBeVisible();
    await fileRow(page, "modified.ts").click();
    await expect(diffView).toBeVisible();
    await expect(tree).toBeHidden();
    await expect(diffView.locator(".kv-diff-path")).toHaveText("src/modified.ts");
    await expect(diffView.locator(".kv-diff-position")).toHaveText("2 of 8");

    await diffView.locator(".kv-diff-back").click();
    await expect(tree).toBeVisible();
    await expect(diffView).toBeHidden();
  });

  test("the diff follows the file cursor under ArrowDown while focus is in the tree, and Alt+ArrowUp/Down move files while focus is in the diff", async ({
    page,
  }) => {
    await page.goto("/?scenario=detail");
    await ready(page);
    await rowByIndex(page, 1).click();
    await fileRow(page, "modified.ts").click(); // opens the diff, sets the file cursor
    const diffView = page.getByTestId("diff-view");
    await expect(diffView.locator(".kv-diff-path")).toHaveText("src/modified.ts");

    await page.keyboard.press("Escape"); // back to the tree, cursor still on modified.ts
    await page.locator(".kv-file-tree-rows").focus();
    await page.keyboard.press("ArrowDown"); // next file alphabetically: renamed-new.ts
    await expect(diffView.locator(".kv-diff-path")).toHaveText("src/renamed-new.ts");

    await diffView.focus(); // the diff root itself is the `.kv-diff-view`/tabindex="0" element
    await page.keyboard.press("Alt+ArrowDown"); // next by original file order: copied-new.ts
    await expect(diffView.locator(".kv-diff-path")).toHaveText("src/copied-new.ts");
    await page.keyboard.press("Alt+ArrowUp");
    await expect(diffView.locator(".kv-diff-path")).toHaveText("src/renamed-new.ts");
  });

  test("binary and LFS files open their labelled row and no diff body; the over-cap file opens its own row", async ({
    page,
  }) => {
    await page.goto("/?scenario=detail");
    await ready(page);
    await rowByIndex(page, 1).click();
    const diffView = page.getByTestId("diff-view");

    await fileRow(page, "image.png").click();
    await expect(diffView.locator(".kv-diff-body")).toHaveCount(0);
    await expect(diffView.locator(".kv-diff-message")).toHaveText(
      "Binary file — not shown (10.0 KB → 20.0 KB)",
    );
    // §6.4/D14a: a binary blob can still be opened in the host's own diff, unlike LFS/too-large.
    await expect(diffView.getByRole("button", { name: "Open in editor" })).toBeVisible();
    await expect(diffView.getByRole("button", { name: "Go to file" })).toHaveCount(0);

    // DetailPane.vue's `mode==='diff'` fully unmounts the file tree (a `v-if`/`v-else-if` pair),
    // so the next file must be selected via the tree again after returning to it — there is no
    // way to click a second file row while the diff is showing.
    await diffView.locator(".kv-diff-back").click();
    await fileRow(page, "large-asset.bin").click();
    await expect(diffView.locator(".kv-diff-body")).toHaveCount(0);
    await expect(diffView.locator(".kv-diff-message")).toHaveText(
      "LFS object, not fetched — 100.0 MB",
    );
    await expect(diffView.getByRole("button", { name: "Open in editor" })).toHaveCount(0);
    await expect(diffView.getByRole("button", { name: "Go to file" })).toHaveCount(0);

    await diffView.locator(".kv-diff-back").click();
    await fileRow(page, "huge.log").click();
    await expect(diffView.locator(".kv-diff-body")).toHaveCount(0);
    await expect(diffView.locator(".kv-diff-message")).toHaveText(
      "File too large to display (6.0 MB, limit 5.0 MB)",
    );
    await expect(diffView.getByRole("button", { name: "Open in editor" })).toHaveCount(0);

    await diffView.locator(".kv-diff-back").click();
    await fileRow(page, "copied-new.ts").click();
    await expect(diffView.locator(".kv-diff-message")).toHaveText("No content change");
  });
});

test.describe("Esc closes the diff first and the pane second", () => {
  test("from focus inside the pane, and from focus on the grid", async ({ page }) => {
    await page.goto("/?scenario=detail");
    await ready(page);
    const detail = page.getByTestId("detail-region");
    const diffView = page.getByTestId("diff-view");

    // From the pane: the last click landed inside the tree, not the grid.
    await rowByIndex(page, 1).click();
    await fileRow(page, "modified.ts").click();
    await expect(diffView).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(diffView).toBeHidden();
    await expect(detail).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(detail).toBeHidden();

    // From the grid: reclaim DOM focus on the row (without re-toggling selection, which a second
    // *click* on an already-selected row would do — `commitList.spec.ts`'s own first test) and
    // repeat the same two-step chain.
    await rowByIndex(page, 1).click();
    await fileRow(page, "modified.ts").click();
    await expect(diffView).toBeVisible();
    await rowByIndex(page, 1).focus();
    await page.keyboard.press("Escape");
    await expect(diffView).toBeHidden();
    await expect(detail).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(detail).toBeHidden();
  });
});

test.describe("the merge parent selector", () => {
  test("defaults to parent 1 of 3; switching re-fetches the tree and resets the file selection", async ({
    page,
  }) => {
    await page.goto("/?scenario=merge");
    await ready(page);
    await rowByIndex(page, 0).click(); // the octopus merge commit
    const tree = page.getByTestId("file-tree");
    const select = page.locator("#kv-parent-select");

    await expect(select).toHaveValue("0");
    await expect(select.locator("option")).toHaveCount(3);
    await expect(fileRow(page, "a-only.ts")).toBeVisible();

    const diffView = page.getByTestId("diff-view");
    await fileRow(page, "a-only.ts").click();
    await expect(diffView).toBeVisible();
    // The parent `<select>` lives in `FileTree.vue`, unmounted while the diff is showing — back
    // to the tree first, the same as a real user would have to.
    await diffView.locator(".kv-diff-back").click();
    await expect(tree).toBeVisible();

    await select.selectOption("1");
    // "Leaves diff mode": switching does not reopen the diff for whatever `selectedFile` used to
    // point at (a-only.ts's index in the *previous* parent's file list means nothing here).
    await expect(diffView).toBeHidden();
    await expect(tree).toBeVisible();
    await expect(fileRow(page, "b-only.ts")).toBeVisible();
    await expect(fileRow(page, "a-only.ts")).toHaveCount(0);

    await select.selectOption("2");
    await expect(fileRow(page, "c-only.ts")).toBeVisible();
    await expect(fileRow(page, "b-only.ts")).toHaveCount(0);
  });
});

test.describe("'Go to file': the four-case matrix, the drift re-map, and the line map end to end", () => {
  test("a live file with drift re-maps its line; a live file with none is unshifted", async ({
    page,
  }) => {
    await page.goto("/?scenario=goToFile");
    await ready(page);
    await rowByIndex(page, 0).click(); // "tip", the only commit with files
    const diffView = page.getByTestId("diff-view");

    await fileRow(page, "live-with-drift.ts").click();
    await diffView.getByRole("button", { name: "Go to file" }).click();
    await expect(diffView.locator(".kv-diff-action-message")).toHaveText(
      "Opened live-with-drift.ts at line 55", // historical line 50 + the drift's 5-line insertion
    );
    await expect(liveAnnouncement(page)).toHaveText("Opened live-with-drift.ts at line 55");
    expect(await lastEditorAction(page)).toMatchObject({ kind: "reveal", line: 55 });

    await diffView.locator(".kv-diff-back").click();
    await fileRow(page, "live-no-drift.ts").click();
    await diffView.getByRole("button", { name: "Go to file" }).click();
    await expect(diffView.locator(".kv-diff-action-message")).toHaveText(
      "Opened live-no-drift.ts at line 1", // no `worktreeDrift` entry — unshifted
    );
    expect(await lastEditorAction(page)).toMatchObject({ kind: "reveal", line: 1 });
  });

  test("a path deleted, renamed or never-tracked since all resolve to the same virtual blob", async ({
    page,
  }) => {
    await page.goto("/?scenario=goToFile");
    await ready(page);
    await rowByIndex(page, 0).click();
    const diffView = page.getByTestId("diff-view");

    for (const path of ["deleted-since.ts", "renamed-since.ts", "not-ancestor.ts"]) {
      await fileRow(page, path).click();
      await diffView.getByRole("button", { name: "Go to file" }).click();
      await expect(diffView.locator(".kv-diff-action-message")).toContainText(
        "this path is not in your checkout",
      );
      expect(await lastEditorAction(page)).toMatchObject({
        kind: "reveal",
        ref: { kind: "virtual" },
      });
      await diffView.locator(".kv-diff-back").click();
    }
  });

  test("a path whose blob is missing entirely reports unavailable, with no editor action", async ({
    page,
  }) => {
    await page.goto("/?scenario=goToFile");
    await ready(page);
    expect(await lastEditorAction(page)).toBeUndefined();
    await rowByIndex(page, 0).click();
    const diffView = page.getByTestId("diff-view");

    await fileRow(page, "missing-blob.ts").click();
    await diffView.getByRole("button", { name: "Go to file" }).click();
    await expect(diffView.locator(".kv-diff-action-message")).toContainText("is not in");
    expect(await lastEditorAction(page)).toBeUndefined();
  });

  test("the line map end to end: a context, a deleted and an added row each resolve to a different, correct line", async ({
    page,
  }) => {
    await page.goto("/?scenario=detail");
    await ready(page);
    await rowByIndex(page, 1).click(); // tip
    await fileRow(page, "modified.ts").click();
    const diffView = page.getByTestId("diff-view");
    const goToFile = diffView.getByRole("button", { name: "Go to file" });

    // Context row, exact: "export function modified(): number {" is old line 1 / new line 1.
    await diffView.locator(".kv-diff-row", { hasText: "export function modified" }).click();
    await goToFile.click();
    expect(await lastEditorAction(page)).toMatchObject({ kind: "reveal", line: 1 });

    // Deleted row, backwards scan: both "const a = 1;" and "const b = 2;" have no new-side
    // number of their own — the nearest preceding row that does (the context row above, new
    // line 1) plus one is where the surviving text picks back up: new line 2.
    await diffView.locator(".kv-diff-row", { hasText: "const a = 1;" }).click();
    await goToFile.click();
    expect(await lastEditorAction(page)).toMatchObject({ kind: "reveal", line: 2 });

    // Added row, exact: "const b = 20;" carries its own new-side number, 3 — bypassing the map
    // and reading `newLine` directly would happen to also get this one right, which is exactly
    // why the context/deleted rows above are asserted too (`docs/plans/P5.md` W13's own words).
    await diffView.locator(".kv-diff-row", { hasText: "const b = 20;" }).click();
    await goToFile.click();
    expect(await lastEditorAction(page)).toMatchObject({ kind: "reveal", line: 3 });
  });
});

test.describe("copy actions", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("each of the four copy sites reports what it copied", async ({ page }) => {
    await page.goto("/?scenario=detail");
    await ready(page);
    await rowByIndex(page, 1).click();
    const detail = page.getByTestId("detail-region");

    await page.locator(".kv-cell-sha").first().click();
    await expect(liveAnnouncement(page)).toHaveText("Copied full SHA");

    await detail.locator(".kv-meta-message-header .kv-copy-button").click();
    await expect(liveAnnouncement(page)).toHaveText("Copied commit message");

    // `.kv-meta-sha-row` appears twice, in template order: full SHA first, short SHA second.
    const shaRows = detail.locator(".kv-meta-sha-row");
    await shaRows.nth(0).locator(".kv-copy-button").click();
    await expect(liveAnnouncement(page)).toHaveText("Copied full SHA");
    await shaRows.nth(1).locator(".kv-copy-button").click();
    await expect(liveAnnouncement(page)).toHaveText("Copied short SHA");

    await fileRow(page, "modified.ts").locator(".kv-file-tree-copy").click();
    await expect(liveAnnouncement(page)).toHaveText("Copied file path");
  });

  test("a rejected write shows the failure message", async ({ page }) => {
    await page.addInitScript(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
    });
    await page.goto("/?scenario=detail");
    await ready(page);
    await rowByIndex(page, 1).click();

    await page.locator(".kv-cell-sha").first().click();
    await expect(liveAnnouncement(page)).toHaveText("Couldn't copy — denied");
  });
});

test.describe("feature detection", () => {
  test("the noCapabilities scenario renders neither editor action nor the copy buttons, and nothing throws", async ({
    page,
  }) => {
    await page.goto("/?scenario=noCapabilities");
    await ready(page);
    await rowByIndex(page, 1).click(); // tip — same fixture data as `detail`
    const detail = page.getByTestId("detail-region");

    await expect(detail.locator(".kv-copy-button")).toHaveCount(0);
    await expect(detail.locator(".kv-file-tree-copy")).toHaveCount(0);

    // The grid's own sha button is disabled, not absent (`columns.ts`'s own doc comment).
    await expect(page.locator(".kv-cell-sha").first()).toBeDisabled();

    await fileRow(page, "modified.ts").click();
    const diffView = page.getByTestId("diff-view");
    await expect(diffView).toBeVisible();
    await expect(diffView.getByRole("button", { name: "Open in editor" })).toHaveCount(0);
    await expect(diffView.getByRole("button", { name: "Go to file" })).toHaveCount(0);
  });
});

test.describe("keyboard-only pass: the whole detail pane, start to finish", () => {
  // P5 W14's own "Done when": focus order is stated and *tested*, not merely arranged — entering
  // the pane lands on the file cursor, the diff's back affordance and both editor actions are
  // reachable, and leaving the diff by keyboard returns focus to the file it was showing.
  test("file cursor in by Tab, an arrow key opens a file's diff, the diff's own actions are reachable, and Escape returns focus to that same file", async ({
    page,
  }) => {
    await page.goto("/?scenario=detail");
    await ready(page);
    // Selecting the commit itself is the *grid's* own keyboard reachability —
    // `commitList.spec.ts`'s own dedicated "keyboard-only pass" already covers Tab-in from a blank
    // page to a row — out of scope for this file (this file's own header comment: it owns the
    // pane, not the grid). `.click()` to arrive at a populated pane is this file's own established
    // convention; every other test here does the same.
    await rowByIndex(page, 1).click(); // tip
    await rowByIndex(page, 1).focus(); // a known anchor to Tab forward from, into the pane

    // Entering the pane lands on the file cursor: the resize handle, the message section's own
    // copy button and the filter box are all real, legitimate tab stops ahead of it — none of them
    // un-skippable (`tabUntil`'s own doc comment on what "reachable" means, `commitList.spec.ts`).
    // Typing straight into the filter — still real keyboard input, reached along the same walk —
    // keeps the file this test lands on deterministic without hand-counting
    // `fileTreeModel.ts`'s own sort order across three directories.
    await tabUntil(page, (info) => info.classList.includes("kv-file-tree-filter"));
    await page.keyboard.type("modified");
    await expect(page.getByTestId("file-tree").locator(".kv-file-tree-row")).toHaveCount(2); // "src" + modified.ts

    await tabUntil(page, (info) => info.id.startsWith("kv-file-tree-row-"));
    const cursorOnDir = await focusInfo(page);
    expect(cursorOnDir.id).toBe("kv-file-tree-row-0"); // "src" — `focusedRow`'s untouched default

    // Arrow onto the file itself. Moving the cursor onto a file row opens its diff directly —
    // the same "the diff follows the file cursor under ArrowDown" behaviour the diff-view describe
    // block above already covers end to end (`FileTree.vue`'s `selectRow`: a file row's own
    // `emit("selectFile", ...)` fires from a plain cursor move, not only from `Enter`/a click) — so
    // this single keypress is what reaches the diff by keyboard here, with nothing further to press.
    await page.keyboard.press("ArrowDown");

    const diffView = page.getByTestId("diff-view");
    await expect(diffView).toBeVisible();
    await expect(diffView.locator(".kv-diff-path")).toHaveText("src/modified.ts");

    // The back affordance and both editor actions are reachable, in that order.
    await diffView.focus(); // the diff root itself is the `.kv-diff-view`/tabindex="0" element
    await tabUntil(page, (info) => info.classList.includes("kv-diff-back"));
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab"); // past the previous- and next-file nav buttons (both
    // enabled here — `modified.ts` is neither the first nor the last of the tip commit's 8 files)
    await expect(page.locator(":focus")).toHaveText("Open in editor");
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveText("Go to file");

    // Leaving the diff by keyboard (Escape — App.vue's document-level handler, reachable no
    // matter which element inside the diff currently holds focus) returns focus to the file it
    // was showing — the same row, not the top of the tree.
    await page.keyboard.press("Escape");
    await expect(diffView).toBeHidden();
    await expect(page.locator("#kv-file-tree-row-1")).toBeFocused();
  });
});

test.describe("the three breakpoints", () => {
  // Three independent `test()`s, each with its own fresh page/origin (Playwright's default) —
  // not one test looping `page.setViewportSize`/`page.goto` over a *shared* page, which would
  // carry `SessionStorageViewStateStore`'s persisted `detailOpen`/`selectedSha` from one
  // iteration's navigation into the next and make "click an already-selected row toggles the
  // pane closed" (`commitList.spec.ts`'s own first test) a real risk on the second/third pass.
  const CASES = [
    { name: "wide", width: 1000, docked: true },
    { name: "narrow", width: 750, docked: true },
    { name: "overlay", width: 480, docked: false },
  ] as const;

  for (const { name, width, docked } of CASES) {
    test(`breakpoint: ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 600 });
      await page.goto("/?scenario=detail");
      await ready(page);
      await rowByIndex(page, 1).click();
      const region = page.getByTestId("detail-region");
      await expect(region).toBeVisible();
      const widthBefore = (await region.boundingBox())?.width ?? 0;

      await fileRow(page, "modified.ts").click();
      await expect(page.getByTestId("diff-view")).toBeVisible();
      const widthAfter = (await region.boundingBox())?.width ?? 0;

      if (docked) {
        // "Takes over the docked pane": the diff replaces the tree in place, the region's own
        // width is unaffected.
        expect(Math.abs(widthAfter - widthBefore)).toBeLessThan(2);
      } else {
        // Overlay: the diff widens the drawer to the full viewport width (`.kv-detail-drawer--diff`).
        expect(widthAfter).toBeGreaterThan(widthBefore);
        expect(widthAfter).toBeGreaterThan(width - 10);
      }
    });
  }
});
