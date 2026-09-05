/**
 * The extension-host half of the postMessage channel (P3 W10) — the "~ten lines of channel
 * adapter" `packages/ipc/src/rpc.ts` leaves to each host. `webview.postMessage` takes no
 * transfer list at all (confirmed against `@types/vscode`'s own signature — `transfer` is
 * accepted here only for interface parity with `MessageChannelLike` and otherwise ignored), so
 * every buffer structured-clones rather than transfers — the design does not change, W17
 * measures the cost rather than assuming it away.
 *
 * **Neither a bare `ArrayBuffer` nor a `Uint8Array` survives that clone intact** — confirmed live
 * against a real, downloaded VS Code build (P15's W1 probe, `docs/plans/P15.md` Findings): a
 * bare `ArrayBuffer` arrives as `{}`. `@types/vscode` documents ArrayBuffers as "correctly
 * recreated inside of the webview" for any extension targeting 1.57+ (this one targets 1.134.0)
 * — true for a `WebviewPanel`, but this extension's view is a `WebviewView`
 * (`contributes.views[].type: "webview"`), whose own equivalent support shipped separately and,
 * empirically, does not recreate the type it started as. `createWebviewChannel` below therefore
 * declares `bufferEncoding: VSCODE_WEBVIEW_BUFFER_ENCODING` (`"base64"`) rather than `"native"` —
 * `rpc.ts`'s `post`/`receive` do the actual buffer<->base64 conversion (`packages/ipc/src/
 * codec.ts`), so this file has nothing bespoke left to do about it.
 *
 * The webview's own half (running inside the iframe, never importing `vscode`) is
 * `src/webview/main.ts` — a separate, browser-only entry point built and loaded like any other
 * host's UI bootstrap (`apps/harness/src/main.ts`'s precedent), implementing this same
 * `MessageChannelLike` shape against `window.addEventListener("message")` /
 * `acquireVsCodeApi().postMessage`, declaring the exact same constant — a mismatch between the
 * two is not a type error, it is a webview that silently renders an empty graph (P15's W5).
 */
import { type MessageChannelLike, VSCODE_WEBVIEW_BUFFER_ENCODING } from "@kira-version/ipc";
import type * as vscode from "vscode";

export function createWebviewChannel(webview: vscode.Webview): MessageChannelLike {
  return {
    bufferEncoding: VSCODE_WEBVIEW_BUFFER_ENCODING,
    post(message): void {
      void webview.postMessage(message);
    },
    onMessage(handler): () => void {
      const subscription = webview.onDidReceiveMessage((message) => handler(message));
      return () => subscription.dispose();
    },
    close(): void {
      // Nothing owned beyond the onDidReceiveMessage subscription above, which callers already
      // drop via the returned unsubscribe function — the webview itself is torn down by
      // panelView.ts's onDidDispose, not by this channel.
    },
  };
}
