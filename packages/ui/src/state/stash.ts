import type { FileChange, ResultOf, StashEntry } from "@kira-version/ipc";
import { TransportError } from "@kira-version/ipc";
import { type ComputedRef, type ShallowRef, computed, shallowRef } from "vue";
import type { BridgeClient } from "../bridge/client.ts";
import type { FileListMode } from "./detail.ts";

export type StashFileDiffResult = ResultOf<"commit.fileDiff">;

/**
 * `docs/plans/P9.md` W13: the stash stack as reactive state, mirroring `RefsState`'s own shape
 * (P6 W12) closely enough that `StashList.vue` (W14) needs nothing bespoke to consume it — a
 * repo's stash stack is exactly as ref-shaped as its branches/tags, just addressed by
 * `stash@{index}`/sha instead of a name.
 *
 * **Refresh.** Reloaded on the same `repo.changed` signal `RefsState` already listens to
 * (`kind === "refsChanged"`), never a bespoke one: every stash mutation (push/apply/pop/drop/
 * branch) writes `refs/stash` like any other ref write, so `watcher.ts`'s existing refs-dir
 * coverage already fires it — `ops.ts`'s stash methods do not additionally call `reload()`
 * themselves.
 *
 * **Selection.** OQ4: a stash IS selectable like a commit, so this class holds the same
 * "selected sha + its loaded file list" shape `DetailState` holds for a commit (P5 W7), not a
 * derivative of it — the two selections are independent (selecting a stash does not touch
 * `DetailState`, and vice versa; `App.vue`/W14 decides which pane wins when both exist).
 */
export class StashState {
  readonly entries: ShallowRef<readonly StashEntry[]> = shallowRef([]);
  /** `null` selects nothing. Otherwise the sha of the entry whose file list `changes` holds —
   *  kept as a sha, not the `StashEntry` itself, so a stack reshuffle (another pop/drop) that
   *  drops this entry out of `entries` is detectable (`selected` below reads back `undefined`)
   *  rather than silently pinning a stale snapshot. */
  readonly selectedSha: ShallowRef<string | null> = shallowRef(null);
  readonly changes: ShallowRef<readonly FileChange[] | undefined> = shallowRef(undefined);
  readonly error: ShallowRef<string | undefined> = shallowRef(undefined);

  /** The selected entry itself, or `undefined` once it is no longer in `entries` — `StashList.vue`
   *  reads this, never re-derives it by scanning `entries` on its own. */
  readonly selected: ComputedRef<StashEntry | undefined>;

  // -------------------------------------------------------------------------------------
  // W14's detail pane, mirroring `DetailState`'s own "detail"/"diff" mode split (P5 W7) closely
  // enough that `StashDetailPane.vue` reuses `FileTree.vue`/`DiffView.vue` unchanged — see this
  // class's own top doc comment on why this lives here rather than on `DetailState` itself.
  // -------------------------------------------------------------------------------------
  readonly mode: ShallowRef<"detail" | "diff"> = shallowRef("detail");
  readonly selectedFile: ShallowRef<number> = shallowRef(-1);
  readonly diff: ShallowRef<StashFileDiffResult | undefined> = shallowRef(undefined);
  readonly diffError: ShallowRef<string | undefined> = shallowRef(undefined);
  readonly listMode: ShallowRef<FileListMode> = shallowRef("tree");
  readonly filter: ShallowRef<string> = shallowRef("");

  readonly #bridge: BridgeClient;
  #repoId: string | undefined;
  #showController: AbortController | undefined;
  #diffController: AbortController | undefined;
  readonly #unsubscribe: () => void;

  constructor(bridge: BridgeClient) {
    this.#bridge = bridge;
    this.selected = computed(() => {
      const sha = this.selectedSha.value;
      return sha === null ? undefined : this.entries.value.find((entry) => entry.sha === sha);
    });
    this.#unsubscribe = bridge.on("repo.changed", (event) => {
      if (this.#repoId !== event.repoId) return;
      if (event.kind !== "refsChanged") return;
      void this.reload();
    });
  }

  /** Called once per repo open/close, exactly like `RefsState.setRepoId`/`DetailState.setRepoId`
   *  — loads the new repo's stash stack immediately rather than waiting on a `repo.changed` event
   *  that a freshly opened repo has no reason to ever emit. */
  setRepoId(repoId: string | undefined): void {
    this.#repoId = repoId;
    if (repoId === undefined) {
      this.#clear();
      return;
    }
    this.selectedSha.value = null;
    this.changes.value = undefined;
    this.error.value = undefined;
    void this.reload();
  }

  async reload(): Promise<void> {
    const repoId = this.#repoId;
    if (repoId === undefined) return;
    const { entries } = await this.#bridge.request("stash.list", { repoId });
    // A repo switch (or close) that lands while this request was in flight must not let a stale
    // reply overwrite the newer repo's own state — the same guard `RefsState.reload` makes.
    if (this.#repoId !== repoId) return;
    this.entries.value = entries;
  }

  /** `StashList.vue`'s row click/Enter, and the graph's own stash-node selection (OQ4) — `null`
   *  clears the selection without a round trip. Re-selecting the already-selected sha is a no-op,
   *  matching `DetailState.select`'s sibling convention for a commit row (P4). */
  select(sha: string | null): void {
    if (sha === this.selectedSha.value) return;
    this.#showController?.abort();
    this.#diffController?.abort();
    this.selectedSha.value = sha;
    this.changes.value = undefined;
    this.error.value = undefined;
    this.mode.value = "detail";
    this.selectedFile.value = -1;
    this.diff.value = undefined;
    this.diffError.value = undefined;
    if (sha !== null) void this.#requestShow(sha);
  }

  /** `StashDetailPane.vue`'s tree click/Enter — mirrors `DetailState.selectFile` exactly (P5 W8's
   *  own convention), including the "re-selecting the open file just flips `mode` back" shortcut. */
  selectFile(index: number): void {
    if (this.selectedFile.value === index) {
      this.mode.value = "diff";
      return;
    }
    this.selectedFile.value = index;
    this.mode.value = "diff";
    void this.#requestFileDiff();
  }

  showTree(): void {
    this.mode.value = "detail";
  }

  setListMode(mode: FileListMode): void {
    this.listMode.value = mode;
  }

  setFilter(text: string): void {
    this.filter.value = text;
  }

  async #requestShow(sha: string): Promise<void> {
    const repoId = this.#repoId;
    if (repoId === undefined) return;
    const controller = new AbortController();
    this.#showController = controller;
    try {
      const result = await this.#bridge.request("stash.show", { repoId, sha }, controller.signal);
      if (this.selectedSha.value !== sha) return;
      this.changes.value = result.changes;
    } catch (error) {
      if (error instanceof TransportError && error.code === "cancelled") return;
      if (this.selectedSha.value !== sha) return;
      this.error.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.#showController === controller) this.#showController = undefined;
    }
  }

  /** `commit.fileDiff` (no dedicated `stash.fileDiff` endpoint exists — §3.1's tree names none)
   *  addressed at the stash commit itself, `parentIndex: 0` against its own `baseSha` — correct
   *  for every TRACKED file, since a stash commit's own tree is exactly the tracked worktree
   *  diffed against its base. `-u`'s untracked files live only in the stash's third parent
   *  (`untrackedSha`), which has no `baseSha` of its own — that repeats `RepoService.fileDiff`'s
   *  existing "root commit ⇒ `baseSha: null`, whole tree as added" path unmodified — so a path
   *  the first request 404s on (`commit.fileDiff` throws when `path` is not one of the sha's own
   *  changed files, `RepoService`'s own `assertDefined`) is retried once against `untrackedSha`
   *  before giving up. A real, minor inefficiency (one wasted round trip per untracked file, the
   *  first time it is opened) accepted in place of a new wire endpoint — see Findings. */
  async #requestFileDiff(): Promise<void> {
    const repoId = this.#repoId;
    const entry = this.selected.value;
    const index = this.selectedFile.value;
    const change = this.changes.value?.[index];
    if (repoId === undefined || entry === undefined || change === undefined) return;
    this.#diffController?.abort();
    const controller = new AbortController();
    this.#diffController = controller;
    this.diffError.value = undefined;
    const stillCurrent = (): boolean =>
      this.selectedSha.value === entry.sha && this.selectedFile.value === index;
    const params = {
      repoId,
      path: change.path,
      ...(change.originalPath !== undefined ? { originalPath: change.originalPath } : {}),
      parentIndex: 0,
    };
    try {
      let result: StashFileDiffResult;
      try {
        result = await this.#bridge.request(
          "commit.fileDiff",
          { ...params, sha: entry.sha },
          controller.signal,
        );
      } catch (trackedError) {
        if (trackedError instanceof TransportError && trackedError.code === "cancelled")
          throw trackedError;
        if (entry.untrackedSha === undefined) throw trackedError;
        result = await this.#bridge.request(
          "commit.fileDiff",
          { ...params, sha: entry.untrackedSha },
          controller.signal,
        );
      }
      if (!stillCurrent()) return;
      this.diff.value = result;
    } catch (error) {
      if (error instanceof TransportError && error.code === "cancelled") return;
      if (!stillCurrent()) return;
      this.diffError.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.#diffController === controller) this.#diffController = undefined;
    }
  }

  #clear(): void {
    this.#showController?.abort();
    this.#diffController?.abort();
    this.entries.value = [];
    this.selectedSha.value = null;
    this.changes.value = undefined;
    this.error.value = undefined;
    this.mode.value = "detail";
    this.selectedFile.value = -1;
    this.diff.value = undefined;
    this.diffError.value = undefined;
  }

  dispose(): void {
    this.#unsubscribe();
    this.#showController?.abort();
    this.#diffController?.abort();
  }
}
