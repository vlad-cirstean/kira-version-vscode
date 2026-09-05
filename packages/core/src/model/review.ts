/**
 * `docs/plans/P7.md` W1 — the base-resolution policy for **Branch review** (§6.8), as a pure
 * classifier over a `for-each-ref` snapshot. No I/O: the caller (`RepoService.resolveReviewBase`,
 * W4) has already fetched `branches`/`remoteBranches` (cached) and the `symbolic-ref --short
 * refs/remotes/origin/HEAD` answer (one spawn, only when needed) before calling this.
 *
 * The range's *walkability* — whether `base` and `branch` actually share history, whether the
 * range is empty — is deliberately NOT this function's business (§6.8's "Base resolution has
 * four outcomes" — read `docs/plans/P7.md`'s own section by that name): that needs two more git
 * spawns (`merge-base`, `rev-list --count`) this function has no way to make and no business
 * making. This function answers exactly one question: *which ref, if any, does §6.8's three-step
 * order pick as the comparison base* — a question answerable entirely from an in-memory ref
 * snapshot.
 */
import type { RefKind, RefRecord } from "./ref.ts";

export type BaseResolutionReason =
  /** §6.8 step 1: the branch's upstream, and it names a *different* branch. */
  | "upstream"
  /** §6.8 step 2: `origin/HEAD`, or the first existing `review.baseCandidates` member. */
  | "defaultBranch"
  /** The user picked it from the header picker — resolution was skipped entirely. Never
   *  returned by `resolveBase` itself; recorded here only because `BaseCandidate.reason`
   *  excludes it explicitly (`ipc`'s `BaseResolutionReason` is the wire copy of this type). */
  | "override"
  /** §6.8 step 3: nothing detected. `base` is null and no walk is opened. */
  | "none";

/** One entry in the header picker's shortlist — see this module's own doc comment for why the
 *  `reason` union here excludes `"override"`/`"none"`: a candidate is a thing detected from the
 *  snapshot, never a thing the user chose, and never "nothing". */
export interface BaseCandidate {
  readonly ref: string;
  readonly kind: RefKind;
  readonly reason: Exclude<BaseResolutionReason, "override" | "none">;
}

export interface ResolveBaseInput {
  /** The branch under review — its `upstream`/`shortName`/`isHead` are what step 1 reads. */
  readonly branch: RefRecord;
  readonly branches: readonly RefRecord[];
  readonly remoteBranches: readonly RefRecord[];
  /** `git symbolic-ref --short refs/remotes/origin/HEAD`'s answer, or `undefined` when unset
   *  (V1: an absent or dangling `origin/HEAD` is "not set", never an error). Already a short
   *  ref name, e.g. `"origin/main"`. */
  readonly originHead: string | undefined;
  /** `kiraVersion.review.baseCandidates`, in configured order (default `["main", "master"]`). */
  readonly candidates: readonly string[];
}

export interface BaseResolutionCore {
  /** `null` iff `reason === "none"`. */
  readonly base: string | null;
  readonly reason: BaseResolutionReason;
  readonly candidates: readonly BaseCandidate[];
}

/** `refs/heads/main` -> `"main"`; `refs/remotes/origin/develop` -> `"develop"` — every namespace
 *  prefix AND the remote name stripped, leaving only the bare branch name §6.8 step 1 compares
 *  against `branch.shortName` ("`feature-x` tracking `refs/remotes/origin/feature-x`" — the
 *  comparison is `feature-x === feature-x`, not `origin/feature-x === feature-x`). */
function bareUpstreamName(upstream: string): string {
  if (upstream.startsWith("refs/heads/")) return upstream.slice("refs/heads/".length);
  const remoteMatch = /^refs\/remotes\/[^/]+\/(.*)$/.exec(upstream);
  if (remoteMatch) return remoteMatch[1] as string;
  return upstream;
}

/** `refs/heads/main` -> `"main"`; `refs/remotes/origin/develop` -> `"origin/develop"` — exactly
 *  `RefRecord.shortName`'s own convention (the remote name is kept), so the result can be looked
 *  up against `branches`/`remoteBranches` by `shortName` and, once found, returned verbatim as
 *  `base` (a value `merge-base`/`rev-list` can resolve directly). */
function upstreamRefShortName(upstream: string): string {
  if (upstream.startsWith("refs/heads/")) return upstream.slice("refs/heads/".length);
  if (upstream.startsWith("refs/remotes/")) return upstream.slice("refs/remotes/".length);
  return upstream;
}

/**
 * §6.8's three-step order, read together with "The resolution rule, exactly" in
 * `docs/plans/P7.md`:
 *
 * 1. The branch's upstream, when it names a genuinely different branch AND still resolves to a
 *    real ref in this snapshot (a `"gone"` upstream whose remote-tracking ref has since been
 *    pruned does not qualify — it falls through, exactly as an absent upstream does).
 * 2. `originHead`, if it resolves in this snapshot; else the first `candidates` member that
 *    does.
 * 3. Neither ⇒ `base: null`, reason `"none"`.
 *
 * The candidate shortlist is built in the same pass, ordered upstream (when it exists at all,
 * even when step 1 rejected it for being same-named — the user may deliberately want
 * `origin/feature-x` as its own base) → `originHead` → each existing `candidates` member in
 * configured order → the current HEAD branch when it is none of the above, de-duplicated by ref
 * name with the first reason recorded winning.
 */
export function resolveBase(input: ResolveBaseInput): BaseResolutionCore {
  const { branch, branches, remoteBranches, originHead, candidates } = input;
  const allRefs = [...branches, ...remoteBranches];
  const findRef = (shortName: string): RefRecord | undefined =>
    allRefs.find((ref) => ref.shortName === shortName);

  const upstreamShort =
    branch.upstream !== undefined ? upstreamRefShortName(branch.upstream) : undefined;
  const upstreamBareName =
    branch.upstream !== undefined ? bareUpstreamName(branch.upstream) : undefined;
  const upstreamRef = upstreamShort !== undefined ? findRef(upstreamShort) : undefined;

  let base: string | null = null;
  let reason: BaseResolutionReason = "none";

  if (upstreamRef !== undefined && upstreamBareName !== branch.shortName) {
    base = upstreamShort as string;
    reason = "upstream";
  }

  if (base === null) {
    if (originHead !== undefined && findRef(originHead) !== undefined) {
      base = originHead;
      reason = "defaultBranch";
    } else {
      for (const candidate of candidates) {
        if (findRef(candidate) !== undefined) {
          base = candidate;
          reason = "defaultBranch";
          break;
        }
      }
    }
  }

  const candidateList: BaseCandidate[] = [];
  const seen = new Set<string>();
  const pushCandidate = (
    ref: string,
    kind: RefKind,
    candidateReason: Exclude<BaseResolutionReason, "override" | "none">,
  ): void => {
    if (seen.has(ref)) return;
    seen.add(ref);
    candidateList.push({ ref, kind, reason: candidateReason });
  };

  if (upstreamRef !== undefined) pushCandidate(upstreamRef.shortName, upstreamRef.kind, "upstream");
  if (originHead !== undefined) {
    const ref = findRef(originHead);
    if (ref !== undefined) pushCandidate(originHead, ref.kind, "defaultBranch");
  }
  for (const candidate of candidates) {
    const ref = findRef(candidate);
    if (ref !== undefined) pushCandidate(candidate, ref.kind, "defaultBranch");
  }
  const headBranch = branches.find((ref) => ref.isHead);
  if (headBranch !== undefined) {
    pushCandidate(headBranch.shortName, headBranch.kind, "defaultBranch");
  }

  return { base, reason, candidates: candidateList };
}
