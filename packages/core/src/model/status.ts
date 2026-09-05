/**
 * `git status --porcelain=v2 --branch -z` (§4.4), as a discriminated union of its five record
 * kinds plus the `#` branch header. `UnmergedEntry` — the `u` record — is defined in
 * `conflict.ts` instead of here, since it is exactly the shape §7.5/§7.6's conflict handling
 * needs and this avoids a second, divergent definition later.
 *
 * `summarizeStatus` (P6/W8) is the pure fold from one `StatusResult` (plus the in-progress
 * record `git/src/ops/conflict.ts` reads separately) into the wire-shaped `StatusSummary` —
 * counts, an uncapped dirty-path list, and `head` derived from the branch header rather than a
 * third rev-parse/symbolic-ref spawn (`status --branch` already carries everything
 * `resolveHeadState` in `discovery.ts` would otherwise re-derive). `dirtyPathsFrom` is the
 * sibling fold used for pre-flight (`core/src/preflight/checkout.ts`'s `dirty` input), kept
 * separate because pre-flight needs `tracked`/`untracked` discrimination per path and
 * `StatusSummary` needs only a flat display list — two different shapes over the same entries,
 * not one shape serving both badly.
 */
import type { InProgressOperation } from "./operation.ts";
import type { HeadState } from "./repo.ts";
import type { UnmergedEntry } from "./conflict.ts";

/** X or Y position of the XY status code. `.` means unmodified in that position. */
export type FileStatusCode = "." | "M" | "T" | "A" | "D" | "R" | "C" | "U";

export interface StatusBranchInfo {
  /** Undefined for an unborn branch (`git init` with no commits yet). */
  readonly oid: string | undefined;
  readonly head: { readonly kind: "branch"; readonly name: string } | { readonly kind: "detached" };
  readonly upstream: string | undefined;
  readonly ahead: number | undefined;
  readonly behind: number | undefined;
}

interface StatusEntryBase {
  readonly staged: FileStatusCode;
  readonly unstaged: FileStatusCode;
  /** Raw 4-char submodule state field (e.g. `N...`, `S.C.`); no deeper modelling in P1. */
  readonly submodule: string;
  readonly path: string;
}

export interface OrdinaryStatusEntry extends StatusEntryBase {
  readonly kind: "ordinary";
  readonly headMode: string;
  readonly indexMode: string;
  readonly worktreeMode: string;
  readonly headObjectId: string;
  readonly indexObjectId: string;
}

export interface RenamedStatusEntry extends StatusEntryBase {
  readonly kind: "renamed";
  readonly renameOrCopy: "rename" | "copy";
  readonly similarity: number;
  readonly headMode: string;
  readonly indexMode: string;
  readonly worktreeMode: string;
  readonly headObjectId: string;
  readonly indexObjectId: string;
  readonly originalPath: string;
}

export interface UntrackedStatusEntry {
  readonly kind: "untracked";
  readonly path: string;
}

export interface IgnoredStatusEntry {
  readonly kind: "ignored";
  readonly path: string;
}

export type StatusEntry =
  | OrdinaryStatusEntry
  | RenamedStatusEntry
  | UnmergedEntry
  | UntrackedStatusEntry
  | IgnoredStatusEntry;

export interface StatusResult {
  readonly branch: StatusBranchInfo;
  readonly entries: readonly StatusEntry[];
}

// ---------------------------------------------------------------------------------------
// P6/W8 — the wire-shaped fold. `RepoService.statusSummary` caps `dirtyPaths` to 200 and sets
// `dirtyTruncated` accordingly (a service-layer display concern, not a classification one); the
// value returned here is always the full, uncapped list, since `dirtyPathsFrom` below — not this
// list — is what pre-flight's set intersection must see in full (capping the input would produce
// a wrong verdict; capping only the display is the whole reason the cap belongs downstream).
// ---------------------------------------------------------------------------------------

export interface StatusSummary {
  readonly head: HeadState;
  readonly upstream:
    | { readonly name: string; readonly ahead: number; readonly behind: number }
    | undefined;
  readonly counts: {
    readonly staged: number;
    readonly unstaged: number;
    readonly untracked: number;
    readonly unmerged: number;
  };
  readonly isClean: boolean;
  readonly dirtyPaths: readonly string[];
  readonly dirtyTruncated: boolean;
  readonly inProgress: InProgressOperation | null;
}

/** `status --branch`'s header already carries HEAD's identity — deriving it here (rather than a
 *  separate `symbolic-ref`/`rev-parse` pair, `discovery.ts`'s own route) means `statusSummary`
 *  and `op.run`'s post-op read-back cost the one spawn they need, not two. Unborn is exactly
 *  `resolveHeadState`'s own rule: a named branch with no commit behind it yet. */
function headStateFromBranch(branch: StatusBranchInfo): HeadState {
  if (branch.head.kind === "detached") return { kind: "detached", sha: branch.oid ?? "" };
  if (branch.oid === undefined) return { kind: "unborn", name: branch.head.name };
  return { kind: "branch", name: branch.head.name };
}

export function summarizeStatus(
  status: StatusResult,
  inProgress: InProgressOperation | null,
): StatusSummary {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let unmerged = 0;
  const dirtyPaths: string[] = [];

  for (const entry of status.entries) {
    switch (entry.kind) {
      case "ordinary":
      case "renamed":
        if (entry.staged !== ".") staged++;
        if (entry.unstaged !== ".") unstaged++;
        dirtyPaths.push(entry.path);
        break;
      case "unmerged":
        unmerged++;
        dirtyPaths.push(entry.path);
        break;
      case "untracked":
        untracked++;
        dirtyPaths.push(entry.path);
        break;
      case "ignored":
        // Never dirty — status only reports these at all when `--ignored` was passed, and
        // §7.5's classification has no use for a path git itself will never touch on checkout.
        break;
    }
  }

  const { branch } = status;
  return {
    head: headStateFromBranch(branch),
    upstream:
      branch.upstream !== undefined
        ? { name: branch.upstream, ahead: branch.ahead ?? 0, behind: branch.behind ?? 0 }
        : undefined,
    counts: { staged, unstaged, untracked, unmerged },
    isClean: staged === 0 && unstaged === 0 && untracked === 0 && unmerged === 0,
    dirtyPaths,
    dirtyTruncated: false,
    inProgress,
  };
}

/** The sibling fold `core/src/preflight/checkout.ts`'s `dirty` input needs: every path git
 *  considers not-clean, discriminated tracked/untracked — the split §7.5's two blocker kinds
 *  (`blockedByTracked`/`blockedByUntracked`) are built from. An unmerged path counts as tracked:
 *  it has index stages, and `blockedByTracked`'s remedy (discard) is the one that actually
 *  applies to it. */
export function dirtyPathsFrom(status: StatusResult): { path: string; tracked: boolean }[] {
  const out: { path: string; tracked: boolean }[] = [];
  for (const entry of status.entries) {
    switch (entry.kind) {
      case "ordinary":
      case "renamed":
      case "unmerged":
        out.push({ path: entry.path, tracked: true });
        break;
      case "untracked":
        out.push({ path: entry.path, tracked: false });
        break;
      case "ignored":
        break;
    }
  }
  return out;
}
