import type { CompiledQuery, LoadedScanResult, SearchField, SearchScope } from "@kira-version/core";
import { compileQuery, matchRef, searchLoadedCommits } from "@kira-version/core";
import type { RefRow, ResultOf } from "@kira-version/ipc";
import { TransportError } from "@kira-version/ipc";
import { type ComputedRef, computed, type ShallowRef, shallowRef, watch } from "vue";
import type { BridgeClient } from "../bridge/client.ts";
import type { GraphViewState } from "./graphView.ts";
import type { RefsState } from "./refs.ts";

export type SearchRunResult = ResultOf<"search.run">;

/** §5.1's client-side ceiling (hard part 4) — `searchLoadedCommits`'s own time box, unrelated to
 *  `TAIL_DEBOUNCE_MS` below (that one bounds how often a *process* spawns; this one bounds how
 *  long a single synchronous scan may hold the main thread). */
const LOADED_SCAN_BUDGET_MS = 120;
/** OQ3: loaded-hit cap. `matchCount` stays exact regardless (`LoadedScanResult.total` keeps
 *  counting past it) — this only bounds how many rows `SearchResults.vue` could ever render from
 *  the client-side half. */
const LOADED_HIT_LIMIT = 500;
/** OQ3: the wire's own default, restated here only so `#runTail`'s request literal has a name
 *  instead of a bare number — `rpcHandlers.ts`'s `DEFAULT_SEARCH_LIMIT` is the actual default
 *  applied when `limit` is omitted; passing it explicitly here would just be the same number
 *  twice, so this request omits `limit` entirely. */
const TAIL_DEBOUNCE_MS = 200;
/** Hard part 6 / §7.8: below this, a query matches most of a repository, and spawning a ~1 s walk
 *  on the very first keystroke of every search is the wrong trade. Two characters, not one. */
const MIN_TAIL_QUERY_LENGTH = 2;
/** OQ1: once the whole history is loaded and it is this small, the *only* thing the tail scan
 *  still adds is a body-only match (hard part 1) — not worth a ~1 s walk on every keystroke.
 *  `runBodySearch()` is the on-demand escape hatch `SearchResults.vue`'s "search message bodies"
 *  affordance (W12) calls when a user asks for it anyway. */
const SKIP_TAIL_MAX_ROWS = 20_000;

/** A ref hit, shaped for `SearchResults.vue`'s grouped listbox (§7.8: "each hit showing its kind
 *  so a tag and a branch of the same name are distinguishable"). Carries the whole `RefRow` the
 *  hit came from rather than re-deriving a subset, since selecting one needs `peeledObjectId ??
 *  objectId` (W14) — information a trimmed shape would have to duplicate. */
export interface RefHit {
  readonly ref: RefRow;
  readonly fields: readonly SearchField[];
}

/** A commit hit, already merged across the loaded and tail halves (hard part 5). `row` is `-1` for
 *  a tail-only hit that has not been paged into `GraphViewState.store` yet — W13's `revealSha` is
 *  what turns such a hit into a real row; until then there is nothing to scroll to or highlight. */
export interface CommitHit {
  readonly sha: string;
  readonly row: number;
  readonly subject: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorTime: number;
  readonly fields: readonly SearchField[];
}

const EMPTY_HITS: readonly never[] = Object.freeze([]);

function toRefHit(ref: RefRow, fields: readonly SearchField[]): RefHit {
  return { ref, fields };
}

/**
 * Hard part 5's merge, exactly: loaded hits first (already in walk order — the store *is* the
 * walk, in order), each carrying every field either half found for its sha (a body-only match on
 * an already-loaded row is folded into that row's own entry rather than listed a second time),
 * then tail hits whose sha is not yet loaded, in the tail's own order — which sorts after every
 * loaded hit by construction (probe 11). `overlapCount` is exactly what `matchCount` needs to
 * subtract: the number of (capped) tail hits that turned out to already be loaded.
 */
function buildCommitHits(
  rowOfSha: (sha: string) => number,
  shaAt: (row: number) => string,
  subjectAt: (row: number) => string,
  authorAt: (row: number) => {
    readonly name: string;
    readonly email: string;
    readonly timestamp: number;
  },
  loaded: LoadedScanResult | undefined,
  tail: SearchRunResult | undefined,
): { readonly hits: readonly CommitHit[]; readonly overlapCount: number } {
  const byRow = new Map<number, Set<SearchField>>();
  for (const hit of loaded?.hits ?? []) byRow.set(hit.row, new Set(hit.fields));

  let overlapCount = 0;
  const tailOnly: CommitHit[] = [];
  if (tail?.kind === "ok") {
    for (const hit of tail.hits) {
      const row = rowOfSha(hit.sha);
      if (row >= 0) {
        overlapCount++;
        const existing = byRow.get(row);
        if (existing) for (const f of hit.fields) existing.add(f);
        else byRow.set(row, new Set(hit.fields));
      } else {
        tailOnly.push({
          sha: hit.sha,
          row: -1,
          subject: hit.subject,
          authorName: hit.authorName,
          authorEmail: hit.authorEmail,
          authorTime: hit.authorTime,
          fields: hit.fields,
        });
      }
    }
  }

  const loadedEntries = [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([row, fields]): CommitHit => {
      const author = authorAt(row);
      return {
        sha: shaAt(row),
        row,
        subject: subjectAt(row),
        authorName: author.name,
        authorEmail: author.email,
        authorTime: author.timestamp,
        fields: [...fields],
      };
    });

  return { hits: [...loadedEntries, ...tailOnly], overlapCount };
}

/**
 * `docs/plans/P11.md` W10: §7.8's search box as reactive state, shaped like `RefsState`/
 * `StashState` closely enough that `SearchBox.vue`/`SearchResults.vue` (W11/W12) need nothing
 * bespoke to consume it — three toggles and a scope compile into one query (hard part 2), which
 * two independent halves then match against: `refHits`/`loaded` are pure, synchronous folds
 * (`matchRef`/`searchLoadedCommits`, both measured at 13-38 ms, probe 9b) that run on every
 * keystroke with no round trip; `tail` is a debounced `search.run` request that only exists to
 * cover what the loaded store structurally cannot (hard part 1: a commit body).
 *
 * **What this class does not do.** It does not highlight anything (W13's job, driven off
 * `searchGeneration`), does not open a dropdown or own focus (W11/W12), and does not itself call
 * `GraphViewState.revealSha` — `next()`/`previous()` only move `activeIndex` over `commitHits`;
 * a consumer (`App.vue`, W14) watches `activeHit` and drives the reveal-and-select side effect,
 * exactly as it already owns the equivalent decision for a `StashState`/`DetailState` selection.
 */
export class SearchState {
  readonly text: ShallowRef<string> = shallowRef("");
  readonly caseSensitive: ShallowRef<boolean> = shallowRef(false);
  readonly wholeWord: ShallowRef<boolean> = shallowRef(false);
  readonly regex: ShallowRef<boolean> = shallowRef(false);
  readonly scope: ShallowRef<SearchScope> = shallowRef("both");

  /** Recompiled per keystroke, never throws (probe 4) — see `core`'s `compileQuery`. */
  readonly compiled: ComputedRef<CompiledQuery>;
  /** `compiled.kind === "invalid"`'s own message, or `undefined` — `SearchBox.vue`'s inline error,
   *  wired to the input via `aria-describedby`. */
  readonly error: ComputedRef<string | undefined>;
  /** Pure — computed straight off `RefsState`, no RPC (OQ4). Empty whenever `scope` is
   *  `"commits"` or the query does not compile to `"ok"`. */
  readonly refHits: ComputedRef<readonly RefHit[]>;
  /** `searchLoadedCommits`'s own last result — `undefined` before the first compile, or whenever
   *  `scope` is `"refs"` (nothing to scan for). */
  readonly loaded: ShallowRef<LoadedScanResult | undefined> = shallowRef(undefined);
  /** `search.run`'s own last reply — `undefined` before the first request settles, whenever the
   *  tail was skipped (OQ1) or never scheduled (query too short, or `scope` is `"refs"`). */
  readonly tail: ShallowRef<SearchRunResult | undefined> = shallowRef(undefined);
  /** `true` once a `repo.changed { refsChanged }` has landed since `tail` was last populated —
   *  the tail is never silently re-run for it (§7.8: search is a question asked at a moment), so
   *  this is `SearchResults.vue`'s own "results may be stale" hint instead. Cleared by the next
   *  successful tail request or by `setRepoId`. */
  readonly tailStale: ShallowRef<boolean> = shallowRef(false);
  readonly commitHits: ComputedRef<readonly CommitHit[]>;
  readonly matchCount: ComputedRef<{ readonly n: number; readonly exact: boolean }>;
  readonly activeIndex: ShallowRef<number> = shallowRef(-1);
  readonly activeHit: ComputedRef<CommitHit | undefined>;
  readonly searching: ShallowRef<boolean> = shallowRef(false);
  /** W13: bumped every time a keystroke settles into a new `loaded` result (including a clear) —
   *  `CommitGrid.vue`'s own watcher on this re-renders the message column's highlight, mirroring
   *  its existing `graphView.generation` watcher exactly. */
  readonly searchGeneration: ShallowRef<number> = shallowRef(0);

  readonly #bridge: BridgeClient;
  readonly #refs: RefsState;
  readonly #graph: GraphViewState;
  #repoId: string | undefined;
  #tailController: AbortController | undefined;
  #tailTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #unsubscribeRefsChanged: () => void;
  readonly #stopWatchers: readonly (() => void)[];

  constructor(bridge: BridgeClient, refs: RefsState, graph: GraphViewState) {
    this.#bridge = bridge;
    this.#refs = refs;
    this.#graph = graph;

    this.compiled = computed(() =>
      compileQuery({
        text: this.text.value,
        caseSensitive: this.caseSensitive.value,
        wholeWord: this.wholeWord.value,
        regex: this.regex.value,
        scope: this.scope.value,
      }),
    );
    this.error = computed(() => {
      const compiled = this.compiled.value;
      return compiled.kind === "invalid" ? compiled.message : undefined;
    });
    this.refHits = computed(() => {
      const compiled = this.compiled.value;
      if (compiled.kind !== "ok" || this.scope.value === "commits") return EMPTY_HITS;
      const ok = compiled;
      const hits: RefHit[] = [];
      const collect = (rows: readonly RefRow[]): void => {
        for (const row of rows) {
          const fields = matchRef(row, ok);
          if (fields.length > 0) hits.push(toRefHit(row, fields));
        }
      };
      // §7.8's own order: local branches, remote-tracking branches, tags.
      collect(this.#refs.branches.value);
      collect(this.#refs.remoteBranches.value);
      collect(this.#refs.tags.value);
      return hits;
    });
    const commitHitsResult = computed(() =>
      buildCommitHits(
        (sha) => this.#graph.store.rowOfSha(sha),
        (row) => this.#graph.store.shaAt(row),
        (row) => this.#graph.store.subjectAt(row),
        (row) => this.#graph.store.authorAt(row),
        this.loaded.value,
        this.tail.value,
      ),
    );
    this.commitHits = computed(() => commitHitsResult.value.hits);
    this.matchCount = computed(() => {
      if (this.compiled.value.kind !== "ok") return { n: 0, exact: true };
      const loaded = this.loaded.value;
      const tail = this.tail.value;
      const loadedLen = loaded?.hits.length ?? 0;
      const tailTotal = tail?.kind === "ok" ? tail.total : 0;
      const n = loadedLen + tailTotal - commitHitsResult.value.overlapCount;
      // Exact only when both halves are known to have seen everything they were asked to: the
      // client-side scan never hit its own time box, and (when a tail actually ran) the tail
      // scanned to git's own end without its own cap truncating the wire payload. A skipped tail
      // (OQ1) does not itself make this inexact — that skip's own premise is "the store already
      // is the whole rev set" — but a tail that ran and was capped or time-boxed does.
      const loadedExact = loaded === undefined || loaded.complete;
      const tailExact =
        tail === undefined || tail.kind !== "ok" || (!tail.truncated && tail.complete);
      return { n, exact: loadedExact && tailExact };
    });
    this.activeHit = computed(() => this.commitHits.value[this.activeIndex.value]);

    this.#unsubscribeRefsChanged = bridge.on("repo.changed", (event) => {
      if (this.#repoId !== event.repoId || event.kind !== "refsChanged") return;
      if (this.tail.value !== undefined) this.tailStale.value = true;
    });

    // Per keystroke, synchronous half (hard part 4's own budget, not the debounce below).
    const stopLoaded = watch(
      [this.compiled, this.#graph.loadedRows, this.#graph.generation],
      () => this.#runLoadedScan(),
      { immediate: true },
    );
    // Debounced tail (hard part 6): a fresh timer per relevant change, so five keystrokes in
    // 300ms spawn at most one process, not five.
    const stopTail = watch(
      [this.text, this.scope, this.caseSensitive, this.wholeWord, this.regex],
      () => this.#scheduleTail(),
      { immediate: true },
    );
    this.#stopWatchers = [stopLoaded, stopTail];
  }

  setRepoId(repoId: string | undefined): void {
    this.#repoId = repoId;
    this.#tailTimer !== undefined && clearTimeout(this.#tailTimer);
    this.#tailTimer = undefined;
    this.#tailController?.abort();
    this.tail.value = undefined;
    this.tailStale.value = false;
    this.searching.value = false;
    this.activeIndex.value = -1;
    // `loaded` is re-derived by the watcher above the moment `#graph`'s own state changes for the
    // new repo (a fresh `GraphViewState` always bumps `generation` on its next stream open) — no
    // explicit recompute is needed here.
  }

  /** `SearchBox.vue`'s `Enter`/`Shift+Enter` (§6.6, judgment call 6) — commit matches only, never
   *  refs (hard part 8: a "next match" key that sometimes moves the grid and sometimes moves a
   *  dropdown cursor is a mode). Wraps at both ends; a no-op with no hits. */
  next(): void {
    const len = this.commitHits.value.length;
    if (len === 0) return;
    this.activeIndex.value = (this.activeIndex.value + 1) % len;
  }

  previous(): void {
    const len = this.commitHits.value.length;
    if (len === 0) return;
    this.activeIndex.value = (this.activeIndex.value - 1 + len) % len;
  }

  /** `SearchResults.vue`'s "search message bodies" affordance (W12) — the on-demand escape hatch
   *  for OQ1's skip: forces one tail request even though the whole (small) history is already
   *  loaded, because that is the one case the skip's own premise does not cover (a body-only
   *  match). A no-op with no compiled query to run. */
  runBodySearch(): void {
    if (this.compiled.value.kind !== "ok") return;
    this.#runTail();
  }

  /** §6.6's `Esc`: clears the query and every derived result. Toggles/scope are left untouched —
   *  only the text (and what it produced) is a "question about now" (hard part 7); the toggles
   *  are the state of a widget, same as `dateFormat`. */
  clear(): void {
    this.text.value = "";
  }

  #shouldRunTail(compiled: Extract<CompiledQuery, { kind: "ok" }>): boolean {
    if (this.scope.value === "refs") return false;
    if (this.text.value.length < MIN_TAIL_QUERY_LENGTH) return false;
    if (this.#graph.exhausted.value && this.#graph.store.rowCount <= SKIP_TAIL_MAX_ROWS) {
      return false;
    }
    void compiled;
    return true;
  }

  #runLoadedScan(): void {
    const compiled = this.compiled.value;
    if (compiled.kind !== "ok" || this.scope.value === "refs") {
      this.loaded.value = undefined;
    } else {
      this.loaded.value = searchLoadedCommits(this.#graph.store, compiled, {
        limit: LOADED_HIT_LIMIT,
        budgetMs: LOADED_SCAN_BUDGET_MS,
      });
    }
    this.searchGeneration.value++;
  }

  #scheduleTail(): void {
    if (this.#tailTimer !== undefined) clearTimeout(this.#tailTimer);
    this.#tailTimer = undefined;
    const compiled = this.compiled.value;
    if (compiled.kind !== "ok" || !this.#shouldRunTail(compiled)) {
      this.#tailController?.abort();
      this.tail.value = undefined;
      this.tailStale.value = false;
      return;
    }
    this.#tailTimer = setTimeout(() => this.#runTail(), TAIL_DEBOUNCE_MS);
  }

  #runTail(): void {
    const repoId = this.#repoId;
    const compiled = this.compiled.value;
    if (repoId === undefined || compiled.kind !== "ok") return;
    this.#tailController?.abort();
    const controller = new AbortController();
    this.#tailController = controller;
    const query = {
      text: this.text.value,
      caseSensitive: this.caseSensitive.value,
      wholeWord: this.wholeWord.value,
      regex: this.regex.value,
    };
    // "Still current" means "this settle is for the query that is still in the box" — matches
    // `StashState`/`DetailState`'s own convention of checking identity against the live ref
    // rather than trusting closure state once an await has crossed.
    const stillCurrent = (): boolean =>
      this.text.value === query.text &&
      this.caseSensitive.value === query.caseSensitive &&
      this.wholeWord.value === query.wholeWord &&
      this.regex.value === query.regex;
    this.searching.value = true;
    this.#bridge
      .request("search.run", { repoId, query }, controller.signal)
      .then((result) => {
        if (!stillCurrent()) return;
        this.tail.value = result;
        this.tailStale.value = false;
      })
      .catch((error: unknown) => {
        if (error instanceof TransportError && error.code === "cancelled") return;
        // A thrown error here is unexpected (`search.run` cannot throw for a bad pattern — it
        // answers `invalidPattern` as data) — surfacing nothing is preferable to crashing the
        // panel over a search; the loaded half still stands on its own.
      })
      .finally(() => {
        if (this.#tailController === controller) {
          this.#tailController = undefined;
          this.searching.value = false;
        }
      });
  }

  dispose(): void {
    this.#unsubscribeRefsChanged();
    for (const stop of this.#stopWatchers) stop();
    if (this.#tailTimer !== undefined) clearTimeout(this.#tailTimer);
    this.#tailController?.abort();
  }
}
