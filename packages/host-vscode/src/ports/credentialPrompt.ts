/**
 * `CredentialPrompt` over VS Code's input box (`docs/plans/P8.md`'s W12). `createInputBox()`
 * rather than the simpler `window.showInputBox` the plan sketches: this port's one hard
 * requirement is that it "must never hang" (`core/src/ports/credentialPrompt.ts`'s own doc
 * comment) — `request.signal` firing (the askpass broker's own bounded timeout, or the op being
 * cancelled) must make the prompt actually go away, not just abandon a promise while VS Code
 * keeps rendering it. `showInputBox`'s returned promise has no matching "cancel this" handle;
 * `InputBox.hide()`/`dispose()` does.
 */
import type { CredentialPrompt, CredentialRequest } from "@kira-version/core";
import * as vscode from "vscode";

export class VsCodeCredentialPrompt implements CredentialPrompt {
  async ask(request: CredentialRequest): Promise<string | undefined> {
    if (request.signal?.aborted) return undefined;

    return new Promise<string | undefined>((resolve) => {
      const box = vscode.window.createInputBox();
      box.password = request.masked;
      box.prompt = request.prompt;
      box.ignoreFocusOut = true;

      let settled = false;
      const disposables: vscode.Disposable[] = [];
      const settle = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        for (const d of disposables) d.dispose();
        box.dispose();
        resolve(value);
      };

      disposables.push(box.onDidAccept(() => settle(box.value)));
      // Covers both the user dismissing it (Escape / clicking away) and our own signal-driven
      // `box.hide()` below — `hide()` fires `onDidHide` too, so there is exactly one settle path.
      disposables.push(box.onDidHide(() => settle(undefined)));

      if (request.signal) {
        request.signal.addEventListener("abort", () => box.hide(), { once: true });
      }

      box.show();
    });
  }
}
