import type { ResultOf } from "@kira-version/ipc";
import { TransportError } from "@kira-version/ipc";
import { type ShallowRef, shallowRef } from "vue";
import type { BridgeClient } from "../bridge/client.ts";

export type CommitDetail = ResultOf<"commit.detail">;
export type FileDiffResult = ResultOf<"commit.fileDiff">;

/** `"detail"` shows `CommitMeta.vue` + `FileTree.vue`; `"diff"` is W9's take-over of the pane by
 *  the currently selected file's diff. */
export type DetailMode = "detail" | "diff";
export type FileListMode = "tree" | "flat";

/**
 * `docs/plans/P5.md` W7: the detail pane's state machine, kept out of any SFC so W13 can test
 * the transitions directly and a later phase can mount the same components in a sidebar. Every
 * field is `shallowRef` (§5.3) — `detail`/`diff` payloads are plain data, never made reactive
 * themselves.
 *
 * **Sequencing.** Selecting a new commit aborts any in-flight `commit.detail`; moving the file
 * cursor aborts any in-flight `commit.fileDiff` — one request per kind, exactly as
 * `GraphViewState` already does for its own streams. Aborting alone is not enough (an abort
 * racing a resolution can still resolve), so every response additionally checks, right before
 * committing itself to a ref, that the sha/parentIndex/selectedFile it was requested for is
 * still the one currently selected — a response for anything else is dropped in silence, not
 * rendered.
 */
export class DetailState {
  readonly sha: ShallowRef<string | null> = shallowRef(null);
  readonly parentIndex: ShallowRef<number> = shallowRef(0);
  readonly detail: ShallowRef<CommitDetail | undefined> = shallowRef(undefined);
  readonly error: ShallowRef<string | undefined> = shallowRef(undefined);

  readonly mode: ShallowRef<DetailMode> = shallowRef("detail");
  /** An index into `detail.value.files`, or `-1` when no file is selected. */
  readonly selectedFile: ShallowRef<number> = shallowRef(-1);
  readonly diff: ShallowRef<FileDiffResult | undefined> = shallowRef(undefined);
  readonly diffError: ShallowRef<string | undefined> = shallowRef(undefined);

  readonly listMode: ShallowRef<FileListMode> = shallowRef("tree");
  readonly filter: ShallowRef<string> = shallowRef("");

  /** W10's copy/"Go to file" outcome text — fed into `App.vue`'s single shared live region
   *  alongside the load-more/refresh announcements it already carries. A plain string, not a
   *  queue: a second announcement while the first is still being read simply replaces it, the
   *  same trade-off the existing live region already makes. */
  readonly announcement: ShallowRef<string> = shallowRef("");

  readonly #bridge: BridgeClient;
  #repoId: string | undefined;
  #detailController: AbortController | undefined;
  #diffController: AbortController | undefined;

  constructor(bridge: BridgeClient) {
    this.#bridge = bridge;
  }

  /** Called whenever the active repo changes — `commit.detail`/`commit.fileDiff` both need a
   *  `repoId`, and this class does not otherwise track which repo it belongs to. */
  setRepoId(repoId: string | undefined): void {
    this.#repoId = repoId;
  }

  /**
   * Selects a different commit (`SelectionState`'s own sha, mirrored here by the caller):
   * resets `parentIndex` to 0, `mode` to `"detail"`, and clears `selectedFile`/`diff` — the file
   * you were reading may not exist in the other commit's tree at all, and carrying a stale
   * selection across is how a diff ends up labelled with the wrong path. Selecting the *same*
   * sha again is P4's toggle and never reaches this method (callers only invoke it on an actual
   * change).
   */
  select(sha: string | null): void {
    this.#detailController?.abort();
    this.#diffController?.abort();
    this.sha.value = sha;
    this.parentIndex.value = 0;
    this.detail.value = undefined;
    this.error.value = undefined;
    this.mode.value = "detail";
    this.selectedFile.value = -1;
    this.diff.value = undefined;
    this.diffError.value = undefined;
    if (sha !== null) void this.#requestDetail();
  }

  /** Re-requests the detail for the *same* commit against a different parent (merges only) —
   *  the file list is per-parent, so `selectedFile`/`mode`/`diff` reset exactly as a commit
   *  change does, but `sha` itself is untouched. */
  setParentIndex(index: number): void {
    if (this.parentIndex.value === index) return;
    this.#diffController?.abort();
    this.parentIndex.value = index;
    this.mode.value = "detail";
    this.selectedFile.value = -1;
    this.diff.value = undefined;
    this.diffError.value = undefined;
    void this.#requestDetail();
  }

  /** Moves the file cursor and opens its diff (W8's tree click/Enter/arrow-nav, W9's Alt+arrow
   *  file-to-file navigation). Re-selecting the file that is *already* the cursor — including
   *  after `showTree()` moved `mode` back to `"detail"` without discarding `selectedFile` — only
   *  flips `mode` back to `"diff"` and never re-requests: the previous `commit.fileDiff` result
   *  is still sitting in `diff`, valid and unchanged. */
  selectFile(index: number): void {
    if (this.selectedFile.value === index) {
      this.mode.value = "diff";
      return;
    }
    this.selectedFile.value = index;
    this.mode.value = "diff";
    void this.#requestFileDiff();
  }

  /** `←`/`Backspace`/the back affordance/`Esc` (W9): returns to the tree without discarding
   *  which file was selected, so re-opening the same file does not re-request its diff. */
  showTree(): void {
    this.mode.value = "detail";
  }

  setListMode(mode: FileListMode): void {
    this.listMode.value = mode;
  }

  setFilter(text: string): void {
    this.filter.value = text;
  }

  announce(text: string): void {
    this.announcement.value = text;
  }

  async #requestDetail(): Promise<void> {
    const repoId = this.#repoId;
    const sha = this.sha.value;
    if (!repoId || !sha) return;
    const controller = new AbortController();
    this.#detailController = controller;
    const parentIndex = this.parentIndex.value;
    const stillCurrent = (): boolean =>
      this.sha.value === sha && this.parentIndex.value === parentIndex;
    try {
      const result = await this.#bridge.request(
        "commit.detail",
        { repoId, sha, parentIndex },
        controller.signal,
      );
      if (!stillCurrent()) return;
      this.detail.value = result;
    } catch (error) {
      if (error instanceof TransportError && error.code === "cancelled") return;
      if (!stillCurrent()) return;
      this.error.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.#detailController === controller) this.#detailController = undefined;
    }
  }

  async #requestFileDiff(): Promise<void> {
    const repoId = this.#repoId;
    const sha = this.sha.value;
    const detail = this.detail.value;
    const index = this.selectedFile.value;
    if (!repoId || !sha || !detail) return;
    const change = detail.files[index];
    if (!change) return;
    this.#diffController?.abort();
    const controller = new AbortController();
    this.#diffController = controller;
    this.diffError.value = undefined;
    const parentIndex = this.parentIndex.value;
    const stillCurrent = (): boolean =>
      this.sha.value === sha &&
      this.parentIndex.value === parentIndex &&
      this.selectedFile.value === index;
    try {
      const result = await this.#bridge.request(
        "commit.fileDiff",
        {
          repoId,
          sha,
          path: change.path,
          ...(change.originalPath !== undefined ? { originalPath: change.originalPath } : {}),
          parentIndex,
        },
        controller.signal,
      );
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

  dispose(): void {
    this.#detailController?.abort();
    this.#diffController?.abort();
  }
}
