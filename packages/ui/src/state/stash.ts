import type { FileChange, StashEntry } from "@kira-version/ipc";
import { TransportError } from "@kira-version/ipc";
import { type ComputedRef, type ShallowRef, computed, shallowRef } from "vue";
import type { BridgeClient } from "../bridge/client.ts";

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

  readonly #bridge: BridgeClient;
  #repoId: string | undefined;
  #showController: AbortController | undefined;
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
    this.selectedSha.value = sha;
    this.changes.value = undefined;
    this.error.value = undefined;
    if (sha !== null) void this.#requestShow(sha);
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

  #clear(): void {
    this.#showController?.abort();
    this.entries.value = [];
    this.selectedSha.value = null;
    this.changes.value = undefined;
    this.error.value = undefined;
  }

  dispose(): void {
    this.#unsubscribe();
    this.#showController?.abort();
  }
}
