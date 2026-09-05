/**
 * §7.9's two pure predicates over a `RefRecord`, named rather than inlined: `peeledObjectId ??
 * objectId` appears at the badge placement, the checkout target, the revert target and the tag
 * list, and getting it backwards on an annotated tag produces a checkout of the *tag object*,
 * which git refuses with `reference is not a tree`.
 */
import type { RefRecord } from "./ref.ts";

/** `objectType === "tag"` — never "does it have `annotation`", so this stays correct even before
 *  a caller has populated that field from a second source. */
export function isAnnotated(ref: RefRecord): boolean {
  return ref.objectType === "tag";
}

/** The commit a tag ref ultimately points at: the peeled commit for an annotated tag, the
 *  ref's own object id (already a commit) for a lightweight one. */
export function tagTargetCommit(ref: RefRecord): string {
  return ref.peeledObjectId ?? ref.objectId;
}
