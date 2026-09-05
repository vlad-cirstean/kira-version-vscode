/**
 * The fixture-key format `Scenario.diffs`/`worktreeDrift` are keyed by (P5 W12) — shared between
 * `mockBridge.ts`, which parses/builds these keys at request time, and any scenario file that
 * needs to author one; living here (not in `mockBridge.ts` itself) avoids a cycle, since a
 * scenario module must never import the bridge that loads scenarios.
 */

/** Separates the two halves of a `` `${sha-or-rev}${DIFF_KEY_SEPARATOR}${path}` `` fixture key —
 *  a NUL, for the same reason `packages/git/src/rpcHandlers.ts`'s `VIRTUAL_KEY_SEPARATOR` is one:
 *  it can never legally appear inside a sha/rev or a repo-relative path, so a hand-written
 *  fixture key can never collide with a real one. Built via `fromCharCode` rather than a
 *  backslash escape, so the character stays visibly intentional in this file's own source. */
export const DIFF_KEY_SEPARATOR = String.fromCharCode(0);

export function diffKey(rev: string, path: string): string {
  return `${rev}${DIFF_KEY_SEPARATOR}${path}`;
}
