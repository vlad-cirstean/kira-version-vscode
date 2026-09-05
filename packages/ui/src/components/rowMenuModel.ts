/**
 * `docs/plans/P6.md` W14: `RowContextMenu.vue`'s pure half. What is present, what is absent, and
 * what is present-but-disabled-with-a-reason is exactly the thing a later phase edits (§10's
 * exit table grows this same menu at P9/P10), so it lives as one testable table
 * (`buildRowMenu`/`buildRefMenu`) rather than template `v-if` conditionals.
 */
import { canRunOp, describeInProgress } from "@kira-version/core";
import type { DecorationRef, InProgressOperation, OpRequest, RefKind } from "@kira-version/ipc";

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  /** §7.11: "disabled with the banner's reason as the tooltip" — an accessible description, not
   *  merely a hover-only `title` (`RowContextMenu.vue` wires this to `aria-describedby`). */
  readonly disabledReason: string | undefined;
}

export interface MenuSection {
  readonly items: readonly MenuItem[];
}

function gatedItem(
  id: string,
  label: string,
  opKind: OpRequest["kind"],
  inProgress: InProgressOperation | null,
): MenuItem {
  const allowed = canRunOp(inProgress, opKind);
  return {
    id,
    label,
    disabled: !allowed,
    disabledReason: allowed || inProgress === null ? undefined : describeInProgress(inProgress),
  };
}

function plainItem(id: string, label: string): MenuItem {
  return { id, label, disabled: false, disabledReason: undefined };
}

export interface CommitMenuContext {
  readonly sha: string;
  readonly decorations: readonly DecorationRef[];
  readonly inProgress: InProgressOperation | null;
  readonly clipboardEnabled: boolean;
}

/**
 * §6.4's per-commit menu, against the phase's own table: checkout (detached, gated same as the
 * picker's own checkout — §7.11 is scoped to the op kind, not to where it was invoked from),
 * create branch/tag here (never gated — git does not refuse either mid-op), revert this commit
 * (gated). Cherry-pick and reset are open question 2/absent-by-plan — not rendered disabled,
 * simply not items at all, so a disabled entry never implies "coming later in this same menu".
 * Copy sha/copy message reuse P5's `clipboardActions.ts` and are absent (not disabled) when the
 * host has no clipboard port, matching `FileTree.vue`'s own `actions.capabilities.clipboard` gate.
 */
export function buildRowMenu(ctx: CommitMenuContext): MenuSection[] {
  const mutating: MenuItem[] = [
    gatedItem(
      "checkoutDetached",
      "Checkout this commit (detached HEAD)",
      "checkout",
      ctx.inProgress,
    ),
    plainItem("createBranchHere", "Create branch here…"),
    plainItem("createTagHere", "Create tag here…"),
    gatedItem("revertThisCommit", "Revert this commit…", "revert", ctx.inProgress),
  ];
  const sections: MenuSection[] = [{ items: mutating }];
  if (ctx.clipboardEnabled) {
    sections.push({
      items: [plainItem("copySha", "Copy SHA"), plainItem("copyMessage", "Copy commit message")],
    });
  }
  return sections;
}

export interface RefMenuContext {
  readonly kind: RefKind;
  readonly shortName: string;
  readonly isHead: boolean;
  /** Set (a remote name) when a lightweight/annotated tag also exists on that remote — the delete
   *  entry's own asymmetry warning (§7.9: deleting locally does not delete on the remote) is
   *  worded differently depending on whether this is even reachable for this tag. */
  readonly knownRemotes: readonly string[];
  readonly inProgress: InProgressOperation | null;
}

/**
 * §6.6's "every mutating action is available from a context menu on the row it applies to", read
 * literally for a ref: the row a branch/tag operation applies to is the ref itself (the picker's
 * own row, or — once wired — the graph's own ref badge), not the commit it happens to point at.
 * Branch: checkout/rename/delete. Tag: checkout/delete/push/delete-on-remote (the last two only
 * where a remote is actually known — P6 has no `remotes.list` endpoint of its own, so
 * `knownRemotes` is derived from the already-loaded `remoteBranches` list rather than a second
 * round trip; see `remoteNamesFrom` below).
 */
export function buildRefMenu(ctx: RefMenuContext): MenuSection[] {
  if (ctx.kind === "tag") {
    const items: MenuItem[] = [
      gatedItem("checkoutRef", "Checkout", "checkout", ctx.inProgress),
      gatedItem("deleteRef", "Delete tag", "tagDelete", ctx.inProgress),
    ];
    for (const remote of ctx.knownRemotes) {
      items.push(plainItem(`pushRef:${remote}`, `Push to ${remote}`));
      items.push(plainItem(`deleteRemoteRef:${remote}`, `Delete on ${remote}`));
    }
    return [{ items }];
  }
  // branch or remoteBranch — a remote-tracking ref itself is read-only here (its only action is
  // the checkout the picker's row already offers); rename/delete apply to a local branch only.
  if (ctx.kind === "remoteBranch") {
    return [{ items: [gatedItem("checkoutRef", "Checkout", "checkout", ctx.inProgress)] }];
  }
  const items: MenuItem[] = [
    gatedItem("checkoutRef", "Checkout", "checkout", ctx.inProgress),
    plainItem("renameRef", "Rename branch…"),
  ];
  // git refuses to delete the branch you are currently on — not one of §7.11's gated op kinds
  // (the gate is scoped to what an in-progress *operation* blocks), so this is its own, simpler
  // disablement with its own reason.
  items.push(
    ctx.isHead
      ? {
          id: "deleteRef",
          label: "Delete branch",
          disabled: true,
          disabledReason: "This is the current branch.",
        }
      : gatedItem("deleteRef", "Delete branch", "branchDelete", ctx.inProgress),
  );
  return [{ items }];
}

/** Distinct remote names implied by an already-loaded `remoteBranches` list (`origin/main` →
 *  `origin`) — see `buildRefMenu`'s own doc comment on why this stands in for a `remotes.list`
 *  endpoint P6 does not have. */
export function remoteNamesFrom(remoteBranchNames: readonly string[]): string[] {
  const names = new Set<string>();
  for (const name of remoteBranchNames) {
    const slash = name.indexOf("/");
    if (slash > 0) names.add(name.slice(0, slash));
  }
  return [...names].sort();
}
