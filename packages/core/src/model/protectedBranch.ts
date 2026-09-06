/**
 * P8/W6, D52's matcher: which branches gate a force-push or a remote-branch deletion behind a
 * typed confirmation (§7.4, closing D19's open half — see `docs/plans/P8.md`'s "Protected
 * branches: what exactly is gated"). Pure and unit-tested so both the host pre-flight and the
 * UI's own "this branch is protected" affordance can call it without a round trip, and so the
 * one matching rule can never drift between the two.
 *
 * Glob semantics only: `*` matches any run of characters *except* `/` (so `release/*` covers
 * `release/1.2` but not `release/1.2/hotfix`); anything else in the pattern is literal. A
 * pattern containing `**` is not a supported glob — it is matched *literally* (almost never what
 * anyone wants, so `matchProtectedBranch` reports it as a "problem" the settings-problem channel
 * already carries, rather than silently doing something clever).
 */

export interface ProtectedMatch {
  /** The pattern from `patterns` that matched — surfaced so a dialog can say "`release/1.2`
   *  matches your protected pattern `release/*`" instead of a bare yes/no. */
  readonly pattern: string;
}

export interface ProtectedBranchProblem {
  readonly pattern: string;
  readonly reason: "unsupportedGlob";
}

/** `*` -> "any run of non-`/` characters"; everything else escaped literally. A pattern
 *  containing `**` is intentionally NOT given `**`'s usual "matches across `/`" meaning — see
 *  the file header — so it is routed to `problems` by the caller and matched as a literal
 *  string here (the `**` regex below degenerates to two adjacent `[^/]*` groups, which matches
 *  strictly less than the literal pattern in almost every real case, so falling through to a
 *  literal-string comparison is the honest, unsurprising behaviour). */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function isLiteralMatch(branch: string, pattern: string): boolean {
  return branch === pattern;
}

/**
 * Returns the first pattern `branch` matches, or `null`. Case-sensitive — git ref names are.
 * `problems`, when supplied, is pushed to for every pattern containing `**` (checked once per
 * call, not cached — the pattern list is short and this runs on a user action, not a hot loop).
 */
export function matchProtectedBranch(
  branch: string,
  patterns: readonly string[],
  problems?: ProtectedBranchProblem[],
): ProtectedMatch | null {
  for (const pattern of patterns) {
    if (pattern.includes("**")) {
      problems?.push({ pattern, reason: "unsupportedGlob" });
      if (isLiteralMatch(branch, pattern)) return { pattern };
      continue;
    }
    if (patternToRegExp(pattern).test(branch)) return { pattern };
  }
  return null;
}
