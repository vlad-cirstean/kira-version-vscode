/**
 * The extension-host half of the postMessage channel (P3 W10) — the "~ten lines of channel
 * adapter" `packages/ipc/src/rpc.ts` leaves to each host. `webview.postMessage` takes no
 * transfer list at all (confirmed against `@types/vscode`'s own signature — `transfer` is
 * accepted here only for interface parity with `MessageChannelLike` and otherwise ignored), so
 * every buffer structured-clones rather than transfers — the design does not change, W17
 * measures the cost rather than assuming it away.
 *
 * **Neither a bare `ArrayBuffer` nor a `Uint8Array` survives that clone intact (P4c, confirmed
 * live).** `@types/vscode` documents ArrayBuffers as "correctly recreated inside of the webview"
 * for any extension targeting 1.57+ (this one targets 1.134.0) — true for a `WebviewPanel`, but
 * this extension's view is a `WebviewView` (`contributes.views[].type: "webview"`), whose own
 * equivalent support shipped separately and, empirically, neither recreates the type it started
 * as: a bare `ArrayBuffer` (no own enumerable properties) arrives as `{}`, and a `Uint8Array`
 * fares only a little better, arriving as a plain object keyed by stringified index
 * (`{"0":123,"1":185,...}`, no `length`) rather than a real typed array — both confirmed by
 * logging the message actually received in a real, downloaded VS Code build; the mock bridges
 * every other host and test uses never exercise this real boundary at all. A genuine `Array`
 * *does* survive as a genuine `Array`, so `toWireSafe` below converts every `ArrayBuffer` it
 * finds into a plain `number[]` immediately before the one real `postMessage` call — nothing
 * downstream changes, since every consumer already does `new Uint8Array(chunk.field)`, and that
 * constructor accepts a plain array of numbers exactly as it does an `ArrayBuffer`. Scoped to
 * this one host rather than to `PackedCommitChunk`'s own field types
 * (`packages/ipc/src/contract.ts`) or to `packages/ipc/src/codec.ts` generally: every other
 * transport (the harness's mock bridge, the layout worker's real `MessageChannel`) already
 * carries a bare `ArrayBuffer` correctly, and nothing about their contract needed to change to
 * fix a bug specific to this one real transport.
 *
 * The webview's own half (running inside the iframe, never importing `vscode`) is
 * `src/webview/main.ts` — a separate, browser-only entry point built and loaded like any other
 * host's UI bootstrap (`apps/harness/src/main.ts`'s precedent), implementing this same
 * `MessageChannelLike` shape against `window.addEventListener("message")` /
 * `acquireVsCodeApi().postMessage`.
 */
import type { MessageChannelLike } from "@kira-version/ipc";
import type * as vscode from "vscode";

/** Walks `value`, replacing every `ArrayBuffer` with a plain `number[]` of its bytes — see this
 *  file's own doc comment for why a real `Array` is the one shape that actually survives.
 *  Mirrors `packages/ipc/src/codec.ts`'s `collectTransferables` traversal
 *  (array/plain-object/typed-array-or-buffer), but rebuilds rather than collects: an
 *  already-typed-array view is returned as-is (nothing on this contract sends one today — see
 *  `packages/ipc/src/contract.ts` — so there is nothing real to convert it against), so this
 *  only ever touches the exact values that would otherwise arrive empty. */
function toWireSafe(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value) || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(toWireSafe);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toWireSafe(item)]));
}

export function createWebviewChannel(webview: vscode.Webview): MessageChannelLike {
  return {
    post(message): void {
      void webview.postMessage(toWireSafe(message));
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
