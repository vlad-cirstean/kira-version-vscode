import type { CommitStore } from "@kira-version/core";
import type { StreamChunkOf } from "@kira-version/ipc";
import { TransportError } from "@kira-version/ipc";
import { markRaw, type ShallowRef, shallowRef } from "vue";
import type { BridgeClient } from "../bridge/client.ts";
import { createLayoutClient, type LayoutClient } from "../graph/layoutClient.ts";
import { LayoutStore } from "../graph/layoutStore.ts";
import { type ChunkSource, PackedStreamState } from "./packedStream.ts";

export type { ChunkSource };
export type LoadingState = "idle" | "streaming" | "loadingMore" | "refreshing";

/** The row range a just-applied chunk gained lane layout for — what `onChunkLayout` hands its
 *  subscribers. Absolute row indices, matching `LayoutChunk`'s own `from`/`to`. */
export interface LayoutRange {
  readonly from: number;
  readonly to: number;
}

/**
 * The UI-side half of §5.4's cache/rehydration story (P3 W9), rebuilt for P4 W5 into the module
 * every component reads (docs/plans/P4.md W5). `store` is the client's own `CommitStore`, fed
 * one `graph.stream` chunk at a time via `appendPacked` — which is also where the ordering
 * guarantee lives: `CommitStore.appendPacked` throws if a chunk does not start exactly at the
 * store's current row count, so an out-of-order or duplicated chunk is a loud bug rather than
 * silently corrupted state. This file adds no ordering check of its own; the store's is the
 * only one, and re-implementing it here would just be a second place to get it wrong.
 *
 * `store` and `layout` are `markRaw`'d and never become reactive (§5.3) — only the scalars
 * below are.
 *
 * **`generation` is the mechanism that makes a reset visible to the grid.** Nothing else
 * changes when rows are dropped and re-walked from row 0 — `loadedRows` might land on the same
 * number — and SlickGrid's row cache holds rendered rows until it is told they are stale, so it
 * would keep showing the old history. Every consumer that caches anything derived from the
 * store invalidates on `generation`.
 *
 * **Layout is driven from the append, not from the render.** After each chunk lands,
 * `layoutClient.submit(store.layoutInput(from, to))` runs and its `LayoutChunk` goes into
 * `layout`; `laneCount` updates once the submission resolves. `onChunkLayout` is the extension
 * point W6's `CommitGrid.vue` subscribes through to invalidate exactly the rows that just
 * gained lanes (`grid.invalidateRows(rows); grid.render()`) — kept as a plain subscribe/
 * unsubscribe callback (mirroring `BridgeClient.on`) rather than a direct reference to the grid,
 * so this file stays ignorant of SlickGrid entirely. This means rows can be *listed* before
 * their lanes exist, which is correct and is what makes the ≤ 300 ms first-paint budget
 * reachable: text first, graph a frame later, never a blank list waiting on a worker.
 */
export class GraphViewState {
  readonly store: CommitStore;
  readonly layout: LayoutStore;
  readonly loadedRows: ShallowRef<number>;
  readonly remaining: ShallowRef<number>;
  readonly exhausted: ShallowRef<boolean>;
  readonly lastChunkSource: ShallowRef<ChunkSource | undefined>;
  readonly laneCount: ShallowRef<number> = shallowRef(0);
  readonly loading: ShallowRef<LoadingState> = shallowRef("idle");
  readonly generation: ShallowRef<number>;

  readonly #packed: PackedStreamState;
  readonly #bridge: BridgeClient;
  readonly #layoutClient: LayoutClient;
  readonly #layoutListeners = new Set<(range: LayoutRange) => void>();
  #abortController: AbortController | undefined;
  #loadController: AbortController | undefined;
  #repoId: string | undefined;
  #layoutSubmitMarked = false;

  constructor(bridge: BridgeClient, layoutClient: LayoutClient = createLayoutClient()) {
    this.#bridge = bridge;
    this.#layoutClient = layoutClient;
    this.#packed = new PackedStreamState();
    this.store = this.#packed.store;
    this.loadedRows = this.#packed.loadedRows;
    this.remaining = this.#packed.remaining;
    this.exhausted = this.#packed.exhausted;
    this.lastChunkSource = this.#packed.lastChunkSource;
    this.generation = this.#packed.generation;
    this.layout = markRaw(new LayoutStore());
  }

  /**
   * Opens `graph.stream` for `repoId`. `resumeThroughRow` defaults to this store's own current
   * row count, which is exactly what a post-remount rehydration needs: a freshly constructed
   * `GraphViewState` (the only kind that exists right after a VS Code webview is recreated,
   * §2.1) starts at 0, so the default asks the host to replay every row it still has cached
   * from row 0 — the single round trip that is "rehydrates without re-running git" from the
   * UI's side (§5.4). The same default also makes a same-session reconnect (the store already
   * holds N rows) resume from N instead of re-fetching them.
   *
   * Supersedes any still-open stream on this instance, matching W2's own
   * supersede-on-reopen rule for the transport underneath.
   */
  async openStream(
    repoId: string,
    resumeThroughRow: number = this.loadedRows.value,
  ): Promise<void> {
    this.#repoId = repoId;
    this.#abortController?.abort();
    const controller = new AbortController();
    this.#abortController = controller;
    if (this.loading.value === "idle") this.loading.value = "streaming";
    try {
      await this.#bridge.stream(
        "graph.stream",
        { repoId, resumeThroughRow },
        (chunk) => this.#applyChunk(chunk),
        controller.signal,
      );
    } finally {
      if (this.#abortController === controller) {
        this.#abortController = undefined;
        if (this.loading.value === "streaming") this.loading.value = "idle";
      }
    }
  }

  /**
   * Loads `pages` more pages (default 1) and folds them into the store — the flow W9's
   * `LoadMoreButton.vue` drives: `graph.loadMore` reads pages into the *host's* store and
   * returns without pushing rows; the rows only arrive by re-opening `graph.stream` from
   * `loadedRows`, which the host then answers entirely from cache. Two round trips, and the
   * right shape: the alternative (one stream kept open for the session) makes the host hold a
   * stream across a webview disposal it cannot observe.
   *
   * Idempotent while already loading (§5.1.1's "a second press is a no-op, not a queued second
   * page") — including while `loadAll()`'s own loop is running, since it calls this directly.
   */
  async loadMore(pages = 1): Promise<void> {
    const repoId = this.#repoId;
    if (!repoId || this.loading.value !== "idle") return;
    const controller = new AbortController();
    this.#loadController = controller;
    try {
      await this.#runLoad("loadingMore", () =>
        this.#bridge.request("graph.loadMore", { repoId, pages }, controller.signal),
      );
    } finally {
      if (this.#loadController === controller) this.#loadController = undefined;
    }
  }

  /** Loops `loadMore` until the host reports the history exhausted (§5.1.1's Alt-click "loads
   *  everything"). Appends progressively — each `loadMore` call still folds its page in via the
   *  usual re-open-and-stream path — so the list stays live throughout rather than jumping once
   *  at the end. `cancelLoad()` stops it between pages; the page in flight when cancelled still
   *  completes and is kept (§5.1.1: "rows already read are kept") — the same one
   *  `AbortController` spans the whole loop so a cancel reaches whichever page is currently in
   *  flight, not just the next one. */
  async loadAll(): Promise<void> {
    const repoId = this.#repoId;
    if (!repoId || this.loading.value !== "idle") return;
    const controller = new AbortController();
    this.#loadController = controller;
    try {
      while (!this.exhausted.value && !controller.signal.aborted) {
        await this.#runLoad("loadingMore", () =>
          this.#bridge.request("graph.loadMore", { repoId, pages: 1 }, controller.signal),
        );
      }
    } finally {
      this.#loadController = undefined;
    }
  }

  /**
   * §6.2's refresh action: forces a full re-query bypassing every cache. `graph.refresh` only
   * marks the host's session stale — the actual re-walk happens on the `graph.stream` re-open
   * that follows, whose first chunk lands with `from: 0`, which `#applyChunk`'s own
   * restart-at-zero detection turns into a reset (clearing `store`/`layout`, resetting the
   * `LayoutClient`'s frontier, bumping `generation`) before folding the re-walked history back
   * in. Idempotent while already refreshing (§6.2: "a second press while running is a no-op").
   * Not cancellable — unlike `loadMore`/`loadAll`, §6.2 describes no cancel affordance for
   * refresh, only a spinner, so this does not touch `#loadController`.
   */
  async refresh(): Promise<void> {
    const repoId = this.#repoId;
    if (!repoId || this.loading.value !== "idle") return;
    await this.#runLoad("refreshing", () => this.#bridge.request("graph.refresh", { repoId }));
  }

  /** Runs one load-shaped operation (`graph.loadMore`/`graph.refresh`) followed by the
   *  cache-only stream re-open that actually folds the new rows in, under one `loading` state.
   *  Shared by `loadMore`/`loadAll`/`refresh` so each keeps its own idempotency check but none
   *  duplicates the "request, then reopen, then always resync" shape — including on
   *  cancellation, where the resync is what turns "rows already read are kept" into the client
   *  actually seeing them. */
  async #runLoad(state: LoadingState, request: () => Promise<unknown>): Promise<void> {
    const repoId = this.#repoId;
    if (!repoId) return;
    this.loading.value = state;
    try {
      await request();
    } catch (error) {
      if (!(error instanceof TransportError && error.code === "cancelled")) throw error;
      // Cancelled mid-request: fall through to the resync below anyway, so whatever the host
      // already read before the abort lands on the client instead of being silently dropped.
    } finally {
      try {
        await this.openStream(repoId, this.loadedRows.value);
      } finally {
        this.loading.value = "idle";
      }
    }
  }

  /** Aborts whichever of `loadMore`/`loadAll` is currently in flight. The resync each of them
   *  always performs in its `finally` (see `#runLoad`) is what keeps this a true
   *  cancel-and-keep-what-was-read rather than a cancel-and-lose-it. */
  cancelLoad(): void {
    this.#loadController?.abort();
  }

  /** Registers a handler for "this row range just gained lane layout" — W6's `CommitGrid.vue`
   *  extension point (see this class's own doc comment). Returns an unsubscribe function,
   *  mirroring `BridgeClient.on`. */
  onChunkLayout(handler: (range: LayoutRange) => void): () => void {
    this.#layoutListeners.add(handler);
    return () => this.#layoutListeners.delete(handler);
  }

  /** Clears every loaded row. Call before opening a stream for a newly *selected* repo — never
   *  needed for a fresh mount or remount, whose store already starts empty. */
  reset(): void {
    this.#resetLayout();
    this.#packed.reset();
  }

  #resetLayout(): void {
    this.layout.clear();
    this.#layoutClient.reset();
    this.laneCount.value = 0;
  }

  async #applyChunk(chunk: StreamChunkOf<"graph.stream">): Promise<void> {
    const range = await this.#packed.applyChunk(chunk, {
      onReset: () => this.#resetLayout(),
      onCorrupted: async () => {
        // The re-open supersedes this call's own still-in-flight stream (W2's
        // supersede-on-reopen rule), so nothing else from the corrupted sequence is applied
        // after this point.
        const repoId = this.#repoId;
        if (repoId) await this.openStream(repoId, 0);
      },
    });
    if (!range) return; // corrupted — already re-opening from row 0, nothing to lay out

    const { from, to } = range;
    // W15's `layoutSubmitMs` — the worker round trip for the *first* page only, so a first-page
    // `firstPageMs`/`worstFrameMs` miss is attributable to this hop or not in one line rather
    // than re-derived. Marked here, not measured externally, because this `await` is the only
    // place that round trip is ever isolated from the rest of `#applyChunk`'s own work.
    const markSubmit = !this.#layoutSubmitMarked;
    if (markSubmit) performance.mark("kira:layout-submit-start");
    const layoutChunk = await this.#layoutClient.submit(this.store.layoutInput(from, to));
    if (markSubmit) {
      this.#layoutSubmitMarked = true;
      performance.mark("kira:layout-submit-end");
      performance.measure(
        "kira:layout-submit",
        "kira:layout-submit-start",
        "kira:layout-submit-end",
      );
    }
    this.layout.append(layoutChunk);
    this.laneCount.value = this.layout.laneCount;
    for (const listener of this.#layoutListeners) listener({ from, to });
  }

  dispose(): void {
    this.#abortController?.abort();
    this.#loadController?.abort();
    this.#layoutClient.dispose();
  }
}
