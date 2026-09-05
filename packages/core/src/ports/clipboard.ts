/**
 * Writes text to the system clipboard (P5, §3.3: "copy sha, branch, message"). One method —
 * branch copying arrives with P6's ref surface and needs nothing more from this port.
 *
 * A failure **propagates** rather than being swallowed into a boolean: `rpcHandlers.ts`'s
 * `clipboard.write` lets it reach the UI as a wire error, so the pane can say what went wrong
 * (§6.4: "if the clipboard write fails, say so; a copy affordance that silently does nothing is
 * worse than none"). The VS Code implementation is `vscode.env.clipboard.writeText`.
 */
export interface Clipboard {
  writeText(text: string): Promise<void>;
}
