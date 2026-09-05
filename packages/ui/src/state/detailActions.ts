import type { GoToFileOutcome, ResultOf } from "@kira-version/ipc";
import type { BridgeClient } from "../bridge/client.ts";
import { copyToClipboard } from "./clipboardActions.ts";
import type { DetailState } from "./detail.ts";

export type Capabilities = ResultOf<"app.init">["capabilities"];

/**
 * P5 W10's single bundle of "things the detail pane's components can *do*", passed down as one
 * prop rather than threading `BridgeClient` + `capabilities` + `DetailState.announce` separately
 * through `CommitMeta.vue`/`FileTree.vue`/`DiffView.vue`. `capabilities` is read once per render
 * (it never changes after `app.init` resolves for a given session — a host does not grow a port
 * mid-session), which is why every one of them gates on `actions.capabilities.*` directly rather
 * than through another accessor.
 */
export interface DetailActions {
  readonly capabilities: Capabilities;
  /** Copies `text` via `clipboard.write` and feeds the resulting announcement into the shared
   *  live region — fire-and-forget from the caller's own perspective (a button click handler),
   *  since every copy site's feedback is the same live-region text plus its own local ~1.5s
   *  inline confirmation, never a value the caller needs to await. */
  copy(text: string, whatCopied: string): void;
  /** Feeds W10's "Open in editor"/"Go to file" outcome text into the same shared live region
   *  `copy`'s own announcements use — kept as a separate method (rather than routing through
   *  `copy`) because these are not clipboard outcomes and should never be confused for one in a
   *  test asserting which `clipboard.write` calls actually happened. */
  announce(text: string): void;
  /** "Open in editor" (§6.4/D14a's sibling action) — hands the same two blobs to the host's
   *  native diff. A no-op (never called) when `capabilities.openInEditor` is false; callers gate
   *  the button on that themselves rather than this method re-checking it. */
  openInEditor(params: {
    sha: string;
    path: string;
    originalPath: string | undefined;
    parentIndex: number;
  }): Promise<void>;
  /** "Go to file" (D14a) — `rev`/`path`/`line` are exactly the algorithm at the top of the plan
   *  already resolved; this method only makes the request and returns the outcome, it does not
   *  compute `rev`/`line` itself (that stays in `DiffView.vue`, the one place that knows which
   *  side of the diff the cursor is on). */
  goToFile(params: { rev: string; path: string; line: number }): Promise<GoToFileOutcome>;
}

export function createDetailActions(
  bridge: BridgeClient,
  detailState: DetailState,
  capabilities: Capabilities,
  repoId: () => string | undefined,
): DetailActions {
  return {
    capabilities,
    copy(text, whatCopied) {
      void copyToClipboard(bridge, text, whatCopied).then((outcome) => {
        detailState.announce(outcome.message);
      });
    },
    announce(text) {
      detailState.announce(text);
    },
    async openInEditor({ sha, path, originalPath, parentIndex }) {
      const repo = repoId();
      if (!repo) return;
      await bridge.request("editor.openDiff", {
        repoId: repo,
        sha,
        path,
        ...(originalPath !== undefined ? { originalPath } : {}),
        parentIndex,
      });
    },
    async goToFile({ rev, path, line }) {
      const repo = repoId();
      if (!repo) throw new Error("createDetailActions: goToFile called with no active repo");
      return bridge.request("editor.goToFile", { repoId: repo, rev, path, line });
    },
  };
}
