import { describe, expect, test } from "bun:test";
import type { RefRow } from "../../../packages/ipc/src/index.ts";
import {
  canSubmitTagCreate,
  classifyTagName,
} from "../../../packages/ui/src/components/dialogs/tagDialogModel.ts";

function tag(overrides: Partial<RefRow> = {}): RefRow {
  return {
    refname: "refs/tags/v1",
    kind: "tag",
    shortName: "v1",
    objectId: "a".repeat(40),
    peeledObjectId: "b".repeat(40),
    upstream: undefined,
    track: undefined,
    committerDate: 0,
    isHead: false,
    checkedOutIn: undefined,
    annotation: undefined,
    ...overrides,
  };
}

describe("classifyTagName", () => {
  test("a brand new name: clean", () => {
    expect(classifyTagName("v2", [], false).verdict).toBe("clean");
  });

  test("probe P3: a name containing @{ is rejected before any spawn is proposed", () => {
    const state = classifyTagName("@{-1}", [], false);
    expect(state.nameValid).toBe(false);
    expect(state.verdict).toBe("invalidName");
  });

  test("an existing name without force: blockedByExisting", () => {
    expect(classifyTagName("v1", [tag()], false).verdict).toBe("blockedByExisting");
  });

  test("an existing name with force: movesWithForce", () => {
    expect(classifyTagName("v1", [tag()], true).verdict).toBe("movesWithForce");
  });

  test("forcing over an existing annotated tag requires re-supplying the annotation", () => {
    const state = classifyTagName(
      "v1",
      [tag({ annotation: { tagger: "a", date: 0, subject: "s" } })],
      true,
    );
    expect(state.existingIsAnnotated).toBe(true);
    expect(state.requiresAnnotationToPreserve).toBe(true);
  });

  test("forcing over an existing lightweight tag has nothing to preserve", () => {
    const state = classifyTagName("v1", [tag({ annotation: undefined })], true);
    expect(state.requiresAnnotationToPreserve).toBe(false);
  });
});

describe("canSubmitTagCreate", () => {
  test("a clean, lightweight tag may submit with no message", () => {
    expect(canSubmitTagCreate(classifyTagName("v2", [], false), false, "")).toBe(true);
  });

  test("an invalid name may never submit", () => {
    expect(canSubmitTagCreate(classifyTagName("@{-1}", [], false), false, "")).toBe(false);
  });

  test("blockedByExisting (force not yet confirmed) may never submit", () => {
    expect(canSubmitTagCreate(classifyTagName("v1", [tag()], false), false, "")).toBe(false);
  });

  test("annotated requires a non-empty message", () => {
    expect(canSubmitTagCreate(classifyTagName("v2", [], false), true, "")).toBe(false);
    expect(canSubmitTagCreate(classifyTagName("v2", [], false), true, "release notes")).toBe(true);
  });

  test("forcing over an annotated tag without re-annotating: blocked, silence would lose data", () => {
    const state = classifyTagName(
      "v1",
      [tag({ annotation: { tagger: "a", date: 0, subject: "s" } })],
      true,
    );
    expect(canSubmitTagCreate(state, false, "")).toBe(false);
    expect(canSubmitTagCreate(state, true, "")).toBe(false);
    expect(canSubmitTagCreate(state, true, "keeping the note")).toBe(true);
  });
});
