import { describe, expect, test } from "bun:test";
import type { RefRecord } from "./ref.ts";
import { isAnnotated, tagTargetCommit } from "./tag.ts";

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

describe("isAnnotated", () => {
  test("lightweight tag (objectType commit) is not annotated", () => {
    expect(isAnnotated(ref({ objectType: "commit" }))).toBe(false);
  });

  test("annotated tag (objectType tag) is annotated", () => {
    expect(isAnnotated(ref({ objectType: "tag", peeledObjectId: "bbb" }))).toBe(true);
  });

  test("a branch ref is not annotated", () => {
    expect(isAnnotated(ref({ kind: "branch", objectType: "commit" }))).toBe(false);
  });
});

describe("tagTargetCommit", () => {
  test("lightweight tag: objectId is already the commit", () => {
    const record = ref({ objectType: "commit", objectId: "commit-sha", peeledObjectId: undefined });
    expect(tagTargetCommit(record)).toBe("commit-sha");
  });

  test("annotated tag: peeledObjectId is the commit, not the tag object's own sha", () => {
    const record = ref({
      objectType: "tag",
      objectId: "tag-object-sha",
      peeledObjectId: "commit-sha",
    });
    expect(tagTargetCommit(record)).toBe("commit-sha");
  });
});
