/**
 * §7.9's tag-create classifier, plus the shared ref-name prefilter both branch and tag creation
 * need before proposing a spawn at all.
 */
import type { RefRecord } from "../model/ref.ts";
import { isAnnotated } from "../model/tag.ts";
import type { TagCreatePreflight } from "./types.ts";

/**
 * A pure prefilter run before `git check-ref-format --branch` is ever spawned. Probe P3: that
 * command **resolves** `@{-1}`-style shorthand rather than rejecting it as a literal name
 * (`check-ref-format --branch '@{-1}'` exits 0 and prints `cp`), so a name containing `@{` must be
 * rejected here — git would silently accept a name meaning "some other ref" instead of the literal
 * text the user typed. A leading `-` and an empty string are rejected for the ordinary reason: git
 * itself would otherwise read either as an option.
 */
export function validateRefName(name: string): { readonly valid: boolean; readonly error: string | undefined } {
  if (name.length === 0) return { valid: false, error: "Name cannot be empty." };
  if (name.startsWith("-")) return { valid: false, error: "Name cannot start with '-'." };
  if (name.includes("@{")) {
    return { valid: false, error: "Name cannot contain '@{' (reserved by git's reflog shorthand)." };
  }
  return { valid: true, error: undefined };
}

export function classifyTagCreate(input: {
  readonly name: string;
  /** The existing tag ref of this name, if any. */
  readonly existing: RefRecord | undefined;
  /** Whether this call is proposing to move an existing tag (`-f`). */
  readonly force: boolean;
}): TagCreatePreflight {
  const { valid, error } = validateRefName(input.name);
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

  const exists = input.existing !== undefined;
  const existingIsAnnotated = input.existing !== undefined && isAnnotated(input.existing);
  // Probe P3: `git tag -f <name> <sha>` on an existing ANNOTATED tag silently downgrades it to
  // lightweight unless `-a -m` is re-supplied. Only relevant to the "move it" (force) path.
  const requiresAnnotationToPreserve = exists && existingIsAnnotated;

  const verdict: TagCreatePreflight["verdict"] = !exists
    ? "clean"
    : input.force
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
