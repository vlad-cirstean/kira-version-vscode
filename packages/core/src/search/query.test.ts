import { describe, expect, test } from "bun:test";
import type { SearchQuery } from "./query.ts";
import { compileQuery, escapeRegExp, MIN_SHA_PREFIX } from "./query.ts";

function query(partial: Partial<SearchQuery>): SearchQuery {
  return {
    text: "",
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    scope: "commits",
    ...partial,
  };
}

describe("escapeRegExp", () => {
  test("escapes every regex metacharacter", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal `${}` pair (two of the metacharacters escapeRegExp() itself escapes), not a mistaken template placeholder.
    expect(escapeRegExp(".*+?^${}()|[]\\")).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
  });

  test("leaves / and - untouched — literal outside a character class", () => {
    expect(escapeRegExp("a/b-c")).toBe("a/b-c");
  });
});

describe("compileQuery — empty and invalid", () => {
  test("empty text compiles to {kind: 'empty'}", () => {
    expect(compileQuery(query({ text: "" }))).toEqual({ kind: "empty" });
  });

  test("an unbalanced group in regex mode compiles to {kind: 'invalid'}, never throws", () => {
    const result = compileQuery(query({ text: "foo(", regex: true }));
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      // The runtime's constant "Invalid regular expression: " prefix is stripped (probe 4) —
      // the message shown inline (§7.8) is the rest of the engine's own text.
      expect(result.message).not.toContain("Invalid regular expression");
    }
  });

  test("a literal query (regex off) is always valid, even with metacharacters", () => {
    const result = compileQuery(query({ text: "foo(", regex: false }));
    expect(result.kind).toBe("ok");
  });
});

describe("compileQuery — sha-prefix arm", () => {
  test(`a ${MIN_SHA_PREFIX}-40 char hex string sets shaPrefix, lower-cased`, () => {
    const result = compileQuery(query({ text: "218224" }));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.shaPrefix).toBe("218224");
  });

  test("upper-case hex is lower-cased in shaPrefix", () => {
    const result = compileQuery(query({ text: "ABCDEF" }));
    if (result.kind === "ok") expect(result.shaPrefix).toBe("abcdef");
  });

  test(`fewer than ${MIN_SHA_PREFIX} hex digits leaves shaPrefix null (probe 3)`, () => {
    const result = compileQuery(query({ text: "218" }));
    if (result.kind === "ok") expect(result.shaPrefix).toBeNull();
  });

  test("a non-hex string leaves shaPrefix null even at 4+ chars", () => {
    const result = compileQuery(query({ text: "widget" }));
    if (result.kind === "ok") expect(result.shaPrefix).toBeNull();
  });
});

describe("compileQuery — case toggle", () => {
  test("case-insensitive (default) matches either case", () => {
    const result = compileQuery(query({ text: "widget" }));
    if (result.kind === "ok") {
      expect(result.pattern.test("WIDGET")).toBe(true);
      expect(result.pattern.test("widget")).toBe(true);
    }
  });

  test("case-sensitive rejects a differently-cased match", () => {
    const result = compileQuery(query({ text: "widget", caseSensitive: true }));
    if (result.kind === "ok") {
      expect(result.pattern.test("WIDGET")).toBe(false);
      expect(result.pattern.test("widget")).toBe(true);
    }
  });
});

describe("compileQuery — whole-word toggle", () => {
  test("a word-edged literal wraps in a real word boundary", () => {
    const result = compileQuery(query({ text: "widget", wholeWord: true }));
    if (result.kind === "ok") {
      expect(result.pattern.test("a widget here")).toBe(true);
      expect(result.pattern.test("subwidgetary")).toBe(false);
      expect(result.pattern.test("widget-ish")).toBe(true); // '-' is not \w: right edge still fires
    }
  });

  test("a punctuation-edged literal (#123) falls back to a lookaround (probe 10)", () => {
    // `\b#123\b` would fail: `\b` needs a \w character on one side of the boundary, and neither
    // edge of "#123" is one — the very case query.ts's own doc comment names.
    const result = compileQuery(query({ text: "#123", wholeWord: true }));
    if (result.kind === "ok") {
      expect(result.pattern.test("fix (#123)")).toBe(true);
      expect(result.pattern.test("fix (#1234)")).toBe(false);
    }
  });

  test("regex mode always uses the lookaround form, even for a word-edged pattern", () => {
    // The pattern's own first/last character is not necessarily the matched text's edge
    // (an alternation like `(foo|bar)`), so the edge test is skipped entirely in regex mode.
    const result = compileQuery(query({ text: "wid(get|ening)", wholeWord: true, regex: true }));
    if (result.kind === "ok") {
      expect(result.pattern.test("Fix the widget cache")).toBe(true);
      expect(result.pattern.test("subwidgetary")).toBe(false);
    }
  });
});
