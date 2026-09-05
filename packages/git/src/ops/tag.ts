/**
 * §7.9's whole tag argv table. `move` (force) on an annotated tag MUST re-supply `-a -m` or git
 * silently downgrades it to lightweight (probe P3) — `OpRequest["tagCreate"].message` being
 * present is what `tagCreateArgs` below keys the annotated form on, and it is the caller's job
 * (the pre-flight's `requiresAnnotationToPreserve`, `core/src/preflight/tag.ts`) to make sure a
 * force-move of an already-annotated tag is never proposed without one.
 */

export function tagCreateArgs(
  name: string,
  target: string,
  opts: { message?: string; force?: boolean } = {},
): string[] {
  const force = opts.force ? ["-f"] : [];
  if (opts.message !== undefined) return ["tag", ...force, "-a", "-m", opts.message, name, target];
  return ["tag", ...force, name, target];
}

export function tagDeleteArgs(name: string): string[] {
  return ["tag", "-d", name];
}

/** A remote delete is its own explicitly labelled action (§7.9) — `OpRequest["tagDeleteRemote"]`
 *  — never something the local delete triggers as a side effect. */
export function tagDeleteRemoteArgs(remote: string, name: string): string[] {
  return ["push", remote, "--delete", name];
}

export function tagPushArgs(remote: string, names: readonly string[] | "all"): string[] {
  return names === "all" ? ["push", remote, "--tags"] : ["push", remote, ...names];
}

/**
 * Undo for a deleted ANNOTATED tag (probe P3): `update-ref` writes the ref straight back at the
 * TAG OBJECT's own sha (still resolvable in the object database — `git tag -d` only removes the
 * ref, never the object, until gc) rather than re-running `tag -a`, which would mint a brand-new
 * tag object with a new tagger date. `tagObjectSha` is `RefRecord.objectId` as it stood right
 * before the delete — the undo-capture read the executor performs before step 3 (W8).
 */
export function undoAnnotatedTagArgs(name: string, tagObjectSha: string): string[] {
  return ["update-ref", `refs/tags/${name}`, tagObjectSha];
}

/** Undo for a deleted LIGHTWEIGHT tag: no tag object exists to restore, so this is simply
 *  re-pointing the ref at the commit it named — the same command, the same reasoning, a plain
 *  commit sha instead of a tag object's. */
export function undoLightweightTagArgs(name: string, commitSha: string): string[] {
  return ["update-ref", `refs/tags/${name}`, commitSha];
}
