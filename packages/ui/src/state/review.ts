import type { BaseResolution, CommitRange } from "@kira-version/ipc";
import { TransportError } from "@kira-version/ipc";
import { type ShallowRef, shallowRef } from "vue";
import type { BridgeClient } from "../bridge/client.ts";
import { copyToClipboard } from "./clipboardActions.ts";
import { DetailState } from "./detail.ts";
import type { Capabilities, DetailActions } from "./detailActions.ts";
import { PackedStreamState } from "./packedStream.ts";

/**
 * The sidebar review view's whole state machine (P7 W10, §6.8):
 *
 * ```
 * idle ──setTarget(branch)──> resolving ──> ask | unrelated | empty | listing
 *                                                ^                      |
 *                                                └──── setBase ─────────┘
 * ```
 *
 * Composes `PackedStreamState` (P7 W10's own extraction, open question 8) with no `onReset`
 * hook — a range walk draws no lanes (§6.8/D41), so there is nothing beyond the packed columns
 * themselves to reset. Every request is supersede-and-verify, `DetailState`'s own discipline:
 * a response checks the branch/base it was requested for is still current before committing
 * itself, because an abort racing a resolution can still resolve.
 */
export type ReviewPhase =
  | "idle"
  | "resolving"
  | "ask"
  | "unrelated"
  | "empty"
  | "listing"
  | "error";

export interface ReviewExpansion {
  readonly detail: DetailState;
  readonly actions: DetailActions;
}

/** "The outcome or the count changed" (D39's mid-review `refsChanged` resolution) — compares the
 *  two things a background re-resolve can find different: which base (and thus which range
 *  shape) applies, and, when both are `ready`, how many commits are in it. `reason` is
 *  deliberately not compared: the same base re-detected via a different reason (say, an upstream
 *  that now happens to match the already-current default branch) is not a change worth a banner. */
function resolutionsDiffer(a: BaseResolution, b: BaseResolution): boolean {
  if (a.base !== b.base) return true;
  if (a.range.kind !== b.range.kind) return true;
  if (a.range.kind === "ready" && b.range.kind === "ready") {
    return a.range.commitCount !== b.range.commitCount;
  }
  return false;
}

export class ReviewSessionState {
  readonly phase: ShallowRef<ReviewPhase> = shallowRef("idle");
  readonly repoId: ShallowRef<string | undefined> = shallowRef(undefined);
  readonly branch: ShallowRef<string | undefined> = shallowRef(undefined);
  readonly resolution: ShallowRef<BaseResolution | undefined> = shallowRef(undefined);
  readonly resolveError: ShallowRef<string | undefined> = shallowRef(undefined);
  readonly isLoadingMore: ShallowRef<boolean> = shallowRef(false);
  /** D39: a background re-resolve found the outcome or the count changed. Never applied
   *  automatically — `acknowledgeStaleReview()` is the only thing that acts on it. */
  readonly staleReview: ShallowRef<boolean> = shallowRef(false);
  /** One shared announcement feeding one live region (`liveAnnouncements.ts`'s own precedent) —
   *  every expanded row's `DetailActions` writes here rather than each owning its own region. */
  readonly announcement: ShallowRef<string> = shallowRef("");
  readonly expandedShas: ShallowRef<ReadonlySet<string>> = shallowRef(new Set());

  readonly #packed: PackedStreamState;
  readonly #bridge: BridgeClient;
  readonly #capabilities: Capabilities;
  readonly #expansions = new Map<string, ReviewExpansion>();
  readonly #unsubscribeChanged: () => void;
  #resolveController: AbortController | undefined;
  #streamController: AbortController | undefined;
  #loadController: AbortController | undefined;
  /** The base actually in effect — `undefined` until a `ready`/`unrelated`/`empty` resolution
   *  lands (never set while `reason: "none"`, since there is no base at all then). Distinct
   *  from `resolution.value.base` only in that this is what `loadMore`/re-open/the background
   *  check reuse, so an override survives a background re-check exactly as §6.8 says it should
   *  ("the override holds for the session"). */
  #base: string | undefined;
  #pendingResolution: BaseResolution | undefined;

  constructor(bridge: BridgeClient, capabilities: Capabilities) {
    this.#bridge = bridge;
    this.#capabilities = capabilities;
    this.#packed = new PackedStreamState();
    this.#unsubscribeChanged = bridge.on("repo.changed", (event) => {
      if (event.kind !== "refsChanged") return;
      if (this.repoId.value !== event.repoId) return;
      if (this.phase.value === "idle" || this.phase.value === "resolving") return;
      void this.#checkForChange();
    });
  }

  get store(): PackedStreamState["store"] {
    return this.#packed.store;
  }

  get loadedRows(): ShallowRef<number> {
    return this.#packed.loadedRows;
  }

  get remaining(): ShallowRef<number> {
    return this.#packed.remaining;
  }

  get exhausted(): ShallowRef<boolean> {
    return this.#packed.exhausted;
  }

  get generation(): ShallowRef<number> {
    return this.#packed.generation;
  }

  /** Targets a new branch — aborts everything in flight, clears rows and expansions, and
   *  requests `review.resolveBase` with no override. The entry point for all three of §6.8's
   *  "how the view learns which branch to review" arms (D40): a cold bootstrap target, a
   *  `review.target` push, and the palette's own branch picker once it has one to hand over. */
  async setTarget(repoId: string, branch: string): Promise<void> {
    this.#abortAll();
    this.#clearExpansions();
    this.#packed.reset();
    this.repoId.value = repoId;
    this.branch.value = branch;
    this.#base = undefined;
    this.resolution.value = undefined;
    this.resolveError.value = undefined;
    this.staleReview.value = false;
    this.#pendingResolution = undefined;
    this.phase.value = "resolving";
    await this.#resolve(repoId, branch, undefined);
  }

  /** The header picker's override (§6.8): re-resolves **with** an explicit base, exactly the
   *  same request shape a detected base gets, so a user-chosen base is checked (`merge-base`,
   *  `rev-list --count`) rather than trusted blind. */
  async setBase(base: string): Promise<void> {
    const repoId = this.repoId.value;
    const branch = this.branch.value;
    if (!repoId || !branch) return;
    this.#resolveController?.abort();
    this.#streamController?.abort();
    this.#loadController?.abort();
    this.#clearExpansions();
    this.#packed.reset();
    this.resolveError.value = undefined;
    this.staleReview.value = false;
    this.#pendingResolution = undefined;
    this.phase.value = "resolving";
    await this.#resolve(repoId, branch, base);
  }

  /** §6.8's "Load more" (D42) — pages the review walk, then re-opens the stream exactly as
   *  `GraphViewState.loadMore` does for the panel: the same two-round-trip host contract, one
   *  `range` param threaded through both requests instead of none. */
  async loadMore(pages = 1): Promise<void> {
    const repoId = this.repoId.value;
    const branch = this.branch.value;
    const base = this.#base;
    if (!repoId || !branch || base === undefined || this.isLoadingMore.value) return;
    const range: CommitRange = { base, branch };
    const controller = new AbortController();
    this.#loadController = controller;
    this.isLoadingMore.value = true;
    try {
      await this.#bridge.request("graph.loadMore", { repoId, pages, range }, controller.signal);
    } catch (error) {
      if (!(error instanceof TransportError && error.code === "cancelled")) throw error;
    } finally {
      try {
        if (this.repoId.value === repoId && this.branch.value === branch && this.#base === base) {
          await this.#open(repoId, branch, base);
        }
      } finally {
        if (this.#loadController === controller) this.#loadController = undefined;
        this.isLoadingMore.value = false;
      }
    }
  }

  /** The "comparison has changed" banner's own click handler (D39). Applies the resolution the
   *  background check already found and re-walks — the only path by which a mid-review
   *  `refsChanged` ever changes what is on screen. */
  async acknowledgeStaleReview(): Promise<void> {
    const repoId = this.repoId.value;
    const branch = this.branch.value;
    const pending = this.#pendingResolution;
    if (!repoId || !branch || !pending) return;
    this.staleReview.value = false;
    this.#pendingResolution = undefined;
    this.#abortAll();
    this.#clearExpansions();
    this.#packed.reset();
    this.resolution.value = pending;
    this.#base = pending.base ?? undefined;
    await this.#applyResolution(repoId, branch, pending);
  }

  /** Expands a row (first expansion fetches `commit.detail`; a later re-expansion reuses the
   *  same, still-live `DetailState` — §6.8 step 2's "fetched on first expansion and kept for the
   *  session"). No-op with no active repo. */
  expand(sha: string): void {
    const repoId = this.repoId.value;
    if (!repoId) return;
    if (this.expandedShas.value.has(sha)) return;
    this.expandedShas.value = new Set(this.expandedShas.value).add(sha);
    if (!this.#expansions.has(sha)) {
      const detail = new DetailState(this.#bridge);
      detail.setRepoId(repoId);
      this.#expansions.set(sha, { detail, actions: this.#createRowActions(repoId) });
      detail.select(sha);
    }
  }

  /** Collapses a row without discarding its `DetailState` — re-expanding does not re-fetch. */
  collapse(sha: string): void {
    if (!this.expandedShas.value.has(sha)) return;
    const next = new Set(this.expandedShas.value);
    next.delete(sha);
    this.expandedShas.value = next;
  }

  toggle(sha: string): void {
    if (this.expandedShas.value.has(sha)) this.collapse(sha);
    else this.expand(sha);
  }

  expansionFor(sha: string): ReviewExpansion | undefined {
    return this.#expansions.get(sha);
  }

  async #resolve(repoId: string, branch: string, base: string | undefined): Promise<void> {
    this.#resolveController?.abort();
    const controller = new AbortController();
    this.#resolveController = controller;
    const stillCurrent = (): boolean =>
      this.repoId.value === repoId && this.branch.value === branch;
    try {
      const result = await this.#bridge.request(
        "review.resolveBase",
        { repoId, branch, ...(base !== undefined ? { base } : {}) },
        controller.signal,
      );
      if (!stillCurrent()) return;
      this.resolution.value = result;
      this.#base = result.base ?? undefined;
      await this.#applyResolution(repoId, branch, result);
    } catch (error) {
      if (error instanceof TransportError && error.code === "cancelled") return;
      if (!stillCurrent()) return;
      this.phase.value = "error";
      this.resolveError.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.#resolveController === controller) this.#resolveController = undefined;
    }
  }

  async #applyResolution(repoId: string, branch: string, result: BaseResolution): Promise<void> {
    switch (result.range.kind) {
      case "ask":
        this.phase.value = "ask";
        return;
      case "unrelated":
        this.phase.value = "unrelated";
        return;
      case "empty":
        this.phase.value = "empty";
        return;
      case "ready": {
        this.phase.value = "listing";
        const base = result.base;
        if (base !== null) await this.#open(repoId, branch, base);
        return;
      }
    }
  }

  async #open(repoId: string, branch: string, base: string): Promise<void> {
    this.#streamController?.abort();
    const controller = new AbortController();
    this.#streamController = controller;
    const range: CommitRange = { base, branch };
    try {
      await this.#bridge.stream(
        "graph.stream",
        { repoId, range },
        (chunk) => this.#applyChunk(repoId, branch, base, chunk),
        controller.signal,
      );
    } finally {
      if (this.#streamController === controller) this.#streamController = undefined;
    }
  }

  async #applyChunk(
    repoId: string,
    branch: string,
    base: string,
    chunk: Parameters<PackedStreamState["applyChunk"]>[0],
  ): Promise<void> {
    await this.#packed.applyChunk(chunk, {
      onCorrupted: async () => {
        if (this.repoId.value === repoId && this.branch.value === branch && this.#base === base) {
          await this.#open(repoId, branch, base);
        }
      },
    });
  }

  async #checkForChange(): Promise<void> {
    const repoId = this.repoId.value;
    const branch = this.branch.value;
    const current = this.resolution.value;
    if (!repoId || !branch || !current) return;
    try {
      const fresh = await this.#bridge.request("review.resolveBase", {
        repoId,
        branch,
        ...(this.#base !== undefined ? { base: this.#base } : {}),
      });
      // Superseded by a real setTarget/setBase (or another background check) while this one
      // was in flight — the newer call's own resolution already reflects reality.
      if (this.repoId.value !== repoId || this.branch.value !== branch) return;
      if (!resolutionsDiffer(current, fresh)) return;
      this.#pendingResolution = fresh;
      this.staleReview.value = true;
    } catch {
      // A background check nobody asked for failing is not itself surfaced — the view stays
      // exactly as it was, silently, until the next `refsChanged` tries again.
    }
  }

  #createRowActions(repoId: string): DetailActions {
    return {
      capabilities: this.#capabilities,
      copy: (text, whatCopied) => {
        void copyToClipboard(this.#bridge, text, whatCopied).then((outcome) => {
          this.announcement.value = outcome.message;
        });
      },
      announce: (text) => {
        this.announcement.value = text;
      },
      openInEditor: async ({ sha, path, originalPath, parentIndex }) => {
        await this.#bridge.request("editor.openDiff", {
          repoId,
          sha,
          path,
          ...(originalPath !== undefined ? { originalPath } : {}),
          parentIndex,
        });
      },
      goToFile: async ({ rev, path, line }) =>
        this.#bridge.request("editor.goToFile", { repoId, rev, path, line }),
    };
  }

  #clearExpansions(): void {
    for (const { detail } of this.#expansions.values()) detail.dispose();
    this.#expansions.clear();
    this.expandedShas.value = new Set();
  }

  #abortAll(): void {
    this.#resolveController?.abort();
    this.#streamController?.abort();
    this.#loadController?.abort();
  }

  dispose(): void {
    this.#abortAll();
    this.#clearExpansions();
    this.#unsubscribeChanged();
  }
}
