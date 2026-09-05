import { describe, expect, test } from "bun:test";
import { linkifySegments } from "../../../packages/ui/src/components/linkify.ts";

describe("linkifySegments", () => {
  test("plain text with no URL is a single text segment", () => {
    expect(linkifySegments("just a message")).toEqual([{ kind: "text", text: "just a message" }]);
  });

  test("a bare URL becomes a single link segment", () => {
    expect(linkifySegments("https://example.com/path")).toEqual([
      { kind: "link", url: "https://example.com/path" },
    ]);
  });

  test("a URL embedded in a sentence splits into text/link/text", () => {
    expect(linkifySegments("see https://example.com/x for details")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", url: "https://example.com/x" },
      { kind: "text", text: " for details" },
    ]);
  });

  test("trailing sentence punctuation is not part of the URL", () => {
    expect(linkifySegments("Fixed in https://example.com/pr/1.")).toEqual([
      { kind: "text", text: "Fixed in " },
      { kind: "link", url: "https://example.com/pr/1" },
      { kind: "text", text: "." },
    ]);
  });

  test("a closing paren with no matching open paren inside the URL is trailing punctuation", () => {
    expect(linkifySegments("(see https://example.com/x)")).toEqual([
      { kind: "text", text: "(see " },
      { kind: "link", url: "https://example.com/x" },
      { kind: "text", text: ")" },
    ]);
  });

  test("a closing paren WITH a matching open paren inside the URL stays part of it", () => {
    const wiki = "https://en.wikipedia.org/wiki/Diff_(disambiguation)";
    expect(linkifySegments(`See ${wiki} for more.`)).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", url: wiki },
      { kind: "text", text: " for more." },
    ]);
  });

  test("two URLs on the same line each become their own segment", () => {
    expect(linkifySegments("https://a.example vs https://b.example")).toEqual([
      { kind: "link", url: "https://a.example" },
      { kind: "text", text: " vs " },
      { kind: "link", url: "https://b.example" },
    ]);
  });

  test("an issue reference is never linkified (deferred to P12)", () => {
    expect(linkifySegments("Fixes #42")).toEqual([{ kind: "text", text: "Fixes #42" }]);
  });

  test("empty string yields no segments", () => {
    expect(linkifySegments("")).toEqual([]);
  });
});
