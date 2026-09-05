import { describe, expect, test } from "bun:test";
import {
  tagCreateArgs,
  tagDeleteArgs,
  tagDeleteRemoteArgs,
  tagPushArgs,
  undoAnnotatedTagArgs,
  undoLightweightTagArgs,
} from "./tag.ts";

describe("tagCreateArgs — §7.9's whole table", () => {
  test("create lightweight", () => {
    expect(tagCreateArgs("v1", "abc1234")).toEqual(["tag", "v1", "abc1234"]);
  });

  test("create annotated", () => {
    expect(tagCreateArgs("v1", "abc1234", { message: "release" })).toEqual([
      "tag",
      "-a",
      "-m",
      "release",
      "v1",
      "abc1234",
    ]);
  });

  test("move (lightweight): -f, no message", () => {
    expect(tagCreateArgs("v1", "def5678", { force: true })).toEqual([
      "tag",
      "-f",
      "v1",
      "def5678",
    ]);
  });

  test("move (annotated): -f -a -m <msg> — probe P3's re-supply requirement", () => {
    expect(tagCreateArgs("v1", "def5678", { message: "re-release", force: true })).toEqual([
      "tag",
      "-f",
      "-a",
      "-m",
      "re-release",
      "v1",
      "def5678",
    ]);
  });
});

describe("delete / push", () => {
  test("delete local", () => {
    expect(tagDeleteArgs("v1")).toEqual(["tag", "-d", "v1"]);
  });

  test("delete on remote: its own explicitly labelled push --delete, never triggered by local delete", () => {
    expect(tagDeleteRemoteArgs("origin", "v1")).toEqual(["push", "origin", "--delete", "v1"]);
  });

  test("push one", () => {
    expect(tagPushArgs("origin", ["v1"])).toEqual(["push", "origin", "v1"]);
  });

  test("push several", () => {
    expect(tagPushArgs("origin", ["v1", "v2"])).toEqual(["push", "origin", "v1", "v2"]);
  });

  test("push all: --tags, no explicit names", () => {
    expect(tagPushArgs("origin", "all")).toEqual(["push", "origin", "--tags"]);
  });
});

describe("undo", () => {
  test("undoAnnotatedTagArgs: update-ref at the TAG OBJECT's sha, not tag -a", () => {
    expect(undoAnnotatedTagArgs("v1", "tagObjectSha")).toEqual([
      "update-ref",
      "refs/tags/v1",
      "tagObjectSha",
    ]);
  });

  test("undoLightweightTagArgs: update-ref at the commit sha", () => {
    expect(undoLightweightTagArgs("v1", "commitSha")).toEqual([
      "update-ref",
      "refs/tags/v1",
      "commitSha",
    ]);
  });
});
