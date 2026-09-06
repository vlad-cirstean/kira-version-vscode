/**
 * One entry of `git stash list` (§4.4/§7.6). Widened at P9 from P1's narrow shape — no file
 * count, no base-commit subject, no index/untracked parent shas, no "was created with `-u`"
 * flag — none of which §7.6's list row or pop-prediction engine can do without. (`baseSubject`
 * was the one field this widening initially missed — added at W14, when `StashList.vue` turned
 * out to need it and no field carried it; see that field's own doc comment.)
 */
export interface StashEntry {
  /** The N in `stash@{N}` at the moment of the read. Positional and unstable — never an
   *  identity. Every mutating argv that uses it is guarded by `sha` (P9 probe 8): git refuses a
   *  raw sha for `pop`/`drop`, and `stash branch <name> <sha>` applies but silently skips the
   *  drop, so every stack-mutating op carries both and the caller verifies `rev-parse
   *  stash@{N}` still equals `sha` immediately before writing. */
  readonly index: number;
  /** The stash commit's own sha. */
  readonly sha: string;
  /** Parent 1 — the base commit, and the merge base every pop prediction MUST pass
   *  (P9 probe 2: omitting `--merge-base=<stash^>` makes a genuinely conflicting pop report
   *  clean). */
  readonly baseSha: string;
  /** `baseSha`'s own commit subject — `git stash list`'s own format string has no way to name a
   *  PARENT commit's subject (only the stash commit's own `%gs`), so `queries.ts`'s `stashList`
   *  fetches it with one extra, tiny batch spawn (`log --no-walk`) over every entry's distinct
   *  `baseSha`, keyed back onto each entry here. `StashList.vue`'s "base commit short sha +
   *  subject" row (§3.1) is the one reader; empty string if a batch spawn somehow omitted a sha
   *  (should not happen — every `baseSha` is a real, reachable commit — but a stash list
   *  should never fail to render over a lookup gap that is not itself worth surfacing). */
  readonly baseSubject: string;
  /** Parent 2 — the index tree commit. Held so the graph's helper-commit filter (P9 probe 7)
   *  can drop it by sha; not otherwise consumed. */
  readonly indexSha: string;
  /** Parent 3, present iff `-u` was passed to `stash push` — which does NOT imply untracked
   *  content actually exists (P9 probe 1: `-u` with nothing untracked still mints an empty
   *  third parent). The real file list comes from `ls-tree -r --name-only <untrackedSha>`. */
  readonly untrackedSha: string | undefined;
  /** `%gs`, the REFLOG subject — what `git stash list` itself shows, and what survives a
   *  `stash store -m` restore. NOT `%s`, the commit subject minted once at push time: the two
   *  diverge the instant a `store` runs, which is exactly what P9's undo replay does
   *  (P9 probe 9). */
  readonly message: string;
  /** Parsed out of `message`'s `WIP on <b>:` / `On <b>:` prefix; `null` on a detached-HEAD
   *  stash (`On (no branch): …`). */
  readonly branch: string | null;
  readonly timestamp: number; // unix seconds
  /** Tracked files the stash changes, from the same single `stash list --numstat` spawn that
   *  reads everything else here (P9 probe 12). Untracked files are never counted here — `-u` in
   *  `stash list` means `--patch`, not `--include-untracked`, so there is no way to see them
   *  without a spawn per entry. `includedUntracked` flags their possible presence and
   *  `stash.show` gives the real list. */
  readonly fileCount: number;
  /** `untrackedSha !== undefined` — see that field's own doc comment on why this, not
   *  `hasUntracked`, is the honest name. */
  readonly includedUntracked: boolean;
}
