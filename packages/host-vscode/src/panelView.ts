/**
 * The `WebviewViewProvider` for `kiraVersion.graph` (P3 W10, §2.1). `retainContextWhenHidden`
 * is deliberately left off — W9's rehydration exists precisely so we do not pay for it — so
 * `resolveWebviewView` runs again on every hide/reveal and must rebuild the channel and the
 * `RpcServer` from scratch each time.
 *
 * `onDidDispose` tears down the RPC server and the channel but never the `RepoService`: the
 * cached store outliving a hidden/disposed webview is the entire mechanism (§5.4), and disposing
 * it here would produce a phase that passes its own tests and fails its exit criterion.
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
import { renderHtml } from "./html.ts";
import { createWebviewChannel } from "./transport.ts";

export interface KiraGraphViewProviderDeps {
  readonly extensionUri: vscode.Uri;
  readonly service: RepoService;
  readonly roots: WorkspaceRoots;
  readonly dialogs: Dialogs;
  readonly settings: () => Settings;
  readonly logger: Logger;
  readonly editor: EditorIntegration;
  readonly clipboard: Clipboard;
}

export class KiraGraphViewProvider implements vscode.WebviewViewProvider {
  readonly #deps: KiraGraphViewProviderDeps;
  #server: RpcServer | undefined;
  #changeSubscription: Disposable | undefined;

  constructor(deps: KiraGraphViewProviderDeps) {
    this.#deps = deps;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const { extensionUri, service, roots, dialogs, settings, logger, editor, clipboard } =
      this.#deps;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "..", "..", "dist", "ui")],
    };
    webviewView.webview.html = renderHtml({ webview: webviewView.webview, extensionUri });

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
    });
    const server = createRpcServer(channel, handlers);
    this.#server = server;
    this.#changeSubscription = service.onChanged((event) => server.emit("repo.changed", event));

    webviewView.onDidChangeVisibility(() => service.setUiVisible(webviewView.visible));
    webviewView.onDidDispose(() => {
      this.#changeSubscription?.dispose();
      this.#changeSubscription = undefined;
      server.dispose();
      if (this.#server === server) this.#server = undefined;
    });
  }

  /** Pushed by `extension.ts` after `onDidChangeConfiguration` re-coerces the settings snapshot
   *  — a no-op when no webview is currently resolved (panel collapsed or never opened). */
  notifySettingsChanged(settings: SettingsSnapshot): void {
    this.#server?.emit("settings.changed", { settings });
  }
}
