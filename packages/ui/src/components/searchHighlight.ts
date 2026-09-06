/**
 * `docs/plans/P11.md` W13: splits a cell's text on a compiled search pattern into alternating
 * plain/matched runs — `columns.ts`'s `messageFormatter` is the only caller, building a
 * `<span class="kv-search-hit">` per matched run and a plain text node for everything between,
 * never `innerHTML` (`enableHtmlRendering: false`, §5.5).
 *
 * `pattern` is `CompiledQuery`'s own `{ kind: "ok" }.pattern` — deliberately never `i`/case-only
 * mutated or reused with `g` added in place: a shared, non-global `RegExp` carries no `lastIndex`
 * and every other caller (`matcher.ts`) relies on that staying true, so this builds a fresh
 * `g`-flagged copy off the same `source`/case-sensitivity instead of touching the original.
 */
export interface HighlightRun {
  readonly text: string;
  readonly matched: boolean;
}

export function splitHighlights(text: string, pattern: RegExp): readonly HighlightRun[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  const runs: HighlightRun[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(global)) {
    const start = match.index;
    const matchedText = match[0];
    // A zero-length match (e.g. an all-optional pattern) would otherwise spin `matchAll` forever
    // without ever advancing `lastIndex` — `matchAll` itself already guards this for a global
    // regex by bumping its internal cursor past the match, but guard here too: an empty match
    // contributes no highlighted run, and the loop still makes forward progress from `matchAll`'s
    // own iteration.
    if (matchedText.length === 0) continue;
    if (start > lastIndex) runs.push({ text: text.slice(lastIndex, start), matched: false });
    runs.push({ text: matchedText, matched: true });
    lastIndex = start + matchedText.length;
  }
  if (lastIndex < text.length) runs.push({ text: text.slice(lastIndex), matched: false });
  return runs;
}
