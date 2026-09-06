import { describe, expect, test } from "bun:test";
import { splitHighlights } from "../../../packages/ui/src/components/searchHighlight.ts";

describe("splitHighlights", () => {
  test("no match: one plain run covering the whole text", () => {
    expect(splitHighlights("unrelated change", /widget/i)).toEqual([
      { text: "unrelated change", matched: false },
    ]);
  });

  test("a single mid-string match splits into plain, matched, plain", () => {
    expect(splitHighlights("Fix the widget cache", /widget/i)).toEqual([
      { text: "Fix the ", matched: false },
      { text: "widget", matched: true },
      { text: " cache", matched: false },
    ]);
  });

  test("a match at the very start has no leading plain run", () => {
    expect(splitHighlights("widget cache", /widget/i)).toEqual([
      { text: "widget", matched: true },
      { text: " cache", matched: false },
    ]);
  });

  test("a match at the very end has no trailing plain run", () => {
    expect(splitHighlights("fix the widget", /widget/i)).toEqual([
      { text: "fix the ", matched: false },
      { text: "widget", matched: true },
    ]);
  });

  test("a non-global pattern still highlights every occurrence — this function builds its own g copy", () => {
    expect(splitHighlights("widget widget", /widget/i)).toEqual([
      { text: "widget", matched: true },
      { text: " ", matched: false },
      { text: "widget", matched: true },
    ]);
  });

  test("an already-global pattern is used as-is, still highlighting every occurrence", () => {
    expect(splitHighlights("widget widget widget", /widget/gi)).toEqual([
      { text: "widget", matched: true },
      { text: " ", matched: false },
      { text: "widget", matched: true },
      { text: " ", matched: false },
      { text: "widget", matched: true },
    ]);
  });

  test("case-sensitive pattern only highlights the exact-case occurrence", () => {
    expect(splitHighlights("widget WIDGET", /widget/)).toEqual([
      { text: "widget", matched: true },
      { text: " WIDGET", matched: false },
    ]);
  });

  test("a whole match (the entire text) yields one matched run and no plain runs", () => {
    expect(splitHighlights("widget", /widget/i)).toEqual([{ text: "widget", matched: true }]);
  });

  test("empty text yields no runs at all", () => {
    expect(splitHighlights("", /widget/i)).toEqual([]);
  });

  test("a zero-length match (an all-optional pattern) contributes no run and does not hang", () => {
    // `x?` matches the empty string everywhere — every run must come back plain, and the call
    // must terminate (the very failure mode this function's own doc comment guards against).
    const runs = splitHighlights("abc", /x?/);
    expect(runs.every((r) => !r.matched)).toBe(true);
    expect(runs.map((r) => r.text).join("")).toBe("abc");
  });

  test("adjacent matches with nothing between them produce no empty plain run", () => {
    expect(splitHighlights("aa", /a/g)).toEqual([
      { text: "a", matched: true },
      { text: "a", matched: true },
    ]);
  });
});
