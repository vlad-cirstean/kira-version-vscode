import { describe, expect, test } from "bun:test";
import type { CheckoutPreflight } from "../../../packages/ipc/src/index.ts";
import {
  composeCheckoutAnnouncement,
  composeLoadMoreAnnouncement,
  composeOpFailureAnnouncement,
  composeRefreshAnnouncement,
  composeRevertAnnouncement,
  formatCount,
} from "../../../packages/ui/src/state/liveAnnouncements.ts";

describe("formatCount", () => {
  test("groups thousands", () => {
    expect(formatCount(122400)).toBe("122,400");
  });
});

describe("composeLoadMoreAnnouncement", () => {
  test("the plan's own worked example", () => {
    expect(composeLoadMoreAnnouncement(5000, 122400, false)).toBe(
      "5,000 more loaded, 122,400 remaining",
    );
  });

  test("exhausted reads as 'history fully loaded', not '0 remaining'", () => {
    expect(composeLoadMoreAnnouncement(400, 0, true)).toBe("400 more loaded, history fully loaded");
  });
});

describe("composeRefreshAnnouncement", () => {
  test("pluralizes 'commits' for anything but exactly one", () => {
    expect(composeRefreshAnnouncement(20000)).toBe("Refreshed — 20,000 commits loaded");
    expect(composeRefreshAnnouncement(0)).toBe("Refreshed — 0 commits loaded");
  });

  test("singular for exactly one commit", () => {
    expect(composeRefreshAnnouncement(1)).toBe("Refreshed — 1 commit loaded");
  });
});

function checkoutPreflight(overrides: Partial<CheckoutPreflight> = {}): CheckoutPreflight {
  return {
    target: { kind: "branch", name: "side" },
    detaches: false,
    createsTracking: undefined,
    carried: [],
    blockers: [],
    verdict: "clean",
    routes: [],
    ...overrides,
  };
}

describe("composeCheckoutAnnouncement", () => {
  test("clean: names the target with no further comment", () => {
    expect(composeCheckoutAnnouncement(checkoutPreflight(), "side")).toBe("Checked out side");
  });

  test("cleanCarry: names how many local changes carried, singular vs plural", () => {
    expect(
      composeCheckoutAnnouncement(
        checkoutPreflight({ verdict: "cleanCarry", carried: ["a.txt"] }),
        "side",
      ),
    ).toBe("Checked out side — 1 local change carried over");
    expect(
      composeCheckoutAnnouncement(
        checkoutPreflight({ verdict: "cleanCarry", carried: ["a.txt", "b.txt"] }),
        "side",
      ),
    ).toBe("Checked out side — 2 local changes carried over");
  });

  test("detaches: says so, and shortens a raw sha but not a branch/tag name", () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    expect(composeCheckoutAnnouncement(checkoutPreflight({ detaches: true }), sha)).toBe(
      "Checked out abcdef0 (detached)",
    );
    expect(composeCheckoutAnnouncement(checkoutPreflight({ detaches: true }), "v1.0")).toBe(
      "Checked out v1.0 (detached)",
    );
  });
});

describe("composeRevertAnnouncement", () => {
  test("a single revert names the (shortened) commit", () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    expect(composeRevertAnnouncement([sha], false)).toBe("Reverted commit abcdef0");
  });

  test("--no-commit says the change is staged, not committed", () => {
    const sha = "a".repeat(40);
    expect(composeRevertAnnouncement([sha], true)).toBe(
      "Reverted commit aaaaaaa — changes staged, not committed",
    );
  });

  test("a multi-sha revert names the count, not any one sha", () => {
    expect(composeRevertAnnouncement(["a".repeat(40), "b".repeat(40)], false)).toBe(
      "Reverted 2 commits",
    );
  });
});

describe("composeOpFailureAnnouncement", () => {
  test("names the action and the error's own reason", () => {
    expect(
      composeOpFailureAnnouncement("Checkout", { kind: "WorktreeConflict", message: "x" }),
    ).toBe("Checkout failed — checked out in another worktree.");
  });

  test("never silent when no error object is given at all", () => {
    expect(composeOpFailureAnnouncement("Checkout", undefined)).toBe("Checkout failed.");
  });
});
