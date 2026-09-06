/**
 * P8/W7 — `git fetch`'s argv and the parser for the ref-update block its stderr trails with,
 * per `docs/plans/P8.md`'s §7.1 and probe 6. `--progress` is always present: the child is not a
 * tty, and without it git emits no progress output at all. `--prune`/`--prune-tags` are both
 * explicit, caller-supplied booleans (never inferred) — D49: `--prune-tags` deletes local-only
 * tags with no undo (§7.12 says fetch never offers one), so it defaults **off** in the UI even
 * though `--prune` defaults on.
 */
import type { RefUpdate } from "@kira-version/core";

export function fetchArgs(params: {
  readonly remote: string | "--all";
  readonly prune: boolean;
  readonly pruneTags: boolean;
}): string[] {
  const args = ["fetch", "--progress"];
  if (params.prune) args.push("--prune");
  if (params.pruneTags) args.push("--prune-tags");
  args.push(params.remote);
  return args;
}

/**
 * One line of git's own post-fetch/post-push ref-update summary — the block that trails the
 * progress output on stderr (probe 6: `From <url>` followed by one line per moved ref) or, for
 * push, a `To <url>` header with the same per-ref line shape. Real shapes:
 *
 *   `   d876420..b5c3142  main       -> origin/main`                      (fast-forward)
 *   ` + 3a55c77...d462520 main       -> main            (forced update)`  (forced; note `...`)
 *   ` * [new branch]      feature    -> origin/feature`
 *   ` * [new tag]         v1.0       -> v1.0`
 *   ` - [deleted]         (none)     -> origin/old`
 *
 * `..` (two dots) is a fast-forward range; `...` (three dots) is git's own marker for a
 * non-fast-forward (forced) update, matching the leading `+` flag when present. Neither shape
 * ever prints a sha for a brand-new or deleted ref — `[new branch]`/`[new tag]`/`[deleted]` carry
 * no sha at all in the text, so this parser's `from`/`to` are both `null` for those three cases.
 * That is a real, known imprecision (this module has no second read path to resolve the actual
 * resulting sha) rather than an oversight; the ref name and `forced` flag are still reported
 * correctly, which is what `RefUpdate` promises for the "what happened" summary it feeds.
 */
const REF_LINE =
  /^\s*([+\-*!=t])?\s*([0-9a-f]{4,40}\.{2,3}[0-9a-f]{4,40}|\[[^\]]+\])\s+(\S+)\s+->\s+(\S+)(?:\s+\(([^)]+)\))?\s*$/;

export function parseRefUpdates(stderr: string): RefUpdate[] {
  const updates: RefUpdate[] = [];
  for (const rawLine of stderr.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const match = REF_LINE.exec(line);
    if (!match) continue;
    const [, flag, summary, , remoteRef, reason] = match as unknown as [
      string,
      string | undefined,
      string,
      string,
      string,
      string | undefined,
    ];
    const forced =
      flag === "+" || summary.includes("...") || (reason !== undefined && /forced/i.test(reason));

    if (summary.startsWith("[")) {
      // [new branch] / [new tag] / [deleted] / [tag update] / [rejected] — no sha in the text.
      updates.push({ ref: remoteRef, from: null, to: null, forced });
      continue;
    }

    const [from, to] = summary.split(/\.{2,3}/) as [string, string];
    updates.push({ ref: remoteRef, from, to, forced });
  }
  return updates;
}
