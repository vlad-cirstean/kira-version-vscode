/**
 * §7.8's search box, compiled once: three toggles and a scope, folded into a single `RegExp`
 * that `matcher.ts` runs against every field the loaded store and the streamed tail can offer.
 * `docs/plans/P11.md`'s hard part 2 is the reason there is exactly one compilation site: git
 * never sees this pattern (`--grep`/`--author`/`--committer` are ANDed across categories, not
 * ORed — probe 1), so there is nothing for a second engine to agree or disagree with.
 */

export type SearchScope = "commits" | "refs" | "both";

/** The three toggles and the scope, as the box holds them. `text` is raw user input — never
 *  pre-escaped, never pre-lowercased: escaping is `compileQuery`'s job and case folding is the
 *  `i` flag's. */
export interface SearchQuery {
  readonly text: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
  readonly scope: SearchScope;
}

/** git's own floor for `rev-parse --disambiguate` (probe 3), adopted as ours: below it a hex
 *  query matches a large fraction of any repository and buries the real hits. */
export const MIN_SHA_PREFIX = 4;
const MAX_SHA_PREFIX = 40;

export type CompiledQuery =
  | { readonly kind: "empty" }
  /** `message` is the runtime's own text with its constant `Invalid regular expression: `
   *  prefix stripped — shown inline under the box (§7.8), never thrown (probe 4). */
  | { readonly kind: "invalid"; readonly message: string }
  | {
      readonly kind: "ok";
      /** The one RegExp every match in this phase goes through. Never carries `g`/`y` — a
       *  stateful `lastIndex` shared across ~100k `test()` calls is a correctness bug, not an
       *  optimisation. */
      readonly pattern: RegExp;
      /** Set iff `text` is 4-40 hex digits, in any mode: the sha-prefix arm of §7.8's Commits
       *  scope. Lower-cased. */
      readonly shaPrefix: string | null;
    };

const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/** Escapes `.*+?^${}()|[]\` — and, deliberately, not `/` or `-`, which are literal outside a
 *  character class. */
export function escapeRegExp(text: string): string {
  return text.replace(REGEX_METACHARACTERS, "\\$&");
}

const HEX_PREFIX = new RegExp(`^[0-9a-fA-F]{${MIN_SHA_PREFIX},${MAX_SHA_PREFIX}}$`);
const INVALID_PREFIX = "Invalid regular expression: ";
const WORD_EDGE = /\w/;

/**
 * Never throws: `new RegExp` is the only fallible call here and it is inside a `try` (probe 4).
 *
 * Whole-word wraps the pattern in `\b…\b` only when the edge character is a word character;
 * otherwise it uses a lookaround (`(?<!\w)`/`(?!\w)`), since `\b` asserts a boundary that is not
 * there when the edge is not `\w` — searching `#123` with whole-word on would otherwise match
 * nothing (probe 10). The lookaround form is correct in strictly more cases than `\b`, so it is
 * the fallback rather than the exception; in `regex` mode the edge test is skipped and the
 * lookaround form is always used, since the pattern's own first/last character is not
 * necessarily the *matched* text's edge (`(foo|bar)`).
 */
export function compileQuery(query: SearchQuery): CompiledQuery {
  const text = query.text;
  if (text.length === 0) return { kind: "empty" };
  let source = query.regex ? text : escapeRegExp(text);
  if (query.wholeWord) {
    const first = text[0] as string;
    const last = text[text.length - 1] as string;
    const lead = !query.regex && WORD_EDGE.test(first) ? "\\b" : "(?<!\\w)";
    const trail = !query.regex && WORD_EDGE.test(last) ? "\\b" : "(?!\\w)";
    // The `(?:…)` wrapper is required: without it, `\bfoo|bar\b` binds the alternation wrong.
    source = `${lead}(?:${source})${trail}`;
  }
  try {
    const pattern = new RegExp(source, query.caseSensitive ? "" : "i");
    return {
      kind: "ok",
      pattern,
      shaPrefix: HEX_PREFIX.test(text) ? text.toLowerCase() : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "invalid",
      message: message.startsWith(INVALID_PREFIX) ? message.slice(INVALID_PREFIX.length) : message,
    };
  }
}
