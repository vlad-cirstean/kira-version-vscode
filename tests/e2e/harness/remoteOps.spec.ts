import { expect, type Page, test } from "@playwright/test";

/**
 * `docs/plans/P8.md` W21: fetch/pull/push/force-push driven through `AppToolbar.vue`,
 * `PullStrategyPicker.vue` and `ForcePushDialog.vue`'s own `data-testid`s (W17), asserted on
 * `window.__kiraHarness.lastRemoteOp` — the wire-level `RemoteOpParams` the UI actually sent and
 * the `RemoteOpResult` it got back — the same "argv contract" convention `refOps.spec.ts` and
 * `undo.spec.ts` already use for `op.run`/`undo.run` (see `mockBridge.ts`'s own `RecordedRemoteOp`
 * doc comment for why the mock's pull/push outcomes are a simplified stand-in, not real git
 * plumbing: that is P8's own integration suite's job).
 *
 * Three scenarios (`./remoteOps.ts`'s own doc comment explains why they are separate rather than
 * one scenario a test switches branches inside of): `remoteOps` (main, ahead 1/behind 0),
 * `remoteOpsPull` (feature-behind, ahead 0/behind 2), `remoteOpsDiverged` (feature-diverged,
 * ahead 1/behind 1, not a protected-branch pattern).
 */

async function ready(page: Page): Promise<void> {
  await page.getByTestId("connection-state").waitFor();
}

test.describe("fetch", () => {
  test("runs against the default remote and announces success", async ({ page }) => {
    await page.goto("/?scenario=remoteOps");
    await ready(page);

    await page.getByTestId("fetch-button").click();

    // `.click()` only resolves once the DOM event is dispatched — `doFetch` is async and is not
    // awaited by the template's `@click` binding, so reading `lastRemoteOp` right after the click
    // would race the in-flight `remote.run` round trip. Waiting on the live region first (an
    // auto-retrying assertion, set only once `#runRemote` resolves) gives the round trip time to
    // finish before the plain, non-retrying `page.evaluate()` below takes its snapshot.
    await expect(page.getByTestId("live-announcements")).toHaveText("Fetched origin");
    const lastRemoteOp = await page.evaluate(() => window.__kiraHarness.lastRemoteOp);
    expect(lastRemoteOp?.request).toMatchObject({ kind: "fetch", remote: "origin" });
    expect(lastRemoteOp?.result.ok).toBe(true);
  });
});

test.describe("push", () => {
  test("a plain push on the checked-out branch is never gated, even on a protected branch", async ({
    page,
  }) => {
    await page.goto("/?scenario=remoteOps");
    await ready(page);

    await page.getByTestId("push-button").click();

    await expect(page.getByTestId("live-announcements")).toHaveText("Pushed main to origin");
    const lastRemoteOp = await page.evaluate(() => window.__kiraHarness.lastRemoteOp);
    expect(lastRemoteOp?.request).toMatchObject({
      kind: "push",
      remote: "origin",
      branch: "main",
      setUpstream: false,
    });
    expect(lastRemoteOp?.result.ok).toBe(true);
    expect(lastRemoteOp?.result.updates).toEqual([
      expect.objectContaining({ ref: "origin/main", forced: false }),
    ]);
  });

  test("rejects a non-fast-forward push with NonFastForward, offering fetch rather than force", async ({
    page,
  }) => {
    await page.goto("/?scenario=remoteOpsDiverged");
    await ready(page);

    await page.getByTestId("push-button").click();

    await expect(page.getByTestId("live-announcements")).toHaveText(
      "Push failed — not a fast-forward.",
    );
    const lastRemoteOp = await page.evaluate(() => window.__kiraHarness.lastRemoteOp);
    expect(lastRemoteOp?.request).toMatchObject({ kind: "push", branch: "feature-diverged" });
    expect(lastRemoteOp?.result.ok).toBe(false);
    expect(lastRemoteOp?.result.error?.kind).toBe("NonFastForward");
  });
});

test.describe("pull", () => {
  test("the default strategy is resolved and shown before it runs", async ({ page }) => {
    await page.goto("/?scenario=remoteOpsPull");
    await ready(page);

    await page.getByTestId("pull-strategy-trigger").click();
    const defaultRow = page.getByTestId("pull-strategy-default");
    await expect(defaultRow).toContainText("Fast-forward only");
    await expect(defaultRow).toContainText("kira-version default");

    await defaultRow.click();

    await expect(page.getByTestId("live-announcements")).toHaveText(
      "Pulled origin/feature-behind (ff-only)",
    );
    const lastRemoteOp = await page.evaluate(() => window.__kiraHarness.lastRemoteOp);
    expect(lastRemoteOp?.request).toMatchObject({
      kind: "pull",
      remote: "origin",
      branch: "feature-behind",
      strategy: "ff-only",
    });
    expect(lastRemoteOp?.result.ok).toBe(true);
  });

  test("an explicit strategy picked from the popover is sent verbatim", async ({ page }) => {
    await page.goto("/?scenario=remoteOpsPull");
    await ready(page);

    await page.getByTestId("pull-strategy-trigger").click();
    await page.getByTestId("pull-strategy-rebase").click();

    await expect(page.getByTestId("live-announcements")).toHaveText(
      "Pulled origin/feature-behind (rebase)",
    );
    const lastRemoteOp = await page.evaluate(() => window.__kiraHarness.lastRemoteOp);
    expect(lastRemoteOp?.request).toMatchObject({ kind: "pull", strategy: "rebase" });
  });
});

test.describe("force push", () => {
  test("a protected branch requires typing the branch name before the lease route enables", async ({
    page,
  }) => {
    await page.goto("/?scenario=remoteOps");
    await ready(page);

    await page.getByTestId("push-overflow-trigger").click();
    await page.getByTestId("force-push-trigger").click();

    const confirmLease = page.getByTestId("force-push-confirm-lease");
    const branchInput = page.getByTestId("force-push-confirm-branch");
    await expect(branchInput).toBeVisible();
    await expect(confirmLease).toBeDisabled();

    await branchInput.fill("not-main");
    await expect(confirmLease).toBeDisabled();

    await branchInput.fill("main");
    await expect(confirmLease).toBeEnabled();
    await confirmLease.click();

    const lastRemoteOp = await page.evaluate(() => window.__kiraHarness.lastRemoteOp);
    expect(lastRemoteOp?.request).toMatchObject({
      kind: "forcePush",
      branch: "main",
      confirmToken: "main",
      plainForce: false,
    });
    expect(lastRemoteOp?.result.ok).toBe(true);
  });

  test("cancelling leaves the branch untouched and records no remote op", async ({ page }) => {
    await page.goto("/?scenario=remoteOps");
    await ready(page);

    await page.getByTestId("push-overflow-trigger").click();
    await page.getByTestId("force-push-trigger").click();
    await expect(page.getByTestId("force-push-confirm-branch")).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByTestId("force-push-confirm-branch")).toBeHidden();
    expect(await page.evaluate(() => window.__kiraHarness.lastRemoteOp)).toBeUndefined();
    await expect(page.getByTestId("live-announcements")).toHaveText("Force push cancelled.");
  });

  test("a non-protected branch skips the typed-name field entirely", async ({ page }) => {
    await page.goto("/?scenario=remoteOpsDiverged");
    await ready(page);

    await page.getByTestId("push-overflow-trigger").click();
    await page.getByTestId("force-push-trigger").click();

    await expect(page.getByTestId("force-push-confirm-branch")).toHaveCount(0);
    const confirmLease = page.getByTestId("force-push-confirm-lease");
    await expect(confirmLease).toBeEnabled();
    await confirmLease.click();

    const lastRemoteOp = await page.evaluate(() => window.__kiraHarness.lastRemoteOp);
    expect(lastRemoteOp?.request).toMatchObject({
      kind: "forcePush",
      branch: "feature-diverged",
      confirmToken: undefined,
      plainForce: false,
    });
    expect(lastRemoteOp?.result.ok).toBe(true);
  });

  test("the plain --force route stays disabled until the extra acknowledgement is checked", async ({
    page,
  }) => {
    await page.goto("/?scenario=remoteOpsDiverged");
    await ready(page);

    await page.getByTestId("push-overflow-trigger").click();
    await page.getByTestId("force-push-trigger").click();

    await page.getByText("Use plain --force instead").click();
    const confirmPlain = page.getByTestId("force-push-confirm-plain");
    await expect(confirmPlain).toBeDisabled();

    await page.getByTestId("force-push-plain-ack").check();
    await expect(confirmPlain).toBeEnabled();
    await confirmPlain.click();

    const lastRemoteOp = await page.evaluate(() => window.__kiraHarness.lastRemoteOp);
    expect(lastRemoteOp?.request).toMatchObject({ kind: "forcePush", plainForce: true });
    expect(lastRemoteOp?.result.ok).toBe(true);
  });
});
