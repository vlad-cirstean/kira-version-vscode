import { describe, expect, test } from "bun:test";
import type { RefRecord } from "../model/ref.ts";
import { classifyTagCreate, validateRefName } from "./tag.ts";

function ref(partial: Partial<RefRecord>): RefRecord {
  return {
    refname: "refs/tags/v1",
    kind: "tag",
    shortName: "v1",
    objectId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    objectType: "commit",
    peeledObjectId: undefined,
    upstream: undefined,
    track: undefined,
    committerDate: 0,
    isHead: false,
    checkedOutIn: undefined,
    annotation: undefined,
    ...partial,
  };
}

describe("validateRefName — the pure prefilter (probe P3)", () => {
  test("empty string is rejected", () => {
    expect(validateRefName("").valid).toBe(false);
  });

  test("a leading '-' is rejected (git would read it as an option)", () => {
    expect(validateRefName("-x").valid).toBe(false);
  });

  test("'@{' is rejected — check-ref-format RESOLVES it rather than validating it literally", () => {
    expect(validateRefName("@{-1}").valid).toBe(false);
    expect(validateRefName("foo@{bar").valid).toBe(false);
  });

  test("an ordinary name is valid", () => {
    expect(validateRefName("v1.2.0")).toEqual({ valid: true, error: undefined });
    expect(validateRefName("feature/thing")).toEqual({ valid: true, error: undefined });
  });
});

describe("classifyTagCreate", () => {
  test("an invalid name short-circuits to verdict 'invalidName'", () => {
    const result = classifyTagCreate({ name: "", existing: undefined, force: false });
    expect(result.nameValid).toBe(false);
    expect(result.verdict).toBe("invalidName");
  });

  test("a fresh name with nothing existing ⇒ clean", () => {
    const result = classifyTagCreate({ name: "v2", existing: undefined, force: false });
    expect(result.exists).toBe(false);
    expect(result.verdict).toBe("clean");
  });

  test("an existing name without force ⇒ blockedByExisting", () => {
    const result = classifyTagCreate({ name: "v1", existing: ref({}), force: false });
    expect(result.verdict).toBe("blockedByExisting");
  });

  test("an existing LIGHTWEIGHT tag with force ⇒ movesWithForce, no annotation to preserve", () => {
    const result = classifyTagCreate({
      name: "v1",
      existing: ref({ objectType: "commit" }),
      force: true,
    });
    expect(result.verdict).toBe("movesWithForce");
    expect(result.existingIsAnnotated).toBe(false);
    expect(result.requiresAnnotationToPreserve).toBe(false);
  });

  test("an existing ANNOTATED tag with force ⇒ movesWithForce AND requiresAnnotationToPreserve (probe P3)", () => {
    const result = classifyTagCreate({
      name: "ann-tag",
      existing: ref({ objectType: "tag", peeledObjectId: "commitsha" }),
      force: true,
    });
    expect(result.verdict).toBe("movesWithForce");
    expect(result.existingIsAnnotated).toBe(true);
    expect(result.requiresAnnotationToPreserve).toBe(true);
  });
});
