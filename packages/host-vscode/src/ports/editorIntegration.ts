/**
 * `EditorIntegration` over VS Code's native diff and document APIs (P5 W5). Four details that
 * are the difference between this working and nearly working (`docs/plans/P5.md`'s W5):
 *
 * 1. The scheme is `kira-version`, registered once at activation and disposed with the
 *    extension. The URI is `kira-version:/<opaque key>/<basename>` — the key is opaque to VS
 *    Code and meaningful only to the registered `VirtualDocumentSource`; the *last* path segment
 *    is the real filename, because that is what VS Code resolves the language mode from.
 * 2. Content is cached by VS Code per URI and never invalidated: a `<rev>:<path>` blob is
 *    immutable, so this provider fires no `onDidChange` and needs no emitter.
 * 3. `vscode.diff` is always given two virtual (or empty) URIs, never the live working file —
 *    both sides of a historical diff are historical.
 * 4. `capabilities` is the constant below; `resolveConflict` (§7.11, D15) is two commands and no
 *    UI of ours — `workbench.view.scm` to reveal the SCM view, then `vscode.open` on the
 *    conflicted file, which is what routes it into the three-way merge editor when the user has
 *    it enabled and into `merge-conflict`'s inline decorations when they do not. We choose
 *    neither; both are the user's own configuration, and picking for them would be exactly the
 *    reimplementation §7.11 forbids.
 */
import type {
  Disposable,
  DocumentRef,
  EditorCapabilities,
  EditorIntegration,
  VirtualDocumentSource,
} from "@kira-version/core";
import * as vscode from "vscode";

const SCHEME = "kira-version";
/** The first path segment reserved for the "empty" side of an add/delete diff — never a real
 *  encoded key, since a real key always contains at least one percent-encoded `/` (repoId is an
 *  absolute filesystem path). */
const EMPTY_SEGMENT = "empty";

function pathSegments(uri: vscode.Uri): readonly string[] {
  return uri.path.split("/").filter((segment) => segment.length > 0);
}

function toUri(ref: DocumentRef): vscode.Uri {
  switch (ref.kind) {
    case "file":
      return vscode.Uri.file(ref.path);
    case "empty":
      return vscode.Uri.parse(`${SCHEME}:/${EMPTY_SEGMENT}/${encodeURIComponent(ref.label)}`);
    case "virtual":
      return vscode.Uri.parse(
        `${SCHEME}:/${encodeURIComponent(ref.key)}/${encodeURIComponent(ref.label)}`,
      );
  }
}

export class VsCodeEditorIntegration implements EditorIntegration {
  readonly capabilities: EditorCapabilities = {
    openInEditor: true,
    goToFile: true,
    resolveConflict: true,
  };
  #source: VirtualDocumentSource | undefined;

  registerVirtualDocuments(source: VirtualDocumentSource): Disposable {
    this.#source = source;
    const provider: vscode.TextDocumentContentProvider = {
      provideTextDocumentContent: async (uri) => {
        const segments = pathSegments(uri);
        const first = segments[0];
        if (first === undefined || first === EMPTY_SEGMENT) return "";
        const content = await this.#source?.provide(decodeURIComponent(first));
        return content ?? "";
      },
    };
    const registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider);
    return {
      dispose: () => {
        registration.dispose();
        this.#source = undefined;
      },
    };
  }

  async openDiff(req: { left: DocumentRef; right: DocumentRef; title: string }): Promise<void> {
    await vscode.commands.executeCommand(
      "vscode.diff",
      toUri(req.left),
      toUri(req.right),
      req.title,
    );
  }

  async reveal(ref: DocumentRef, line: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(toUri(ref));
    const position = new vscode.Position(Math.max(0, line - 1), 0);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(position, position),
    });
  }

  async resolveConflict(req: { readonly path: string }): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.scm");
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(req.path));
  }
}
