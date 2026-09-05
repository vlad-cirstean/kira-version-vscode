/**
 * `docs/plans/P6.md` W15: `TagDialog.vue`'s pure half. P6 has no `preflight.tagCreate` wire entry
 * (only checkout and revert get one — see `contract.ts`'s own comment), so this is a structural
 * adaptation of `core`'s `classifyTagCreate` over the wire's `RefRow` rather than a `RefRecord`:
 * a `RefRow` already carries `annotation` directly, so there is nothing here that needs
 * `objectType`/`isAnnotated` at all. `validateRefName` itself IS imported from `core` — it takes
 * no `RefRecord`, so there is no reason to duplicate probe P3's own `@{`/leading-`-`/empty rules.
 */
import { validateRefName } from "@kira-version/core";
import type { RefRow } from "@kira-version/ipc";

export type TagCreateVerdict = "clean" | "blockedByExisting" | "movesWithForce" | "invalidName";

export interface TagCreateState {
  readonly nameValid: boolean;
  readonly nameError: string | undefined;
  readonly exists: boolean;
  readonly existingIsAnnotated: boolean;
  /** Probe P3: `git tag -f <name> <sha>` on an existing ANNOTATED tag silently downgrades it to
   *  lightweight unless `-a -m` is re-supplied — true only on the force path over such a tag. */
  readonly requiresAnnotationToPreserve: boolean;
  readonly verdict: TagCreateVerdict;
}

export function classifyTagName(
  name: string,
  existingTags: readonly RefRow[],
  force: boolean,
): TagCreateState {
  const { valid, error } = validateRefName(name);
  if (!valid) {
    return {
      nameValid: false,
      nameError: error,
      exists: false,
      existingIsAnnotated: false,
      requiresAnnotationToPreserve: false,
      verdict: "invalidName",
    };
  }
  const existing = existingTags.find((tag) => tag.shortName === name);
  const exists = existing !== undefined;
  const existingIsAnnotated = existing?.annotation !== undefined;
  const requiresAnnotationToPreserve = exists && existingIsAnnotated;
  const verdict: TagCreateVerdict = !exists
    ? "clean"
    : force
      ? "movesWithForce"
      : "blockedByExisting";
  return {
    nameValid: true,
    nameError: undefined,
    exists,
    existingIsAnnotated,
    requiresAnnotationToPreserve,
    verdict,
  };
}

/** Whether the dialog's own Create button may be pressed — separate from `TagCreateState` itself
 *  so the "annotated needs a non-empty message" and "force-over-annotated needs one too" rules
 *  are each one named branch here rather than folded into a template `v-if` chain. */
export function canSubmitTagCreate(
  state: TagCreateState,
  annotated: boolean,
  message: string,
): boolean {
  if (!state.nameValid) return false;
  if (state.verdict === "blockedByExisting") return false;
  if (annotated && message.trim() === "") return false;
  if (state.requiresAnnotationToPreserve && !(annotated && message.trim() !== "")) return false;
  return true;
}
