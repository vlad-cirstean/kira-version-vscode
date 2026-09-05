/**
 * `Clipboard` over `vscode.env.clipboard.writeText` (P5 W5) — one method, and a rejection
 * propagates rather than being swallowed, exactly as `core/src/ports/clipboard.ts` documents.
 */
import type { Clipboard } from "@kira-version/core";
import * as vscode from "vscode";

export class VsCodeClipboard implements Clipboard {
  async writeText(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
  }
}
