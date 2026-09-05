import { describe, expect, test } from "bun:test";
import type { OpRequest } from "../model/operation.ts";
import { UNDO_POLICY, UndoSlot, type UndoRecord } from "./slot.ts";

function record(id: string): UndoRecord {
  return {
    id,
    label: `Deleted branch ${id}`,
    recoverySha: "d657c6e",
    createdAt: 0,
    replay: [["branch", id, "d657c6e"]],
  };
}

describe("UNDO_POLICY — the total mapping", () => {
  test("every OpRequest kind has an entry (the mapped type already enforces this at compile time)", () => {
    const kinds: readonly OpRequest["kind"][] = [
      "checkout",
      "branchCreate",
      "branchDelete",
      "branchRename",
      "tagCreate",
      "tagDelete",
      "tagPush",
      "tagDeleteRemote",
      "revert",
      "opContinue",
      "opAbort",
    ];
    for (const kind of kinds) {
      expect(UNDO_POLICY[kind]).toBeDefined();
    }
  });

  test("only branchDelete and tagDelete are undoable — §7.12's two seeded rows", () => {
    expect(UNDO_POLICY.branchDelete.kind).toBe("undoable");
    expect(UNDO_POLICY.tagDelete.kind).toBe("undoable");
  });

  test("every other kind is notUndoable with a real, non-empty reason", () => {
    const notUndoableKinds: readonly OpRequest["kind"][] = [
      "checkout",
      "branchCreate",
      "branchRename",
      "tagCreate",
      "tagPush",
      "tagDeleteRemote",
      "revert",
      "opContinue",
      "opAbort",
    ];
    for (const kind of notUndoableKinds) {
      const policy = UNDO_POLICY[kind];
      expect(policy.kind).toBe("notUndoable");
      if (policy.kind === "notUndoable") {
        expect(policy.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("UndoSlot", () => {
  test("starts empty", () => {
    expect(new UndoSlot().peek()).toBeNull();
  });

  test("set() then peek() returns the record without clearing it", () => {
    const slot = new UndoSlot();
    slot.set(record("feature"));
    expect(slot.peek()?.id).toBe("feature");
    expect(slot.peek()?.id).toBe("feature"); // peek is idempotent
  });

  test("set(null) clears a previously set record", () => {
    const slot = new UndoSlot();
    slot.set(record("feature"));
    slot.set(null);
    expect(slot.peek()).toBeNull();
  });

  test("take() returns the record and clears the slot", () => {
    const slot = new UndoSlot();
    slot.set(record("feature"));
    const taken = slot.take("feature");
    expect(taken?.id).toBe("feature");
    expect(slot.peek()).toBeNull();
  });

  test("a second take() with the same id is idempotent-safe: returns null, does not throw", () => {
    const slot = new UndoSlot();
    slot.set(record("feature"));
    slot.take("feature");
    expect(slot.take("feature")).toBeNull();
  });

  test("take() with a mismatched id returns null and does not clear the slot", () => {
    const slot = new UndoSlot();
    slot.set(record("feature"));
    expect(slot.take("other-id")).toBeNull();
    expect(slot.peek()?.id).toBe("feature");
  });

  test("take() on an empty slot returns null", () => {
    expect(new UndoSlot().take("anything")).toBeNull();
  });
});
