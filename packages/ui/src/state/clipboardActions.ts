import type { BridgeClient } from "../bridge/client.ts";

export interface ClipboardOutcome {
  readonly ok: boolean;
  /** §6.4's own required wording: "Copied full SHA" on success, "Couldn't copy — <reason>" on a
   *  rejection — composed once, here, so every copy site (the sha column button, `CommitMeta.vue`'s
   *  two sha buttons and its message button, `FileTree.vue`'s per-row path affordance) reports the
   *  same wording rather than each inventing its own. */
  readonly message: string;
}

/**
 * P5 W10's one path to the `Clipboard` port: every copy site calls this rather than
 * `bridge.request("clipboard.write", ...)` directly, so a rejection is never silently swallowed
 * (§6.4: "silence is the one unacceptable outcome") and every site's wording matches. `whatCopied`
 * names the thing for the success message ("full SHA", "short SHA", "commit message", a file
 * path) and doubles as `clipboard.write`'s own `label` param — the host's log line only, never the
 * copied text itself.
 */
export async function copyToClipboard(
  bridge: BridgeClient,
  text: string,
  whatCopied: string,
): Promise<ClipboardOutcome> {
  try {
    await bridge.request("clipboard.write", { text, label: whatCopied });
    return { ok: true, message: `Copied ${whatCopied}` };
  } catch (error) {
    console.error(`clipboard.write failed (${whatCopied}):`, error);
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Couldn't copy — ${reason}` };
  }
}
