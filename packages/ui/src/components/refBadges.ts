/**
 * `docs/plans/P4.md` W7: pure DOM-builder functions for the ref badges shown inline at the start
 * of the message cell (§6.2) — not a Vue SFC, because a SlickGrid formatter is synchronous and
 * mounting a component per badge per row would mean a Vue app instance and lifecycle per badge,
 * created and torn down as rows scroll, orders of magnitude more expensive than the badges
 * themselves for nothing (§3.1's tree update: `RefBadge.vue` → `refBadges.ts`). The same reasoning
 * applies to `columns.ts`'s other formatters and to W8's graph column: nothing inside a grid row
 * is a Vue component.
 *
 * The single source for "is this row a stash" is `DecorationRef`'s `stash` kind
 * (`store.decorationAt(row)`, `packages/git/src/parse/log.ts`'s `parseDecorationToken`) — never a
 * second heuristic over the subject line, which an ordinary commit could coincidentally match.
 * W8's graph-column stash node shape reads the exact same decoration, so the two never disagree.
 *
 * Split deliberately in two: `badgeSpecFor`/`planBadges` are pure functions over data (no DOM),
 * unit-tested directly below in `tests/unit/ui/refBadges.test.ts`; `buildRefBadges` and its
 * private `build*Element` helpers touch `document` and so, per this repo's own W6 precedent (no
 * jsdom/happy-dom is wired into `bun:test` — confirmed, not assumed), are exercised only by
 * W13's Playwright pass rather than here.
 */
import type { DecorationRef } from "@kira-version/core";
import { BADGE_ICONS } from "../icons/index.ts";

/** §6.2: "a row with more than three badges collapses the overflow into a +N badge". */
const MAX_VISIBLE_BADGES = 3;

type BadgeShape = "pill" | "square";

export interface BadgeSpec {
  readonly shape: BadgeShape;
  readonly icon: string;
  /** Which `--kv-badge-*` token group this badge draws from — a CSS class, never a colour value
   *  read or computed here (B4: colours live only in the theme layer). */
  readonly colorClass: string;
  readonly text: string;
  readonly isCurrentBranch: boolean;
  readonly dashed: boolean;
  /** `docs/plans/P7.md` W14: set only for `branch`/`remoteBranch` — the two kinds
   *  `CommitGrid.vue`'s ref-badge hit-test and `App.vue`'s ref context menu care about. A tag/HEAD
   *  badge has no review action and no rename/delete-from-the-graph menu, so it carries neither
   *  field — the hit-test's own `[data-ref-kind]` selector is exactly this distinction, made a DOM
   *  query rather than a second decoration check. `docs/plans/P9.md` W14 adds `"stash"`: a stash
   *  badge's own menu (`buildStashMenu`) needs the same hit-test seam, `refName` carrying
   *  `stash@{N}` rather than a ref name proper (there is no ref for anything but the top entry —
   *  see `parseDecorationToken`'s own doc comment). */
  readonly refKind: "branch" | "remoteBranch" | "stash" | undefined;
  readonly refName: string | undefined;
}

/** The text used both on the badge itself and in a `+N` overflow badge's title list — one
 *  function so the two never disagree about what a decoration is "called". Exhaustive over
 *  `DecorationRef["kind"]`: a new kind is a compile error here, not a silently-dropped badge. */
export function badgeSpecFor(ref: DecorationRef): BadgeSpec {
  switch (ref.kind) {
    case "branch":
      return {
        shape: "pill",
        icon: BADGE_ICONS.localBranch,
        colorClass: "kv-badge-local",
        text: ref.name,
        isCurrentBranch: ref.isHead,
        dashed: false,
        refKind: "branch",
        refName: ref.name,
      };
    case "remoteBranch":
      return {
        shape: "pill",
        icon: BADGE_ICONS.remoteBranch,
        colorClass: "kv-badge-remote",
        text: ref.name,
        isCurrentBranch: false,
        dashed: false,
        refKind: "remoteBranch",
        refName: ref.name,
      };
    case "tag":
      return {
        shape: "square",
        icon: BADGE_ICONS.tag,
        colorClass: "kv-badge-tag",
        text: ref.name,
        isCurrentBranch: false,
        dashed: false,
        refKind: undefined,
        refName: undefined,
      };
    case "stash":
      // P9 W14: `stash@{N}` — same text a `StashEntry`'s own `index` renders everywhere else
      // (`StashList.vue`, `StashDialog.vue`) — not the bare "stash" P4 shipped, which could not
      // say *which* stash a badge on a non-`stash@{0}` row (P9 W12's own graph walk) belonged to.
      return {
        shape: "square",
        icon: BADGE_ICONS.stash,
        colorClass: "kv-badge-stash",
        text: `stash@{${ref.index}}`,
        isCurrentBranch: false,
        dashed: true,
        refKind: "stash",
        refName: `stash@{${ref.index}}`,
      };
    case "head":
      // Detached HEAD: §6.2's table describes the filled dot as a modifier on the *branch*
      // badge, but a detached HEAD has no branch decoration alongside it to modify — this is
      // the one case the table's wording does not literally cover. It gets the same local-branch
      // pill and dot, with the literal text "HEAD" standing in for a branch name that does not
      // exist, rather than going undecorated (which would make a detached-HEAD commit visually
      // indistinguishable from an ordinary one — the opposite of what this column is for).
      return {
        shape: "pill",
        icon: BADGE_ICONS.localBranch,
        colorClass: "kv-badge-local",
        text: "HEAD",
        isCurrentBranch: true,
        dashed: false,
        refKind: undefined,
        refName: undefined,
      };
  }
}

export interface OverflowSpec {
  /** The `N` in "+N" — the *hidden* count, not the row's total decoration count. */
  readonly count: number;
  /** Names every decoration on the row, not just the hidden ones — "a row with six decorations
   *  renders three plus +3 and its title names all six" (§6.2's own "Done when" wording). */
  readonly title: string;
}

export interface BadgePlan {
  readonly visible: readonly BadgeSpec[];
  readonly overflow: OverflowSpec | null;
}

/** The pure "what to render" computation: which badges show, and what the overflow badge (if
 *  any) says — with no DOM touched, so this is what `tests/unit/ui/refBadges.test.ts` exercises
 *  directly. `buildRefBadges` below is a thin DOM-construction layer over this. */
export function planBadges(decorations: readonly DecorationRef[]): BadgePlan {
  const specs = decorations.map(badgeSpecFor);
  const visible = specs.slice(0, MAX_VISIBLE_BADGES);
  const overflow: OverflowSpec | null =
    specs.length > MAX_VISIBLE_BADGES
      ? {
          count: specs.length - MAX_VISIBLE_BADGES,
          title: specs.map((spec) => spec.text).join(", "),
        }
      : null;
  return { visible, overflow };
}

function buildBadgeElement(spec: BadgeSpec): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = `kv-badge kv-badge-${spec.shape} ${spec.colorClass}${spec.dashed ? " kv-badge-dashed" : ""}`;
  // The full name always lives in `title` (a mouse-hover affordance) independent of whether the
  // ~190px CSS truncation (kv-badge-label) actually clips this particular badge's text.
  badge.title = spec.text;

  // `docs/plans/P7.md` W14: the one seam `CommitGrid.vue`'s `handleContextMenu` hit-tests for
  // (`closest("[data-ref-kind]")`) — present only for `branch`/`remoteBranch` (see `BadgeSpec`'s
  // own doc comment on why a tag/stash/HEAD badge carries neither).
  if (spec.refKind !== undefined && spec.refName !== undefined) {
    badge.dataset.refKind = spec.refKind;
    badge.dataset.refName = spec.refName;
  }

  const icon = document.createElement("span");
  icon.className = `codicon ${spec.icon} kv-badge-icon`;
  // Decorative: the visible label text (or, for the overflow badge, its title) already carries
  // the information — see this file's module doc on "no colour/glyph-only meaning" (§7.9/W14).
  icon.setAttribute("aria-hidden", "true");
  badge.appendChild(icon);

  const label = document.createElement("span");
  label.className = "kv-badge-label";
  label.textContent = spec.text;
  badge.appendChild(label);

  if (spec.isCurrentBranch) {
    const dot = document.createElement("span");
    dot.className = "kv-badge-dot";
    // `role="img"` + `aria-label` is what makes a label on a plain, non-interactive `<span>`
    // reliably reach the accessibility tree — the dot is a second, non-text signal for "this is
    // the current branch" (§6.1's "no colour/shape-only meaning" also applies to HEAD itself),
    // read as part of the row rather than as a separate focusable control (§7's own "Done when").
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", "current branch");
    badge.appendChild(dot);
  }

  return badge;
}

function buildOverflowBadge(overflow: OverflowSpec): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = "kv-badge kv-badge-pill kv-badge-overflow";
  badge.title = overflow.title;
  badge.textContent = `+${overflow.count}`;
  return badge;
}

/**
 * Builds the inline badge strip for one row's decorations, or `null` for a row with none — the
 * caller (`columns.ts`'s `messageFormatter`) skips the wrapper element entirely in that case
 * rather than inserting an empty, non-contributing `<span>` into every one of the tens of
 * thousands of ordinary rows a full history walk can produce.
 */
export function buildRefBadges(decorations: readonly DecorationRef[]): HTMLSpanElement | null {
  if (decorations.length === 0) return null;

  const plan = planBadges(decorations);
  const container = document.createElement("span");
  container.className = "kv-ref-badges";

  for (const spec of plan.visible) container.appendChild(buildBadgeElement(spec));
  if (plan.overflow !== null) container.appendChild(buildOverflowBadge(plan.overflow));

  return container;
}
