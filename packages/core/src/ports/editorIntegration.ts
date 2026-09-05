/**
 * The host's native diff view and "reveal a line" capability (P5, §3.3: "the one port whose
 * contract is genuinely richer than a single call"). Describes a native diff, a reveal-at-a-line,
 * and a lazily-materialized read-only document — without knowing that git exists.
 *
 * `packages/host-vscode/src/ports/editorIntegration.ts` is the shipped implementation, over
 * `vscode.workspace.registerTextDocumentContentProvider`,
 * `vscode.commands.executeCommand("vscode.diff", …)` and
 * `window.showTextDocument(doc, { selection })`.
 */
import type { Disposable } from "./disposable.ts";

export type DocumentRef =
  /** An absolute path on disk. */
  | { readonly kind: "file"; readonly path: string }
  /** Content the app produces on demand; `label` is the filename the host shows, which is also
   *  what drives its syntax highlighting. */
  | { readonly kind: "virtual"; readonly key: string; readonly label: string }
  /** The empty side of an add or a delete. */
  | { readonly kind: "empty"; readonly label: string };

export interface VirtualDocumentSource {
  /** Resolves the text for a key previously handed to `openDiff`/`reveal`; `undefined` if it
   *  is no longer resolvable (the repo was closed). */
  provide(key: string): Promise<string | undefined>;
}

export interface EditorCapabilities {
  readonly openInEditor: boolean;
  readonly goToFile: boolean;
}

export interface EditorIntegration {
  readonly capabilities: EditorCapabilities;
  /** Registered once, at activation. */
  registerVirtualDocuments(source: VirtualDocumentSource): Disposable;
  openDiff(req: { left: DocumentRef; right: DocumentRef; title: string }): Promise<void>;
  /** Opens `ref` and puts the cursor on `line` (1-based). */
  reveal(ref: DocumentRef, line: number): Promise<void>;
}
