import { describe, expect, test } from "bun:test";
import {
  rewrittenPathsArgs,
  switchArgs,
  switchCreateTrackingArgs,
  switchDetachArgs,
} from "./checkout.ts";

describe("switchArgs", () => {
  test("plain switch: --no-guess always present", () => {
    expect(switchArgs("topic")).toEqual(["switch", "--no-guess", "topic"]);
  });

  test("discard route: --discard-changes inserted before the target", () => {
    expect(switchArgs("topic", { discard: true })).toEqual([
      "switch",
      "--no-guess",
      "--discard-changes",
      "topic",
    ]);
  });

  test("discard: false behaves exactly like omitting the option", () => {
    expect(switchArgs("topic", { discard: false })).toEqual(["switch", "--no-guess", "topic"]);
  });
});

describe("switchDetachArgs", () => {
  test("a tag, a raw sha, or a remote-tracking ref: --detach, no --no-guess", () => {
    expect(switchDetachArgs("v1.0.0")).toEqual(["switch", "--detach", "v1.0.0"]);
    expect(switchDetachArgs("abc1234")).toEqual(["switch", "--detach", "abc1234"]);
  });

  test("discard route: --discard-changes inserted before --detach (P6/W8)", () => {
    expect(switchDetachArgs("v1.0.0", { discard: true })).toEqual([
      "switch",
      "--discard-changes",
      "--detach",
      "v1.0.0",
    ]);
  });
});

describe("switchCreateTrackingArgs (P6/W8's createsTracking executor route)", () => {
  test("switch -c <branch> <upstream>, no --no-guess (the name is already explicit)", () => {
    expect(switchCreateTrackingArgs("topic", "origin/topic")).toEqual([
      "switch",
      "-c",
      "topic",
      "origin/topic",
    ]);
  });

  test("discard route: --discard-changes inserted before -c", () => {
    expect(switchCreateTrackingArgs("topic", "origin/topic", { discard: true })).toEqual([
      "switch",
      "--discard-changes",
      "-c",
      "topic",
      "origin/topic",
    ]);
  });
});

describe("rewrittenPathsArgs", () => {
  test("T: git diff --name-only -z HEAD <target>", () => {
    expect(rewrittenPathsArgs("origin/main")).toEqual([
      "diff",
      "--name-only",
      "-z",
      "HEAD",
      "origin/main",
    ]);
  });
});
