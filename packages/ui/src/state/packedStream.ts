import { CommitStore } from "@kira-version/core";
import type { StreamChunkOf } from "@kira-version/ipc";
import { markRaw, type ShallowRef, shallowRef } from "vue";

export type ChunkSource = StreamChunkOf<"graph.stream">["source"];

/** The row range a chunk just appended — `{from, to}` straight off `PackedCommitChunk`, handed
 *  back to the caller so it can do whatever comes after the append (P4's lane-layout submission;
 *  P7's review view does nothing with it at all). `undefined` when the chunk was corrupted and
 *  recovery already kicked off a fresh re-open — there is nothing for the caller to do with a
 *  range that was never actually applied. */
export interface AppliedChunkRange {
  readonly from: number;
  readonly to: number;
}

export interface ApplyChunkHooks {
  /** Called when this chunk triggers a restart-at-row-0 reset, *before* the reset itself runs —
   *  the caller's own chance to clear whatever it layers on top of the store (P4's lane layout;
   *  P7's `review.ts` has nothing extra to clear and omits this). */
  readonly onReset?: () => void;
  /** Called instead of applying the chunk when `CommitStore.appendPacked` rejects it (an
   *  out-of-order or duplicated chunk — a genuinely corrupted stream). The caller is expected to
   *  re-open its stream from row 0, mirroring the one recovery both `graphView.ts` and
   *  `review.ts` need. */
  readonly onCorrupted: (error: unknown) => void | Promise<void>;
}

/**
 * The chunk-application core `GraphViewState` (P4) and `ReviewSessionState` (P7) both need,
 * extracted verbatim from `GraphViewState`'s original `#applyChunk`/`#reset` (P7 W10, open
 * question 8): the reset-on-`from: 0` rule, the `appendPacked` call, the corrupted-chunk
 * recovery (log, let the caller re-open from row 0), and the `loadedRows`/`remaining`/
 * `exhausted`/`lastChunkSource`/`generation` reactive scalars. It owns a `CommitStore` and
 * nothing else — no layout, no bridge, no knowledge of what a "row" means beyond a slice of
 * that store. `GraphViewState` composes this and layers its own lane-layout submission and
 * `laneCount` on top via `ApplyChunkHooks.onReset`; the review view's `ReviewSessionState`
 * composes it with no such hook, because a range walk draws no lanes (§6.8/D41).
 *
 * `store` is `markRaw`'d and never becomes reactive (§5.3) — only the scalars below are.
 * **`generation` is the mechanism that makes a reset visible to a grid or list** built on top:
 * nothing else changes when rows are dropped and re-walked from row 0 (`loadedRows` might land
 * on the same number), so every consumer that caches anything derived from the store
 * invalidates on `generation`.
 */
export class PackedStreamState {
  readonly store: CommitStore;
  readonly loadedRows: ShallowRef<number> = shallowRef(0);
  readonly remaining: ShallowRef<number> = shallowRef(0);
  readonly exhausted: ShallowRef<boolean> = shallowRef(false);
  readonly lastChunkSource: ShallowRef<ChunkSource | undefined> = shallowRef(undefined);
  readonly generation: ShallowRef<number> = shallowRef(0);

  constructor() {
    this.store = markRaw(new CommitStore());
  }

  /** Clears every loaded row and bumps `generation`. Callable directly (P7's `review.ts` resets
   *  on every `setTarget`/`setBase`, not only on a restart-at-zero chunk); `applyChunk` also
   *  calls this internally when it detects the restart-at-zero condition itself. */
  reset(): void {
    this.store.clear();
    this.loadedRows.value = 0;
    this.remaining.value = 0;
    this.exhausted.value = false;
    this.lastChunkSource.value = undefined;
    this.generation.value++;
  }

  async applyChunk(
    chunk: StreamChunkOf<"graph.stream">,
    hooks: ApplyChunkHooks,
  ): Promise<AppliedChunkRange | undefined> {
    if (chunk.from === 0 && this.store.rowCount > 0) {
      hooks.onReset?.();
      this.reset();
    }

    try {
      this.store.appendPacked(chunk.commits);
    } catch (error) {
      // A genuinely corrupted stream (§5.5's store asserts are the right place to catch this
      // and the wrong place to recover from it): log it and let the caller re-open from row 0
      // instead of leaving an unhandled rejection and a half-populated list on screen.
      console.error("packedStream: appendPacked failed, re-opening from row 0", error);
      await hooks.onCorrupted(error);
      return undefined;
    }

    this.loadedRows.value = this.store.rowCount;
    this.remaining.value = chunk.remaining;
    this.exhausted.value = chunk.exhausted;
    this.lastChunkSource.value = chunk.source;
    return { from: chunk.commits.from, to: chunk.commits.to };
  }
}
