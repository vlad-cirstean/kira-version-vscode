/**
 * §7.6/P9 W12's chunk-build post-pass, run once per raw `CommitRecord` as `RepoService` reads a
 * page out of the log walk, before it ever reaches `CommitStore` — pure and independent of the
 * walk mechanics themselves (`revSetArgs`'s own doc comment covers the argv half: naming every
 * stash beyond `stash@{0}` as an explicit positional rev is what makes them reachable at all).
 *
 * Three things, driven entirely by the session's own current stash list:
 *
 * 1. **Drop** a row whose sha is a stash entry's `indexSha`/`untrackedSha` — a real commit object
 *    `git log` visits as an ordinary ancestor of the stash commit (it walks every parent, not
 *    just the first), never nameable with `^<sha>` instead: its own ancestor is the base commit,
 *    real history that would vanish along with it.
 * 2. **Truncate** a stash commit's parent list to `[baseSha]`, so it draws hanging off its base
 *    with no edge into a row this same pass just dropped.
 * 3. **Synthesise** `{kind: "stash", index}` onto a stash commit's decorations when `%D` didn't
 *    already carry one — probe 7: `--decorate` can only ever name `refs/stash`'s own tip this
 *    way, i.e. `stash@{0}`; every other stack member's decoration has no ref to be parsed from at
 *    all and is added here instead, by sha membership against the fetched stash list.
 */
import type { CommitRecord, DecorationRef } from "../model/commit.ts";
import type { StashEntry } from "../model/stash.ts";

export interface StashRowFilter {
  readonly helperShas: ReadonlySet<string>;
  readonly baseByStashSha: ReadonlyMap<string, string>;
  readonly indexByStashSha: ReadonlyMap<string, number>;
}

/** `entries` empty ⇒ every method below is a no-op pass-through — the same filter this file
 *  hands out when `kiraVersion.stash.showInGraph` is off, or a repo has no stashes at all. */
export function buildStashRowFilter(entries: readonly StashEntry[]): StashRowFilter {
  const helperShas = new Set<string>();
  const baseByStashSha = new Map<string, string>();
  const indexByStashSha = new Map<string, number>();
  for (const entry of entries) {
    helperShas.add(entry.indexSha);
    if (entry.untrackedSha !== undefined) helperShas.add(entry.untrackedSha);
    baseByStashSha.set(entry.sha, entry.baseSha);
    indexByStashSha.set(entry.sha, entry.index);
  }
  return { helperShas, baseByStashSha, indexByStashSha };
}

/** Returns `null` for a row this pass drops entirely (item 1 above); otherwise the record,
 *  unchanged unless it is itself a stash commit (items 2/3). Applied to every record a page read
 *  yields, in the same order `git log` produced them — `CommitStore.append`'s own ordering
 *  requirement is unaffected, since dropping a row never reorders the rows kept around it. */
export function applyStashRowFilter(
  record: CommitRecord,
  filter: StashRowFilter,
): CommitRecord | null {
  if (filter.helperShas.has(record.sha)) return null;
  const baseSha = filter.baseByStashSha.get(record.sha);
  if (baseSha === undefined) return record;
  const alreadyDecorated = record.decoration.some((d) => d.kind === "stash");
  const index = filter.indexByStashSha.get(record.sha);
  const decoration: readonly DecorationRef[] =
    alreadyDecorated || index === undefined
      ? record.decoration
      : [...record.decoration, { kind: "stash", index }];
  return { ...record, parents: [baseSha], decoration };
}
