import type { HeadState, RefRow } from "@kira-version/ipc";
import { type ComputedRef, computed, type ShallowRef, shallowRef } from "vue";
import type { BridgeClient } from "../bridge/client.ts";

/**
 * `docs/plans/P6.md` W12: the ref list as reactive state. Loads once a repo is open, reloads on
 * `repo.changed` with `kind === "refsChanged"` — exactly the watcher signal `git branch`/`git
 * tag`/a ref write of any kind touches (`packages/git/src/watcher.ts`) — and derives the three
 * things more than one component needs (`currentBranchName`, `badgesBySha`, `worktreeBranches`)
 * so `BranchPicker.vue`, `TagList.vue` and the graph's own ref badges (`refBadges.ts`, P4) never
 * each recompute their own copy.
 */
export class RefsState {
  readonly branches: ShallowRef<readonly RefRow[]> = shallowRef([]);
  readonly remoteBranches: ShallowRef<readonly RefRow[]> = shallowRef([]);
  readonly tags: ShallowRef<readonly RefRow[]> = shallowRef([]);
  readonly head: ShallowRef<HeadState | undefined> = shallowRef(undefined);

  /** The toolbar's `[branch ▾]` label — `undefined` on a detached/unborn HEAD, where there is no
   *  branch name to show (the toolbar falls back to the short sha or "unborn" itself). */
  readonly currentBranchName: ComputedRef<string | undefined>;
  /** Every ref whose `objectId` (or, for an annotated tag, `peeledObjectId`) resolves to a given
   *  commit — `refBadges.ts`'s own enrichment step, kept here so it is computed once per reload
   *  rather than once per row `CommitGrid.vue` renders. */
  readonly badgesBySha: ComputedRef<ReadonlyMap<string, readonly RefRow[]>>;
  /** D12: branch short names checked out in some *other* worktree — `checkedOutIn` is already
   *  scoped to "not this session's own" by `RepoService.refs` (W8), so presence here is exactly
   *  "why can't I check out this branch". */
  readonly worktreeBranches: ComputedRef<ReadonlySet<string>>;

  readonly #bridge: BridgeClient;
  #repoId: string | undefined;
  readonly #unsubscribe: () => void;

  constructor(bridge: BridgeClient) {
    this.#bridge = bridge;
    this.currentBranchName = computed(() => {
      const head = this.head.value;
      return head?.kind === "branch" ? head.name : undefined;
    });
    this.badgesBySha = computed(() => {
      const map = new Map<string, RefRow[]>();
      const add = (row: RefRow, sha: string) => {
        const existing = map.get(sha);
        if (existing) existing.push(row);
        else map.set(sha, [row]);
      };
      for (const row of this.branches.value) add(row, row.objectId);
      for (const row of this.remoteBranches.value) add(row, row.objectId);
      for (const row of this.tags.value) add(row, row.peeledObjectId ?? row.objectId);
      return map;
    });
    this.worktreeBranches = computed(
      () =>
        new Set(
          this.branches.value
            .filter((row) => row.checkedOutIn !== undefined)
            .map((row) => row.shortName),
        ),
    );
    this.#unsubscribe = bridge.on("repo.changed", (event) => {
      if (this.#repoId !== event.repoId) return;
      if (event.kind !== "refsChanged") return;
      void this.reload();
    });
  }

  /** Called once per repo open/close (`App.vue`'s own `handleRepoOpened`/close path) — loads the
   *  new repo's refs immediately rather than waiting on a `repo.changed` event that may never
   *  come (a freshly opened repo's refs are not "changed", they are simply not loaded yet). */
  setRepoId(repoId: string | undefined): void {
    this.#repoId = repoId;
    if (repoId === undefined) {
      this.#clear();
      return;
    }
    void this.reload();
  }

  async reload(): Promise<void> {
    const repoId = this.#repoId;
    if (repoId === undefined) return;
    const result = await this.#bridge.request("refs.list", { repoId });
    // A repo switch (or close) that lands while this request was in flight must not let a
    // stale reply overwrite the newer repo's own state — the same "does this answer still apply"
    // guard `GraphViewState`'s own doc comment names for exactly this race.
    if (this.#repoId !== repoId) return;
    this.branches.value = result.branches;
    this.remoteBranches.value = result.remoteBranches;
    this.tags.value = result.tags;
    this.head.value = result.head;
  }

  /** `ops.ts`'s own step 4: applies an `OpResult.head` synchronously, before the `repo.changed`
   *  event (and this class's own `reload()`) has had a chance to arrive — what keeps the
   *  toolbar's branch name from lagging the watcher's debounce (W12's own "Done when"). Does not
   *  touch `branches`/`tags`/`remoteBranches` — their `isHead`/track fields are only ever as
   *  fresh as the next `reload()`, which the same event triggers moments later. */
  applyHead(head: HeadState): void {
    this.head.value = head;
  }

  #clear(): void {
    this.branches.value = [];
    this.remoteBranches.value = [];
    this.tags.value = [];
    this.head.value = undefined;
  }

  dispose(): void {
    this.#unsubscribe();
  }
}
