/**
 * The `WebviewViewProvider` for `kiraVersion.review` (P7 W8, §2.1/§6.8). `panelView.ts`'s
 * sibling, deliberately *not* a refactor of it into a shared base class — the two differ in the
 * four things that matter (which HTML is rendered, whether `setUiVisible` is called, what
 * `onDidDispose` tears down, and whether a target can be pushed in), and a base class hiding
 * four differences behind three template methods would be harder to read than two eighty-line
 * files.
 *
 * Two things a future reader may be tempted to "fix", both load-bearing:
 *
 * 1. This class never calls `service.setUiVisible`. That toggle exists so the panel's own
 *    background-refresh posture (§5.4) can go quiet while hidden; the review view has no
 *    equivalent background work; the panel and the review view are two independent webviews
 *    that can both be visible at once, and `setUiVisible` is keyed by `repoId`, not by webview —
 *    calling it here would let the review view's hide/show cycle stomp the panel's own posture
 *    for the same repo.
 * 2. `onDidDispose` calls `service.endReview(repoId)`, never just the server/subscription
 *    teardown `panelView.ts` does. §6.8's lifecycle is explicit: "when the sidebar is hidden and
 *    the webview disposed, the session is simply gone" (D38) — the review walk must not outlive
 *    the webview the way the panel's own walk outlives a hidden panel.
 */
import type {
  Clipboard,
  Dialogs,
  Disposable,
  EditorIntegration,
  Logger,
  Settings,
  WorkspaceRoots,
} from "@kira-version/core";
import type { RepoService } from "@kira-version/git";
import { createRepoHandlers } from "@kira-version/git";
import type { RpcServer, SettingsSnapshot } from "@kira-version/ipc";
import { createRpcServer } from "@kira-version/ipc";
import * as vscode from "vscode";
import type { ReviewTarget } from "./html.ts";
import { renderHtml } from "./html.ts";
import { createWebviewChannel } from "./transport.ts";

const REVIEW_FOCUS_COMMAND = "kiraVersion.review.focus";

export interface KiraReviewViewProviderDeps {
  readonly extensionUri: vscode.Uri;
  readonly service: RepoService;
  readonly roots: WorkspaceRoots;
  readonly dialogs: Dialogs;
  readonly settings: () => Settings;
  readonly logger: Logger;
  readonly editor: EditorIntegration;
  readonly clipboard: Clipboard;
}

export class KiraReviewViewProvider implements vscode.WebviewViewProvider {
  readonly #deps: KiraReviewViewProviderDeps;
  #server: RpcServer | undefined;
  #changeSubscription: Disposable | undefined;
  /** The target a cold `resolveWebviewView` should seed into the bootstrap island — set by
   *  `reviewBranch` before the view is revealed, read (and left in place, so a subsequent hide/
   *  reveal without an intervening `reviewBranch` call still repaints the same review) here. */
  #pendingTarget: ReviewTarget | null = null;

  constructor(deps: KiraReviewViewProviderDeps) {
    this.#deps = deps;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const { extensionUri, service, roots, dialogs, settings, logger, editor, clipboard } =
      this.#deps;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "..", "..", "dist", "ui")],
    };
    webviewView.webview.html = renderHtml({
      webview: webviewView.webview,
      extensionUri,
      view: "review",
      target: this.#pendingTarget,
    });

    const channel = createWebviewChannel(webviewView.webview);
    const handlers = createRepoHandlers({
      service,
      roots,
      dialogs,
      settings,
      host: "vscode",
      logger,
      editor,
      clipboard,
      revealReview: (repoId, branch) => this.reviewBranch(repoId, branch),
    });
    const server = createRpcServer(channel, handlers);
    this.#server = server;
    this.#changeSubscription = service.onChanged((event) => server.emit("repo.changed", event));

    webviewView.onDidDispose(() => {
      this.#changeSubscription?.dispose();
      this.#changeSubscription = undefined;
      server.dispose();
      if (this.#server === server) this.#server = undefined;
      // §6.8's lifecycle, D38: the review walk does not outlive the webview the way the panel's
      // own walk outlives a hidden panel — there is no rehydration guarantee here to preserve.
      service.endReview(repoId(this.#pendingTarget));
    });
  }

  /**
   * Reveals the review view, optionally targeting `branch` in `repoId`. Both undefined is the
   * palette command's own case (§6.8/D40): reveal with no target at all and let the view ask —
   * for a repo first if none is open yet (the same repo-open flow the panel itself falls back
   * to, reused rather than a second host-side picker), then for a branch, in the same ask-state
   * vocabulary §6.8 already defines for a missing base. `review.open`'s caller (the panel
   * webview) always supplies both — it already knows its own active repo.
   *
   * Reveal, then either seed a cold resolve or push `review.target` to an already-live one:
   * `resolveWebviewView` only runs on reveal-from-hidden, and reviewing a second branch must
   * replace an already-open view's contents rather than being silently ignored.
   */
  reviewBranch(repoId: string | undefined, branch: string | undefined): void {
    // A review targeting a different repo than the one already open leaves that other repo's
    // `RepoSession` with a walk nothing will ever read again (D38: at most one review walk's
    // worth of state should exist for a session no longer being reviewed) — end it explicitly
    // rather than waiting on eviction. The common case (same repo, a different branch, or the
    // same branch with an overridden base) needs no such cleanup: `resolveReviewBase`'s own
    // `#ensureReviewWalk` already reopens the walk in place when the range changes.
    if (this.#pendingTarget && this.#pendingTarget.repoId !== repoId) {
      this.#deps.service.endReview(this.#pendingTarget.repoId);
    }
    this.#pendingTarget = repoId !== undefined && branch !== undefined ? { repoId, branch } : null;
    void vscode.commands.executeCommand(REVIEW_FOCUS_COMMAND);
    if (this.#pendingTarget) {
      this.#server?.emit("review.target", {
        repoId: this.#pendingTarget.repoId,
        branch: this.#pendingTarget.branch,
      });
    }
  }

  /** Pushed by `extension.ts` after `onDidChangeConfiguration` re-coerces the settings snapshot
   *  — a no-op when no webview is currently resolved (view collapsed or never opened). */
  notifySettingsChanged(settings: SettingsSnapshot): void {
    this.#server?.emit("settings.changed", { settings });
  }
}

/** `endReview` takes a `repoId`; a view disposed before any target was ever set has none to end
 *  — `RepoService.endReview` is already a silent no-op for a `repoId` with no open session (its
 *  own doc comment), so an empty string here reaches that same no-op path rather than needing a
 *  second guard. */
function repoId(target: ReviewTarget | null): string {
  return target?.repoId ?? "";
}
