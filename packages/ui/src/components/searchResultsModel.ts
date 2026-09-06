/**
 * `docs/plans/P11.md` W12: the pure half of `SearchResults.vue` — grouping (local branches /
 * remote branches / tags / commits), per-section caps and the two honesty footers, kept out of
 * the template exactly as `refListModel.ts` keeps `BranchPicker.vue`'s own fold out of *its*
 * template. Nothing here is Vue-reactive: every input is already-unwrapped data, so this is
 * ordinary data-in, data-out logic W16 can assert against with no component mount at all.
 */
import type { SearchField, SearchScope } from "@kira-version/core";
import type { RefRow } from "@kira-version/ipc";
import type { CommitHit, RefHit, SearchRunResult } from "../state/search.ts";
import { capItems, REF_LIST_SECTION_CAP } from "./refListModel.ts";

/** One row in the dropdown, tagged by which half of `SearchState` it came from — the discriminant
 *  `SearchResults.vue`'s click/keyboard-select handler switches on to decide whether a hit is a
 *  `RefHit` or a `CommitHit` without a second lookup. `id` is a stable DOM id: what `:id` renders
 *  on the option and what `aria-activedescendant` (on `SearchBox.vue`'s own input — the element
 *  that actually holds focus, per the ARIA combobox pattern this dropdown follows) points at. */
export type SearchOption =
  | { readonly kind: "ref"; readonly id: string; readonly hit: RefHit }
  | { readonly kind: "commit"; readonly id: string; readonly hit: CommitHit };

function refOptionId(ref: RefRow): string {
  return `kv-search-option-ref-${ref.refname}`;
}

function commitOptionId(hit: CommitHit): string {
  return `kv-search-option-commit-${hit.sha}`;
}

export interface SearchResultsSection {
  readonly title: string;
  readonly options: readonly SearchOption[];
  readonly hiddenCount: number;
}

export interface SearchResultsModel {
  /** Refs first (§7.8's own order), grouped and labelled by kind so a tag and a branch of the
   *  same name are never confused — the empty ones are omitted entirely rather than rendered as a
   *  section with nothing in it. */
  readonly sections: readonly SearchResultsSection[];
  /** Every visible option, refs-then-commits, section order preserved — what `SearchBox.vue`'s
   *  own arrow-key handler walks; a flat list because "next option" crosses section boundaries. */
  readonly flatOptions: readonly SearchOption[];
  /** "Searched N of M loaded commits" — set only when the client-side time box (hard part 4)
   *  actually fired; a scan that reached every loaded row has nothing to disclose. */
  readonly loadedFooter: string | undefined;
  /** "N more matches in history" — set only when the tail's own result cap (OQ3) truncated a
   *  larger total. There is no wire support for paging past it (`search.run` takes a `limit`, not
   *  a cursor), so this is disclosure, not an invitation to load more — narrowing the query is
   *  the only way to see a hit past the cap. */
  readonly tailFooter: string | undefined;
}

/** A hit's own field list, rendered as one short label — "matched: body", "matched: sha" — for
 *  a hit that matched somewhere other than the subject/ref-name (the plan's own "a field label
 *  for a hit that matched somewhere other than the subject"). `undefined` when `subject`/
 *  `refName` is present, since that is the row's own visible text and needs no label pointing at
 *  it. */
const FIELD_LABELS: Readonly<Record<SearchField, string>> = {
  subject: "subject",
  body: "body",
  authorName: "author",
  authorEmail: "author email",
  committerName: "committer",
  committerEmail: "committer email",
  sha: "sha",
  refName: "name",
  tagAnnotation: "tag message",
};

export function fieldLabel(fields: readonly SearchField[]): string | undefined {
  const other = fields.filter((f) => f !== "subject" && f !== "refName");
  if (other.length === 0) return undefined;
  return other.map((f) => FIELD_LABELS[f]).join(", ");
}

const SEARCH_SECTION_CAP = REF_LIST_SECTION_CAP;

function buildRefSection(title: string, hits: readonly RefHit[]): SearchResultsSection | undefined {
  if (hits.length === 0) return undefined;
  const { visible, hiddenCount } = capItems(hits, SEARCH_SECTION_CAP);
  return {
    title,
    hiddenCount,
    options: visible.map((hit) => ({ kind: "ref", id: refOptionId(hit.ref), hit }) as const),
  };
}

function buildCommitSection(hits: readonly CommitHit[]): SearchResultsSection | undefined {
  if (hits.length === 0) return undefined;
  const { visible, hiddenCount } = capItems(hits, SEARCH_SECTION_CAP);
  return {
    title: "Commits",
    hiddenCount,
    options: visible.map((hit) => ({ kind: "commit", id: commitOptionId(hit), hit }) as const),
  };
}

export interface SearchResultsInput {
  readonly scope: SearchScope;
  readonly refHits: readonly RefHit[];
  readonly commitHits: readonly CommitHit[];
  /** `LoadedScanResult`, read only for `complete`/`scannedRows` — kept as loosely typed as the
   *  two fields this model actually reads so a caller need not import `@kira-version/core` just
   *  to satisfy this signature. */
  readonly loaded: { readonly complete: boolean; readonly scannedRows: number } | undefined;
  readonly loadedRowCount: number;
  readonly tail: SearchRunResult | undefined;
}

export function buildSearchResultsModel(input: SearchResultsInput): SearchResultsModel {
  const sections: SearchResultsSection[] = [];
  if (input.scope !== "commits") {
    const branches = input.refHits.filter((h) => h.ref.kind === "branch");
    const remotes = input.refHits.filter((h) => h.ref.kind === "remoteBranch");
    const tags = input.refHits.filter((h) => h.ref.kind === "tag");
    for (const section of [
      buildRefSection("Branches", branches),
      buildRefSection("Remote branches", remotes),
      buildRefSection("Tags", tags),
    ]) {
      if (section) sections.push(section);
    }
  }
  if (input.scope !== "refs") {
    const commitSection = buildCommitSection(input.commitHits);
    if (commitSection) sections.push(commitSection);
  }

  const loaded = input.loaded;
  const loadedFooter =
    loaded !== undefined && !loaded.complete
      ? `Searched ${loaded.scannedRows} of ${input.loadedRowCount} loaded commits`
      : undefined;

  const tail = input.tail;
  const tailFooter =
    tail?.kind === "ok" && tail.truncated
      ? `${tail.total - tail.hits.length} more match${tail.total - tail.hits.length === 1 ? "" : "es"} in history`
      : undefined;

  return {
    sections,
    flatOptions: sections.flatMap((section) => section.options),
    loadedFooter,
    tailFooter,
  };
}
