/**
 * §7.12's undo slot. `UndoSlot` is the mutable, session-scoped container the executor
 * (`RepoService.runOp`, W8) calls unconditionally after every op; `UNDO_POLICY` is the total
 * mapping over `OpRequest["kind"]` that makes adding a new destructive operation without stating
 * its undo policy a compile error rather than a silent gap — §7.12's "so adding a new destructive
 * operation without an undo entry is a visible omission rather than a silent one", read literally.
 */
import type { OpRequest } from "../model/operation.ts";

export interface UndoRecord {
  readonly id: string;
  /** "Deleted branch feature" — §7.12's "labelled with what it will undo". */
  readonly label: string;
  /** "was d657c6e" — shown alongside the button so the user can recover manually even after the
   *  slot is cleared. */
  readonly recoverySha: string;
  readonly createdAt: number;
  /** The argv sequence that undoes it, applied in order. A list because restoring a branch is a
   *  ref write plus zero or more config writes (probe P4: `branch.<name>.remote`/`.merge`). */
  readonly replay: readonly (readonly string[])[];
}

export type UndoPolicy =
  | { readonly kind: "undoable" }
  | { readonly kind: "notUndoable"; readonly reason: string };

/**
 * A mapped type over `OpRequest`'s discriminant: `[K in OpRequest["kind"]]` means a new member
 * added to that union without a corresponding entry here fails `tsc`, which is the whole
 * mechanism (`docs/plans/P6.md`'s W3). Every `notUndoable` reason is real user-facing text — the
 * tooltip on the (cleared) undo affordance when the last op was one of these — never a
 * placeholder, per §7.12's "we never present an undo we cannot honour" being honest only if the
 * alternative is stated.
 */
export const UNDO_POLICY: { readonly [K in OpRequest["kind"]]: UndoPolicy } = {
  checkout: { kind: "notUndoable", reason: "Switch back to the previous ref to undo this." },
  branchCreate: { kind: "notUndoable", reason: "Delete the branch to undo this." },
  branchDelete: { kind: "undoable" },
  branchRename: { kind: "notUndoable", reason: "Rename it back to undo this." },
  tagCreate: { kind: "notUndoable", reason: "Delete the tag to undo this." },
  tagDelete: { kind: "undoable" },
  tagPush: { kind: "notUndoable", reason: "A push is not undone locally (§7.12)." },
  tagDeleteRemote: { kind: "notUndoable", reason: "Push the tag again to undo this." },
  revert: { kind: "notUndoable", reason: "Revert the revert, or use Reset once it ships." },
  opContinue: { kind: "notUndoable", reason: "Continuing an operation has no undo." },
  opAbort: { kind: "notUndoable", reason: "Aborting an operation has no undo." },
};

/**
 * One slot per session, holding at most one `UndoRecord`. §7.12's "bounded window" is deliberately
 * not a wall-clock timer here (open question 6): the slot lives until the next operation clears
 * it, until the session/repo closes (the slot simply goes out of scope with it), or until
 * `take()`'s caller (W8's `undo.run`) finds the recovery object no longer resolves.
 */
export class UndoSlot {
  #record: UndoRecord | null = null;

  peek(): UndoRecord | null {
    return this.#record;
  }

  /** §7.12: "Performing another operation clears the undo slot." The executor calls this for
   *  EVERY op, with `null` for a non-undoable one — clearing is the default, retaining the
   *  explicit act. */
  set(record: UndoRecord | null): void {
    this.#record = record;
  }

  /** Returns the record and clears the slot, so a replayed undo cannot be replayed twice. `null`
   *  when there is no record, or `id` does not match the one currently held (stale UI, a second
   *  op already cleared it). */
  take(id: string): UndoRecord | null {
    if (this.#record === null || this.#record.id !== id) return null;
    const record = this.#record;
    this.#record = null;
    return record;
  }
}
